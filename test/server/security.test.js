import { describe, expect, it } from 'vitest';
import { PW, account, code, setup } from './helpers.js';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { clientIp, createApp } from '../../server/app.js';
import { createMailer } from '../../server/lib/mailer.js';
import { housekeep } from '../../server/jobs.js';

const member = (id, email, role = 'Member') => ({
  c: 'members',
  id,
  k: 'put',
  v: { id, name: id, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
});
const tokenOf = (link, kind) => link.split(`#${kind}/`)[1];
const DAY = 86_400_000;

describe('B7 invited addresses need the invite link', () => {
  it('refuses to activate an invited member without their invite token, even with a join link or open signup', async () => {
    const t = setup({ ALLOW_OPEN_SIGNUP: 'true' });
    const { c } = await account(t);
    await c.sync([member('mbob', 'bob@example.com', 'Admin')]);
    const join = tokenOf((await c.post('/api/workspace/invite-link')).body.link, 'join');

    for (const extra of [{}, { join }, { invite: 'not-the-token' }]) {
      const r = await t.client().post('/api/auth/signup', { name: 'Mallory', email: 'bob@example.com', password: PW, ...extra });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('invite_required');
    }
    expect(t.db.get('SELECT COUNT(*) n FROM users').n).toBe(1);

    const r = await t
      .client()
      .post('/api/auth/signup', { name: 'Bob', email: 'bob@example.com', password: PW, invite: tokenOf(t.lastLink('bob@example.com'), 'invite') });
    expect(r.status).toBe(201);
    expect(r.body.user).toMatchObject({ id: 'mbob', role: 'Admin' });
  });
});

describe('B8 setting up a fresh deployment', () => {
  it('the first account needs SETUP_TOKEN when one is set', async () => {
    const t = setup({ SETUP_TOKEN: 'let-me-in-123' });
    const body = { name: 'Ada', email: 'ada@example.com', password: PW };
    expect((await t.client().post('/api/auth/signup', body)).body.code).toBe('setup_required');
    expect((await t.client().post('/api/auth/signup', { ...body, setup: 'guess' })).status).toBe(403);
    const r = await t.client().post('/api/auth/signup', { ...body, setup: 'let-me-in-123' });
    expect(r.status).toBe(201);
    expect(r.body.user.role).toBe('Owner');
  });

  it('in production without SETUP_TOKEN, generates one and logs the setup link while no workspace exists', async () => {
    const lines = [];
    const log = { info: l => lines.push(l), error() {} };
    const config = loadConfig({ NODE_ENV: 'production', SERVE_STATIC: 'false', APP_URL: 'https://pm.example.com', DISABLE_RATE_LIMIT: 'true' });
    const db = openDb(':memory:');
    const { app } = createApp({ db, config, log, pushSend: async () => {} });
    const tok = lines.map(l => /#setup\/(\S+)/.exec(l)?.[1]).find(Boolean);
    expect(lines.join('\n')).toContain('https://pm.example.com/#setup/');
    const signup = body =>
      app.request('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'gr8r' },
        body: JSON.stringify(body),
      });
    const body = { name: 'Ada', email: 'ada@example.com', password: PW };
    expect((await signup(body)).status).toBe(403);
    expect((await signup({ ...body, setup: tok })).status).toBe(201);

    const again = [];
    createApp({ db, config, log: { info: l => again.push(l), error() {} }, pushSend: async () => {} });
    expect(again.join('\n')).not.toContain('#setup/');
  });
});

describe('B9 client IP behind proxies', () => {
  it('takes the X-Forwarded-For entry TRUST_PROXY hops from the right', () => {
    const c = xff => ({ env: { incoming: { socket: { remoteAddress: '::ffff:10.0.0.9' } } }, req: { header: () => xff } });
    expect(clientIp(c('6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientIp(c('6.6.6.6, 1.2.3.4, 10.0.0.2'), 2)).toBe('1.2.3.4');
    expect(clientIp(c('1.2.3.4'), 3)).toBe('1.2.3.4');
    expect(clientIp(c('6.6.6.6'), 0)).toBe('10.0.0.9');
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(loadConfig({}).trustProxy).toBe(0);
  });

  it('rotating the client-written part of X-Forwarded-For does not get around the login limit', async () => {
    const t = setup({ TRUST_PROXY: 'true', DISABLE_RATE_LIMIT: 'false' });
    const statuses = [];
    for (let i = 0; i < 15; i++)
      statuses.push(
        (
          await t
            .client()
            .post('/api/auth/login', { email: `nobody${i}@example.com`, password: 'wrong-password-1' }, { 'x-forwarded-for': `6.6.6.${i}, 1.2.3.4` })
        ).status,
      );
    expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
    expect(statuses.slice(10).every(s => s === 429)).toBe(true);
  });
});

describe('B10 brute-force protection', () => {
  it('locks an email after 10 failed sign-ins from any number of addresses', async () => {
    const t = setup({ TRUST_PROXY: 'true', DISABLE_RATE_LIMIT: 'false' });
    await account(t);
    const from = i => ({ 'x-forwarded-for': `10.1.${i}.1` });
    for (let i = 0; i < 10; i++)
      expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: 'nope-nope-1' }, from(i))).status).toBe(401);
    const r = await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW }, from(99));
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    expect((await t.client().post('/api/auth/login', { email: 'other@example.com', password: PW }, from(98))).status).toBe(401);
  });

  it('ends a pending two-factor session after 5 wrong codes, and never accepts the same code twice', async () => {
    const t = setup();
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await c.post('/api/auth/2fa/enable', { code: code(secret) });

    const d = t.client();
    await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    for (let i = 0; i < 4; i++) expect((await d.post('/api/auth/2fa/verify', { code: '000000' })).body.field).toBe('code');
    const last = await d.post('/api/auth/2fa/verify', { code: '000000' });
    expect(last.body.code).toBe('unauthenticated');
    expect((await d.post('/api/auth/2fa/verify', { code: code(secret, 1) })).body.error).toBe('Sign in to continue.');

    // The code used to turn 2FA on can't be replayed, and a code accepted once can't be reused.
    const e = t.client();
    await e.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await e.post('/api/auth/2fa/verify', { code: code(secret) })).status).toBe(401);
    expect((await e.post('/api/auth/2fa/verify', { code: code(secret, 1) })).status).toBe(200);
    const f = t.client();
    await f.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await f.post('/api/auth/2fa/verify', { code: code(secret, 1) })).status).toBe(401);
  });
});

