/* Regression tests for the security and production-readiness review (H1–H3, M1–M7, L1–L13). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PW, account, code, setup } from './helpers.js';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { createMailer } from '../../server/lib/mailer.js';
import { housekeep, runDigests } from '../../server/jobs.js';

const project = (id, extra = {}) => ({
  id,
  key: id.toUpperCase().replace(/\d/g, d => 'ABCDEFGHIJ'[d]),
  name: 'Project ' + id,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  due: null,
  start: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
let n = 500;
const task = (id, pid, extra = {}) => ({
  id,
  key: `X-${++n}`,
  project: pid,
  title: 'Task ' + id,
  status: 'todo',
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
  ...extra,
});
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });
const del = (c, id) => ({ c, id, k: 'del' });
const res = r => r.body.results.map(x => x.ok);
const boot = async c => (await c.get('/api/bootstrap')).body.data;
const tokenOf = (link, kind) => link.split(`#${kind}/`)[1];
const MIN = 60_000;

/* Ada (Owner), Bob (Member), Cat (Admin) and Gus (Guest), all signed in. */
async function people(env = {}, deps = {}) {
  const t = setup(env, deps);
  const ada = await account(t);
  const join = async (id, name, email, role) => {
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    return (await account(t, { name, email, invite: tokenOf(t.lastLink(email), 'invite') })).c;
  };
  const bob = await join('mbob', 'Bob Lee', 'bob@example.com', 'Member');
  const cat = await join('mcat', 'Cat Admin', 'cat@example.com', 'Admin');
  const gus = await join('mgus', 'Gus Guest', 'gus@example.com', 'Guest');
  return { t, ada: ada.c, adaId: ada.user.id, bob, cat, gus };
}
async function upload(t, c, q, body = 'bytes', type = 'text/plain') {
  const r = await t.app.request(`/api/files?${new URLSearchParams(q)}`, {
    method: 'POST',
    headers: { 'x-requested-with': 'gr8r', 'content-type': type, cookie: c.cookie },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  return { status: r.status, body: await r.json() };
}
function listen(t, ...uids) {
  const seen = Object.fromEntries(uids.map(u => [u, []]));
  for (const uid of uids)
    t.engine.connect(
      { uid, sessionId: 's-' + uid, clientId: 'tab-' + uid },
      (e, d) => e === 'changes' && seen[uid].push(...d),
      () => {},
    );
  return seen;
}
/* A database file with the migrations before `upto` applied, ready for rows written the old way. */
function oldDb(upto) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-mig-')), 'db.sqlite');
  const migs = path.resolve('server/migrations');
  const raw = new DatabaseSync(file);
  raw.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const f of fs.readdirSync(migs).filter(f => f < upto)) {
    raw.exec(fs.readFileSync(path.join(migs, f), 'utf8'));
    raw.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(f);
  }
  return { file, raw };
}

const HOSTILE =
  '<p>ok</p><img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">l</a><form action="https://evil.example"><input name=q></form>' +
  '<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><style>*{display:none}</style><svg onload=alert(4)></svg>';

describe('H1 rich-text descriptions', () => {
  it('sanitises descriptions on write and leaves what the editor produces alone', async () => {
    const { ada } = await people();
    const clean =
      '<p>a<br>b&nbsp;<b>bold</b> <i>it</i></p><ul><li>one</li></ul><ol><li>two</li></ol><h4>Head</h4><div><a href="https://example.com/?a=1&amp;b=2">link</a></div>';
    const r = await ada.sync([
      put('projects', project('p1')),
      put('tasks', task('t1', 'p1', { desc: HOSTILE })),
      put('tasks', task('t2', 'p1', { desc: clean })),
    ]);
    expect(res(r)).toEqual([true, true, true]);
    expect(r.body.results[1].v.desc).toBe('<p>ok</p><a>l</a>');
    expect(r.body.results[2].v.desc).toBe(clean);
    const p = await ada.sync([patch('tasks', 't2', { desc: '<p onclick="x()">hi<iframe src="https://evil.example"></iframe></p>' })]);
    expect(p.body.results[0].v.desc).toBe('<p>hi</p>');
    expect((await boot(ada)).tasks.find(t => t.id === 't2').desc).toBe('<p>hi</p>');
  });

  it('the app CSP stops injected markup re-pointing URLs, posting forms elsewhere or loading plugins', async () => {
    const t = setup();
    const csp = (await t.client().get('/api/health')).headers.get('content-security-policy');
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
  });

  it('a migration cleans descriptions, repeat settings, event times and reactions saved before', () => {
    const { file, raw } = oldDb('007');
    const ins = (table, v, scope = 'project_id') =>
      raw.prepare(`INSERT INTO ${table} (id, ${scope}, data, created_at, updated_at) VALUES (?, 'p1', ?, 0, 0)`).run(v.id, JSON.stringify(v));
    ins('tasks', task('t1', 'p1', { desc: HOSTILE, recur: '<b>x</b>' }));
    ins('tasks', task('t2', 'p1', { desc: '<p>fine</p>', recur: 'Weekly' }));
    ins('events', { id: 'e1', title: 'E', date: '2026-11-01', time: '"><img src=x onerror=alert(1)>', project: 'p1' });
    ins('comments', { id: 'c1', task: 't1', by: 'm', at: 1, text: 'x', re: { '👍': ['m'], '<img src=x onerror=alert(1)>': ['m'] } });
    raw.close();
    const db = openDb(file);
    const get = (table, id) => JSON.parse(db.get(`SELECT data FROM ${table} WHERE id = ?`, id).data);
    expect(get('tasks', 't1')).toMatchObject({ desc: '<p>ok</p><a>l</a>', recur: null });
    expect(get('tasks', 't2')).toMatchObject({ desc: '<p>fine</p>', recur: 'Weekly' });
    expect(get('events', 'e1').time).toBe('');
    expect(get('comments', 'c1').re).toEqual({ '👍': ['m'] });
    db.close();
  });
});

