/* Regressions for the platform audit's high and medium findings (H1–M8). */
import { describe, expect, it, vi } from 'vitest';
import { PW, account, apiKey, keyClient, setup } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import { cleanRich, richTextProblem } from '../../server/lib/rich-text.js';

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

  it('reads markup the way the sanitiser does, so tricks to hide nesting don’t work', () => {
    const fill = unit => unit.repeat(Math.floor(99_000 / unit.length));
    const plain = fill('<p>hello <b>world</b></p>');
    cleanRich(plain); // warm up
    const t0 = performance.now();
    cleanRich(plain);
    const plainMs = performance.now() - t0;
    const tricks = {
      // End tags that match nothing are ignored by the parser, so they close nothing.
      unmatched: fill('<b></q>'),
      mixedCase: fill('<B></Q>'),
      inAttribute: fill('<b title="</b>">'),
      inComment: fill('<b><!--</b>-->'),
      cdata: fill('<b><![CDATA[</b>]]>'),
      selfClosing: fill('<b/>'),
      rawText: fill('<b><textarea></b></textarea>'),
      unclosedComment: '<b>'.repeat(10) + '<!--' + fill('</b><b>'),
      deepThenUnmatched: '<b>'.repeat(64) + fill('</q>'),
    };
    for (const [name, html] of Object.entries(tricks)) {
      const t1 = performance.now();
      if (!richTextProblem(html)) cleanRich(html);
      expect(performance.now() - t1, name).toBeLessThan(3 * plainMs + 50);
    }
    for (const name of ['unmatched', 'mixedCase', 'inAttribute', 'inComment', 'cdata', 'selfClosing', 'rawText'])
      expect(richTextProblem(tricks[name]), name).toBe('Its formatting is nested too deeply.');
    // Optional end tags close themselves, as in the parser: long flat lists and paragraphs are fine.
    expect(richTextProblem('<ul>' + '<li>item'.repeat(70) + '</ul>')).toBeNull();
    expect(richTextProblem('<p>x'.repeat(70))).toBeNull();
    expect(richTextProblem('<dl>' + '<dt>a<dd>b'.repeat(70) + '</dl>')).toBeNull();
  });

  it('measures nesting with the sanitiser’s own parser, and never re-parses fallback content', () => {
    const fill = unit => unit.repeat(Math.floor(99_000 / unit.length));
    const plain = fill('<p>hello <b>world</b></p>');
    cleanRich(plain);
    const t0 = performance.now();
    cleanRich(plain);
    const limit = 4 * (performance.now() - t0) + 40;
    // Raw text that the sanitiser used to re-parse (iframe fallback), and SVG-adjusted names that a
    // hand-made copy of the parser read differently.
    for (const html of [
      '<iframe>' + fill('<b></q>'),
      '<foreignobject><svg></foreignobject><script>' + fill('<b></q>'),
      '<clippath><svg></clippath><style>' + fill('<b></q>'),
      '<noscript>' + fill('<b></q>'),
    ]) {
      const t1 = performance.now();
      if (!richTextProblem(html)) cleanRich(html);
      expect(performance.now() - t1).toBeLessThan(limit);
    }
    expect(cleanRich('<p>a</p><iframe><b>hidden</b></iframe><p>b</p>')).toBe('<p>a</p><p>b</p>');
  });

  it('fuzz: random tag soup either is refused or sanitises in linear time', () => {
    const TOKENS = [
      '<html>',
      '<body>',
      '<svg>',
      '</svg>',
      '<math>',
      '</math>',
      '<foreignObject>',
      '<foreignobject>',
      '</foreignObject>',
      '</foreignobject>',
      '<clippath>',
      '<clipPath>',
      '</clippath>',
      '<iframe>',
      '</iframe>',
      '<script>',
      '</script>',
      '<style>',
      '</style>',
      '<textarea>',
      '</textarea>',
      '<title>',
      '</title>',
      '<noscript>',
      '</noscript>',
      '<template>',
      '</template>',
      '<!--',
      '-->',
      '<![CDATA[',
      ']]>',
      '<b>',
      '</b>',
      '</q>',
      '<p>',
      '</p>',
      '<li>',
      '<div>',
      '</div>',
      '<b/>',
      '<a href="x">',
      'text',
      '<xmp>',
      '<select>',
      '<option>',
      '<table>',
      '<td>',
      '<mi>',
      '<desc>',
      '<B>',
      '</Q>',
    ];
    let seed = 20261107;
    const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const SIZE = 100_000;
    const plain = '<p>hello <b>world</b></p>'.repeat(SIZE / 25);
    const run = html => {
      const t1 = performance.now();
      if (!richTextProblem(html)) cleanRich(html);
      return performance.now() - t1;
    };
    const pick = n => Array.from({ length: n }, () => TOKENS[rnd(TOKENS.length)]).join('');
    const timed = [];
    for (let i = 0; i < 300; i++) {
      // A short prefix (a context like <svg> or <iframe>) and a unit repeated to 100 KB.
      const unit = pick(1 + rnd(4));
      const html = (pick(rnd(5)) + unit.repeat(Math.ceil(SIZE / unit.length))).slice(0, SIZE);
      timed.push({ html, ms: run(html) });
    }
    // The slowest few, timed again against plain text (best of 3, interleaved, so other tests
    // running alongside don't decide the outcome). Linear work stays within a small multiple of
    // plain text; the superlinear cases this guards against took 5–40 times as long.
    for (const { html } of timed.sort((x, y) => y.ms - x.ms).slice(0, 5)) {
      let best = Infinity;
      let base = Infinity;
      for (let i = 0; i < 3; i++) {
        base = Math.min(base, run(plain));
        best = Math.min(best, run(html));
      }
      expect(best, html.slice(0, 80)).toBeLessThan(3.5 * base + 25);
    }
  });

  it('stops sanitising for a request once it has taken too long, whatever the checks say', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    // Every sanitising pass now "takes" 300 ms (the budget is 500 ms a request).
    let clock = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 300));
    try {
      const r = await ada.sync([1, 2, 3].map(i => put('tasks', task(`t${i}`, 'p1', { key: undefined, desc: '<p>x</p>' }))));
      expect(r.body.results.map(x => [x.ok, x.status ?? 200, !!x.retry])).toEqual([
        [true, 200, false],
        [false, 413, true],
        [false, 413, true],
      ]);
      // Alone in its request, a description that slow is refused for good.
      clock = 0;
      spy.mockImplementation(() => (clock += 600));
      const one = await ada.sync([put('tasks', task('t9', 'p1', { key: undefined, desc: '<p>y</p>' }))]);
      expect(one.body.results[0]).toMatchObject({
        ok: false,
        status: 413,
        error: 'desc: This description takes too long to process. Simplify its formatting.',
      });
      expect(one.body.results[0].retry).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(1);
  });

  it('copies an older, deeply nested description into the next repeat instead of refusing', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const deep = '<div>'.repeat(80) + 'old' + '</div>'.repeat(80);
    await ada.sync([put('tasks', task('t1', 'p1', { recur: 'Weekly', due: '2026-11-10' }))]);
    // Stored before nesting was limited.
    t.repo.put('tasks', { ...t.repo.get('tasks', 't1'), desc: deep }, 'p1');
    const api = keyClient(t.app, await apiKey(ada));
    const r = await api.post('/tasks/t1/complete');
    expect(r.status).toBe(200);
    const next = t.repo.all('tasks').find(x => x.id !== 't1');
    expect(next).toMatchObject({ desc: deep, status: 'todo' });
    // A new deep description is still refused.
    expect((await api.patch('/tasks/t1', { descriptionHtml: '<div>'.repeat(80) + 'new' })).status).toBe(400);
  });

  it('caps the rich text one request can have sanitised', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1'))]);
    const desc = '<p>' + 'a'.repeat(99_000) + '</p>';
    const ops = Array.from({ length: 12 }, (_, i) => put('tasks', task(`t${i}`, 'p1', { key: undefined, desc })));
    const r = await ada.sync(ops);
    expect(r.body.results.slice(0, 10).every(x => x.ok)).toBe(true);
    expect(r.body.results.slice(10)).toEqual([
      expect.objectContaining({ ok: false, status: 413, error: 'desc: This batch has too much formatted text. Send it in smaller batches.' }),
      expect.objectContaining({ ok: false, status: 413 }),
    ]);
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(10);
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

describe('requests without credentials are refused before their body is read', () => {
  const never = () => {
    const read = { n: 0 };
    // highWaterMark 0: pull runs only when someone reads.
    return { read, body: new ReadableStream({ pull: () => void read.n++ }, { highWaterMark: 0 }) };
  };
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
  it('a session route answers 401 without waiting for (or reading) a large body', async () => {
    const { t } = await workspace();
    const { read, body } = never();
    const res = await within(
      t.app.request('/api/sync', {
        method: 'POST',
        duplex: 'half',
        body,
        headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024), 'x-requested-with': 'sudo-sapient', cookie: 'ss_sid=bogus' },
      }),
      1000,
    );
    expect(res.status).toBe(401);
    expect(read.n).toBe(0);
  });
  it('the API answers 401 for a bad key without reading the body', async () => {
    const { t } = await workspace();
    const { read, body } = never();
    const res = await within(
      t.app.request('/api/v1/tasks', {
        method: 'POST',
        duplex: 'half',
        body,
        headers: { 'content-type': 'application/json', 'content-length': String(512 * 1024), authorization: 'Bearer ssk_not-a-key' },
      }),
      1000,
    );
    expect(res.status).toBe(401);
    expect(read.n).toBe(0);
  });
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

  it('a sign-in whose password check was running when the password changed gets no session', async () => {
    const { t } = await workspace();
    const uid = t.db.get("SELECT id FROM users WHERE email = 'ada@example.com'").id;
    const before = t.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', uid).n;
    const devices = t.db.get('SELECT COUNT(*) n FROM devices WHERE user_id = ?', uid).n;
    const evil = t.client();
    const pending = evil.post('/api/auth/login', { email: 'ada@example.com', password: PW });
    await tick(5);
    // What a password change does, landing while scrypt checks the old password.
    t.db.run("UPDATE users SET password_hash = 'scrypt$changed' WHERE id = ?", uid);
    expect((await pending).status).toBe(401);
    expect(evil.session).toBe('');
    expect(t.db.get('SELECT COUNT(*) n FROM sessions WHERE user_id = ?', uid).n).toBe(before);
    expect(t.db.get('SELECT COUNT(*) n FROM devices WHERE user_id = ?', uid).n).toBe(devices);
  });

  it('one reset link can’t be used by two requests racing each other', async () => {
    const { t, ada } = await workspace();
    await ada.post('/api/auth/forgot', { email: 'ada@example.com' });
    const token = t.lastLink('ada@example.com').split('#reset/')[1];
    const [a, b] = await Promise.all([
      t.client().post('/api/auth/reset', { token, password: 'first-new-pass-1' }),
      t.client().post('/api/auth/reset', { token, password: 'second-new-pass-2' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner = a.status === 200 ? 'first-new-pass-1' : 'second-new-pass-2';
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: winner })).status).toBe(200);
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

describe('M3 the task-key counter is the server’s', () => {
  const keyOf = (t, id) => t.repo.get('tasks', id)?.key;
  it('ignores seq from clients and keys that jump ahead', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1', 'WEB', { seq: 9_999_999 }))]);
    expect(t.repo.get('projects', 'p1').seq).toBeUndefined();
    await ada.sync([patch('projects', 'p1', { seq: 9_999_999 })]);
    expect(t.repo.get('projects', 'p1').seq).toBeUndefined();

    // An optimistic key far past the counter is replaced by the next number.
    await ada.sync([put('tasks', task('t1', 'p1', { key: 'WEB-9999999' }))]);
    expect(keyOf(t, 't1')).toBe('WEB-201');
    // The next one the client expects is kept.
    await ada.sync([put('tasks', task('t2', 'p1', { key: 'WEB-202' }))]);
    expect(keyOf(t, 't2')).toBe('WEB-202');
    // A key can't be edited in place.
    await ada.sync([patch('tasks', 't2', { key: 'WEB-9999999' })]);
    expect(keyOf(t, 't2')).toBe('WEB-202');
    expect(t.repo.get('projects', 'p1').seq).toBe(202);

    const r = await ada.sync([put('tasks', task('t3', 'p1', { key: undefined }))]);
    expect(r.body.results[0].ok).toBe(true);
    expect(keyOf(t, 't3')).toBe('WEB-203');
  });

  it('keeps creating tasks when the numbers already reached the end (older data)', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { key: 'WEB-201' }))]);
    const p = t.repo.get('projects', 'p1');
    t.repo.put('projects', { ...p, seq: 9_999_999 });
    const t1 = t.repo.get('tasks', 't1');
    t.repo.put('tasks', { ...t1, key: 'WEB-9999999' }, 'p1');
    const r = await ada.sync([put('tasks', task('t2', 'p1', { key: 'WEB-9999999' })), put('tasks', task('t3', 'p1', { key: 'WEB-1' }))]);
    expect(r.body.results.map(x => x.ok)).toEqual([true, true]);
    expect(keyOf(t, 't2')).toBe('WEB-201');
    expect(keyOf(t, 't3')).toBe('WEB-1');
  });
});

