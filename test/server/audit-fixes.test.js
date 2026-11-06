/* Regressions for the platform audit's high and medium findings (H1–M8). */
import { describe, expect, it } from 'vitest';
import { PW, account, apiKey, keyClient, setup } from './helpers.js';
import { cleanRich } from '../../server/lib/rich-text.js';

const project = (id, key = 'WEB', extra = {}) => ({
  id,
  key,
  name: 'Project ' + key,
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
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });

/* Ada (Owner) plus invited teammates, each signed in: { t, ada, [name]: client }. */
async function workspace(people = [], env) {
  const t = setup(env);
  const ada = await account(t);
  const out = { t, ada: ada.c };
  for (const [id, name, role] of people) {
    const email = `${name.toLowerCase()}@example.com`;
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    out[name.toLowerCase()] = (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  }
  return out;
}

const nested = n => '<div>'.repeat(n) + 'x' + '</div>'.repeat(n);
const timed = async f => {
  const t0 = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t0 };
};

describe('H1 rich text is bounded before it is sanitised', () => {
  it('refuses an oversized description quickly, on create and on update', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    // 2 MB of nested tags used to block the server for tens of seconds.
    const huge = nested(170_000);
    const create = await timed(() => ada.sync([put('tasks', task('t1', 'p1', { desc: huge }))]));
    expect(create.r.body.results[0]).toMatchObject({ ok: false, status: 413 });
    expect(create.ms).toBeLessThan(1000);
    expect(t.repo.get('tasks', 't1')).toBeNull();

    // Just over the character limit, but under the record size: refused by the description check.
    const long = 'a'.repeat(100_001);
    const r = await ada.sync([put('tasks', task('t2', 'p1', { desc: long }))]);
    expect(r.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Keep it under 100,000 characters.' });

    await ada.sync([put('tasks', task('t3', 'p1'))]);
    const deep = await timed(() => ada.sync([patch('tasks', 't3', { desc: nested(9_000) })]));
    expect(deep.r.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Its formatting is nested too deeply.' });
    expect(deep.ms).toBeLessThan(1000);
    expect(t.repo.get('tasks', 't3').desc).toBe('');

    const notText = await ada.sync([patch('tasks', 't3', { desc: { html: '<p>x</p>' } })]);
    expect(notText.body.results[0]).toMatchObject({ ok: false, status: 400, error: 'desc: Expected text.' });
  });

  it('keeps ordinary formatting and lists nested a few levels', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const desc = '<p>Hi <b>there</b></p><ul><li>one<ul><li>two<ul><li>three</li></ul></li></ul></li></ul>';
    const r = await ada.sync([put('tasks', task('t1', 'p1', { desc }))]);
    expect(r.body.results[0].ok).toBe(true);
    expect(t.repo.get('tasks', 't1').desc).toBe(desc);
  });

  it('applies the same bound to descriptionHtml through the API', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const api = keyClient(t.app, await apiKey(ada));
    const { r, ms } = await timed(() => api.post('/tasks', { project: 'WEB', title: 'Deep', descriptionHtml: nested(9_000) }));
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid_request', field: 'descriptionHtml' });
    expect(ms).toBeLessThan(1000);
  });

  it('cleanRich itself refuses what it cannot sanitise cheaply', () => {
    expect(() => cleanRich(nested(1_000))).toThrow(RangeError);
    expect(() => cleanRich('x'.repeat(100_001))).toThrow(RangeError);
    expect(cleanRich('<p>a<script>x</script></p>')).toBe('<p>a</p>');
  });
});

/* A request whose body is held back until `send()`, like a client that opened the request before
   its access was taken away and finishes it afterwards. */