describe('B11-B13 sessions end when they should', () => {
  it('changing the password signs out every other session and closes its live stream', async () => {
    const t = setup();
    const { c } = await account(t);
    const other = t.client();
    await other.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const otherId = (await c.get('/api/auth/sessions')).body.find(s => !s.cur).id;
    let closed = false;
    t.engine.connect(
      { uid: (await c.get('/api/auth/session')).body.user.id, sessionId: otherId, clientId: 'x' },
      () => {},
      () => (closed = true),
    );
    const r = await c.post('/api/auth/password', { current: PW, password: 'another-pass-1' });
    expect(r.body.sessions).toHaveLength(1);
    expect(closed).toBe(true);
    expect((await other.get('/api/bootstrap')).status).toBe(401);
    expect((await c.get('/api/bootstrap')).status).toBe(200);
  });

  it('turning off two-factor needs the password or a current code', async () => {
    const t = setup();
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await c.post('/api/auth/2fa/enable', { code: code(secret) });
    const on = () => t.db.get('SELECT totp_enabled FROM users').totp_enabled;
    expect((await c.post('/api/auth/2fa/disable')).status).toBe(400);
    expect((await c.post('/api/auth/2fa/disable', { password: 'wrong-pass-1' })).status).toBe(400);
    expect((await c.post('/api/auth/2fa/disable', { code: code(secret) })).status).toBe(400); // already used
    expect(on()).toBe(1);
    expect((await c.post('/api/auth/2fa/disable', { code: code(secret, 1) })).status).toBe(200);
    expect(on()).toBe(0);

    const s2 = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await c.post('/api/auth/2fa/enable', { code: code(s2) });
    expect((await c.post('/api/auth/2fa/disable', { password: PW })).status).toBe(200);
    expect(on()).toBe(0);
  });

  it('a live-update stream closes once its session is gone', async () => {
    const t = setup();
    const { c } = await account(t);
    t.config.ssePingMs = 20;
    const res = await t.app.request('/api/events', { headers: { cookie: c.cookie } });
    const reader = res.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: hello');
    t.db.run('DELETE FROM sessions');
    const ended = (async () => {
      for (;;) if ((await reader.read()).done) return true;
    })();
    expect(await Promise.race([ended, new Promise(r => setTimeout(() => r(false), 2000))])).toBe(true);
  });
});