describe('M4 password guesses are counted before they are checked', () => {
  const env = { DISABLE_RATE_LIMIT: 'false', TRUST_PROXY: '1' };
  const from = i => ({ 'x-forwarded-for': `10.0.${i >> 8}.${i & 255}` });

  it('parallel sign-in guesses get only the 10 checks the lock allows', async () => {
    const { t } = await workspace([], env);
    const st = (
      await Promise.all(Array.from({ length: 40 }, (_, i) => t.client().post('/api/auth/login', { email: 'ada@example.com', password: `wrong-${i}` }, from(i))))
    ).map(r => r.status);
    expect(st.filter(s => s === 401)).toHaveLength(10);
    expect(st.filter(s => s === 429)).toHaveLength(30);
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW }, from(999))).status).toBe(429);
  });

  it('a successful sign-in gives its reserved attempt back', async () => {
    const { t } = await workspace([], env);
    for (let i = 0; i < 9; i++) await t.client().post('/api/auth/login', { email: 'ada@example.com', password: 'nope-nope-1' }, from(i));
    for (let i = 0; i < 3; i++) expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW }, from(100 + i))).status).toBe(200);
  });

  it('strangers failing to sign in can’t lock the person out of password-confirmed actions', async () => {
    const { t, ada } = await workspace([], env);
    for (let i = 0; i < 12; i++) await t.client().post('/api/auth/login', { email: 'ada@example.com', password: `wrong-${i}` }, from(i));
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW }, from(300))).status).toBe(429);
    expect((await ada.post('/api/keys', { name: 'k', scope: 'read', expiresInDays: null, password: PW }, from(301))).status).toBe(201);
    expect((await ada.post('/api/auth/password', { current: PW, password: 'brand-new-pass-7' }, from(302))).status).toBe(200);
  });

  it('a signed-in session guessing through password-confirmed endpoints is limited, and feeds the sign-in lock', async () => {
    const { t, ada } = await workspace([], env);
    const guesses = [
      ...Array.from({ length: 6 }, (_, i) => ada.post('/api/auth/password', { current: `wrong-${i}`, password: 'brand-new-pass-7' }, from(i))),
      ...Array.from({ length: 6 }, (_, i) => ada.post('/api/keys', { name: 'k', scope: 'read', expiresInDays: null, password: `wrong-${i}` }, from(50 + i))),
      ...Array.from({ length: 6 }, (_, i) => ada.post('/api/auth/email', { email: `x${i}@example.com`, password: `wrong-${i}` }, from(100 + i))),
    ];
    const st = (await Promise.all(guesses)).map(r => r.status);
    expect(st.filter(s => s === 400)).toHaveLength(10);
    expect(st.filter(s => s === 429)).toHaveLength(8);
    // Locked now, even with the right password and from a fresh address; sign-in from a new browser too.
    expect((await ada.post('/api/auth/2fa/setup', { password: PW }, from(200))).status).toBe(429);
    expect((await t.client().post('/api/auth/login', { email: 'ada@example.com', password: PW }, from(201))).status).toBe(429);
  });
});