describe('H2 user-controlled fields the client interpolates', () => {
  it('comments start without reactions, and reactions are only the picker’s emoji', async () => {
    const { ada, bob } = await people();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const c = await bob.sync([put('comments', { id: 'c1', task: 't1', by: 'x', at: 1, text: 'hi', re: { '👍': ['mbob', 'mcat'] } })]);
    expect(c.body.results[0].v.re).toEqual({});
    const bad = await ada.sync([patch('comments', 'c1', { re: { '"><img src=x onerror=alert(1)>': [] } })]);
    expect(bad.body.results[0].ok).toBe(false);
    expect(res(await ada.sync([patch('comments', 'c1', { re: { '🎉': [] } })]))).toEqual([true]);
  });

  it('repeat is one of the UI’s choices and event times are HH:MM or empty', async () => {
    const { ada } = await people();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    expect(res(await ada.sync([patch('tasks', 't1', { recur: '<img src=x onerror=alert(1)>' })]))).toEqual([false]);
    expect(res(await ada.sync([patch('tasks', 't1', { recur: 'Every 2 weeks' })]))).toEqual([true]);
    const ev = time => put('events', { id: 'e' + time.length, title: 'Standup', date: '2026-11-02', time, project: 'p1' });
    expect(res(await ada.sync([ev('"><svg onload=alert(1)>'), ev('9am'), ev('09:30'), ev('')]))).toEqual([false, false, true, true]);
  });

  it('the server computes a file’s type and size; the client’s values are ignored', async () => {
    const { t, ada } = await people();
    await ada.sync([put('projects', project('p1'))]);
    const up = await upload(t, ada, { project: 'p1', name: 'shot.png' }, 'x'.repeat(2048), 'image/png');
    expect(up.body.file).toMatchObject({ type: 'img', size: '2 KB' });
    const id = up.body.file.id;
    const ren = await ada.sync([patch('files', id, { name: 'notes.pdf', type: '<img src=x onerror=alert(1)>' })]);
    expect(ren.body.results[0].v).toMatchObject({ name: 'notes.pdf', type: 'pdf', size: '2 KB' });
    expect(res(await ada.sync([patch('files', id, { size: '<img src=x onerror=alert(1)>' })]))).toEqual([false]);
    const copy = await ada.sync([
      put('files', { id: 'fcopy', project: 'p1', name: 'copy.zip', type: 'x', size: '"><svg onload=1>', by: null, at: 1, url: up.body.file.url }),
    ]);
    expect(copy.body.results[0].v).toMatchObject({ type: 'zip', size: '2 KB' });
  });
});

