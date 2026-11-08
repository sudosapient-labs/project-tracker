/* The public API (/api/v1): personal keys, scopes, permissions, live updates, idempotency, rate
   limits and the OpenAPI contract. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PW, account, apiKey, keyClient, setup } from './helpers.js';
import { sha256 } from '../../server/lib/crypto.js';
import * as S from '../../server/api/schemas.js';

const project = (id, key, extra = {}) => ({
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
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });
const boot = async c => (await c.get('/api/bootstrap')).body.data;

/* Ada (Owner), Bob (Member) and Gus (Guest), with an open project WEB, a private project SEC (Ada
   only) and a project OPS that lists Gus with "Can comment". */
async function workspace(env) {
  const t = setup(env);
  const ada = await account(t);
  const join = async (id, name, email, role) => {
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    return (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  };
  const bob = await join('mbob', 'Bob Lee', 'bob@example.com', 'Member');
  const gus = await join('mgus', 'Gus Guest', 'gus@example.com', 'Guest');
  const r = await ada.c.sync([
    put('projects', project('pweb', 'WEB')),
    put('projects', project('psec', 'SEC', { private: true })),
    put('projects', project('pops', 'OPS', { members: ['mgus'], perms: { mgus: 'Can comment' } })),
  ]);
  expect(r.body.results.every(x => x.ok)).toBe(true);
  return { t, ada: ada.c, adaId: ada.user.id, bob, gus };
}
const as = async (t, c, opts = {}) => keyClient(t.app, await apiKey(c, opts), opts);

describe('personal API keys', () => {
  it('are shown once, stored hashed, listed without secrets, and stop working when revoked', async () => {
    const { t, ada } = await workspace();
    const r = await ada.post('/api/keys', { name: 'Laptop CLI', scope: 'write', expiresInDays: 90, password: PW });
    expect(r.status).toBe(201);
    const { token, key } = r.body;
    expect(token).toMatch(/^ssk_[A-Za-z0-9_-]{43}$/);
    expect(key).toMatchObject({ name: 'Laptop CLI', scope: 'write', prefix: token.slice(0, 12), lastUsedAt: null });
    expect(key.expiresAt - Date.now()).toBeGreaterThan(89 * 86_400_000);

    // Only the hash is stored; the list never carries the token or the hash.
    const row = t.db.get('SELECT * FROM api_keys WHERE id = ?', key.id);
    expect(row.token_hash).toBe(sha256(token));
    expect(JSON.stringify(t.db.all('SELECT * FROM api_keys'))).not.toContain(token);
    const list = await ada.get('/api/keys');
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(token.slice(12));
    expect(list.body[0]).not.toHaveProperty('token_hash');

    const api = keyClient(t.app, token);
    const me = await api.get('/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ name: 'Ada Owner', email: 'ada@example.com', role: 'Owner', key: { name: 'Laptop CLI', scope: 'write' } });
    expect((await ada.get('/api/keys')).body[0].lastUsedAt).toBeGreaterThan(0);

    const rev = await ada.del(`/api/keys/${key.id}`);
    expect(rev.body).toEqual([]);
    expect(await api.get('/me')).toMatchObject({ status: 401, body: { code: 'invalid_key' } });
  });

  it('refuse missing, unknown and expired keys, and never accept the session cookie', async () => {
    const { t, ada } = await workspace();
    expect((await keyClient(t.app, null).get('/me')).body).toMatchObject({ code: 'unauthenticated' });
    expect((await keyClient(t.app, 'ssk_' + 'x'.repeat(43)).get('/me')).body).toMatchObject({ code: 'invalid_key' });
    // A signed-in browser's cookie is not a credential here.
    const viaCookie = await t.app.request('/api/v1/me', { headers: { cookie: ada.cookie, 'x-requested-with': 'sudo-sapient' } });
    expect(viaCookie.status).toBe(401);

    const token = await apiKey(ada, { expiresInDays: 30 });
    t.db.run('UPDATE api_keys SET expires_at = ?', Date.now() - 1);
    expect(await keyClient(t.app, token).get('/me')).toMatchObject({ status: 401, body: { code: 'expired_key' } });
  });

  it('are managed only with a signed-in session and its CSRF header', async () => {
    const { t, ada } = await workspace();
    const token = await apiKey(ada);
    // A key can't mint more keys.
    const res = await t.app.request('/api/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-requested-with': 'sudo-sapient', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scope: 'write', expiresInDays: null, password: PW }),
    });
    expect(res.status).toBe(401);
    const noCsrf = await t.app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', scope: 'write', expiresInDays: null, password: PW }),
    });
    expect(noCsrf.status).toBe(403);
    expect((await ada.post('/api/keys', { name: '', scope: 'write', expiresInDays: null, password: PW })).body.field).toBe('name');
    // A signed-in browser alone can't mint a key: it takes the current password.
    expect((await ada.post('/api/keys', { name: 'x', scope: 'write', expiresInDays: null })).body.field).toBe('password');
    expect((await ada.post('/api/keys', { name: 'x', scope: 'write', expiresInDays: null, password: 'wrong-password-1' })).body).toMatchObject({
      field: 'password',
    });
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys').n).toBe(1);
    expect((await ada.post('/api/keys', { name: 'x', scope: 'admin', expiresInDays: null, password: PW })).status).toBe(400);
  });

  it('read-only keys can read but not write', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada, { scope: 'read' });
    expect((await api.get('/tasks')).status).toBe(200);
    const w = await api.post('/tasks', { project: 'WEB', title: 'Nope' });
    expect(w).toMatchObject({ status: 403, body: { code: 'insufficient_scope' } });
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(0);
  });

  it('are revoked when the password is changed or the account is recovered with a reset', async () => {
    const { t, ada } = await workspace();
    // Making a key needs the password, so anyone who knew the old one could have made one.
    const before = keyClient(t.app, await apiKey(ada));
    const changed = await ada.post('/api/auth/password', { current: PW, password: 'another-pass-2' });
    expect(changed.status).toBe(200);
    expect(changed.body.apiKeys).toEqual([]);
    expect((await before.get('/me')).body.code).toBe('invalid_key');
    const after = await ada.post('/api/keys', { name: 'New laptop', scope: 'write', expiresInDays: null, password: 'another-pass-2' });
    expect((await keyClient(t.app, after.body.token).get('/me')).status).toBe(200);
    await t.client().post('/api/auth/forgot', { email: 'ada@example.com' });
    const token = t.lastLink('ada@example.com').split('#reset/')[1];
    expect((await t.client().post('/api/auth/reset', { token, password: 'recovered-pass-3' })).status).toBe(200);
    expect((await keyClient(t.app, after.body.token).get('/me')).body.code).toBe('invalid_key');
  });

  it('go with their person: removing someone deletes their keys, and keys follow role changes', async () => {
    const { t, ada, bob } = await workspace();
    const token = await apiKey(bob);
    const api = keyClient(t.app, token);
    expect((await api.get('/projects/SEC')).status).toBe(404);
    // Made an Admin: still can't open the private project's work (admin recovery is settings only).
    await ada.sync([patch('members', 'mbob', { role: 'Admin' })]);
    expect((await api.get('/me')).body.role).toBe('Admin');
    await ada.sync([{ c: 'members', id: 'mbob', k: 'del' }]);
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys').n).toBe(0);
    expect((await api.get('/me')).status).toBe(401);
  });
});