describe('M6 uploads are bounded per person, per workspace and by free disk', () => {
  const upload = (c, name, bytes) => c.post(`/api/files?project=p1&name=${name}`, 'x'.repeat(bytes), { 'content-type': 'text/plain' });
  async function files(env) {
    const w = await workspace([['mbob', 'Bob', 'Member']], env);
    await w.ada.sync([put('projects', project('p1'))]);
    return w;
  }

  it('limits how many uploads one person can start an hour', async () => {
    const { ada, bob } = await files({ DISABLE_RATE_LIMIT: 'false', UPLOADS_PER_HOUR: '3' });
    for (let i = 0; i < 3; i++) expect((await upload(bob, `f${i}.txt`, 10)).status).toBe(201);
    const r = await upload(bob, 'f4.txt', 10);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBeTruthy();
    // Someone else's allowance is their own.
    expect((await upload(ada, 'a.txt', 10)).status).toBe(201);
  });

  it('refuses uploads past the workspace quota, before and while they stream', async () => {
    // 2 KB for the whole workspace.
    const { t, bob } = await files({ UPLOAD_QUOTA_MB: String(2048 / 1024 / 1024) });
    expect((await upload(bob, 'a.txt', 1500)).status).toBe(201);
    const over = await upload(bob, 'b.txt', 1000);
    expect(over.status).toBe(507);
    expect(over.body.error).toMatch(/no room/);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(1);
    // Without a Content-Length the stream itself is cut off at the quota.
    const res = await t.app.request('/api/files?project=p1&name=c.txt', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream({
        start(ctl) {
          ctl.enqueue(new TextEncoder().encode('y'.repeat(1000)));
          ctl.close();
        },
      }),
      headers: { cookie: bob.cookie, 'x-requested-with': 'sudo-sapient', 'content-type': 'text/plain' },
    });
    expect(res.status).toBe(507);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(1);
    // Only the first file's bytes are on disk.
    const stored = fs.readdirSync(t.config.uploadDir, { recursive: true }).filter(f => fs.statSync(path.join(t.config.uploadDir, String(f))).isFile());
    expect(stored).toHaveLength(1);
  });

  it('refuses uploads when the volume is nearly full', async () => {
    const { t, bob } = await files({ MIN_FREE_DISK_MB: String(1024 * 1024 * 1024) });
    const r = await upload(bob, 'a.txt', 10);
    expect(r.status).toBe(507);
    expect(t.db.get('SELECT COUNT(*) n FROM files').n).toBe(0);
  });
});

