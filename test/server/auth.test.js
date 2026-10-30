import { describe, expect, it } from 'vitest';
import { PW, account, code, setup } from './helpers.js';

describe('sign up, verify, sign in, sign out', () => {
  it('first account creates the workspace as Owner and must verify before loading data', async () => {
    const t = setup();
    const c = t.client();
    expect((await c.get('/api/auth/session')).body).toEqual({ user: null, workspace: null });

    const r = await c.post('/api/auth/signup', { name: 'Ada Owner', email: 'Ada@Example.com', password: PW });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada Owner', role: 'Owner', verified: false });
    expect(r.body.workspace).toEqual({ name: '', onboarded: false });
    expect(r.body.devLink).toMatch(/^http:\/\/app\.test\/#verify\//);
    expect(t.lastLink('ada@example.com')).toBe(r.body.devLink);

    expect((await c.get('/api/bootstrap')).status).toBe(403);
    const token = r.body.devLink.split('#verify/')[1];
    expect((await c.post('/api/auth/verify', { token })).body.user.verified).toBe(true);
    expect((await c.post('/api/auth/verify', { token })).status).toBe(400);

    const b = await c.get('/api/bootstrap');
    expect(b.status).toBe(200);
    expect(b.body.data.me).toBe(r.body.user.id);
    expect(b.body.data.members).toHaveLength(1);
    expect(b.body.data.teams.map(x => x.name)).toEqual(['Design', 'Engineering', 'Marketing', 'Product']);
    expect(b.body.data.sessions).toEqual([expect.objectContaining({ dev: 'Mac · Chrome', cur: true, at: 'Active now' })]);
    expect(b.body.workspace.onboarded).toBe(false);
    expect(b.body.prefs.name).toBe('Ada Owner');
  });

  it('rejects weak passwords, duplicate emails and bad credentials', async () => {
    const t = setup();
    const c = t.client();
    const weak = await c.post('/api/auth/signup', { name: 'A', email: 'a@x.io', password: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.field).toBe('password');
    await account(t);
    const dup = await t.client().post('/api/auth/signup', { name: 'B', email: 'ADA@example.com', password: PW });
    expect(dup.status).toBe(409);

    const bad = await t.client().post('/api/auth/login', { email: 'ada@example.com', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error).toBe('Incorrect email or password.');
    expect((await t.client().post('/api/auth/login', { email: 'nobody@example.com', password: PW })).status).toBe(401);
  });

  it('signs in, keeps the session, and signs out', async () => {
    const t = setup();
    await account(t);
    const c = t.client({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' });
    const r = await c.post('/api/auth/login', { email: 'ada@example.com', password: PW, remember: true });
    expect(r.status).toBe(200);
    expect(r.body.twoFactor).toBe(false);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    expect(r.headers.get('set-cookie')).toMatch(/SameSite=Lax/i);
    expect((await c.get('/api/auth/session')).body.user.email).toBe('ada@example.com');
    expect((await c.get('/api/bootstrap')).status).toBe(200);

    await c.post('/api/auth/logout');
    // The session cookie goes; the device cookie stays (see M2 device cookies in security.test.js).
    expect(c.session).toBe('');
    expect((await c.get('/api/auth/session')).body.user).toBeNull();
  });

  it('refuses mutating requests without the CSRF header', async () => {
    const t = setup();
    const r = await t.app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });
});

describe('password reset and change', () => {
  it('resets with an emailed link, ends old sessions, and accepts the new password', async () => {
    const t = setup();
    const { c } = await account(t);
    const anon = t.client();
    const none = await anon.post('/api/auth/forgot', { email: 'ghost@example.com' });
    expect(none.body).toEqual({ ok: true });

    const f = await anon.post('/api/auth/forgot', { email: 'ada@example.com' });
    const token = f.body.devLink.split('#reset/')[1];
    expect((await anon.get(`/api/auth/reset/${token}`)).body.email).toBe('ada@example.com');
    expect((await anon.post('/api/auth/reset', { token, password: 'weak' })).status).toBe(400);
    expect((await anon.post('/api/auth/reset', { token, password: 'brand-new-pass-2' })).status).toBe(200);
    expect((await anon.post('/api/auth/reset', { token, password: 'brand-new-pass-3' })).status).toBe(400);

    expect((await c.get('/api/bootstrap')).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email: 'ada@example.com', password: PW })).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email: 'ada@example.com', password: 'brand-new-pass-2' })).status).toBe(200);
  });

  it('changes the password only with the current one', async () => {
    const t = setup();
    const { c } = await account(t);
    expect((await c.post('/api/auth/password', { current: 'nope-nope-1', password: 'another-pass-1' })).status).toBe(400);
    expect((await c.post('/api/auth/password', { current: PW, password: 'another-pass-1' })).status).toBe(200);
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: 'another-pass-1' })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('lists devices and signs out others', async () => {
    const t = setup();
    const { c } = await account(t);
    const other = t.client({ ua: 'Mozilla/5.0 (Windows NT 10.0) Edg/120.0' });
    await other.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const list = (await c.get('/api/auth/sessions')).body;
    expect(list).toHaveLength(2);
    expect(list.find(s => !s.cur).dev).toBe('Windows · Edge');

    const after = await c.del(`/api/auth/sessions/${list.find(s => !s.cur).id}`);
    expect(after.body).toHaveLength(1);
    expect((await other.get('/api/bootstrap')).status).toBe(401);

    await other.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await c.post('/api/auth/sessions/revoke-others')).body).toHaveLength(1);
    expect((await other.get('/api/bootstrap')).status).toBe(401);
    expect((await c.get('/api/bootstrap')).status).toBe(200);
  });
});