describe('H3 a pending email change dies when the account is secured', () => {
  async function pending(t, c) {
    expect((await c.post('/api/auth/email', { email: 'new@example.com', password: PW })).status).toBe(200);
    return tokenOf(t.lastLink('new@example.com'), 'email');
  }
  const confirm = (t, tok) => t.client().post('/api/auth/email/confirm', { token: tok });

  it('tells the old address straight away, without a link that confirms anything', async () => {
    const t = setup();
    const { c } = await account(t);
    await pending(t, c);
    const mail = t.db.get("SELECT subject, body_text, link FROM outbox WHERE to_addr = 'ada@example.com' ORDER BY id DESC");
    expect(mail.subject).toBe('Someone asked to change your Sudo Sapient email');
    expect(mail.body_text).toContain('new@example.com');
    expect(mail.link).not.toContain('#email/');
  });

  for (const [what, act] of [
    ['a password change', (t, c) => c.post('/api/auth/password', { current: PW, password: 'another-pass-1' })],
    ['revoking other sessions', (t, c) => c.post('/api/auth/sessions/revoke-others')],
    [
      'a password reset',
      async t => {
        await t.client().post('/api/auth/forgot', { email: 'ada@example.com' });
        await t.client().post('/api/auth/reset', { token: tokenOf(t.lastLink('ada@example.com'), 'reset'), password: 'another-pass-1' });
      },
    ],
    [
      'turning two-factor on',
      async (t, c) => {
        const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
        expect((await c.post('/api/auth/2fa/enable', { code: code(secret) })).status).toBe(200);
      },
    ],
  ])
    it(`after ${what}`, async () => {
      const t = setup();
      const { c } = await account(t);
      const tok = await pending(t, c);
      await act(t, c);
      expect((await confirm(t, tok)).status).toBe(400);
      expect(t.db.get('SELECT email FROM users').email).toBe('ada@example.com');
    });

  it('after turning two-factor off, and when the account is deleted', async () => {
    const { t, bob } = await people();
    const secret = (await bob.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await bob.post('/api/auth/2fa/enable', { code: code(secret) });
    const tok = await pending(t, bob);
    expect((await bob.post('/api/auth/2fa/disable', { password: PW })).status).toBe(200);
    expect((await confirm(t, tok)).status).toBe(400);
    const tok2 = await pending(t, bob);
    expect((await bob.post('/api/auth/account/delete', { password: PW })).status).toBe(200);
    expect(
      t.db.get(
        "SELECT used_at FROM auth_tokens WHERE kind = 'email' AND token_hash = (SELECT token_hash FROM auth_tokens WHERE kind = 'email' ORDER BY created_at DESC LIMIT 1)",
      ).used_at,
    ).toBeTruthy();
    expect((await confirm(t, tok2)).status).toBe(400);
  });
});

describe('M1 wrong two-factor codes count per account', () => {
  it('pauses two-factor for the account after 10 wrong codes in 15 minutes, across sessions, and tells the person', async () => {
    const t = setup();
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await c.post('/api/auth/2fa/enable', { code: code(secret) });
    const pendingSession = async () => {
      const d = t.client();
      await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
      return d;
    };
    let d;
    for (let i = 0; i < 9; i++) {
      if (i % 4 === 0) d = await pendingSession(); // a fresh session before the per-session limit of 5
      expect((await d.post('/api/auth/2fa/verify', { code: '000000' })).status).toBe(401);
    }
    d = await pendingSession();
    const tenth = await d.post('/api/auth/2fa/verify', { code: '000000' });
    expect(tenth.status).toBe(429);
    expect(tenth.body.code).toBe('two_factor_locked');
    expect(t.db.get("SELECT subject FROM outbox WHERE to_addr = 'ada@example.com' ORDER BY id DESC").subject).toMatch(/wrong two-factor codes/);

    // Even the right code is refused while paused, from any session.
    const e = await pendingSession();
    const right = await e.post('/api/auth/2fa/verify', { code: code(secret, 1) });
    expect(right.status).toBe(429);
    expect(right.body.error).toMatch(/paused for 15 minutes/);

    // The pause is stored with the account (survives restarts), and ends after 15 minutes.
    t.db.run('UPDATE users SET tfa_locked_until = ?', Date.now() - 1);
    expect((await e.post('/api/auth/2fa/verify', { code: code(secret, 1) })).status).toBe(200);
    expect(t.db.get('SELECT tfa_failed, tfa_locked_until FROM users')).toEqual({ tfa_failed: 0, tfa_locked_until: null });
  });

  it('a correct code resets the count', async () => {
    const t = setup();
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await c.post('/api/auth/2fa/enable', { code: code(secret) });
    const d = t.client();
    await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    for (let i = 0; i < 3; i++) await d.post('/api/auth/2fa/verify', { code: '000000' });
    expect(t.db.get('SELECT tfa_failed FROM users').tfa_failed).toBe(3);
    expect((await d.post('/api/auth/2fa/verify', { code: code(secret, 1) })).status).toBe(200);
    expect(t.db.get('SELECT tfa_failed FROM users').tfa_failed).toBe(0);
  });
});

describe('M2 device cookies keep the owner signing in while someone else is locked out', () => {
  const env = { TRUST_PROXY: 'true', DISABLE_RATE_LIMIT: 'false' };
  const from = i => ({ 'x-forwarded-for': `10.2.${i}.1` });
  const login = (c, password, i) => c.post('/api/auth/login', { email: 'ada@example.com', password }, from(i));
  const attack = async (t, start = 0) => {
    for (let i = start; i < start + 10; i++) expect((await login(t.client(), 'nope-nope-1', i)).status).toBe(401);
  };

  it('a browser that signed in before is exempt from the per-email lockout; others are not', async () => {
    const t = setup(env);
    await account(t);
    const home = t.client();
    expect((await login(home, PW, 50)).status).toBe(200);
    expect(home.cookie).toMatch(/gr8r_dev=/);
    const set = (await login(t.client(), PW, 51)).headers.getSetCookie().find(s => s.startsWith('gr8r_dev='));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Path=\/api\/auth/);
    await home.post('/api/auth/logout');
    expect(home.cookie).toMatch(/gr8r_dev=/); // signing out keeps it

    await attack(t);
    expect((await login(t.client(), PW, 60)).status).toBe(429);
    expect((await login(home, PW, 61)).status).toBe(200);
  });

  it('a trusted browser has its own failure limit, and then counts as a stranger', async () => {
    const t = setup(env);
    await account(t);
    const home = t.client();
    await login(home, PW, 70);
    for (let i = 0; i < 10; i++) expect((await login(home, 'nope-nope-1', 71 + i)).status).toBe(401);
    // Its own failures didn't lock the email for everyone else…
    expect((await login(t.client(), PW, 90)).status).toBe(200);
    // …and once they're used up it shares the per-email limit.
    await attack(t, 100);
    expect((await login(home, PW, 120)).status).toBe(429);
  });

  it('changing or resetting the password forgets every device', async () => {
    const t = setup(env);
    const { c } = await account(t);
    const home = t.client();
    await login(home, PW, 130);
    await c.post('/api/auth/password', { current: PW, password: 'another-pass-1' }, from(131));
    expect(t.db.get('SELECT COUNT(*) n FROM devices').n).toBe(1); // only the browser that changed it
    await attack(t, 140);
    expect((await home.post('/api/auth/login', { email: 'ada@example.com', password: 'another-pass-1' }, from(160))).status).toBe(429);

    await t.client().post('/api/auth/forgot', { email: 'ada@example.com' }, from(161));
    await t.client().post('/api/auth/reset', { token: tokenOf(t.lastLink('ada@example.com'), 'reset'), password: 'third-pass-12' }, from(162));
    expect(t.db.get('SELECT COUNT(*) n FROM devices').n).toBe(0);
  });
});