describe('M2 stale list and map edits only apply their own changes', () => {
  const merged = (c, id, v, base) => ({ c, id, k: 'patch', v, base });

  it('someone removed from a private project stays removed after a stale edit adds someone else', async () => {
    const { t, ada, bob, carol } = await workspace([
      ['mbob', 'Bob', 'Member'],
      ['mcarol', 'Carol', 'Member'],
      ['mdan', 'Dan', 'Member'],
    ]);
    const adaId = t.repo.all('members').find(m => m.role === 'Owner').id;
    const list = [adaId, 'mbob', 'mcarol'];
    const perms = { [adaId]: 'Full access', mbob: 'Full access', mcarol: 'Can edit' };
    await ada.sync([put('projects', project('p1', 'SEC', { private: true, members: list, perms }))]);
    const seen = t.repo.get('projects', 'p1');

    // The Owner takes Carol off the project.
    const without = { ...perms };
    delete without.mcarol;
    await ada.sync([merged('projects', 'p1', { members: [adaId, 'mbob'], perms: without }, { members: seen.members, perms: seen.perms })]);
    // Bob, still holding the old list, adds Dan.
    const r = await bob.sync([merged('projects', 'p1', { members: [...list, 'mdan'], perms: { ...perms, mdan: 'Can view' } }, { members: list, perms })]);
    expect(r.body.results[0].ok).toBe(true);
    const p = t.repo.get('projects', 'p1');
    expect(p.members).toEqual([adaId, 'mbob', 'mdan']);
    expect(p.perms).toEqual({ [adaId]: 'Full access', mbob: 'Full access', mdan: 'Can view' });
    expect((await carol.get('/api/bootstrap')).body.data.tasks).toEqual([]);
    expect((await carol.get('/api/bootstrap')).body.data.projects.find(x => x.id === 'p1')).not.toHaveProperty('desc');
  });

  it('concurrent subtask toggles and label edits both survive', async () => {
    const { t, ada, bob } = await workspace([['mbob', 'Bob', 'Member']]);
    const subs = [
      { id: 's1', title: 'One', done: false },
      { id: 's2', title: 'Two', done: false },
    ];
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { subtasks: subs, labels: ['a', 'b'] }))]);
    await ada.sync([
      merged('tasks', 't1', { subtasks: [{ ...subs[0], done: true }, subs[1]], labels: ['a', 'b', 'c'] }, { subtasks: subs, labels: ['a', 'b'] }),
    ]);
    await bob.sync([merged('tasks', 't1', { subtasks: [subs[0], { ...subs[1], done: true }], labels: ['b'] }, { subtasks: subs, labels: ['a', 'b'] })]);
    const x = t.repo.get('tasks', 't1');
    expect(x.subtasks.map(s => [s.id, s.done])).toEqual([
      ['s1', true],
      ['s2', true],
    ]);
    expect(x.labels).toEqual(['b', 'c']);

    // A subtask someone deleted isn't brought back by a stale toggle of it; a new one is added.
    await ada.sync([merged('tasks', 't1', { subtasks: [x.subtasks[1]] }, { subtasks: x.subtasks })]);
    await bob.sync([
      merged(
        'tasks',
        't1',
        { subtasks: [{ ...x.subtasks[0], done: false }, x.subtasks[1], { id: 's3', title: 'Three', done: false }] },
        { subtasks: x.subtasks },
      ),
    ]);
    expect(t.repo.get('tasks', 't1').subtasks.map(s => s.id)).toEqual(['s2', 's3']);
  });

  it('a patch without a base still replaces the whole value (the REST API and older clients)', async () => {
    const { t, ada } = await workspace();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { labels: ['a'] }))]);
    await ada.sync([patch('tasks', 't1', { labels: ['z'] })]);
    expect(t.repo.get('tasks', 't1').labels).toEqual(['z']);
  });
});

