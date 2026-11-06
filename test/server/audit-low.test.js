/* Regression tests for the low-severity audit findings (server side). */
import { describe, expect, it } from 'vitest';
import { PW, account, setup } from './helpers.js';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { ipKey } from '../../server/lib/rate-limit.js';

const invite = (id, email, role = 'Member') => ({
  c: 'members',
  id,
  k: 'put',
  v: { id, name: id, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
});
const tokenOf = (link, kind) => link.split(`#${kind}/`)[1];

describe('sign-up in an invite-only workspace', () => {
  it('answers the same for an existing account, a pending invite and a stranger', async () => {
    const t = setup();
    const { c } = await account(t);
    await c.sync([invite('mbob', 'bob@example.com')]);
    const signup = email => t.client().post('/api/auth/signup', { name: 'Mallory', email, password: PW });
    const answers = await Promise.all(['ada@example.com', 'bob@example.com', 'nobody@example.com'].map(signup));
    for (const r of answers) {
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('invite_only');
    }
    expect(new Set(answers.map(r => JSON.stringify(r.body))).size).toBe(1);
    expect(JSON.stringify(answers[1].body)).not.toContain('bob@');
    expect(t.db.get('SELECT COUNT(*) n FROM users').n).toBe(1);
  });

  it('still says why to someone with a join link, and the invite link still works', async () => {
    const t = setup();
    const { c } = await account(t);
    await c.sync([invite('mbob', 'bob@example.com', 'Admin')]);
    const join = tokenOf((await c.post('/api/workspace/invite-link')).body.link, 'join');
    const withJoin = email => t.client().post('/api/auth/signup', { name: 'Someone', email, password: PW, join });
    expect((await withJoin('ada@example.com')).status).toBe(409);
    expect((await withJoin('bob@example.com')).body.code).toBe('invite_required');
    // An invite for another address doesn't count as an invite for this one.
    const other = await t.client().post('/api/auth/signup', {
      name: 'Eve',
      email: 'eve@example.com',
      password: PW,
      invite: tokenOf(t.lastLink('bob@example.com'), 'invite'),
    });
    expect(other.body.code).toBe('invite_only');

    const bob = await t
      .client()
      .post('/api/auth/signup', { name: 'Bob', email: 'bob@example.com', password: PW, invite: tokenOf(t.lastLink('bob@example.com'), 'invite') });
    expect(bob.status).toBe(201);
    expect(bob.body.user).toMatchObject({ id: 'mbob', role: 'Admin', verified: true });
    expect((await withJoin('carol@example.com')).status).toBe(201);
  });
});

describe('join links and their creator’s role', () => {
  async function adminWithJoinLink() {
    const t = setup();
    const { c: ada } = await account(t);
    await ada.sync([invite('mbob', 'bob@example.com', 'Admin')]);
    const { c: bob } = await account(t, { name: 'Bob', email: 'bob@example.com', invite: tokenOf(t.lastLink('bob@example.com'), 'invite') });
    const join = tokenOf((await bob.post('/api/workspace/invite-link')).body.link, 'join');
    expect((await t.client().get(`/api/auth/join/${join}`)).status).toBe(200);
    return { t, ada, join };
  }
  const joinWith = (t, join, email) => t.client().post('/api/auth/signup', { name: 'New', email, password: PW, join });

  it('retires the links someone made when they stop being an Admin', async () => {
    const { t, ada, join } = await adminWithJoinLink();
    const r = await ada.sync([{ c: 'members', id: 'mbob', k: 'patch', v: { role: 'Member' } }]);
    expect(r.body.results[0].ok).toBe(true);
    expect(t.db.get("SELECT used_at FROM auth_tokens WHERE kind = 'join'").used_at).toBeGreaterThan(0);
    expect((await t.client().get(`/api/auth/join/${join}`)).status).toBe(404);
    expect((await joinWith(t, join, 'carol@example.com')).body.code).toBe('invite_only');
  });

  it('refuses a link whose creator is no longer an Admin, however the role changed', async () => {
    const { t, join } = await adminWithJoinLink();
    t.repo.put('members', { ...t.repo.get('members', 'mbob'), role: 'Guest' });
    expect((await t.client().get(`/api/auth/join/${join}`)).status).toBe(404);
    expect((await joinWith(t, join, 'carol@example.com')).status).toBe(403);
    t.repo.put('members', { ...t.repo.get('members', 'mbob'), role: 'Admin' });
    expect((await joinWith(t, join, 'carol@example.com')).status).toBe(201);
  });
});

describe('rate-limit keys and the proxy setting', () => {
  it('keys IPv6 clients on their /64 and IPv4 clients on their address', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:DB8:1:2::1')).toBe(ipKey('2001:db8:1:2:ffff::9'));
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  });

  it('shares one sign-in budget across a /64', async () => {
    const t = setup({ TRUST_PROXY: 'true', DISABLE_RATE_LIMIT: 'false' });
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await t.client().post('/api/auth/login', { email: `x${i}@example.com`, password: 'wrong-password-1' }, { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('warns once in production when requests come through a proxy TRUST_PROXY doesn’t know about', async () => {
    const lines = [];
    const log = { info() {}, error: l => lines.push(l) };
    const config = loadConfig({ NODE_ENV: 'production', SERVE_STATIC: 'false', APP_URL: 'https://pm.example.com', DISABLE_RATE_LIMIT: 'true' });
    const { app } = createApp({ db: openDb(':memory:'), config, log, pushSend: async () => {} });
    await app.request('/api/health');
    expect(lines).toEqual([]);
    for (let i = 0; i < 3; i++) await app.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(lines.filter(l => /TRUST_PROXY/.test(l))).toHaveLength(1);

    const quiet = [];
    const behind = loadConfig({ NODE_ENV: 'production', SERVE_STATIC: 'false', TRUST_PROXY: '1', DISABLE_RATE_LIMIT: 'true' });
    const other = createApp({ db: openDb(':memory:'), config: behind, log: { info() {}, error: l => quiet.push(l) }, pushSend: async () => {} });
    await other.app.request('/api/health', { headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(quiet).toEqual([]);
  });
});