describe('M3 records without a project', () => {
  it('only admins touch workspace-wide events; project events need edit rights; nobody logs project-less activity', async () => {
    const { ada, bob, cat, gus, adaId } = await people();
    await ada.sync([put('projects', project('p1', { members: [adaId, 'mgus'] }))]);
    const ev = (id, pid) => put('events', { id, title: 'Offsite', date: '2026-11-03', time: '10:00', project: pid });
    expect(res(await ada.sync([ev('e1', null)]))).toEqual([true]);
    expect(res(await bob.sync([ev('e2', null), patch('events', 'e1', { title: 'Mine now' }), del('events', 'e1')]))).toEqual([false, false, false]);
    expect(res(await gus.sync([ev('e3', null), del('events', 'e1'), ev('e4', 'p1')]))).toEqual([false, false, false]);
    expect(res(await cat.sync([patch('events', 'e1', { title: 'Admin edit' })]))).toEqual([true]);
    expect(res(await bob.sync([ev('e5', 'p1'), patch('events', 'e5', { project: null })]))).toEqual([true, false]);

    const act = (id, pid) => put('activity', { id, by: 'x', verb: 'archived', task: null, project: pid, at: Date.now() });
    expect(res(await gus.sync([act('a1', null)]))).toEqual([false]);
    expect(res(await ada.sync([act('a2', null)]))).toEqual([false]);
    expect(res(await bob.sync([act('a3', 'p1')]))).toEqual([true]);
  });
});

describe('M4 attachment links', () => {
  it('only accepts this server’s file links, and rebuilds attachments from the files they point to', async () => {
    const { t, ada } = await people();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const up = await upload(t, ada, { project: 'p1', task: 't1', name: 'spec.txt' });
    const real = up.body.task.attachments[0];
    const forged = { ...real, name: '"><img src=x onerror=alert(1)>', size: '<b>9</b>', type: 'img', url: '/api/files/' + real.id + '/spec.txt' };
    const r = await ada.sync([patch('tasks', 't1', { attachments: [forged] })]);
    expect(r.body.results[0].v.attachments).toEqual([real]);
    for (const url of ['javascript:alert(1)', 'https://evil.example/x.png', '//evil.example/x', 'data:text/html,hi']) {
      const r = await ada.sync([patch('tasks', 't1', { attachments: [{ ...real, id: 'fx', url }] })]);
      expect(r.body.results[0].v.attachments[0].url).toBeUndefined();
      expect(res(await ada.sync([put('files', { id: 'fy', project: 'p1', name: 'x.png', type: 'img', size: '1 KB', by: null, at: 1, url })]))).toEqual([false]);
    }
    // An entry with no stored file keeps its name, loses any link and gets a type from its name.
    const legacy = await ada.sync([
      patch('tasks', 't1', { attachments: [{ id: 'fold', name: 'old.fig', type: 'zip', size: '1.2 MB', by: null, at: 1, url: '/api/files/fold/old.fig' }] }),
    ]);
    expect(legacy.body.results[0].v.attachments).toEqual([{ id: 'fold', name: 'old.fig', type: 'fig', size: '1.2 MB', by: null, at: 1 }]);
  });
});

