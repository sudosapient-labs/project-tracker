/* Regression tests for the low-severity audit findings (server side). */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PW, account, setup } from './helpers.js';
import { loadConfig } from '../../server/config.js';
import { migrate, openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { ipKey } from '../../server/lib/rate-limit.js';
import { housekeep } from '../../server/jobs.js';
import { RESTORE_MS } from '../../server/sync/engine.js';
import { HREF_MAX, cleanRich } from '../../server/lib/rich-text.js';
import { SYNCS_PER_MINUTE } from '../../server/routes/data.js';

const invite = (id, email, role = 'Member') => ({
  c: 'members',
  id,
  k: 'put',
  v: { id, name: id, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
});
const tokenOf = (link, kind) => link.split(`#${kind}/`)[1];
const project = (id, extra = {}) => ({
  id,
  key: 'WEB',
  name: 'Website',
  icon: 'globe',
  color: 'indigo',
  status: 'planning',
  team: '',
  lead: null,
  due: null,
  start: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const task = (id, pid, extra = {}) => ({
  id,
  key: 'WEB-201',
  project: pid,
  title: 'Write copy',
  status: 'todo',
  assignee: null,
  priority: 'medium',
  due: null,
  start: null,
  labels: [],
  subtasks: [],
  attachments: [],
  deps: [],
  desc: '',
  estimate: null,
  created: Date.now(),
  updated: Date.now(),
  order: 1,
  recur: null,
  ...extra,
});
const put = (c, v, extra = {}) => ({ c, id: v.id, k: 'put', v, ...extra });
const patch = (c, id, v, extra = {}) => ({ c, id, k: 'patch', v, ...extra });
const del = (c, id) => ({ c, id, k: 'del' });
const oks = r => r.body.results.map(x => x.ok);

/* The Owner (ada) and a signed-up Member (bob). */
async function team() {
  const t = setup();
  const { c: ada, user } = await account(t);
  await ada.sync([invite('mbob', 'bob@example.com')]);
  const { c: bob } = await account(t, { name: 'Bob', email: 'bob@example.com', invite: tokenOf(t.lastLink('bob@example.com'), 'invite') });
  return { t, ada, adaId: user.id, bob };
}

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
      const r = await t
        .client()
        .post('/api/auth/login', { email: `x${i}@example.com`, password: 'wrong-password-1' }, { 'x-forwarded-for': `2001:db8:1:2::${i.toString(16)}` });
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

describe('editing a comment', () => {
  it('lets its author change the text and their own reactions only', async () => {
    const { t, ada, adaId, bob } = await team();
    await ada.sync([
      put('projects', project('p1')),
      put('tasks', task('t1', 'p1')),
      put('comments', { id: 'c1', task: 't1', by: adaId, at: 1, text: 'hi', re: {} }),
    ]);
    await bob.sync([patch('comments', 'c1', { re: { '👍': ['mbob'] } })]);
    const stored = t.repo.get('comments', 'c1');
    const tries = [
      { at: 1 },
      { re: { '👍': [] } },
      { re: { '👍': ['mbob', adaId], '🎉': ['mbob'] } },
      { text: 'edited', at: stored.at - 86_400_000 },
      { flag: true },
    ];
    for (const v of tries) expect(oks(await ada.sync([patch('comments', 'c1', v)]))).toEqual([false]);
    expect(t.repo.get('comments', 'c1')).toEqual(stored);
    expect(oks(await ada.sync([patch('comments', 'c1', { text: 'edited', re: { '👍': ['mbob', adaId] } })]))).toEqual([true]);
    expect(t.repo.get('comments', 'c1')).toMatchObject({ text: 'edited', at: stored.at, by: adaId, re: { '👍': ['mbob', adaId] } });
  });
});

describe('favourites', () => {
  it('answers a favourite of a record someone can’t open like a missing record, and stores nothing', async () => {
    const { t, ada, bob } = await team();
    await ada.sync([put('projects', project('p2', { key: 'SEC', private: true })), put('tasks', task('t2', 'p2', { key: 'SEC-201' }))]);
    const missing = (await bob.sync([patch('tasks', 'nope', { fav: true })])).body.results[0];
    for (const [c, id] of [
      ['tasks', 't2'],
      ['projects', 'p2'],
    ]) {
      const r = (await bob.sync([patch(c, id, { fav: true })])).body.results[0];
      expect(r).toMatchObject({ ok: false, status: 404, error: missing.error });
    }
    expect(t.db.get("SELECT COUNT(*) n FROM favorites WHERE user_id = 'mbob'").n).toBe(0);
    // Once they can open it, it works.
    await ada.sync([patch('projects', 'p2', { private: false })]);
    expect(oks(await bob.sync([patch('tasks', 't2', { fav: true })]))).toEqual([true]);
    expect(t.db.get("SELECT COUNT(*) n FROM favorites WHERE user_id = 'mbob'").n).toBe(1);
  });
});

describe('task keys', () => {
  it('can’t be renamed in place, taken from another project, or used to find out what a private project holds', async () => {
    const { t, ada, bob } = await team();
    await ada.sync([
      put('projects', project('p2', { key: 'SEC', private: true })),
      put('tasks', task('s1', 'p2', { key: 'SEC-201' })),
      put('projects', project('p1', { key: 'WEB' })),
    ]);
    await bob.sync([put('tasks', task('t1', 'p1', { key: 'WEB-201' }))]);
    const keyOf = r => r.body.results[0].v?.key;

    // Editing a key in place keeps it, whatever it's changed to.
    for (const key of ['SEC-201', 'SEC-999', 'WEB-500', 'WEB-202']) expect(keyOf(await bob.sync([patch('tasks', 't1', { key })]))).toBe('WEB-201');
    // A new task always gets its own project's prefix, and taken or free keys elsewhere make no difference.
    const a = keyOf(await bob.sync([put('tasks', task('t2', 'p1', { key: 'SEC-201' }))]));
    const b = keyOf(await bob.sync([put('tasks', task('t3', 'p1', { key: 'SEC-202' }))]));
    expect([a, b]).toEqual(['WEB-202', 'WEB-203']);
    // Moving into the private project is refused, and the private task keeps its key.
    expect(oks(await bob.sync([patch('tasks', 't1', { project: 'p2', key: 'SEC-201' })]))).toEqual([false]);
    expect(t.repo.get('tasks', 's1').key).toBe('SEC-201');
    expect(t.repo.get('projects', 'p2').seq || 0).toBeLessThanOrEqual(201);
  });
});

describe('migrations', () => {
  const dirWith = files => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-mig-'));
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    return dir;
  };
  function dbWithSession() {
    const db = openDb(':memory:');
    db.run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@example.com', 'x', 1)");
    db.run("INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES ('s1', 'h', 'u1', 1, 1, 9e15)");
    return db;
  }

  it('rebuilds a table without cascading deletes to the rows that point at it', () => {
    const db = dbWithSession();
    const create = db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").sql.replace(/^CREATE TABLE users/, 'CREATE TABLE users_new');
    const dir = dirWith({
      '900_rebuild_users.sql': `${create};\nINSERT INTO users_new SELECT * FROM users;\nDROP TABLE users;\nALTER TABLE users_new RENAME TO users;`,
    });
    migrate(db.raw, dir);
    expect(db.get('SELECT user_id FROM sessions')).toEqual({ user_id: 'u1' });
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
    // Foreign keys are back on afterwards.
    db.run("DELETE FROM users WHERE id = 'u1'");
    expect(db.get('SELECT COUNT(*) n FROM sessions').n).toBe(0);
  });

  it('rolls back a migration that leaves a broken reference', () => {
    const db = dbWithSession();
    const dir = dirWith({ '900_orphan.sql': "DELETE FROM users WHERE id = 'u1';" });
    expect(() => migrate(db.raw, dir)).toThrow(/900_orphan\.sql failed: .*broken reference/);
    expect(db.get('SELECT COUNT(*) n FROM users').n).toBe(1);
    expect(db.get("SELECT 1 FROM schema_migrations WHERE name = '900_orphan.sql'")).toBeUndefined();
    expect(db.get('PRAGMA foreign_keys').foreign_keys).toBe(1);
  });
});

describe('deleted records kept for Undo', () => {
  it('are purged once expired, without waiting for the next delete', async () => {
    const { t, ada, adaId } = await team();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    await ada.sync([
      put('comments', { id: 'c1', task: 't1', by: adaId, at: 1, text: 'old', re: {} }),
      put('comments', { id: 'c2', task: 't1', by: adaId, at: 1, text: 'new', re: {} }),
    ]);
    await ada.sync([del('comments', 'c1'), del('comments', 'c2')]);
    t.db.run("UPDATE recent_deletes SET deleted_at = ? WHERE id = 'c1'", Date.now() - RESTORE_MS - 1);
    housekeep({ db: t.db });
    expect(t.db.all('SELECT id FROM recent_deletes').map(r => r.id)).toEqual(['c2']);
  });

  it('go with the person who wrote them when they are removed', async () => {
    const { t, ada, adaId, bob } = await team();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    await bob.sync([put('comments', { id: 'cb', task: 't1', by: 'mbob', at: 1, text: 'bob wrote this', re: {} })]);
    await ada.sync([put('comments', { id: 'ca', task: 't1', by: adaId, at: 1, text: 'ada wrote this', re: {} })]);
    // Ada (an admin) deletes both; her Undo copies are kept under her name.
    await ada.sync([del('comments', 'cb'), del('comments', 'ca')]);
    expect(t.db.all('SELECT id FROM recent_deletes ORDER BY id').map(r => r.id)).toEqual(['ca', 'cb']);
    expect(oks(await ada.sync([del('members', 'mbob')]))).toEqual([true]);
    expect(t.db.all('SELECT id FROM recent_deletes').map(r => r.id)).toEqual(['ca']);
  });
});

describe('three-way merges of reactions and milestones', () => {
  it('keeps both of two people reacting at once, even with the same emoji', async () => {
    const { t, ada, adaId, bob } = await team();
    await ada.sync([
      put('projects', project('p1')),
      put('tasks', task('t1', 'p1')),
      put('comments', { id: 'c1', task: 't1', by: adaId, at: 1, text: 'hi', re: {} }),
    ]);
    const base = { re: {} };
    expect(oks(await ada.sync([patch('comments', 'c1', { re: { '👍': [adaId] } }, { base })]))).toEqual([true]);
    // Bob edited from the copy without Ada's reaction.
    expect(oks(await bob.sync([patch('comments', 'c1', { re: { '👍': ['mbob'], '🎉': ['mbob'] } }, { base })]))).toEqual([true]);
    expect(t.repo.get('comments', 'c1').re).toEqual({ '👍': ['mbob', adaId], '🎉': ['mbob'] });
    // Taking his back off, from a stale copy, leaves Ada's.
    await bob.sync([patch('comments', 'c1', { re: { '👍': [], '🎉': ['mbob'] } }, { base: { re: { '👍': ['mbob'], '🎉': ['mbob'] } } })]);
    expect(t.repo.get('comments', 'c1').re).toEqual({ '👍': [adaId], '🎉': ['mbob'] });
  });

  it('keeps milestones someone else added or removed, matched by name', async () => {
    const { t, ada, bob } = await team();
    const ms = [
      { name: 'Beta', date: '2026-12-01' },
      { name: 'Launch', date: '2027-01-15' },
    ];
    await ada.sync([put('projects', project('p1', { milestones: ms }))]);
    await ada.sync([
      patch(
        'projects',
        'p1',
        { milestones: [ms[0], { name: 'Launch', date: '2027-02-01' }, { name: 'GA', date: '2027-03-01' }] },
        { base: { milestones: ms } },
      ),
    ]);
    // Bob, still on the old list, drops Beta.
    await bob.sync([patch('projects', 'p1', { milestones: [ms[1]] }, { base: { milestones: ms } })]);
    expect(t.repo.get('projects', 'p1').milestones).toEqual([
      { name: 'Launch', date: '2027-02-01' },
      { name: 'GA', date: '2027-03-01' },
    ]);
  });
});

describe('the cost of one person’s sync requests', () => {
  it('drops an over-long href before the slow link check, keeping ordinary links', () => {
    const html = '<a href="https://x.test/' + '<!---->'.repeat(14_000) + '">x</a>';
    cleanRich(html);
    const t0 = performance.now();
    expect(cleanRich(html)).toBe('<a>x</a>');
    expect(performance.now() - t0).toBeLessThan(40);
    const ok = `<a href="https://example.com/${'a'.repeat(HREF_MAX - 30)}">ok</a>`;
    expect(cleanRich(ok)).toBe(ok);
    expect(cleanRich('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('limits sync requests per person, not per tab', async () => {
    const t = setup({ DISABLE_RATE_LIMIT: 'false' });
    const { c } = await account(t);
    const other = t.client();
    await other.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    for (let i = 0; i < SYNCS_PER_MINUTE; i++) expect((await (i % 2 ? c : other).sync([])).status).toBe(200);
    const r = await c.sync([]);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await other.sync([])).status).toBe(429);
  });
});
