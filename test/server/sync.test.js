import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';

const project = (id, extra = {}) => ({
  id,
  key: 'WEB',
  name: 'Website',
  icon: 'globe',
  color: 'indigo',
  status: 'planning',
  team: '',
  lead: null,
  due: '2026-12-01',
  start: '2026-11-01',
  fav: false,
  members: [],
  desc: '',
  milestones: [],
  last: 0,
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
  fav: false,
  recur: null,
  ...extra,
});
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });
const del = (c, id) => ({ c, id, k: 'del' });

/* Owner plus an invited, signed-up teammate with the given role. */
async function team(role = 'Member') {
  const t = setup();
  const owner = await account(t);
  const m = { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role, team: '', title: '', c: '#6B7280', status: 'invited', last: null, tz: '' };
  await owner.c.sync([put('members', m)]);
  if (role === 'Guest' || role === 'Member') await owner.c.sync([patch('members', 'mbob', { role })]);
  const token = t.lastLink('bob@example.com').split('#invite/')[1];
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: token });
  return { t, owner: owner.c, ownerId: owner.user.id, bob: bob.c };
}

describe('projects and tasks', () => {
  it('creates, edits and deletes with server-assigned keys and cascades', async () => {
    const { owner, bob } = await team();
    const r = await owner.sync([
      put('projects', project('p1')),
      put('tasks', task('t1', 'p1')),
      put('tasks', task('t2', 'p1', { key: 'WEB-201', title: 'Dup key' })),
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([true, true, true]);
    expect(r.body.results[1].v.key).toBe('WEB-201');
    expect(r.body.results[2].v.key).toBe('WEB-202');

    const b = (await bob.get('/api/bootstrap')).body.data;
    expect(b.tasks.map(x => x.key)).toEqual(['WEB-201', 'WEB-202']);
    expect(b.projects[0].seq).toBe(202);
    expect(b.projOrder).toEqual(['p1']);

    const e = await bob.sync([
      patch('tasks', 't1', { title: 'Write homepage copy', status: 'progress', deps: ['t2'], due: '2026-11-02T09:30:00.000Z', start: '2026-10-30' }),
    ]);
    expect(e.body.results[0].v).toMatchObject({ title: 'Write homepage copy', status: 'progress', due: '2026-11-02T09:30:00.000Z' });

    await owner.sync([put('comments', { id: 'c1', task: 't2', by: 'spoofed', at: 0, text: 'hello', re: {} })]);
    await owner.sync([del('tasks', 't2')]);
    const after = (await bob.get('/api/bootstrap')).body.data;
    expect(after.tasks.map(x => x.id)).toEqual(['t1']);
    expect(after.tasks[0].deps).toEqual([]);
    expect(after.comments).toEqual([]);
  });

  it('validates records and reports the canonical value on rejection', async () => {
    const { owner } = await team();
    await owner.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const r = await owner.sync([patch('tasks', 't1', { status: 'nope' }), patch('tasks', 't1', { title: 'ok' }), patch('tasks', 'ghost', { title: 'x' })]);
    expect(r.body.results[0]).toMatchObject({ ok: false, v: { status: 'todo' } });
    expect(r.body.results[0].error).toMatch(/status/);
    expect(r.body.results[1]).toMatchObject({ ok: true, v: { title: 'ok' } });
    expect(r.body.results[2]).toMatchObject({ ok: false, v: null });
  });

  it('keeps favourites per person', async () => {
    const { owner, bob } = await team();
    await owner.sync([put('projects', project('p1'))]);
    await owner.sync([patch('projects', 'p1', { fav: true })]);
    expect((await owner.get('/api/bootstrap')).body.data.projects[0].fav).toBe(true);
    expect((await bob.get('/api/bootstrap')).body.data.projects[0].fav).toBe(false);
  });

  it('hides private project work from non-members', async () => {
    const { owner, bob, ownerId } = await team();
    await owner.sync([put('projects', project('p1', { private: true, members: [ownerId] })), put('tasks', task('t1', 'p1'))]);
    const b = (await bob.get('/api/bootstrap')).body.data;
    expect(b.projects).toHaveLength(1);
    expect(b.tasks).toEqual([]);
    const r = await bob.sync([patch('tasks', 't1', { title: 'sneaky' })]);
    expect(r.body.results[0]).toMatchObject({ ok: false });
    await owner.sync([patch('projects', 'p1', { members: [ownerId, 'mbob'] })]);
    expect((await bob.get('/api/bootstrap')).body.data.tasks).toHaveLength(1);
  });

  it('only lets admins or the lead delete a project, and cascades its tasks', async () => {
    const { owner, bob } = await team();
    await owner.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    expect((await bob.sync([del('projects', 'p1')])).body.results[0].ok).toBe(false);
    expect((await owner.sync([del('projects', 'p1')])).body.results[0].ok).toBe(true);
    const b = (await bob.get('/api/bootstrap')).body.data;
    expect(b.projects).toEqual([]);
    expect(b.tasks).toEqual([]);
  });
});

describe('people and permissions', () => {
  it('guests cannot create projects or invite people', async () => {
    const { bob } = await team('Guest');
    const r = await bob.sync([
      put('projects', project('p9')),
      put('members', { id: 'mx', name: 'X', email: 'x@x.io', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([false, false]);
  });

  it('only admins change roles, nobody changes their own, and removal unassigns work', async () => {
    const { owner, bob, ownerId } = await team();
    expect((await bob.sync([patch('members', ownerId, { role: 'Guest' })])).body.results[0].ok).toBe(false);
    expect((await bob.sync([patch('members', 'mbob', { title: 'Engineer', name: 'Bobby' })])).body.results[0].ok).toBe(true);
    expect((await owner.sync([patch('members', ownerId, { role: 'Admin' })])).body.results[0].ok).toBe(false);

    await owner.sync([put('projects', project('p1', { members: [ownerId, 'mbob'] })), put('tasks', task('t1', 'p1', { assignee: 'mbob' }))]);
    expect((await owner.sync([del('members', 'mbob')])).body.results[0].ok).toBe(true);
    const b = (await owner.get('/api/bootstrap')).body.data;
    expect(b.members.map(m => m.id)).toEqual([ownerId]);
    expect(b.tasks[0].assignee).toBeNull();
    expect(b.projects[0].members).toEqual([ownerId]);
    expect((await bob.get('/api/bootstrap')).status).toBe(401);
  });

  it('workspace settings are admin-only', async () => {
    const { owner, bob } = await team();
    expect((await bob.sync([patch('ws', null, { name: 'Hacked' })])).body.results[0].ok).toBe(false);
    expect((await owner.sync([{ c: 'ws', k: 'patch', v: { name: 'Acme' } }])).body.results[0].v).toMatchObject({ name: 'Acme' });
  });
});

describe('comments, activity and notifications', () => {
  it('notifies on assignment, mentions and comments, and only the reader can mark them read', async () => {
    const { owner, bob, ownerId } = await team();
    await owner.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1', { assignee: 'mbob' }))]);
    await bob.sync([patch('tasks', 't1', { assignee: ownerId })]);
    await bob.sync([put('comments', { id: 'c1', task: 't1', by: 'mbob', at: Date.now(), text: 'Looks good @Ada Owner', re: {} })]);

    const ownerNotifs = (await owner.get('/api/bootstrap')).body.data.notifs;
    expect(ownerNotifs.map(n => n.type).sort()).toEqual(['assign', 'mention']);
    const bobNotifs = (await bob.get('/api/bootstrap')).body.data.notifs;
    expect(bobNotifs.map(n => n.type)).toEqual(['assign']);

    const id = ownerNotifs[0].id;
    expect((await bob.sync([patch('notifs', id, { read: true })])).body.results[0]).toMatchObject({ ok: false, v: null });
    expect((await owner.sync([patch('notifs', id, { read: true })])).body.results[0].v.read).toBe(true);
    expect((await owner.sync([patch('notifs', id, { text: 'x' })])).body.results[0].ok).toBe(false);
  });

  it('forces authorship and lets others only toggle their own reactions', async () => {
    const { owner, bob, ownerId } = await team();
    await owner.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const r = await owner.sync([
      put('comments', { id: 'c1', task: 't1', by: 'mbob', at: 1, text: 'hi', re: {} }),
      put('activity', { id: 'a1', by: 'mbob', verb: 'created', task: 't1', project: 'p1', at: 1, extra: '' }),
    ]);
    expect(r.body.results[0].v.by).toBe(ownerId);
    expect(r.body.results[1].v.by).toBe(ownerId);
    expect((await bob.sync([patch('comments', 'c1', { re: { '👍': ['mbob'] } })])).body.results[0].ok).toBe(true);
    expect((await bob.sync([patch('comments', 'c1', { re: { '👍': ['mbob', ownerId] } })])).body.results[0].ok).toBe(false);
    expect((await bob.sync([patch('comments', 'c1', { text: 'edited' })])).body.results[0].ok).toBe(false);
    expect((await bob.sync([del('comments', 'c1')])).body.results[0].ok).toBe(false);
    expect((await bob.sync([patch('activity', 'a1', { verb: 'x' })])).body.results[0].ok).toBe(false);
  });
});

describe('per-person documents', () => {
  it('stores sidebar order, recent searches, notification prefs and UI state per person', async () => {
    const { owner, bob } = await team();
    await owner.sync([
      put('projects', project('p1')),
      put('projects', project('p2', { key: 'MOB', name: 'Mobile' })),
      { c: 'projOrder', k: 'put', v: ['p1', 'p2'] },
      { c: 'recentSearches', k: 'put', v: ['homepage'] },
      { c: 'notifPrefs', k: 'patch', v: { email_digest: false } },
    ]);
    await owner.put('/api/me/state', { prefs: { theme: 'dark', name: 'ignored' }, views: { tasks: { q: 'x' } }, collapsed: true });
    const o = (await owner.get('/api/bootstrap')).body;
    expect(o.data.projOrder).toEqual(['p1', 'p2']);
    expect(o.data.recentSearches).toEqual(['homepage']);
    expect(o.data.notifPrefs).toEqual({ email_digest: false });
    expect(o.prefs).toMatchObject({ theme: 'dark', name: 'Ada Owner' });
    expect(o.views).toEqual({ tasks: { q: 'x' } });
    expect(o.collapsed).toBe(true);
    const b = (await bob.get('/api/bootstrap')).body;
    expect(b.data.projOrder).toEqual(['p2', 'p1']);
    expect(b.data.recentSearches).toEqual([]);
  });

  it('marks the workspace onboarded only for the owner', async () => {
    const { owner, bob } = await team();
    expect((await bob.post('/api/workspace/onboarded')).status).toBe(403);
    expect((await owner.post('/api/workspace/onboarded')).body.ws.name).toBe('My Workspace');
    expect((await owner.get('/api/auth/session')).body.workspace.onboarded).toBe(true);
  });
});

describe('live updates', () => {
  it('pushes changes to other people who can see them, but not back to the sender', async () => {
    const { t, owner, ownerId } = await team();
    const seen = { owner: [], bob: [] };
    t.engine.connect(
      { uid: ownerId, sessionId: 's1', clientId: 'tab-owner' },
      (e, d) => seen.owner.push([e, d]),
      () => {},
    );
    t.engine.connect(
      { uid: 'mbob', sessionId: 's2', clientId: 'tab-bob' },
      (e, d) => seen.bob.push([e, d]),
      () => {},
    );
    const c = t.client({ clientId: 'tab-owner' });
    c.cookie = owner.cookie;
    await c.sync([put('projects', project('p1', { private: true, members: [ownerId] })), put('tasks', task('t1', 'p1'))]);
    expect(seen.owner).toEqual([]);
    const bobChanges = seen.bob.flatMap(([, d]) => d);
    expect(bobChanges.map(x => x.c)).toEqual(['projects']);
  });
});