describe('M5 the digest reads tasks as they are now', () => {
  it('leaves out the key and title of a task that moved somewhere the reader can no longer see', async () => {
    const { t, ada, bob, adaId } = await people();
    await ada.sync([
      put('projects', project('p1')),
      put('projects', project('p2', { private: true, members: [adaId] })),
      put('tasks', task('t1', 'p1', { title: 'Acme pricing' })),
    ]);
    await ada.sync([patch('tasks', 't1', { assignee: 'mbob' })]);
    await bob.sync([put('notifPrefs', { email_digest: true })]);
    await ada.sync([patch('tasks', 't1', { project: 'p2', assignee: null })]);
    const monday9 = Date.parse('2026-11-02T09:00:00Z');
    t.repo.saveUserState('mbob', { prefs: { tz: 'UTC' } });
    t.db.run("UPDATE notifications SET created_at = ? WHERE user_id = 'mbob'", monday9 - MIN);
    expect(runDigests(t, monday9)).toBe(1);
    const mail = t.db.get("SELECT body_text FROM outbox WHERE to_addr = 'bob@example.com' AND subject LIKE '%digest%'").body_text;
    expect(mail).toContain('An update on work you no longer have access to');
    expect(mail).not.toContain('Acme pricing');
    expect(mail).not.toMatch(/PB?-\d+/);
  });
});

describe('M6 push subscriptions end with their session', () => {
  const sub = endpoint => ({ endpoint, keys: { p256dh: 'BOr0', auth: 'au' } });
  const subs = t => t.db.all('SELECT endpoint FROM push_subscriptions ORDER BY endpoint').map(r => r.endpoint);

  it('signing out, revoking a session, changing the password and session expiry delete them', async () => {
    const t = setup();
    const { c } = await account(t);
    const tabs = await Promise.all(
      [1, 2, 3, 4].map(async () => {
        const d = t.client();
        await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
        return d;
      }),
    );
    for (const [i, d] of tabs.entries()) expect((await d.post('/api/push/subscriptions', sub(`https://fcm.googleapis.com/fcm/send/${i}`))).status).toBe(201);
    expect(subs(t)).toHaveLength(4);
    await tabs[0].post('/api/auth/logout');
    expect(subs(t)).not.toContain('https://fcm.googleapis.com/fcm/send/0');
    const ids = (await c.get('/api/auth/sessions')).body.filter(s => !s.cur).map(s => s.id);
    const s1 = t.db.get("SELECT session_id FROM push_subscriptions WHERE endpoint LIKE '%/1'").session_id;
    expect(ids).toContain(s1);
    await c.del(`/api/auth/sessions/${s1}`);
    expect(subs(t)).toHaveLength(2);
    t.db.run("UPDATE sessions SET expires_at = 0 WHERE id = (SELECT session_id FROM push_subscriptions WHERE endpoint LIKE '%/2')");
    housekeep(t);
    expect(subs(t)).toEqual(['https://fcm.googleapis.com/fcm/send/3']);
    await c.post('/api/auth/password', { current: PW, password: 'another-pass-1' });
    expect(subs(t)).toEqual([]);
  });

  it('the migration drops subscriptions that belong to no session', () => {
    const { file, raw } = oldDb('006');
    raw
      .prepare("INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES ('https://fcm.googleapis.com/x', 'm1', 'k', 'a', 0)")
      .run();
    raw.close();
    const db = openDb(file);
    expect(db.get('SELECT COUNT(*) n FROM push_subscriptions').n).toBe(0);
    db.close();
  });
});

describe('M7 only development and test relax security', () => {
  it('any other NODE_ENV, or none, gets production behaviour', async () => {
    for (const NODE_ENV of ['production', 'staging', 'prod', undefined]) {
      const cfg = loadConfig({ NODE_ENV });
      expect(cfg).toMatchObject({ prod: true, secureCookies: true, exposeEmailLinks: false });
    }
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({ prod: false, secureCookies: false, exposeEmailLinks: true });
    expect(loadConfig({ NODE_ENV: 'test', RESEND_API_KEY: 're_1' }).exposeEmailLinks).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'test', SECRET_KEY: 'short' })).toThrow(/32 bytes/);

    // With NODE_ENV=staging, forgot-password hands back no link and the first sign-up needs the setup token.
    const lines = [];
    const config = loadConfig({ NODE_ENV: 'staging', SERVE_STATIC: 'false', DISABLE_RATE_LIMIT: 'true' });
    const db = openDb(':memory:');
    const { app } = createApp({ db, config, log: { info: l => lines.push(l), error() {} }, pushSend: async () => {} });
    expect(lines.join('\n')).toContain('#setup/');
    const r = await app.request('/api/auth/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'gr8r' },
      body: JSON.stringify({ email: 'anyone@example.com' }),
    });
    expect(await r.json()).toEqual({ ok: true });
  });

  it('in production without Resend, logs recipient and subject but not the link, unless LOG_EMAIL_LINKS=true', async () => {
    const run = async env => {
      const lines = [];
      const db = openDb(':memory:');
      const mailer = createMailer(db, loadConfig({ NODE_ENV: 'production', ...env }), { info: l => lines.push(l), error() {} });
      mailer.queue({ to: 'ada@example.com', subject: 'Reset your password', intro: 'Hi', action: 'Reset', link: 'https://app.test/#reset/SECRET' });
      await mailer.drain();
      return lines.join('\n');
    };
    const quiet = await run({});
    expect(quiet).toContain('to=ada@example.com');
    expect(quiet).toContain('Reset your password');
    expect(quiet).not.toContain('SECRET');
    expect(await run({ LOG_EMAIL_LINKS: 'true' })).toContain('https://app.test/#reset/SECRET');
  });
});