describe('C14 request body limits', () => {
  it('refuses oversized JSON bodies with a JSON 413, but not uploads', async () => {
    const t = setup();
    const { c } = await account(t);
    const big = n => JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(n) });
    const raw = (url, body, method = 'POST') =>
      t.app.request(url, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'gr8r', cookie: c.cookie }, body });
    const login = await raw('/api/auth/login', big(100_000));
    expect(login.status).toBe(413);
    expect(await login.json()).toEqual({ error: 'This request is too large.' });
    expect((await raw('/api/me/state', JSON.stringify({ views: { x: 'y'.repeat(1_100_000) } }), 'PUT')).status).toBe(413);
    // Sync batches may be larger.
    expect((await raw('/api/sync', JSON.stringify({ ops: [], pad: 'z'.repeat(2_000_000) }))).status).toBe(200);
    expect((await raw('/api/sync', JSON.stringify({ ops: [], pad: 'z'.repeat(11 * 1024 * 1024) }))).status).toBe(413);
    // A body without Content-Length is counted as it streams.
    const stream = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new TextEncoder().encode(big(100_000)));
        ctl.close();
      },
    });
    expect((await t.app.request('/api/auth/login', { method: 'POST', headers: { 'x-requested-with': 'gr8r' }, body: stream, duplex: 'half' })).status).toBe(
      413,
    );

    await c.sync([
      {
        c: 'projects',
        id: 'p1',
        k: 'put',
        v: { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] },
      },
    ]);
    const up = await t.app.request('/api/files?project=p1&name=big.bin', {
      method: 'POST',
      headers: { 'x-requested-with': 'gr8r', 'content-type': 'application/octet-stream', cookie: c.cookie },
      body: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(up.status).toBe(201);
  });
});