describe('permissions through the API', () => {
  it('Guests only see projects they are listed on, and can only comment where that is their level', async () => {
    const { t, ada, gus } = await workspace();
    const owner = await as(t, ada);
    const web = (await owner.post('/tasks', { project: 'WEB', title: 'Workspace task' })).body;
    const ops = (await owner.post('/tasks', { project: 'OPS', title: 'Ops task' })).body;
    const sec = (await owner.post('/tasks', { project: 'SEC', title: 'Secret task' })).body;

    const g = await as(t, gus);
    expect((await g.get('/projects')).body.data.map(p => p.key)).toEqual(['OPS']);
    expect((await g.get('/tasks')).body.data.map(t => t.key)).toEqual([ops.key]);
    for (const key of [web.key, sec.key]) {
      expect((await g.get(`/tasks/${key}`)).body.code).toBe('not_found');
      expect((await g.post(`/tasks/${key}/comments`, { text: 'hi' })).status).toBe(404);
    }
    const found = (await g.get('/search?q=task')).body;
    expect(found.tasks.map(t => t.key)).toEqual([ops.key]);
    expect(found.projects).toEqual([]);
    // Guests see only the emails of people they share a project with.
    const people = (await g.get('/members')).body.data;
    expect(people.find(m => m.id === 'mbob').email).toBe('');

    // "Can comment": comments work, edits are refused by the same rule as in the app.
    expect((await g.post(`/tasks/${ops.key}/comments`, { text: 'Looks good' })).status).toBe(201);
    expect(await g.post(`/tasks/${ops.key}/complete`)).toMatchObject({
      status: 403,
      body: { code: 'forbidden', error: 'You can only comment in this project.' },
    });
    expect((await g.post('/tasks', { project: 'OPS', title: 'Mine' })).status).toBe(403);
    expect((await g.post('/tasks', { project: 'WEB', title: 'Mine' })).body).toMatchObject({ code: 'not_found', field: 'project' });
    expect((await owner.get(`/tasks/${ops.key}`)).body.status).toBe('todo');
  });

  it('private projects are invisible to people not on them, and work can’t be assigned to them', async () => {
    const { t, ada, bob } = await workspace();
    const owner = await as(t, ada);
    const sec = (await owner.post('/tasks', { project: 'SEC', title: 'Payroll' })).body;
    const b = await as(t, bob);
    // OPS is open to the workspace (it only lists Gus), so Bob sees it too.
    expect((await b.get('/projects')).body.data.map(p => p.key)).toEqual(['WEB', 'OPS']);
    expect((await b.get(`/tasks/${sec.id}`)).status).toBe(404);
    expect((await b.get('/tasks?project=SEC')).status).toBe(404);
    expect((await b.get('/search?q=payroll')).body.tasks).toEqual([]);
    expect((await b.patch(`/tasks/${sec.key}`, { title: 'Hacked' })).status).toBe(404);

    const a = await owner.patch(`/tasks/${sec.key}`, { assignee: 'bob@example.com' });
    expect(a).toMatchObject({ status: 400, body: { error: 'Add Bob Lee to the project first.' } });
    // Moving work into a project you can't see is refused too.
    const mine = (await b.post('/tasks', { project: 'WEB', title: 'Mine' })).body;
    expect((await b.patch(`/tasks/${mine.key}`, { project: 'SEC' })).status).toBe(404);
  });

  it('Can view is enforced on writes', async () => {
    const { t, ada, bob } = await workspace();
    await ada.sync([patch('projects', 'pweb', { members: ['mbob'], perms: { mbob: 'Can view' } })]);
    const owner = await as(t, ada);
    const task = (await owner.post('/tasks', { project: 'WEB', title: 'Read me' })).body;
    const b = await as(t, bob);
    expect((await b.get(`/tasks/${task.key}`)).status).toBe(200);
    expect((await b.post(`/tasks/${task.key}/comments`, { text: 'x' })).body.error).toBe('You can only view this project.');
    expect((await b.post(`/tasks/${task.key}/archive`)).status).toBe(403);
  });
});