describe('L1 recovery codes', () => {
  it('a recovery code works once even when two sign-ins race with it', async () => {
    const t = setup();
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    const codes = (await c.post('/api/auth/2fa/enable', { code: code(secret) })).body.recoveryCodes;
    const a = t.client();
    const b = t.client();
    await a.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    await b.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const [ra, rb] = await Promise.all([a.post('/api/auth/2fa/verify', { code: codes[0] }), b.post('/api/auth/2fa/verify', { code: codes[0] })]);
    expect([ra.status, rb.status].sort()).toEqual([200, 401]);
    expect(JSON.parse(t.db.get('SELECT recovery_codes FROM users').recovery_codes)).toHaveLength(7);
  });
});

describe('L2 removing someone clears every reference to them', () => {
  it('clears project lead and subtask assignees, for removal and self-deletion alike', async () => {
    const { ada, bob, cat } = await people();
    const sub = (id, assignee) => ({ id, title: 'Sub ' + id, done: false, assignee });
    await ada.sync([
      put('projects', project('p1', { lead: 'mbob' })),
      put('projects', project('p2', { lead: 'mcat' })),
      put('tasks', task('t1', 'p1', { subtasks: [sub('s1', 'mbob'), sub('s2', 'mcat')] })),
    ]);
    expect(res(await ada.sync([del('members', 'mbob')]))).toEqual([true]);
    expect((await cat.post('/api/auth/account/delete', { password: PW })).status).toBe(200);
    const d = await boot(ada);
    expect(d.projects.find(p => p.id === 'p1').lead).toBeNull();
    expect(d.projects.find(p => p.id === 'p2').lead).toBeNull();
    expect(d.tasks.find(t => t.id === 't1').subtasks.map(s => s.assignee)).toEqual([null, null]);
    expect((await bob.get('/api/bootstrap')).status).toBe(401);
  });
});

describe('L3 subtask assignees', () => {
  it('must exist and be able to open the project', async () => {
    const { ada, adaId } = await people();
    await ada.sync([put('projects', project('p1', { private: true, members: [adaId] })), put('tasks', task('t1', 'p1'))]);
    const sub = assignee => ({ subtasks: [{ id: 's1', title: 'Sub', done: false, assignee }] });
    expect(res(await ada.sync([patch('tasks', 't1', sub('mbob'))]))).toEqual([false]);
    expect(res(await ada.sync([patch('tasks', 't1', sub('nobody'))]))).toEqual([false]);
    expect(res(await ada.sync([put('tasks', task('t2', 'p1', sub('mbob')))]))).toEqual([false]);
    expect(res(await ada.sync([patch('tasks', 't1', sub(adaId))]))).toEqual([true]);
  });
});

describe('L4 the workspace join link', () => {
  it('only Owners and Admins create or rotate it, and that is rate-limited', async () => {
    const { t, ada, bob, cat } = await people({ DISABLE_RATE_LIMIT: 'false' });
    expect((await bob.post('/api/workspace/invite-link')).status).toBe(403);
    expect((await cat.post('/api/workspace/invite-link')).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await ada.post('/api/workspace/invite-link')).status).toBe(200);
    expect((await ada.post('/api/workspace/invite-link')).status).toBe(200);
    expect((await ada.post('/api/workspace/invite-link')).status).toBe(429);
    expect(t.db.get("SELECT COUNT(*) n FROM auth_tokens WHERE kind = 'join' AND used_at IS NULL").n).toBe(1);
  });
});