function held(t, url, { headers = {}, body, raw } = {}) {
  const payload = raw ?? new TextEncoder().encode(JSON.stringify(body));
  let ctrl;
  const res = t.app.request(url, {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream({ start: c => void (ctrl = c) }),
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length), 'x-requested-with': 'sudo-sapient', ...headers },
  });
  return {
    async send() {
      ctrl.enqueue(payload);
      ctrl.close();
      const r = await res;
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: r.status, body: json };
    },
  };
}
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
/* The auth object a request resolved when it started (session, user and member rows). */
const authOf = (t, uid) => ({
  session: t.db.get('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC', uid),
  user: t.db.get('SELECT * FROM users WHERE id = ?', uid),
  member: t.repo.get('members', uid),
});

describe('H2 access is checked again when the write happens', () => {
  it('a key requested with a stolen session is refused once the password changes, even if the body arrives later', async () => {
    const { t, ada } = await workspace();
    const evil = t.client();
    await evil.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const req = held(t, '/api/keys', { headers: { cookie: evil.cookie }, body: { name: 'persist', scope: 'write', expiresInDays: null, password: PW } });
    await tick();
    expect((await ada.post('/api/auth/password', { current: PW, password: 'brand-new-pass-7' })).status).toBe(200);
    const r = await req.send();
    expect(r.status).toBe(401);
    expect(r.body.token).toBeUndefined();
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys').n).toBe(0);
  });

  it('a key whose password check was still running when the password changed is not made', async () => {
    const { t } = await workspace();
    const evil = t.client();
    await evil.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const pending = evil.post('/api/keys', { name: 'persist', scope: 'write', expiresInDays: null, password: PW });
    await tick(5);
    // What a password change does to the account, landing while scrypt checks the old password.
    t.db.run("UPDATE users SET password_hash = 'scrypt$changed' WHERE email = 'ada@example.com'");
    t.db.run('DELETE FROM sessions');
    expect((await pending).status).toBe(401);
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys').n).toBe(0);
  });

  it('a password change sent with a stolen session can’t land after the owner changed it', async () => {
    const { t, ada } = await workspace();
    const evil = t.client();
    await evil.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const req = held(t, '/api/auth/password', { headers: { cookie: evil.cookie }, body: { current: PW, password: 'attacker-pass-1' } });
    await tick();
    expect((await ada.post('/api/auth/password', { current: PW, password: 'brand-new-pass-7' })).status).toBe(200);
    expect((await req.send()).status).toBe(401);
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: 'brand-new-pass-7' })).status).toBe(200);
  });

  it('a bot key requested before a password reset is refused afterwards', async () => {
    const { t, ada } = await workspace();
    const b = await ada.post('/api/bots', { name: 'Release Bot', role: 'Member', projects: [] });
    const evil = t.client();
    await evil.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    const req = held(t, `/api/bots/${b.body.id}/keys`, {
      headers: { cookie: evil.cookie },
      body: { name: 'k', scope: 'write', expiresInDays: null, password: PW },
    });
    await tick();
    await ada.post('/api/auth/forgot', { email: 'ada@example.com' });
    const tok = t.lastLink('ada@example.com').split('#reset/')[1];
    expect((await t.client().post('/api/auth/reset', { token: tok, password: 'brand-new-pass-7' })).status).toBe(200);
    expect((await req.send()).status).toBe(401);
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys').n).toBe(0);
  });

  it('a removed admin’s held sync batch applies nothing', async () => {
    const { t, ada, cat } = await workspace([
      ['mcat', 'Cat', 'Admin'],
      ['mbob', 'Bob', 'Member'],
    ]);
    const req = held(t, '/api/sync', {
      headers: { cookie: cat.cookie },
      body: {
        ops: [
          { c: 'members', id: 'mbob', k: 'del' },
          { c: 'ws', k: 'patch', v: { name: 'pwned' } },
        ],
      },
    });
    await tick();
    expect((await ada.sync([{ c: 'members', id: 'mcat', k: 'del' }])).body.results[0].ok).toBe(true);
    const r = await req.send();
    expect(r.status).toBe(401);
    expect(t.repo.get('members', 'mbob')).toBeTruthy();
    expect(t.repo.workspace().name).not.toBe('pwned');
  });

  it('a batch is checked against the writer’s current role, not the one they had when it started', async () => {
    const { t, ada } = await workspace([['mcat', 'Cat', 'Admin']]);
    const stale = authOf(t, 'mcat');
    await ada.sync([patch('members', 'mcat', { role: 'Member' })]);
    const r = t.engine.apply(stale, [{ c: 'ws', k: 'patch', v: { name: 'pwned' } }], null);
    expect(r.results[0]).toMatchObject({ ok: false, error: 'Only admins can change workspace settings.' });
    // And once the session is gone, nothing applies at all.
    t.db.run("DELETE FROM sessions WHERE user_id = 'mcat'");
    expect(t.engine.apply(stale, [{ c: 'ws', k: 'patch', v: { name: 'pwned' } }], null)).toMatchObject({ gone: true, results: [] });
    expect(t.repo.workspace().name).not.toBe('pwned');
  });

  it('a revoked key’s held API write is refused', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const key = await apiKey(ada);
    const req = held(t, '/api/v1/tasks', { headers: { authorization: `Bearer ${key}` }, body: { project: 'WEB', title: 'made after revoke' } });
    await tick();
    const [k] = (await ada.get('/api/keys')).body;
    await ada.del(`/api/keys/${k.id}`);
    expect((await req.send()).status).toBe(401);
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(0);
    // The engine refuses a stale key as well, whatever got past the middleware.
    const stale = {
      key: { id: k.id, token_hash: 'x' },
      user: t.db.get("SELECT * FROM users WHERE email = 'ada@example.com'"),
      member: t.repo.all('members')[0],
    };
    expect(t.engine.apply(stale, [], null, { atomic: true })).toMatchObject({ gone: true, failed: { status: 401 } });
  });

  it('an upload finished after its uploader lost access records nothing', async () => {
    const { t, ada, bob } = await workspace([['mbob', 'Bob', 'Member']]);
    await ada.sync([put('projects', project('p1'))]);
    const up = held(t, '/api/files?project=p1&name=a.txt', {
      headers: { cookie: bob.cookie, 'content-type': 'text/plain' },
      raw: new TextEncoder().encode('hello'),
    });
    await tick();
    // Bob is listed with "Can view" on the project now.
    await ada.sync([patch('projects', 'p1', { members: [t.repo.all('members')[0].id, 'mbob'], perms: { mbob: 'Can view' } })]);
    expect((await up.send()).status).toBe(403);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(0);

    await ada.sync([patch('projects', 'p1', { perms: {} })]);
    const up2 = held(t, '/api/files?project=p1&name=b.txt', {
      headers: { cookie: bob.cookie, 'content-type': 'text/plain' },
      raw: new TextEncoder().encode('hello'),
    });
    await tick();
    await ada.sync([{ c: 'members', id: 'mbob', k: 'del' }]);
    expect((await up2.send()).status).toBe(401);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(0);
  });

  it('two owners demoting each other at once leave one owner', async () => {
    const { t, ada, bob } = await workspace([['mbob', 'Bob', 'Admin']]);
    const adaId = t.repo.all('members').find(m => m.role === 'Owner').id;
    await ada.sync([patch('members', 'mbob', { role: 'Owner' })]);
    const staleBob = authOf(t, 'mbob');
    const a = held(t, '/api/sync', { headers: { cookie: ada.cookie }, body: { ops: [patch('members', 'mbob', { role: 'Admin' })] } });
    const b = held(t, '/api/sync', { headers: { cookie: bob.cookie }, body: { ops: [patch('members', adaId, { role: 'Admin' })] } });
    await tick();
    expect((await a.send()).body.results[0].ok).toBe(true);
    expect((await b.send()).body.results[0].ok).toBe(false);
    // Even a batch that started while Bob was still an Owner is checked against now.
    expect(t.engine.apply(staleBob, [patch('members', adaId, { role: 'Admin' })], null).results[0].ok).toBe(false);
    expect(t.repo.all('members').filter(m => m.role === 'Owner')).toHaveLength(1);
  });
});