describe('M5 undoing a delete restores the record as it was', () => {
  const comment = (id, by, extra = {}) => ({ id, task: 't1', by, at: 1, text: 'Looks good @Ada', re: {}, ...extra });
  async function thread() {
    const w = await workspace([
      ['mbob', 'Bob', 'Member'],
      ['mcarol', 'Carol', 'Member'],
    ]);
    const adaId = w.t.repo.all('members').find(m => m.role === 'Owner').id;
    await w.ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { assignee: 'mcarol' }))]);
    await w.bob.sync([put('comments', comment('c1', 'mbob'))]);
    await w.ada.sync([patch('comments', 'c1', { re: { '👍': [adaId] } })]);
    return { ...w, adaId, original: w.t.repo.get('comments', 'c1') };
  }
  const notifs = t => t.db.get('SELECT COUNT(*) n FROM notifications').n;

  it('keeps the author, time and reactions, and notifies nobody again', async () => {
    const { t, ada, original } = await thread();
    const before = notifs(t);
    await ada.sync([{ c: 'comments', id: 'c1', k: 'del' }]);
    expect(t.repo.get('comments', 'c1')).toBeNull();
    // The client re-sends its copy; the server uses its own, even where the client's differs.
    const r = await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: { ...original, by: 'mcarol', at: 5, re: {} }, restore: true }]);
    expect(r.body.results[0].ok).toBe(true);
    expect(t.repo.get('comments', 'c1')).toEqual(original);
    expect(notifs(t)).toBe(before);
    // The kept copy is used once.
    expect(t.db.get("SELECT COUNT(*) n FROM recent_deletes WHERE id = 'c1'").n).toBe(0);
  });

  it('can’t be used by someone else, or to forge an author', async () => {
    const { t, ada, carol, original } = await thread();
    await ada.sync([{ c: 'comments', id: 'c1', k: 'del' }]);
    await carol.sync([{ c: 'comments', id: 'c1', k: 'put', v: { ...original, by: 'mbob', at: 1 }, restore: true }]);
    expect(t.repo.get('comments', 'c1')).toMatchObject({ by: 'mcarol', re: {} });
    expect(t.repo.get('comments', 'c1').at).toBeGreaterThan(1);
  });

  it('only shortly after the delete', async () => {
    const { t, ada, adaId, original } = await thread();
    await ada.sync([{ c: 'comments', id: 'c1', k: 'del' }]);
    t.db.run('UPDATE recent_deletes SET deleted_at = deleted_at - ?', 11 * 60_000);
    await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: original, restore: true }]);
    expect(t.repo.get('comments', 'c1')).toMatchObject({ by: adaId, re: {} });
  });

  it('a deleted task comes back with its comments, without re-notifying its assignee', async () => {
    const { t, ada, original } = await thread();
    const task1 = t.repo.get('tasks', 't1');
    const before = notifs(t);
    await ada.sync([{ c: 'tasks', id: 't1', k: 'del' }]);
    expect(t.repo.get('comments', 'c1')).toBeNull();
    const r = await ada.sync([
      { c: 'tasks', id: 't1', k: 'put', v: task1, restore: true },
      { c: 'comments', id: 'c1', k: 'put', v: original, restore: true },
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([true, true]);
    expect(t.repo.get('tasks', 't1')).toMatchObject({ key: task1.key, assignee: 'mcarol', created: task1.created });
    expect(t.repo.get('comments', 'c1')).toEqual(original);
    expect(notifs(t)).toBe(before);
  });
});