describe('L5 what Guests and outsiders learn', () => {
  it('Guests only see the email of people they share a project with', async () => {
    const { t, ada, gus, adaId } = await people();
    await ada.sync([put('projects', project('p1', { members: [adaId, 'mgus'] }))]);
    const emails = Object.fromEntries((await boot(gus)).members.map(m => [m.id, m.email]));
    expect(emails).toMatchObject({ [adaId]: 'ada@example.com', mgus: 'gus@example.com', mbob: '', mcat: '' });
    expect((await boot(ada)).members.find(m => m.id === 'mbob').email).toBe('bob@example.com');
    const seen = listen(t, 'mgus');
    await ada.sync([patch('members', 'mbob', { title: 'Engineer' })]);
    expect(seen.mgus.find(x => x.id === 'mbob').v.email).toBe('');
  });

  it('asking for access answers the same whether or not the project exists, and names nobody', async () => {
    const { ada, bob, adaId } = await people();
    await ada.sync([put('projects', project('p1', { private: true, members: [adaId], lead: adaId }))]);
    const real = await bob.post('/api/projects/p1/request-access');
    const fake = await bob.post('/api/projects/nope/request-access');
    expect([real.status, real.body]).toEqual([200, { ok: true }]);
    expect([fake.status, fake.body]).toEqual([200, { ok: true }]);
  });

  it('deletes in a private project only reach people who could see it', async () => {
    const { t, ada, adaId } = await people();
    await ada.sync([put('projects', project('p1', { private: true, members: [adaId] })), put('tasks', task('t1', 'p1')), put('tasks', task('t2', 'p1'))]);
    const seen = listen(t, adaId, 'mbob', 'mcat');
    await ada.sync([del('tasks', 't1')]);
    await ada.sync([del('projects', 'p1')]);
    expect(seen.mbob.filter(x => x.c === 'tasks')).toEqual([]);
    expect(seen.mcat.filter(x => x.c === 'tasks')).toEqual([]);
    expect(seen[adaId].filter(x => x.c === 'tasks').map(x => x.id)).toEqual(['t1', 't2']);
  });
});