describe('C15 served files keep their own CSP', () => {
  it('sends the sandbox policy on files and the app policy elsewhere', async () => {
    const t = setup();
    const { c } = await account(t);
    await c.sync([
      {
        c: 'projects',
        id: 'p1',
        k: 'put',
        v: { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] },
      },
    ]);
    const up = await t.app.request('/api/files?project=p1&name=a.txt', {
      method: 'POST',
      headers: { 'x-requested-with': 'gr8r', 'content-type': 'text/plain', cookie: c.cookie },
      body: 'hi',
    });
    const f = (await up.json()).file;
    const got = await t.app.request(f.url, { headers: { cookie: c.cookie } });
    expect(got.headers.get('content-security-policy')).toBe("default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    expect(got.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await c.get('/api/health')).headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('C16 outbox and housekeeping', () => {
  const quiet = { info() {}, error() {} };
  const msg = { to: 'ada@example.com', subject: 'Reset', intro: 'Hi', action: 'Reset', link: 'https://app.test/#reset/live-token' };
  const resend = status => async () => new Response('{}', { status });

  it('wipes links and bodies once mail is sent or given up on', async () => {
    const db = openDb(':memory:');
    const config = loadConfig({ NODE_ENV: 'test', RESEND_API_KEY: 're_x' });
    await createMailer(db, config, quiet, resend(200)).queue(msg);
    await createMailer(db, config, quiet, resend(200)).drain();
    const failing = createMailer(db, config, quiet, resend(422));
    failing.queue(msg);
    await failing.drain();
    expect(db.all('SELECT link, body_text, body_html FROM outbox')).toEqual([
      { link: null, body_text: '', body_html: '' },
      { link: null, body_text: '', body_html: '' },
    ]);
  });

  it('deletes old sent mail and reminders for tasks that are gone or done', async () => {
    const t = setup();
    const { c } = await account(t);
    const now = Date.now();
    t.db.run(
      "INSERT INTO outbox (to_addr, subject, body_text, body_html, created_at, sent_at) VALUES ('a', 'old', '', '', ?, ?), ('b', 'new', '', '', ?, ?)",
      now - 40 * DAY,
      now - 40 * DAY,
      now,
      now,
    );
    t.db.run("INSERT INTO outbox (to_addr, subject, body_text, body_html, created_at, attempts) VALUES ('c', 'failed', '', '', ?, 5)", now - 40 * DAY);
    const T = (id, status) => ({
      id,
      key: 'WEB-' + id.slice(1),
      project: 'p1',
      title: id,
      status,
      assignee: null,
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: 1,
      updated: 1,
      order: 1,
    });
    await c.sync([
      {
        c: 'projects',
        id: 'p1',
        k: 'put',
        v: { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] },
      },
      { c: 'tasks', id: 't201', k: 'put', v: T('t201', 'todo') },
      { c: 'tasks', id: 't202', k: 'put', v: T('t202', 'done') },
    ]);
    for (const id of ['t201', 't202', 'tgone']) t.db.run("INSERT INTO reminders (task_id, kind, due, sent_at) VALUES (?, 'overdue', '2026-01-01', 1)", id);
    housekeep(t, now);
    expect(t.db.all("SELECT subject FROM outbox WHERE subject IN ('old', 'new', 'failed')").map(r => r.subject)).toEqual(['new']);
    expect(t.db.all('SELECT task_id FROM reminders').map(r => r.task_id)).toEqual(['t201']);
  });
});

describe('C17 push endpoints', () => {
  it('only accepts subscriptions on known browser push services', async () => {
    const t = setup();
    const { c } = await account(t);
    const sub = endpoint => c.post('/api/push/subscriptions', { endpoint, keys: { p256dh: 'BKey', auth: 'a' } });
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QABC',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ])
      expect((await sub(ok)).status).toBe(201);
    for (const bad of [
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example.com/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/x',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://user@fcm.googleapis.com/x',
    ])
      expect((await sub(bad)).status).toBe(400);
  });
});

describe('C18 abuse limits', () => {
  it('caps invites per person per hour, through sync and resends together', async () => {
    const t = setup({ DISABLE_RATE_LIMIT: 'false' });
    const { c } = await account(t);
    const ops = Array.from({ length: 51 }, (_, i) => member('m' + i, `p${i}@example.com`));
    const r = await c.sync(ops);
    expect(r.body.results.filter(x => x.ok)).toHaveLength(50);
    expect(r.body.results[50]).toMatchObject({ ok: false, status: 429 });
    expect((await c.post('/api/members/m0/resend-invite')).status).toBe(429);
  });

  it('caps access requests per person and project', async () => {
    const t = setup({ DISABLE_RATE_LIMIT: 'false' });
    const { c, user } = await account(t);
    await c.sync([
      member('mbob', 'bob@example.com'),
      {
        c: 'projects',
        id: 'p1',
        k: 'put',
        v: {
          id: 'p1',
          key: 'WEB',
          name: 'Web',
          icon: 'globe',
          color: 'indigo',
          status: 'active',
          team: '',
          lead: user.id,
          members: [],
          desc: '',
          milestones: [],
          private: true,
        },
      },
    ]);
    const bob = await account(t, { name: 'Bob', email: 'bob@example.com', invite: tokenOf(t.lastLink('bob@example.com'), 'invite') });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await bob.c.post('/api/projects/p1/request-access')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });
});