describe('writes behave like the app’s', () => {
  it('create → comment → complete reach open apps live, notify, and log activity “via” the client', async () => {
    const { t, ada, adaId, bob } = await workspace();
    // Bob has the app open; Ada works from the CLI.
    const seen = [];
    t.engine.connect(
      { uid: 'mbob', sessionId: 's-bob', clientId: 'tab-bob' },
      (e, d) => e === 'changes' && seen.push(...d),
      () => {},
    );
    const api = await as(t, ada, { client: 'CLI' });

    const c = await api.post('/tasks', {
      project: 'web',
      title: 'Fix login bug',
      description: 'Steps:\n\n1. Sign in',
      assignee: 'Bob',
      due: '2026-11-20',
      priority: 'high',
    });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({
      key: 'WEB-201',
      status: 'todo',
      priority: 'high',
      assignee: 'mbob',
      due: '2026-11-20',
      description: 'Steps:\n\n1. Sign in',
    });
    expect(c.body.descriptionHtml).toBe('<p>Steps:</p><p>1. Sign in</p>');
    expect(seen.find(x => x.c === 'tasks')?.v).toMatchObject({ key: 'WEB-201', title: 'Fix login bug' });
    expect(seen.find(x => x.c === 'activity')?.v).toMatchObject({ verb: 'created', by: adaId, via: 'CLI' });

    seen.length = 0;
    const cm = await api.post(`/tasks/${c.body.key}/comments`, { text: 'On it @Bob Lee' });
    expect(cm.status).toBe(201);
    expect(seen.map(x => x.c).sort()).toEqual(['activity', 'comments', 'notifs']);

    seen.length = 0;
    const done = await api.post(`/tasks/${c.body.key}/complete`);
    expect(done.body).toMatchObject({ status: 'done' });
    expect(done.body.completedAt).toBeGreaterThan(0);
    expect(seen.find(x => x.c === 'tasks').v).toMatchObject({ status: 'done', prevStatus: 'todo' });
    // Completing again is a no-op, not a second activity line.
    await api.post(`/tasks/${c.body.key}/complete`);

    // Bob's next bootstrap matches what the app itself would have saved.
    const d = await boot(bob);
    const task = d.tasks.find(x => x.key === 'WEB-201');
    expect(task).toMatchObject({ status: 'done', assignee: 'mbob', priority: 'high', prevStatus: 'todo' });
    expect(d.comments.filter(x => x.task === task.id).map(x => x.text)).toEqual(['On it @Bob Lee']);
    const log = d.activity.filter(a => a.task === task.id).map(a => [a.verb, a.via]);
    expect(log).toEqual([
      ['completed', 'CLI'],
      ['commented on', 'CLI'],
      ['created', 'CLI'],
    ]);
    expect(d.notifs.map(n => n.type).sort()).toEqual(['assign', 'mention', 'update']);

    const act = await api.get(`/tasks/${task.key}/activity`);
    expect(act.body.data[0]).toMatchObject({ verb: 'completed', via: 'CLI', by: adaId });
  });

  it('labels changes with the key’s name when the client sends no label, and the app can’t forge one', async () => {
    const { t, ada, adaId } = await workspace();
    const api = await as(t, ada, { name: 'Zapier' });
    const task = (await api.post('/tasks', { project: 'WEB', title: 'From a zap' })).body;
    expect((await api.get(`/tasks/${task.key}/activity`)).body.data[0].via).toBe('Zapier');
    const r = await ada.sync([
      put('activity', { id: 'aforge', by: adaId, verb: 'renamed', task: task.id, project: 'pweb', at: Date.now(), extra: '', via: 'Claude' }),
    ]);
    expect(r.body.results[0].ok).toBe(true);
    expect(r.body.results[0].v.via).toBeUndefined();
    // A key name is cleaned like a client label: no control or bidi characters reach Activity.
    const odd = await as(t, ada, { name: 'Laptop‮\u0007\nevil' });
    const t2 = (await odd.post('/tasks', { project: 'WEB', title: 'Odd' })).body;
    expect((await odd.get(`/tasks/${t2.key}/activity`)).body.data[0].via).toBe('Laptopevil');
  });

  it('refuses dates that don’t exist, which would otherwise break repeating tasks', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    for (const due of ['2026-02-31', '2026-13-45', '2026-11-06T25:00Z'])
      expect((await api.post('/tasks', { project: 'WEB', title: 'x', due })).body, due).toMatchObject({ code: 'invalid_request', field: 'due' });
    const { key, id } = (await api.post('/tasks', { project: 'WEB', title: 'Leap', due: '2028-02-29' })).body;
    expect((await api.patch(`/tasks/${key}`, { start: '2026-04-31' })).body.field).toBe('start');
    t.db.run("UPDATE tasks SET data = json_set(data, '$.recur', 'Weekly') WHERE id = ?", id);
    expect((await api.post(`/tasks/${key}/complete`)).status).toBe(200);
    expect((await api.get('/tasks?status=open')).body.data[0].due).toBe('2028-03-07');
  });

  it('updates field by field with the app’s activity lines, and archive / restore', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    const { key } = (await api.post('/tasks', { project: 'WEB', title: 'Draft' })).body;
    const u = await api.patch(`/tasks/${key}`, { title: 'Final', status: 'progress', priority: 'urgent', assignee: 'me', due: '2026-12-01', labels: ['bug'] });
    expect(u.body).toMatchObject({ title: 'Final', status: 'progress', priority: 'urgent', labels: ['bug'] });
    const lines = (await api.get(`/tasks/${key}/activity`)).body.data.map(a => `${a.verb} ${a.extra}`.trim());
    expect(lines).toEqual(
      expect.arrayContaining([
        'renamed to “Final”',
        'moved from To Do to In Progress',
        'changed priority of to Urgent',
        'assigned to Ada Owner',
        'changed due date of to Dec 1',
        'updated labels on',
      ]),
    );
    // Unchanged fields don't log anything.
    const before = lines.length;
    await api.patch(`/tasks/${key}`, { title: 'Final' });
    expect((await api.get(`/tasks/${key}/activity`)).body.data).toHaveLength(before);

    expect((await api.post(`/tasks/${key}/archive`)).body.archived).toBe(true);
    expect((await api.get('/tasks')).body.data).toEqual([]);
    expect((await api.get('/tasks?includeArchived=true')).body.data).toHaveLength(1);
    expect((await api.post(`/tasks/${key}/restore`)).body.archived).toBe(false);

    // Moving to another project gives it that project's next key.
    const moved = await api.patch(`/tasks/${key}`, { project: 'OPS' });
    expect(moved.body.key).toBe('OPS-201');
  });

  it('completing a repeating task schedules the next one, as in the app', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    const { key, id } = (await api.post('/tasks', { project: 'WEB', title: 'Weekly report', due: '2026-11-06' })).body;
    t.db.run("UPDATE tasks SET data = json_set(data, '$.recur', 'Weekly') WHERE id = ?", id);
    await api.post(`/tasks/${key}/complete`);
    const open = (await api.get('/tasks?status=open')).body.data;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Weekly report', due: '2026-11-13', status: 'todo' });
  });

  it('rolls a request back whole when any part is refused', async () => {
    const { t, adaId } = await workspace();
    const ops = [
      put('tasks', {
        id: 'tok',
        project: 'pweb',
        title: 'ok',
        status: 'todo',
        priority: 'none',
        labels: [],
        subtasks: [],
        attachments: [],
        deps: [],
        desc: '',
        created: 1,
        updated: 1,
        order: 1,
      }),
      put('comments', { id: 'cbad', task: 'missing', by: adaId, at: 1, text: 'x', re: {} }),
    ];
    const member = JSON.parse(t.db.get('SELECT data FROM members WHERE id = ?', adaId).data);
    const r = t.engine.apply({ member }, ops, null, { atomic: true, via: 'API' });
    expect(r.failed).toMatchObject({ ok: false, status: 404 });
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(0);
  });
});

