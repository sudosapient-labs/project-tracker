/* Regression tests for the low-severity audit findings (server side). */
import { describe, expect, it } from 'vitest';
import { PW, account, setup } from './helpers.js';

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