describe('invites', () => {
  it('is invite-only after the first account, and an invite link signs the person in verified', async () => {
    const t = setup();
    const { c } = await account(t);
    const blocked = await t.client().post('/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: PW });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('invite_only');

    const inv = await c.sync([
      {
        c: 'members',
        id: 'mbob',
        k: 'put',
        v: { id: 'mbob', name: 'Bob', email: 'Bob@Example.com', role: 'Admin', team: '', title: 'Admin', c: '#6B7280', status: 'active', last: null, tz: '—' },
      },
    ]);
    expect(inv.body.results[0]).toMatchObject({ ok: true, v: { status: 'invited', email: 'bob@example.com', role: 'Admin' } });
    const link = t.lastLink('bob@example.com');
    expect(inv.body.links).toEqual([link]);
    const token = link.split('#invite/')[1];
    expect((await t.client().get(`/api/auth/invite/${token}`)).body.email).toBe('bob@example.com');

    const bob = t.client();
    const r = await bob.post('/api/auth/signup', { name: 'Bob Builder', email: 'bob@example.com', password: PW, invite: token });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ id: 'mbob', role: 'Admin', verified: true, name: 'Bob Builder' });
    const b = await bob.get('/api/bootstrap');
    expect(b.body.data.members.find(m => m.id === 'mbob')).toMatchObject({ status: 'active', name: 'Bob Builder' });
  });

  it('lets anyone sign up when open signup is enabled', async () => {
    const t = setup({ ALLOW_OPEN_SIGNUP: 'true' });
    await account(t);
    const r = await t.client().post('/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: PW });
    expect(r.status).toBe(201);
    expect(r.body.user.role).toBe('Member');
  });
});

describe('two-factor authentication', () => {
  it('enables TOTP, challenges at sign in, and accepts a recovery code once', async () => {
    const t = setup();
    const { c } = await account(t);
    const s = await c.post('/api/auth/2fa/setup', { password: PW });
    expect(s.body.qr).toMatch(/^<svg/);
    expect(s.body.otpauth).toMatch(/^otpauth:\/\/totp\//);
    expect((await c.post('/api/auth/2fa/enable', { code: '000000' })).status).toBe(400);
    const en = await c.post('/api/auth/2fa/enable', { code: code(s.body.secret) });
    expect(en.body.recoveryCodes).toHaveLength(8);
    expect((await c.get('/api/bootstrap')).body.data.tfa).toBe(true);

    const d = t.client();
    const l = await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect(l.body.twoFactor).toBe(true);
    expect(l.body.user.twoFactorPending).toBe(true);
    expect((await d.get('/api/bootstrap')).status).toBe(401);
    expect((await d.post('/api/auth/2fa/verify', { code: '123456' })).status).toBe(401);
    expect((await d.post('/api/auth/2fa/verify', { code: code(s.body.secret, 1) })).body.user.twoFactorPending).toBe(false);
    expect((await d.get('/api/bootstrap')).status).toBe(200);

    const e = t.client();
    await e.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await e.post('/api/auth/2fa/verify', { code: en.body.recoveryCodes[0] })).status).toBe(200);
    const f = t.client();
    await f.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await f.post('/api/auth/2fa/verify', { code: en.body.recoveryCodes[0] })).status).toBe(401);

    await c.post('/api/auth/2fa/disable', { password: PW });
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW })).body.twoFactor).toBe(false);
  });
});
