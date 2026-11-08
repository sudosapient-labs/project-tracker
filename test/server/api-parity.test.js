/* The public API's parity with the app (/api/v1, v1-more.js): every write builds the app's records and
   activity lines and goes through the sync engine, so permissions, notifications and live updates
   are the app's; a key acts as its person, admin powers included. */
import { describe, expect, it } from 'vitest';
import { PW, account, apiKey, keyClient, setup } from './helpers.js';

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
const acts = t =>
  t.db.all(
    "SELECT json_extract(data, '$.verb') verb, json_extract(data, '$.extra') extra, json_extract(data, '$.via') via FROM activity ORDER BY created_at, rowid",
  );

/* Ada (Owner), Bob (Member) and Gus (Guest); an open project WEB, a private SEC (Ada only), and OPS
   listing Gus with Can comment. */
async function workspace(env) {
  const t = setup(env);
  const ada = await account(t);
  const join = async (id, name, email, role) => {
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    return (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  };
  const bob = await join('mbob', 'Bob Lee', 'bob@example.com', 'Member');
  const gus = await join('mgus', 'Gus Guest', 'gus@example.com', 'Guest');
  await ada.c.sync([
    put('projects', project('pweb', 'WEB')),
    put('projects', project('psec', 'SEC', { private: true })),
    put('projects', project('pops', 'OPS', { members: ['mgus'], perms: { mgus: 'Can comment' } })),
  ]);
  const key = async (c, scope = 'write') => keyClient(t.app, await apiKey(c, { scope }), { client: 'Test' });
  return { t, ada: ada.c, adaId: ada.user.id, bob, gus, key };
}

describe('workspace administration follows the key’s person', () => {
  it('keys are read or write; there is no separate admin key', async () => {
    const { ada } = await workspace();
    expect((await ada.post('/api/keys', { name: 'Admin', scope: 'admin', expiresInDays: 30, password: PW })).status).toBe(400);
    const b = await ada.post('/api/bots', { name: 'CI', role: 'Member', projects: [] });
    expect((await ada.post(`/api/bots/${b.body.id}/keys`, { name: 'k', scope: 'admin', expiresInDays: null, password: PW })).status).toBe(400);
  });

  it('an Owner’s or Admin’s write key administers; anyone else’s is refused; a demotion counts at once', async () => {
    const { t, ada, bob, key } = await workspace();
    const bobApi = await key(bob);
    expect(await bobApi.patch('/workspace', { name: 'Renamed' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect((await bobApi.del('/members/mgus')).status).toBe(403);
    expect((await bobApi.patch('/members/mgus', { role: 'Member' })).status).toBe(403);
    expect((await bobApi.get('/bots')).status).toBe(403);
    // A read-only key of the Owner still only reads.
    expect((await (await key(ada, 'read')).patch('/workspace', { name: 'Nope' })).body.code).toBe('insufficient_scope');

    const owner = await key(ada);
    expect(await owner.patch('/workspace', { name: 'Renamed', color: '#3B82C4' })).toMatchObject({ status: 200, body: { name: 'Renamed', color: '#3B82C4' } });
    expect((await owner.patch('/members/mbob', { role: 'Admin' })).body.role).toBe('Admin');
    // Bob's key made while he was a Member now administers, and stops once he's demoted.
    expect((await bobApi.patch('/workspace', { name: 'By Bob' })).status).toBe(200);
    await owner.patch('/members/mbob', { role: 'Member' });
    expect(await bobApi.patch('/workspace', { name: 'Again' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    // Nobody changes their own role, and the Owner can't be removed.
    expect((await owner.patch('/members/me', { role: 'Member' })).status).toBe(403);
    expect((await owner.del('/members/me')).status).toBe(403);
    // Removing someone: tasks unassigned, off projects, signed out.
    const tk = await owner.post('/tasks', { project: 'WEB', title: 'Bob’s', assignee: 'bob@example.com' });
    expect((await owner.del('/members/bob@example.com')).body).toEqual({ deleted: true, id: 'mbob' });
    expect((await owner.get(`/tasks/${tk.body.key}`)).body.assignee).toBeNull();
    expect(t.db.get("SELECT 1 FROM users WHERE id = 'mbob'")).toBeUndefined();
  });

  it('an Owner’s key can do what the app lets an Owner: admin recovery, others’ comments, workspace events', async () => {
    const { t, ada, bob, key, adaId } = await workspace();
    const bobApi = await key(bob);
    await bobApi.post('/projects', { name: 'Hush', key: 'HUSH', private: true });
    const c = (await (await key(ada)).post('/tasks', { project: 'WEB', title: 'Talk' })).body;
    const bobComment = (await bobApi.post(`/tasks/${c.key}/comments`, { text: 'Mine' })).body;
    const owner = await key(ada);
    expect((await owner.del(`/comments/${bobComment.id}`)).status).toBe(200);
    expect((await owner.post('/events', { title: 'All hands', date: '2026-12-02' })).body.project).toBeNull();
    expect((await owner.put('/projects/HUSH/members/me')).status).toBe(200);
    expect(t.repo.get('projects', (await bobApi.get('/projects/HUSH')).body.id).members).toContain(adaId);
    // A Member's key can't do any of it.
    const adaComment = (await owner.post(`/tasks/${c.key}/comments`, { text: 'Ada' })).body;
    expect((await bobApi.del(`/comments/${adaComment.id}`)).status).toBe(403);
    expect((await bobApi.post('/events', { title: 'Mine', date: '2026-12-02' })).status).toBe(403);
    expect((await bobApi.put('/projects/SEC/members/me')).status).toBe(404);
  });

  it('an Owner’s key administers bots, but can’t make bot keys (no credential from a credential)', async () => {
    const { t, ada, key } = await workspace();
    const owner = await key(ada);
    const b = await owner.post('/bots', { name: 'Release Bot', projects: ['WEB'] });
    expect(b).toMatchObject({ status: 201, body: { name: 'Release Bot', role: 'Member', projects: ['pweb'], keys: [] } });
    expect((await owner.patch(`/bots/${b.body.id}`, { role: 'Guest', projects: ['OPS'] })).body).toMatchObject({ role: 'Guest', projects: ['pops'] });
    const k = await ada.post(`/api/bots/${b.body.id}/keys`, { name: 'CI', scope: 'write', expiresInDays: null, password: PW });
    expect((await owner.get('/bots')).body.data[0].keys.map(x => x.name)).toEqual(['CI']);
    expect((await owner.post(`/bots/${b.body.id}/keys`, { name: 'x' })).status).toBe(404);
    expect((await owner.del(`/bots/${b.body.id}/keys/${k.body.key.id}`)).body.keys).toEqual([]);
    expect((await keyClient(t.app, k.body.token).get('/me')).status).toBe(401);
    // A bot isn't a person: /members won't edit or remove it.
    expect((await owner.del(`/members/${b.body.id}`)).status).toBe(400);
    expect((await owner.del(`/bots/${b.body.id}`)).body.deleted).toBe(true);
    expect(t.db.get("SELECT COUNT(*) n FROM users WHERE kind = 'bot'").n).toBe(0);
  });
});

describe('projects', () => {
  it('create, edit, share, archive, duplicate and delete as the app does', async () => {
    const { t, bob, gus, key, adaId } = await workspace();
    const api = await key(bob);
    const r = await api.post('/projects', {
      name: 'Mobile App',
      description: 'iOS and Android',
      status: 'active',
      members: [{ member: 'gus@example.com', permission: 'Can view' }],
      milestones: [{ name: 'Beta', date: '2026-12-01' }],
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      key: 'MA',
      name: 'Mobile App',
      lead: 'mbob',
      members: ['mbob', 'mgus'],
      permissions: { mbob: 'Full access', mgus: 'Can view' },
      private: false,
      access: 'full',
      milestones: [{ name: 'Beta', date: '2026-12-01' }],
    });
    expect(acts(t).at(-1)).toEqual({ verb: 'created project', extra: '', via: 'Test' });
    // The whole sidebar (SEC as a locked card), not only the new project: open apps take it as it is.
    expect(t.repo.userState('mbob').projOrder).toEqual([r.body.id, 'pops', 'psec', 'pweb']);

    // Status changes are logged; a new lead is listed too; privacy needs full access.
    const up = await api.patch('/projects/MA', { status: 'risk', lead: 'Ada Owner', private: true });
    expect(up.body).toMatchObject({ status: 'risk', lead: adaId, private: true });
    expect(up.body.members).toContain(adaId);
    expect(acts(t).at(-1)).toMatchObject({ verb: 'changed status of project', extra: 'to At Risk' });
    const gusApi = await key(gus);
    expect((await gusApi.get('/projects/MA')).body.access).toBe('view');
    expect(await gusApi.patch('/projects/MA', { name: 'Nope' })).toMatchObject({ status: 403 });

    // Sharing: Gus off, then on again; a Guest can't see it when taken off a private project.
    expect((await api.del('/projects/MA/members/Gus')).body.members).not.toContain('mgus');
    expect((await gusApi.get('/projects/MA')).status).toBe(404);
    // No body: listed with the default permission.
    expect((await api.put('/projects/MA/members/gus@example.com')).body.members).toContain('mgus');
    expect((await api.put('/projects/MA/members/gus@example.com', { permission: 'Can comment' })).body.permissions.mgus).toBe('Can comment');
    expect((await gusApi.get('/projects/MA')).body.access).toBe('comment');

    await api.post('/tasks', { project: 'MA', title: 'Ship it', assignee: 'gus@example.com' });
    const dup = await api.post('/projects/MA/duplicate');
    expect(dup.body).toMatchObject({ name: 'Mobile App copy', status: 'planning', openTasks: 1 });
    // The copy is open to the workspace and doesn't list Gus, so the copied task is unassigned.
    const copied = (await api.get(`/tasks?project=${dup.body.key}`)).body.data;
    expect(copied).toMatchObject([{ title: 'Ship it', status: 'todo', assignee: null }]);

    // A copy of a private project stays private: copying can't open its work to the workspace.
    const privDup = await (await key(gus)).post('/projects/MA/duplicate');
    expect(privDup.status).toBe(403);
    const sec = await api.post('/projects/MA/duplicate');
    expect(sec.body.private).toBe(true);
    expect((await api.post('/projects/MA/archive')).body.archived).toBe(true);
    expect((await api.get('/projects')).body.data.map(p => p.key)).not.toContain('MA');
    expect((await api.post('/projects/MA/restore')).body.archived).toBe(false);
    expect((await api.del('/projects/MA')).body.deleted).toBe(true);
    expect(t.db.get('SELECT COUNT(*) n FROM tasks WHERE project_id = ?', r.body.id).n).toBe(0);
  });

  it('lets an Owner recover a private project they aren’t in, without seeing its work', async () => {
    const { ada, adaId, bob, key } = await workspace();
    const bobApi = await key(bob);
    const p = await bobApi.post('/projects', { name: 'Secret', key: 'HUSH', private: true });
    await bobApi.post('/tasks', { project: 'HUSH', title: 'Hidden' });
    const owner = await key(ada);
    expect((await owner.get('/projects/HUSH')).status).toBe(404);
    // Its settings are still the Owner's to manage: they list themselves.
    const r = await owner.put('/projects/HUSH/members/me', { permission: 'Full access' });
    expect(r.body).toMatchObject({ access: 'full', permissions: { [adaId]: 'Full access' } });
    expect((await owner.get('/tasks?project=HUSH')).body.data.map(x => x.title)).toEqual(['Hidden']);
    expect(p.body.key).toBe('HUSH');
  });

  it('request access answers the same whether or not the project exists, and notifies the lead', async () => {
    const { t, bob, gus, key, adaId } = await workspace();
    const api = await key(bob);
    expect((await api.post('/projects/SEC/request-access')).body).toEqual({ ok: true });
    expect((await api.post('/projects/NOPE/request-access')).body).toEqual({ ok: true });
    // A Guest gets no locked cards, so a guessed key reaches nobody (an id still works, as in the app).
    const before = t.db.get('SELECT COUNT(*) n FROM notifications').n;
    expect((await (await key(gus)).post('/projects/SEC/request-access')).body).toEqual({ ok: true });
    expect(t.db.get('SELECT COUNT(*) n FROM notifications').n).toBe(before);
    await (await key(gus)).post('/projects/psec/request-access');
    expect(t.db.get('SELECT COUNT(*) n FROM notifications').n).toBe(before + 1);
    const n = t.db.all('SELECT data FROM notifications WHERE user_id = ?', adaId).map(r => JSON.parse(r.data));
    expect(n.some(x => x.text === 'requested access to Project SEC')).toBe(true);
  });

  it('request access shares the app’s budget, and says when to try again', async () => {
    const { bob, key } = await workspace({ DISABLE_RATE_LIMIT: 'false' });
    const api = await key(bob);
    // 3 an hour for each project, the app's and the API's asks together.
    for (let i = 0; i < 3; i++) expect((await api.post('/projects/SEC/request-access')).status).toBe(200);
    const more = await api.post('/projects/SEC/request-access');
    expect(more.status).toBe(429);
    expect(more.body).toMatchObject({ code: 'rate_limited', error: expect.stringMatching(/already asked/) });
    expect(Number(more.headers.get('retry-after'))).toBeGreaterThan(3000);
  });
});

describe('tasks', () => {
  it('repeat, dependencies, order, subtasks and duplicate, with the app’s activity lines', async () => {
    const { t, ada, key } = await workspace();
    const api = await key(ada);
    const a = (await api.post('/tasks', { project: 'WEB', title: 'Design' })).body;
    const b = await api.post('/tasks', {
      project: 'WEB',
      title: 'Build',
      dependsOn: [a.key],
      recurrence: 'Weekly',
      due: '2026-11-20',
      subtasks: [{ title: 'Spec' }, { title: 'Code', assignee: 'me' }],
    });
    expect(b.body).toMatchObject({ dependsOn: [a.id], recurrence: 'Weekly', subtasks: [{ title: 'Spec', done: false }, { title: 'Code' }] });
    expect((await api.patch(`/tasks/${a.key}`, { dependsOn: [a.key] })).body.code).toBe('invalid_request');
    const other = await api.post('/tasks', { project: 'OPS', title: 'Elsewhere' });
    expect((await api.patch(`/tasks/${b.body.key}`, { dependsOn: [other.body.key] })).body.error).toMatch(/another project/);

    await api.patch(`/tasks/${b.body.key}`, { recurrence: null, order: 0.5 });
    expect(acts(t).slice(-1)).toEqual([{ verb: 'set repeat on', extra: 'off', via: 'Test' }]);

    const sid = b.body.subtasks[0].id;
    const s1 = await api.post(`/tasks/${b.body.key}/subtasks`, { title: 'Test', due: '2026-11-18' });
    expect(s1.status).toBe(201);
    await api.patch(`/tasks/${b.body.key}/subtasks/${sid}`, { done: true, assignee: 'Bob Lee' });
    expect(
      acts(t)
        .slice(-4)
        .map(x => [x.verb, x.extra]),
    ).toEqual([
      ['added subtask to', '“Test”'],
      ['set a subtask due date on', 'Nov 18'],
      ['completed subtask on', '“Spec”'],
      ['assigned a subtask on', 'to Bob Lee'],
    ]);
    const del = await api.del(`/tasks/${b.body.key}/subtasks/${sid}`);
    expect(del.body.subtasks.map(s => s.title)).toEqual(['Code', 'Test']);

    const promoted = await api.post(`/tasks/${b.body.key}/subtasks/${del.body.subtasks[1].id}/promote`);
    expect(promoted.body).toMatchObject({ title: 'Test', due: '2026-11-18' });
    expect(acts(t).at(-1)).toMatchObject({ verb: 'converted a subtask of', extra: `into ${promoted.body.key}` });

    const dup = await api.post(`/tasks/${a.key}/duplicate`);
    expect(dup.body).toMatchObject({ title: 'Design (copy)', project: 'pweb' });
    expect(dup.body.key).not.toBe(a.key);
  });

  it('completing a repeating task schedules one next copy; reopening it removes the untouched copy', async () => {
    const { t, ada, key } = await workspace();
    const api = await key(ada);
    const r = (await api.post('/tasks', { project: 'WEB', title: 'Standup notes', recurrence: 'Daily', due: '2026-11-20' })).body;
    await api.post(`/tasks/${r.key}/complete`);
    const count = () => t.db.get("SELECT COUNT(*) n FROM tasks WHERE json_extract(data, '$.title') = 'Standup notes'").n;
    expect(count()).toBe(2);
    await api.patch(`/tasks/${r.key}`, { status: 'todo' });
    expect(count()).toBe(1);
    await api.post(`/tasks/${r.key}/complete`);
    await api.patch(`/tasks/${r.key}`, { status: 'todo' });
    await api.post(`/tasks/${r.key}/complete`);
    expect(count()).toBe(2);
  });

  it('delete and undelete (comments and key come back), and favourites per person', async () => {
    const { t, ada, bob, key } = await workspace();
    const api = await key(ada);
    const tk = (await api.post('/tasks', { project: 'WEB', title: 'Oops' })).body;
    await api.post(`/tasks/${tk.key}/comments`, { text: 'Keep me' });
    const d = await api.del(`/tasks/${tk.key}`);
    expect(d.body).toMatchObject({ deleted: true, id: tk.id });
    expect(d.body.restoreUntil).toBeGreaterThan(Date.now());
    expect((await api.get(`/tasks/${tk.key}`)).status).toBe(404);
    // Only whoever deleted it can undo it.
    expect((await (await key(bob)).post(`/tasks/${tk.id}/undelete`)).status).toBe(410);
    const back = await api.post(`/tasks/${tk.id}/undelete`);
    expect((await api.post(`/tasks/${tk.id}/undelete`)).status).toBe(409);
    expect(back.body).toMatchObject({ key: tk.key, title: 'Oops' });
    expect((await api.get(`/tasks/${tk.key}/comments`)).body.data.map(c => c.text)).toEqual(['Keep me']);

    expect((await api.put(`/tasks/${tk.key}/favorite`)).body.favorite).toBe(true);
    expect((await api.put('/projects/WEB/favorite')).body.favorite).toBe(true);
    expect((await api.get('/me/favorites')).body).toMatchObject({ tasks: [tk.id], projects: ['pweb'] });
    expect((await (await key(bob)).get(`/tasks/${tk.key}`)).body.favorite).toBe(false);
    expect((await api.del(`/tasks/${tk.key}/favorite`)).body.favorite).toBe(false);
    const order = await api.put('/me/project-order', { projects: ['OPS', 'WEB'] });
    expect(order.body.projectOrder.slice(0, 2)).toEqual(['pops', 'pweb']);
    expect(t.repo.userState((await api.get('/me')).body.id).projOrder.slice(0, 2)).toEqual(['pops', 'pweb']);
  });
});

describe('comments', () => {
  it('only the author edits; reactions are merged per person; delete and undelete', async () => {
    const { ada, bob, key } = await workspace();
    const adaApi = await key(ada);
    const bobApi = await key(bob);
    const tk = (await adaApi.post('/tasks', { project: 'WEB', title: 'Discuss' })).body;
    const c = (await adaApi.post(`/tasks/${tk.key}/comments`, { text: 'First' })).body;
    expect((await adaApi.patch(`/comments/${c.id}`, { text: 'First!' })).body.text).toBe('First!');
    expect((await bobApi.patch(`/comments/${c.id}`, { text: 'Hijack' })).status).toBe(403);
    await adaApi.put(`/comments/${c.id}/reactions/👍`);
    const both = await bobApi.put(`/comments/${c.id}/reactions/👍`);
    expect(both.body.reactions['👍'].sort()).toEqual([(await adaApi.get('/me')).body.id, 'mbob'].sort());
    expect((await bobApi.del(`/comments/${c.id}/reactions/👍`)).body.reactions['👍']).toEqual([(await adaApi.get('/me')).body.id]);
    expect((await bobApi.put(`/comments/${c.id}/reactions/🤡`)).status).toBe(400);
    expect((await bobApi.del(`/comments/${c.id}`)).status).toBe(403);
    expect((await adaApi.del(`/comments/${c.id}`)).body.deleted).toBe(true);
    expect((await adaApi.post(`/comments/${c.id}/undelete`)).body).toMatchObject({ text: 'First!', reactions: { '👍': expect.any(Array) } });
  });
});

describe('teams and people', () => {
  it('teams: create with members, change, delete (people and projects keep going)', async () => {
    const { ada, gus, key } = await workspace();
    const api = await key(ada);
    const tm = await api.post('/teams', { name: 'Platform', members: ['Bob Lee', 'me'] });
    expect(tm.body).toMatchObject({ name: 'Platform', icon: 'users', color: '#23918A' });
    expect(tm.body.members.sort()).toEqual([(await api.get('/me')).body.id, 'mbob'].sort());
    expect((await api.patch(`/teams/${tm.body.id}`, { members: ['Bob Lee'], description: 'APIs' })).body).toMatchObject({
      members: ['mbob'],
      description: 'APIs',
    });
    await api.patch('/projects/WEB', { team: tm.body.id });
    expect((await api.get('/members/mbob')).body.team).toBe(tm.body.id);
    expect((await (await key(gus)).post('/teams', { name: 'Guests' })).status).toBe(403);
    expect((await api.del(`/teams/${tm.body.id}`)).body.deleted).toBe(true);
    expect((await api.get('/members/mbob')).body.team).toBe('');
    expect((await api.get('/projects/WEB')).body.team).toBe('');
  });

  it('invites by email, resends, and edits profiles with the app’s limits', async () => {
    const { t, ada, bob, gus, key } = await workspace();
    const api = await key(bob);
    const inv = await api.post('/members', { email: 'Cara.Diaz@Example.com' });
    expect(inv).toMatchObject({ status: 201, body: { member: { name: 'Cara Diaz', email: 'cara.diaz@example.com', role: 'Member', status: 'invited' } } });
    expect(t.lastLink('cara.diaz@example.com')).toMatch(/#invite\//);
    expect((await api.post('/members', { email: 'cara.diaz@example.com' })).status).toBe(409);
    // Only Owners and Admins invite Admins (the app would quietly make it a Member invite).
    expect((await api.post('/members', { email: 'dan@example.com', role: 'Admin' })).body.code).toBe('forbidden');
    expect((await api.post(`/members/${inv.body.member.id}/resend-invite`)).body).toEqual({ ok: true });
    expect((await api.post('/members/mbob/resend-invite')).body.error).toMatch(/already joined/);
    expect((await (await key(gus)).post('/members', { email: 'eve@example.com' })).status).toBe(403);

    // Your own profile; another person's team (anyone but a Guest); their title is for Owners and Admins.
    expect((await api.patch('/me', { title: 'Engineer', color: '#3B82C4' })).body).toMatchObject({ title: 'Engineer' });
    expect((await api.patch('/members/mgus', { title: 'Boss' })).body.code).toBe('forbidden');
    const owner = await key(ada);
    expect((await owner.patch('/members/mgus', { title: 'Contractor' })).body.title).toBe('Contractor');
  });
});

describe('preferences, notifications and activity', () => {
  it('saves display and notification preferences; the time zone shows on the profile', async () => {
    const { t, bob, key } = await workspace();
    const api = await key(bob);
    const r = await api.patch('/me/preferences', { preferences: { theme: 'dark', tz: 'Europe/Berlin', weekStart: 0 }, notifications: { email_comment: true } });
    expect(r.body.preferences).toMatchObject({ theme: 'dark', tz: 'Europe/Berlin', weekStart: 0 });
    expect(r.body.notifications).toMatchObject({ email_comment: true, email_mention: true });
    expect(t.repo.get('members', 'mbob').tz).toBe('Berlin');
    expect((await bob.get('/api/bootstrap')).body.prefs.theme).toBe('dark');
    expect((await api.patch('/me/preferences', { preferences: { theme: 'neon' } })).status).toBe(400);
    expect((await api.patch('/me/preferences', { preferences: { permCreate: true } })).status).toBe(400);
  });

  it('lists the inbox and marks it read; the feed shows only what the key’s person may see', async () => {
    const { t, ada, gus, key } = await workspace();
    const api = await key(ada);
    await api.post('/tasks', { project: 'OPS', title: 'For Gus', assignee: 'gus@example.com' });
    await api.post('/tasks', { project: 'SEC', title: 'Secret' });
    const gusApi = await key(gus);
    const inbox = await gusApi.get('/notifications');
    expect(inbox.body.data).toHaveLength(1);
    expect(inbox.body.data[0]).toMatchObject({ type: 'assign', read: false, text: 'assigned you', taskKey: 'OPS-201' });
    expect((await gusApi.patch(`/notifications/${inbox.body.data[0].id}`, { read: true })).body.read).toBe(true);
    expect((await gusApi.get('/notifications?unread=true')).body.data).toEqual([]);
    expect((await gusApi.post('/notifications/read-all')).body).toEqual({ updated: 0 });

    const feed = await gusApi.get('/activity');
    expect(feed.body.data.map(a => a.project)).toEqual(['pops']);
    expect((await api.get('/activity?project=SEC')).body.data[0]).toMatchObject({ verb: 'created', via: 'Test' });
    expect((await gusApi.get('/activity?project=SEC')).status).toBe(404);
    const page = await api.get('/activity?limit=1');
    expect(page.body.nextCursor).toBeTruthy();
    expect((await api.get(`/activity?limit=1&cursor=${page.body.nextCursor}`)).body.data[0].id).not.toBe(page.body.data[0].id);
    expect(t.db.get('SELECT COUNT(*) n FROM activity').n).toBe(2);
  });
});

describe('files', () => {
  it('uploads raw bytes (over 1 MB), attaches, renames, copies, downloads and deletes', async () => {
    const { t, ada, gus, key } = await workspace();
    const api = await key(ada);
    const tk = (await api.post('/tasks', { project: 'WEB', title: 'With a file' })).body;
    const big = Buffer.alloc(1_500_000, 7);
    const up = await api.upload(`/files?task=${tk.key}&name=spec.pdf`, big, 'application/pdf');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ name: 'spec.pdf', type: 'pdf', size: '1.4 MB', task: tk.id, project: 'pweb' });
    expect(acts(t).at(-1)).toEqual({ verb: 'added a file to', extra: 'spec.pdf', via: 'Test' });
    // At the address a key can fetch, the same as the file's own.
    expect((await api.get(`/tasks/${tk.key}`)).body.attachments).toEqual([{ id: up.body.id, name: 'spec.pdf', size: '1.4 MB', url: up.body.url }]);
    expect(up.body.url).toMatch(new RegExp(`^https?://.+/api/v1/files/${up.body.id}/content$`));

    const got = await api.get(`/files/${up.body.id}/content?download=true`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(Buffer.compare(got.body, big)).toBe(0);

    const loose = await api.upload('/files?project=WEB&name=notes.txt', Buffer.from('hello'), 'text/plain');
    expect((await api.patch(`/files/${loose.body.id}`, { task: tk.key, name: 'notes-v2.txt' })).body).toMatchObject({ task: tk.id, name: 'notes-v2.txt' });
    expect((await api.get(`/tasks/${tk.key}`)).body.attachments.map(a => a.name).sort()).toEqual(['notes-v2.txt', 'spec.pdf']);
    expect((await api.patch(`/files/${loose.body.id}`, { task: null })).body.task).toBeNull();
    expect((await api.get(`/files?task=${tk.key}`)).body.data.map(f => f.name)).toEqual(['spec.pdf']);
    const copy = await api.post(`/files/${up.body.id}/duplicate`);
    expect(copy.body.name).toBe('spec copy.pdf');
    expect((await api.del(`/files/${up.body.id}`)).body.deleted).toBe(true);
    expect((await api.get(`/tasks/${tk.key}`)).body.attachments).toEqual([]);
    expect((await api.get(`/files/${copy.body.id}/content`)).status).toBe(200);

    // Can comment isn't enough to add files, and projects people can't open stay hidden.
    const gusApi = await key(gus);
    expect((await gusApi.upload('/files?project=OPS&name=x.txt', Buffer.from('x'))).status).toBe(403);
    expect((await gusApi.get(`/files/${copy.body.id}`)).status).toBe(404);
    expect((await api.upload('/files?name=x.txt', Buffer.from('x'))).body.field).toBe('project');
    expect((await api.upload('/files?project=WEB&name=x.txt', Buffer.from('x'), 'text/plain')).status).toBe(201);
    const idem = await api.post('/files?project=WEB&name=y.txt', 'y', { 'idempotency-key': 'k1', 'content-type': 'text/plain' });
    expect(idem.status).toBe(400);
  });
});

describe('events and saved views', () => {
  it('project events need Can edit; workspace-wide ones are for Owners and Admins', async () => {
    const { ada, bob, gus, key } = await workspace();
    const bobApi = await key(bob);
    const e = await bobApi.post('/events', { title: 'Launch', date: '2026-12-01', time: '09:30', project: 'WEB' });
    expect(e.body).toMatchObject({ title: 'Launch', project: 'pweb', time: '09:30' });
    expect((await bobApi.post('/events', { title: 'All hands', date: '2026-12-02' })).status).toBe(403);
    // Workspace-wide events are for Owners and Admins.
    const adaApi = await key(ada);
    expect((await adaApi.post('/events', { title: 'All hands', date: '2026-12-02' })).body.project).toBeNull();
    expect((await bobApi.get('/events?from=2026-12-01&to=2026-12-31')).body.data.map(x => x.title)).toEqual(['Launch', 'All hands']);
    expect((await bobApi.patch(`/events/${e.body.id}`, { date: '2026-12-03' })).body.date).toBe('2026-12-03');
    expect((await (await key(gus)).get(`/events`)).body.data.map(x => x.title)).toEqual(['All hands']);
    expect((await bobApi.del(`/events/${e.body.id}`)).body.deleted).toBe(true);
  });

  it('saved views are shared tabs on a project', async () => {
    const { gus, key, ada } = await workspace();
    const api = await key(ada);
    const v = await api.post('/views', { project: 'OPS', name: 'Urgent', type: 'board', filters: [{ field: 'priority', op: 'is', values: ['urgent'] }] });
    expect(v.body).toMatchObject({ name: 'Urgent', type: 'board', filters: [{ field: 'priority', op: 'is', values: ['urgent'] }] });
    expect((await api.patch(`/views/${v.body.id}`, { name: 'Hot' })).body.name).toBe('Hot');
    const gusApi = await key(gus);
    expect((await gusApi.get('/views')).body.data.map(x => x.name)).toEqual(['Hot']);
    expect((await gusApi.del(`/views/${v.body.id}`)).status).toBe(403);
    expect((await api.del(`/views/${v.body.id}`)).body.deleted).toBe(true);
  });
});

describe('live updates and the contract', () => {
  it('reaches open apps, as other writes do', async () => {
    const { t, bob, key } = await workspace();
    const seen = [];
    t.engine.connect(
      { uid: 'mbob', sessionId: 's', clientId: 'tab' },
      (ev, data) => ev === 'changes' && seen.push(...data),
      () => {},
    );
    const api = await key(bob);
    await api.post('/teams', { name: 'Live' });
    await api.post('/projects', { name: 'Live Project' });
    expect(seen.map(x => x.c)).toEqual(expect.arrayContaining(['teams', 'projects', 'activity', 'projOrder']));
  });

  it('declares every route once, with a unique id, and marks the ones for Owners and Admins', async () => {
    const { t } = await workspace();
    const spec = await (await t.app.request('/api/v1/openapi.json')).json();
    const ops = Object.values(spec.paths).flatMap(m => Object.values(m));
    expect(new Set(ops.map(o => o.operationId)).size).toBe(ops.length);
    expect(ops.length).toBeGreaterThan(70);
    expect(spec.paths['/workspace'].patch.description).toMatch(/Owners and Admins only/);
    expect(spec.paths['/files'].post.requestBody.content['application/octet-stream']).toBeTruthy();
    expect((await t.app.request('/api/docs')).status).toBe(200);
  });
});