describe('API conventions', () => {
  it('errors are { error, code, field }', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    expect((await api.post('/tasks', { project: 'WEB', title: ' ' })).body).toEqual({
      error: 'title: Give the task a name',
      code: 'invalid_request',
      field: 'title',
    });
    expect((await api.post('/tasks', { project: 'WEB', title: 'x', colour: 'red' })).body).toMatchObject({ code: 'invalid_request', field: 'colour' });
    expect((await api.post('/tasks', { project: 'WEB', title: 'x', due: 'friday' })).body.field).toBe('due');
    expect((await api.post('/tasks', 'not json')).body).toMatchObject({ code: 'invalid_request' });
    expect((await api.post('/tasks', { project: 'WEB', title: 'x', assignee: 'nobody' })).body).toMatchObject({ field: 'assignee' });
    expect((await api.get('/tasks?status=later')).body.field).toBe('status');
    expect((await api.get('/nope')).body.code).toBe('not_found');
  });

  it('paginates with cursors and filters', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    // Newest first is by created_at, then id; ids are random, so give each task its own millisecond.
    for (const title of ['one', 'two', 'three']) {
      const at = Date.now();
      while (Date.now() === at) await new Promise(r => setTimeout(r, 1));
      await api.post('/tasks', { project: 'WEB', title, assignee: title === 'two' ? 'me' : null });
    }
    const p1 = (await api.get('/tasks?limit=2')).body;
    expect(p1.data.map(x => x.title)).toEqual(['three', 'two']);
    const p2 = (await api.get(`/tasks?limit=2&cursor=${p1.nextCursor}`)).body;
    expect(p2).toEqual({ data: [expect.objectContaining({ title: 'one' })], nextCursor: null });
    expect((await api.get('/tasks?assignee=me')).body.data.map(x => x.title)).toEqual(['two']);
    expect((await api.get('/tasks?q=thr')).body.data.map(x => x.title)).toEqual(['three']);
    expect((await api.get('/tasks?q=web-202')).body.data.map(x => x.title)).toEqual(['two']);
    expect((await api.get(`/tasks?updatedSince=${Date.now() + 60_000}`)).body.data).toEqual([]);
    expect((await api.get('/tasks?cursor=garbage')).body.field).toBe('cursor');
    const m = (await api.get('/members?limit=2')).body;
    expect(m.data).toHaveLength(2);
    expect((await api.get(`/members?cursor=${m.nextCursor}`)).body.data).toHaveLength(1);
  });

  it('sorts by due date across every page with sort=due, within what the person can see', async () => {
    const { t, ada, bob } = await workspace();
    const api = await as(t, ada);
    // Oldest first: a, b, c, d, e, f (created_at set so ties break the same way every run).
    const make = [
      ['a', 'WEB', '2027-03-01'],
      ['b', 'WEB', null],
      ['c', 'WEB', '2027-01-01'],
      ['d', 'SEC', '2026-12-01'],
      ['e', 'WEB', '2027-03-01'],
      ['f', 'WEB', null],
      ['g', 'WEB', '2027-01-01T09:00'],
      ['h', 'WEB', '2027-03-01'],
    ];
    const ids = {};
    for (const [i, [title, project, due]] of make.entries()) {
      const r = await api.post('/tasks', { project, title, ...(due ? { due } : {}) });
      ids[title] = r.body.id;
      // h is created in the same millisecond as e, so the two tie on everything but id.
      t.db.run('UPDATE tasks SET created_at = ? WHERE id = ?', 1_000_000 + (title === 'h' ? 4 : i), r.body.id);
    }
    const [eh1, eh2] = ids.e > ids.h ? ['e', 'h'] : ['h', 'e'];
    const walk = async (who, limit) => {
      const seen = [];
      let cursor = '';
      do {
        const p = (await who.get(`/tasks?sort=due&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)).body;
        expect(p.sort).toBe('due');
        seen.push(...p.data.map(x => x.title));
        cursor = p.nextCursor;
      } while (cursor);
      return seen;
    };
    // Soonest first; the same due date newest first; no due date last, newest first.
    for (const n of [1, 2, 3, 50]) expect(await walk(api, n)).toEqual(['d', 'c', 'g', eh1, eh2, 'a', 'f', 'b']);
    // Bob can't open SEC, so its task isn't in his list on any page.
    const asBob = await as(t, bob);
    expect(await walk(asBob, 1)).toEqual(['c', 'g', eh1, eh2, 'a', 'f', 'b']);
    // Without sort the order and the answer are as before.
    expect((await api.get('/tasks')).body).toEqual({ data: expect.any(Array), nextCursor: null });
    // A cursor from one order isn't taken for the other.
    const created = (await api.get('/tasks?limit=1')).body.nextCursor;
    expect((await api.get(`/tasks?sort=due&cursor=${created}`)).body.field).toBe('cursor');
    expect((await api.get('/tasks?sort=soon')).body.field).toBe('sort');
  });

  it('replays a write sent again with the same Idempotency-Key', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    const body = { project: 'WEB', title: 'Once' };
    const a = await api.post('/tasks', body, { 'idempotency-key': 'abc-1' });
    const b = await api.post('/tasks', body, { 'idempotency-key': 'abc-1' });
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(1);
    expect((await api.post('/tasks', { ...body, title: 'Other' }, { 'idempotency-key': 'abc-1' })).body.code).toBe('idempotency_mismatch');
    // Another key's idempotency keys are its own.
    const other = await as(t, ada);
    expect((await other.post('/tasks', body, { 'idempotency-key': 'abc-1' })).body.id).not.toBe(a.body.id);
  });

  it('reports a committed write as saved even if fanning it out fails, so a retry replays it', async () => {
    const { t, ada } = await workspace();
    const api = await as(t, ada);
    // An open app whose stream breaks on the first change.
    let broke = false;
    t.engine.connect(
      { uid: 'mbob', sessionId: 's', clientId: 'c' },
      () => {
        if (broke) return;
        broke = true;
        throw new Error('stream broke');
      },
      () => {},
    );
    const a = await api.post('/tasks', { project: 'WEB', title: 'Once only' }, { 'idempotency-key': 'k-1' });
    expect(broke).toBe(true);
    expect(a.status).toBe(201);
    const b = await api.post('/tasks', { project: 'WEB', title: 'Once only' }, { 'idempotency-key': 'k-1' });
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    expect(t.db.get('SELECT COUNT(*) n FROM tasks').n).toBe(1);
  });

  it('a broken stream doesn’t keep changes from other apps, or keep a removed person connected', async () => {
    const { t, ada, adaId } = await workspace();
    t.engine.connect(
      { uid: 'mgus', sessionId: 's1', clientId: 'broken' },
      () => {
        throw new Error('stream broke');
      },
      () => {},
    );
    let bobClosed = false;
    t.engine.connect(
      { uid: 'mbob', sessionId: 's2', clientId: 'bob' },
      () => {},
      () => (bobClosed = true),
    );
    const got = [];
    t.engine.connect(
      { uid: adaId, sessionId: 's3', clientId: 'other' },
      (ev, data) => got.push(ev, data),
      () => {},
    );
    const r = await ada.sync([{ c: 'members', id: 'mbob', k: 'del' }]);
    expect(r.body.results[0].ok).toBe(true);
    expect(bobClosed).toBe(true);
    expect(got[0]).toBe('changes');
  });

  it('limits each person’s keys together, with RateLimit headers and 429 + Retry-After', async () => {
    const { t, ada, bob } = await workspace({ DISABLE_RATE_LIMIT: 'false', API_RATE_LIMIT: '2' });
    const api = await as(t, ada);
    const r1 = await api.get('/me');
    expect(r1.headers.get('ratelimit-limit')).toBe('2');
    expect(r1.headers.get('ratelimit-remaining')).toBe('1');
    await api.get('/me');
    const r3 = await api.get('/me');
    expect(r3.status).toBe(429);
    expect(r3.body.code).toBe('rate_limited');
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another key of the same person shares the budget; someone else has their own.
    expect((await (await as(t, ada)).get('/me')).status).toBe(429);
    expect((await (await as(t, bob)).get('/me')).status).toBe(200);
  });
});

describe('long discussions', () => {
  /* A WEB task with `n` comments ("Comment 1" oldest) and `n` activity entries ("step 1" oldest). */
  async function busy(n) {
    const w = await workspace();
    const api = await as(w.t, w.ada);
    const task = (await api.post('/tasks', { project: 'WEB', title: 'Busy' })).body;
    const at = Date.now() - n * 60_000;
    const r = await w.ada.sync(
      Array.from({ length: n }, (_, i) => [
        put('comments', { id: `cbusy${i + 1}`, task: task.id, by: w.adaId, at: at + i * 60_000, text: `Comment ${i + 1}`, re: {} }),
        put('activity', { id: `abusy${i + 1}`, by: w.adaId, verb: 'renamed', task: task.id, project: 'pweb', at: at + i * 60_000, extra: `step ${i + 1}` }),
      ]).flat(),
    );
    expect(r.body.results.every(x => x.ok)).toBe(true);
    return { ...w, api, task };
  }

  it('comments: oldest first by default (as 0.2.0 clients expect), newest first on request, with the total', async () => {
    const { api, task } = await busy(25);
    const first = (await api.get(`/tasks/${task.key}/comments?limit=20`)).body;
    expect(first.data.map(c => c.text)).toEqual(Array.from({ length: 20 }, (_, i) => `Comment ${i + 1}`));
    expect(first).toMatchObject({ nextCursor: 'o20', total: 25 });

    const newest = (await api.get(`/tasks/${task.key}/comments?order=newest&limit=20`)).body;
    expect(newest.data.map(c => c.text)).toEqual(Array.from({ length: 20 }, (_, i) => `Comment ${25 - i}`));
    expect(newest.total).toBe(25);
    // The cursor carries on to older ones.
    const rest = (await api.get(`/tasks/${task.key}/comments?order=newest&limit=20&cursor=${newest.nextCursor}`)).body;
    expect(rest).toMatchObject({ nextCursor: null, total: 25 });
    expect(rest.data.map(c => c.text)).toEqual(['Comment 5', 'Comment 4', 'Comment 3', 'Comment 2', 'Comment 1']);

    expect((await api.get(`/tasks/${task.key}/comments?order=sideways`)).body).toMatchObject({ code: 'invalid_request', field: 'order' });
  });

  it('task activity: newest first by default, oldest first on request, with the total', async () => {
    const { api, task } = await busy(15);
    // Plus the "created" entry the API logged.
    const newest = (await api.get(`/tasks/${task.key}/activity?limit=10`)).body;
    expect(newest.data.map(a => a.extra)).toEqual(Array.from({ length: 10 }, (_, i) => `step ${15 - i}`));
    expect(newest.total).toBe(16);
    const oldest = (await api.get(`/tasks/${task.key}/activity?order=oldest&limit=2`)).body;
    expect(oldest.data.map(a => a.verb)).toEqual(['created', 'renamed']);
    expect(oldest.total).toBe(16);
  });

  it('counts only the task asked for, and a task someone can’t see stays hidden', async () => {
    const { t, gus, api, task } = await busy(3);
    const other = (await api.post('/tasks', { project: 'WEB', title: 'Quiet' })).body;
    expect((await api.get(`/tasks/${other.key}/comments?order=newest`)).body).toEqual({ data: [], nextCursor: null, total: 0 });
    const g = await as(t, gus);
    expect((await g.get(`/tasks/${task.key}/comments?order=newest`)).status).toBe(404);
    expect((await g.get(`/tasks/${task.key}/activity?order=oldest`)).status).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('serves a 3.1 document built from the route table, and responses match its schemas', async () => {
    const { t, ada } = await workspace();
    const spec = await (await t.app.request('/api/v1/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('http://app.test/api/v1');
    const ops = Object.entries(spec.paths).flatMap(([p, m]) => Object.keys(m).map(k => `${k.toUpperCase()} ${p}`));
    expect(ops).toEqual(
      expect.arrayContaining([
        'GET /me',
        'GET /tasks',
        'POST /tasks',
        'GET /tasks/{ref}',
        'PATCH /tasks/{ref}',
        'POST /tasks/{ref}/complete',
        'POST /tasks/{ref}/archive',
        'GET /tasks/{ref}/comments',
        'POST /tasks/{ref}/comments',
        'GET /projects',
        'GET /projects/{ref}',
        'GET /members',
        'GET /search',
      ]),
    );
    // Every $ref resolves.
    for (const [, id] of JSON.stringify(spec).matchAll(/"#\/components\/schemas\/(\w+)"/g)) expect(spec.components.schemas[id], id).toBeTruthy();
    expect(spec.paths['/tasks'].post.requestBody.content['application/json'].schema.required).toEqual(['project', 'title']);

    // Contract smoke: real responses parse against the response schemas the spec documents.
    const strict = s => (s instanceof z.ZodObject ? z.strictObject(Object.fromEntries(Object.entries(s.shape).map(([k, v]) => [k, strict(v)]))) : s);
    const api = await as(t, ada);
    const task = (await api.post('/tasks', { project: 'WEB', title: 'Contract', assignee: 'me' })).body;
    await api.post(`/tasks/${task.key}/comments`, { text: 'hi' });
    const checks = [
      ['/me', S.Me],
      ['/tasks', S.TaskPage],
      ['/tasks?sort=due', S.TaskPage],
      [`/tasks/${task.key}`, S.Task],
      [`/tasks/${task.key}/comments`, S.CommentPage],
      [`/tasks/${task.key}/activity`, S.TaskActivityPage],
      ['/projects', S.ProjectPage],
      ['/projects/WEB', S.Project],
      ['/members', S.MemberPage],
      ['/search?q=contract', S.SearchResult],
    ];
    for (const [url, schema] of checks) {
      const r = await api.get(url);
      expect(r.status, url).toBe(200);
      const ok = strict(schema).safeParse(r.body);
      expect(ok.success, `${url}: ${ok.error?.message}`).toBe(true);
    }
    expect(strict(S.ErrorBody).safeParse((await api.get('/tasks/NOPE-1')).body).success).toBe(true);
  });

  it('renders the docs page without inline scripts', async () => {
    const { t } = await workspace();
    const res = await t.app.request('/api/docs');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('POST</span> <code>/api/v1/tasks</code>');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect((await t.app.request('/api/docs/try.js')).headers.get('content-type')).toContain('javascript');
  });
});

describe('a key revoking itself', () => {
  it('works for any scope, only ever for the key presented, and the key stops working at once', async () => {
    const t = setup();
    const { c } = await account(t);
    const read = await apiKey(c, { name: 'Read', scope: 'read' });
    const other = await apiKey(c, { name: 'Other' });
    const api = keyClient(t.app, read);
    const r = await api.del('/me/key');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ revoked: true, id: expect.any(String) });
    expect((await api.get('/me')).status).toBe(401);
    expect((await api.del('/me/key')).status).toBe(401);
    // Another key's id in the path, or a body naming it, changes nothing: there is no such route.
    const rest = keyClient(t.app, other);
    const ids = (await c.get('/api/keys')).body.map(k => k.id);
    expect(ids).toHaveLength(1);
    expect((await rest.del(`/me/key/${ids[0]}`)).status).toBe(404);
    expect((await rest.get('/me')).status).toBe(200);
    // With an Idempotency-Key too.
    expect((await rest.del('/me/key', { 'idempotency-key': 'bye' })).status).toBe(200);
    expect((await c.get('/api/keys')).body).toEqual([]);
  });
});