describe('L6 no orphans', () => {
  it('deleting a project deletes its activity; deleting a task unlinks its files', async () => {
    const { t, ada } = await people();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const up = await upload(t, ada, { project: 'p1', task: 't1', name: 'a.txt' });
    expect(t.db.get("SELECT COUNT(*) n FROM activity WHERE project_id = 'p1'").n).toBeGreaterThan(0);
    await ada.sync([del('tasks', 't1')]);
    expect(JSON.parse(t.db.get('SELECT data FROM files WHERE id = ?', up.body.file.id).data).task).toBeNull();
    await ada.sync([del('projects', 'p1')]);
    expect(t.db.get("SELECT COUNT(*) n FROM activity WHERE project_id = 'p1'").n).toBe(0);
  });

  it('housekeeping prunes read notifications older than 180 days', () => {
    const t = setup();
    const ins = (id, read, at) =>
      t.db.run('INSERT INTO notifications (id, user_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, 'm1', JSON.stringify({ id, read }), at, at);
    const old = Date.now() - 181 * 86_400_000;
    ins('n1', true, old);
    ins('n2', false, old);
    ins('n3', true, Date.now());
    housekeep(t);
    expect(t.db.all('SELECT id FROM notifications ORDER BY id').map(r => r.id)).toEqual(['n2', 'n3']);
  });

  it('an upload whose project is deleted while it streams records nothing and keeps no bytes', async () => {
    const { t, ada } = await people();
    await ada.sync([put('projects', project('p1'))]);
    let push;
    const body = new ReadableStream({ start: c => (push = c) });
    const pending = upload(t, ada, { project: 'p1', name: 'big.txt' }, body);
    push.enqueue(new TextEncoder().encode('part one '));
    await new Promise(r => setTimeout(r, 50));
    await ada.sync([del('projects', 'p1')]);
    push.enqueue(new TextEncoder().encode('part two'));
    push.close();
    const r = await pending;
    expect(r.status).toBe(404);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(0);
    const left = fs.readdirSync(t.config.uploadDir, { recursive: true }).filter(f => fs.statSync(path.join(t.config.uploadDir, f)).isFile());
    expect(left).toEqual([]);
  });
});

describe('L7 file types and saved-view filters', () => {
  it('saved views only keep filters the view engine understands', async () => {
    const { ada } = await people();
    await ada.sync([put('projects', project('p1'))]);
    const view = filters => put('savedViews', { id: 'v' + JSON.stringify(filters).length, project: 'p1', name: 'Mine', type: 'list', filters });
    expect(res(await ada.sync([view([{ f: 'status', op: 'is', v: ['todo'] }])]))).toEqual([true]);
    expect(res(await ada.sync([view([{ f: 'nope', op: 'is', v: [] }])]))).toEqual([false]);
    expect(res(await ada.sync([view([{ f: 'status', op: 'maybe', v: [] }])]))).toEqual([false]);
    expect(res(await ada.sync([view([{ f: 'status', op: 'is', v: 'todo' }])]))).toEqual([false]);
  });
});

describe('L8 the Owner’s export', () => {
  it('holds only the work of projects the Owner can open, and is logged', async () => {
    const lines = [];
    const { ada, bob } = await people({}, { log: { info: l => lines.push(l), error() {} } });
    await bob.sync([put('projects', project('p1', { private: true, members: ['mbob'] })), put('tasks', task('t1', 'p1', { title: 'Secret plan' }))]);
    await ada.sync([put('projects', project('p2')), put('tasks', task('t2', 'p2'))]);
    const r = await ada.get('/api/me/export');
    const w = r.body.workspace;
    expect(w.tasks.map(x => x.id)).toEqual(['t2']);
    expect(JSON.stringify(w)).not.toContain('Secret plan');
    const stub = w.projects.find(p => p.id === 'p1');
    expect(stub).toMatchObject({ id: 'p1', private: true, members: ['mbob'] });
    expect(stub.desc).toBeUndefined();
    expect(lines.filter(l => l.startsWith('[export]'))).toEqual([expect.stringContaining('Ada Owner <ada@example.com>')]);
    const a = (await boot(ada)).activity.find(x => x.verb === 'exported the workspace data');
    expect(a).toMatchObject({ by: (await ada.get('/api/auth/session')).body.user.id, project: null });
  });
});

describe('L9 two-factor setup and resetting someone else’s', () => {
  it('setting up two-factor needs the current password', async () => {
    const t = setup();
    const { c } = await account(t);
    expect((await c.post('/api/auth/2fa/setup')).status).toBe(400);
    expect((await c.post('/api/auth/2fa/setup', { password: 'wrong-pass-1' })).body.field).toBe('password');
    expect((await c.post('/api/auth/2fa/setup', { password: PW })).body.secret).toMatch(/^[A-Z2-7]+$/);
  });

  it('the Owner can reset another person’s two-factor with their password; it emails them and ends their sessions', async () => {
    const { t, ada, bob, cat } = await people();
    const secret = (await bob.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    await bob.post('/api/auth/2fa/enable', { code: code(secret) });
    expect((await cat.post('/api/members/mbob/reset-2fa', { password: PW })).status).toBe(403);
    expect((await ada.post('/api/members/mbob/reset-2fa', { password: 'wrong-pass-1' })).status).toBe(400);
    expect((await ada.post('/api/members/mbob/reset-2fa', { password: PW })).status).toBe(200);
    expect(t.db.get("SELECT totp_enabled, totp_secret FROM users WHERE id = 'mbob'")).toEqual({ totp_enabled: 0, totp_secret: null });
    expect((await bob.get('/api/bootstrap')).status).toBe(401);
    expect(t.db.get("SELECT subject FROM outbox WHERE to_addr = 'bob@example.com' ORDER BY id DESC").subject).toMatch(/two-factor authentication was reset/);
    expect((await ada.post('/api/members/mbob/reset-2fa', { password: PW })).status).toBe(400); // already off
  });
});

describe('L11 PDFs render inline', () => {
  it('serves PDFs without the sandbox (Chromium refuses sandboxed PDFs) but still script-free; other files stay sandboxed', async () => {
    const { t, ada } = await people();
    await ada.sync([put('projects', project('p1'))]);
    const pdf = await upload(t, ada, { project: 'p1', name: 'a.pdf' }, '%PDF-1.4', 'application/pdf');
    const txt = await upload(t, ada, { project: 'p1', name: 'a.txt' }, 'hi', 'text/plain');
    const csp = async url => (await t.app.request(url, { headers: { cookie: ada.cookie } })).headers.get('content-security-policy');
    expect(await csp(pdf.body.file.url)).toBe("default-src 'none'; object-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    expect(await csp(pdf.body.file.url + '?download=1')).toMatch(/sandbox/);
    expect(await csp(txt.body.file.url)).toMatch(/sandbox/);
  });
});

describe('L13 assignment notification wording', () => {
  it('says "No priority", not "No priority priority"', async () => {
    const { ada, bob } = await people();
    await ada.sync([
      put('projects', project('p1')),
      put('tasks', task('t1', 'p1', { assignee: 'mbob' })),
      put('tasks', task('t2', 'p1', { assignee: 'mbob', priority: 'high', due: '2026-12-01' })),
    ]);
    const snippets = (await boot(bob)).notifs.map(x => x.snippet).sort();
    expect(snippets).toEqual(['Due 2026-12-01 · High priority', 'No priority']);
  });
});

describe('TOTP secrets at rest', () => {
  it('with SECRET_KEY, secrets are stored encrypted, plaintext ones are sealed on start, and codes still work', async () => {
    const KEY = 'k'.repeat(40);
    const t = setup({ SECRET_KEY: KEY });
    const { c } = await account(t);
    const secret = (await c.post('/api/auth/2fa/setup', { password: PW })).body.secret;
    const stored = t.db.get('SELECT totp_secret FROM users').totp_secret;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(secret);
    expect((await c.post('/api/auth/2fa/enable', { code: code(secret) })).status).toBe(200);
    const d = t.client();
    await d.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    expect((await d.post('/api/auth/2fa/verify', { code: code(secret, 1) })).status).toBe(200);

    // A secret written before the key was set is sealed the next time the app starts.
    t.db.run('UPDATE users SET totp_secret = ?', secret);
    createApp({ db: t.db, config: t.config, log: { info() {}, error() {} }, pushSend: async () => {} });
    expect(t.db.get('SELECT totp_secret FROM users').totp_secret).toMatch(/^enc:v1:/);
  });
});
