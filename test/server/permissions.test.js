import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';
import { openDb } from '../../server/db.js';
import { runReminders } from '../../server/jobs.js';

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
  desc: 'Secret plans for ' + id,
  milestones: [{ name: 'Launch', date: '2026-12-01' }],
  ...extra,
});
let n = 200;
const task = (id, pid, extra = {}) => ({
  id,
  key: `X-${++n}`,
  project: pid,
  title: 'Negotiate Acme price',
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
const comment = (id, tid, text = 'hello') => ({ id, task: tid, by: 'x', at: Date.now(), text, re: {} });
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });
const del = (c, id) => ({ c, id, k: 'del' });
const oks = r => r.body.results.map(x => x.ok);

/* Ada (Owner), Bob and Dan (Members), Cat (Admin) and Gus (Guest), all signed in. */
async function people() {
  const t = setup();
  const ada = await account(t);
  const join = async (id, name, email, role) => {
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    return (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  };
  const bob = await join('mbob', 'Bob Lee', 'bob@example.com', 'Member');
  const dan = await join('mdan', 'Dan Day', 'dan@example.com', 'Member');
  const cat = await join('mcat', 'Cat Admin', 'cat@example.com', 'Admin');
  const gus = await join('mgus', 'Gus Guest', 'gus@example.com', 'Guest');
  return { t, ada: ada.c, adaId: ada.user.id, bob, dan, cat, gus };
}
const boot = async c => (await c.get('/api/bootstrap')).body.data;
async function upload(t, c, q) {
  const res = await t.app.request(`/api/files?${new URLSearchParams(q)}`, {
    method: 'POST',
    headers: { 'x-requested-with': 'gr8r', 'content-type': 'text/plain', cookie: c.cookie },
    body: 'bytes',
  });
  return { status: res.status, body: await res.json() };
}
/* Live-update listeners for the given member ids. */
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

describe('A1 share-dialog privacy', () => {
  it('setting access to private in the share dialog makes the project private, and either field keeps the other in step', async () => {
    const { ada, bob } = await people();
    const c = await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    expect(c.body.results[0].v).toMatchObject({ private: false, access: 'workspace' });
    expect((await boot(bob)).tasks).toHaveLength(1);

    const r = await ada.sync([patch('projects', 'p1', { access: 'private' })]);
    expect(r.body.results[0].v).toMatchObject({ private: true, access: 'private' });
    expect((await boot(bob)).tasks).toEqual([]);
    expect((await bob.sync([patch('tasks', 't1', { title: 'x' })])).body.results[0].ok).toBe(false);

    expect((await ada.sync([patch('projects', 'p1', { private: false })])).body.results[0].v).toMatchObject({ private: false, access: 'workspace' });
    expect((await ada.sync([put('projects', project('p2', { access: 'private' }))])).body.results[0].v).toMatchObject({ private: true, access: 'private' });
  });

  it('the migration makes projects saved with access "private" actually private, and aligns access everywhere', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-mig-'));
    const file = path.join(dir, 'db.sqlite');
    const migs = path.resolve('server/migrations');
    const raw = new DatabaseSync(file);
    raw.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const f of fs.readdirSync(migs).filter(f => f < '005')) {
      raw.exec(fs.readFileSync(path.join(migs, f), 'utf8'));
      raw.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(f);
    }
    const ins = raw.prepare('INSERT INTO projects (id, data, created_at, updated_at) VALUES (?, ?, 0, 0)');
    ins.run('p1', JSON.stringify(project('p1', { access: 'private' })));
    ins.run('p2', JSON.stringify(project('p2', { private: true })));
    ins.run('p3', JSON.stringify(project('p3')));
    raw.close();

    const db = openDb(file);
    const got = Object.fromEntries(db.all('SELECT id, data FROM projects').map(r => [r.id, JSON.parse(r.data)]));
    expect(got.p1).toMatchObject({ private: true, access: 'private' });
    expect(got.p2).toMatchObject({ private: true, access: 'private' });
    expect(got.p3).toMatchObject({ private: false, access: 'workspace' });
    db.close();
  });
});

describe('A2 per-person project permissions', () => {
  it('enforces view, comment, edit and full access', async () => {
    const { t, ada, adaId, bob } = await people();
    await ada.sync([put('projects', project('p1', { members: ['mbob'], perms: { mbob: 'Can view' } })), put('tasks', task('t1', 'p1'))]);
    expect((await boot(ada)).projects[0].perms[adaId]).toBe('Full access'); // the creator

    // Can view: reads, nothing else.
    expect((await boot(bob)).tasks).toHaveLength(1);
    let r = await bob.sync([put('tasks', task('t2', 'p1')), patch('tasks', 't1', { title: 'x' }), put('comments', comment('c1', 't1'))]);
    expect(oks(r)).toEqual([false, false, false]);
    expect(r.body.results[0].error).toBe('You can only view this project.');
    expect((await upload(t, bob, { project: 'p1', name: 'a.txt' })).status).toBe(403);

    // Can comment: own comments, reactions and the "commented on" entry, but no task edits or files.
    await ada.sync([patch('projects', 'p1', { perms: { [adaId]: 'Full access', mbob: 'Can comment' } }), put('comments', comment('c0', 't1'))]);
    r = await bob.sync([
      put('comments', comment('c1', 't1')),
      put('activity', { id: 'a1', by: 'mbob', verb: 'commented on', task: 't1', project: 'p1', at: Date.now() }),
      patch('comments', 'c0', { re: { '👍': ['mbob'] } }),
      patch('tasks', 't1', { title: 'x' }),
      put('activity', { id: 'a2', by: 'mbob', verb: 'completed', task: 't1', project: 'p1', at: Date.now() }),
      put('events', { id: 'e1', title: 'Kickoff', date: '2026-11-02', time: '10:00', project: 'p1' }),
    ]);
    expect(oks(r)).toEqual([true, true, true, false, false, false]);
    expect((await bob.sync([patch('comments', 'c1', { text: 'edited' }), del('comments', 'c1')])).body.results.map(x => x.ok)).toEqual([true, true]);
    expect((await upload(t, bob, { project: 'p1', name: 'a.txt' })).status).toBe(403);

    // Can edit: tasks, files, events and views, but not the project's settings.
    await ada.sync([patch('projects', 'p1', { perms: { [adaId]: 'Full access', mbob: 'Can edit' } })]);
    r = await bob.sync([
      patch('tasks', 't1', { title: 'Edited' }),
      put('events', { id: 'e1', title: 'Kickoff', date: '2026-11-02', time: '10:00', project: 'p1' }),
      put('savedViews', { id: 'v1', project: 'p1', name: 'Mine', type: 'list', filters: [] }),
      patch('projects', 'p1', { name: 'Renamed' }),
      patch('projects', 'p1', { private: true }),
      patch('projects', 'p1', { members: ['mbob', 'mdan'] }),
      patch('projects', 'p1', { perms: { mbob: 'Full access' } }),
      patch('projects', 'p1', { archived: true }),
      del('projects', 'p1'),
    ]);
    expect(oks(r)).toEqual([true, true, true, true, false, false, false, false, false]);
    expect((await upload(t, bob, { project: 'p1', name: 'a.txt' })).status).toBe(201);

    // Full access: settings and deleting the project.
    await ada.sync([patch('projects', 'p1', { perms: { [adaId]: 'Full access', mbob: 'Full access' } })]);
    r = await bob.sync([patch('projects', 'p1', { members: ['mbob', 'mdan'], private: true }), del('projects', 'p1')]);
    expect(oks(r)).toEqual([true, true]);
  });

  it('defaults: the lead has full access, listed Guests comment, and any Member edits a workspace project', async () => {
    const { ada, bob, dan, gus } = await people();
    await ada.sync([put('projects', project('p1', { members: ['mgus'], lead: 'mbob' })), put('tasks', task('t1', 'p1'))]);
    expect(oks(await gus.sync([put('comments', comment('c1', 't1')), patch('tasks', 't1', { title: 'x' })]))).toEqual([true, false]);
    expect(oks(await dan.sync([patch('tasks', 't1', { title: 'Dan was here' }), patch('projects', 'p1', { private: true })]))).toEqual([true, false]);
    expect(oks(await bob.sync([patch('projects', 'p1', { private: true })]))).toEqual([true]);
  });
});

describe('A3 nobody can lock the owner out', () => {
  it('a Member cannot make a workspace project private to themselves', async () => {
    const { ada, bob } = await people();
    await ada.sync([put('projects', project('p1')), put('tasks', task('t1', 'p1'))]);
    const r = await bob.sync([patch('projects', 'p1', { private: true, members: ['mbob'] })]);
    expect(r.body.results[0]).toMatchObject({ ok: false, v: { private: false } });
    expect((await boot(ada)).tasks).toHaveLength(1);
  });

  it('Owners and Admins manage settings of a private project they are not in, without seeing its work', async () => {
    const { t, ada, adaId, bob, cat } = await people();
    await bob.sync([put('projects', project('p1', { private: true })), put('tasks', task('t1', 'p1')), put('comments', comment('c1', 't1'))]);
    const f = (await upload(t, bob, { project: 'p1', name: 'secret.txt' })).body.file;

    const d = await boot(ada);
    expect(d.projects[0]).toMatchObject({ id: 'p1', private: true, members: ['mbob'], perms: { mbob: 'Full access' } });
    expect(d.projects[0].desc).toBeUndefined();
    expect([d.tasks, d.comments, d.files]).toEqual([[], [], []]);
    expect((await ada.sync([patch('tasks', 't1', { title: 'x' })])).body.results[0]).toMatchObject({ ok: false, v: null });
    expect((await t.app.request(f.url, { headers: { cookie: ada.cookie } })).status).toBe(404);
    // Settings work; content doesn't.
    expect((await ada.sync([patch('projects', 'p1', { name: 'Renamed' })])).body.results[0].ok).toBe(false);
    const r = await ada.sync([patch('projects', 'p1', { members: ['mbob', adaId] })]);
    expect(r.body.results[0]).toMatchObject({ ok: true, v: { desc: 'Secret plans for p1' } });
    expect((await boot(ada)).tasks).toHaveLength(1);

    // An Admin can delete one they can't see.
    await bob.sync([put('projects', project('p2', { private: true }))]);
    expect((await cat.sync([del('projects', 'p2')])).body.results[0].ok).toBe(true);
  });
});

describe('A4 notifications respect project visibility', () => {
  it('mentions and @workspace in a private project do not reach non-members, and work cannot be assigned to them', async () => {
    const { t, ada, bob } = await people();
    await bob.sync([{ c: 'notifPrefs', k: 'patch', v: { mention_ws: true, email_comment: true } }]);
    await ada.sync([put('projects', project('sec', { private: true })), put('tasks', task('t1', 'sec'))]);
    await ada.sync([put('comments', comment('c1', 't1', 'Over to you @Bob Lee, and @workspace'))]);
    const r = await ada.sync([patch('tasks', 't1', { assignee: 'mbob' }), put('tasks', task('t2', 'sec', { assignee: 'mbob' }))]);
    expect(r.body.results.map(x => x.error)).toEqual(['Add Bob Lee to the project first.', 'Add Bob Lee to the project first.']);

    expect((await boot(bob)).notifs).toEqual([]);
    const mail = t.db.all("SELECT subject, body_text FROM outbox WHERE to_addr = 'bob@example.com'");
    expect(mail.map(m => m.subject)).toEqual([expect.stringMatching(/invited you/)]);
    expect(JSON.stringify(mail)).not.toContain('Acme');
  });

  it('reminders skip someone who has since lost access to the project', async () => {
    const { t, ada, adaId, bob } = await people();
    const now = Date.parse('2026-11-04T12:00:00Z');
    await bob.put('/api/me/state', { prefs: { tz: 'UTC' } });
    await ada.sync([
      put('projects', project('sec', { private: true, members: ['mbob'] })),
      put('tasks', task('t1', 'sec', { assignee: 'mbob', due: '2026-11-05' })),
    ]);
    await ada.sync([patch('projects', 'sec', { members: [adaId] })]);
    const before = (await boot(bob)).notifs.length;
    expect(runReminders(t, now)).toBe(0);
    expect((await boot(bob)).notifs).toHaveLength(before);
  });
});

describe('A5 private project records are not sent to everyone', () => {
  it('sends a stub to people who cannot see a project, nothing to Guests, and settings to Admins', async () => {
    const { ada, bob, cat, gus } = await people();
    await ada.sync([put('projects', project('sec', { private: true, lead: null })), put('projects', project('pub'))]);
    const stub = (await boot(bob)).projects.find(p => p.id === 'sec');
    expect(stub).toEqual({ id: 'sec', key: 'SEC', name: 'Project sec', icon: 'globe', color: 'indigo', lead: null, private: true, fav: false });
    expect((await boot(gus)).projects).toEqual([]);
    expect((await boot(gus)).projOrder).toEqual([]);
    const admin = (await boot(cat)).projects.find(p => p.id === 'sec');
    expect(Object.keys(admin).sort()).toEqual(['access', 'color', 'fav', 'icon', 'id', 'key', 'lead', 'members', 'name', 'perms', 'private']);
  });

  it('live updates and rejected changes follow the same rules', async () => {
    const { t, ada, adaId, bob } = await people();
    await ada.sync([put('projects', project('sec', { private: true })), put('tasks', task('t1', 'sec'))]);
    const seen = listen(t, 'mbob', 'mcat', 'mgus');
    await ada.sync([patch('projects', 'sec', { desc: 'Even more secret', milestones: [] })]);
    expect(seen.mbob).toEqual([{ c: 'projects', id: 'sec', v: expect.not.objectContaining({ desc: expect.anything() }) }]);
    expect(seen.mcat[0].v.members).toEqual([adaId]);
    expect(seen.mcat[0].v.desc).toBeUndefined();
    expect(seen.mgus).toEqual([]);
    // A refused write returns nothing about the hidden record.
    expect((await bob.sync([patch('tasks', 't1', { title: 'sneaky' })])).body.results[0].v).toBeNull();
    expect((await bob.sync([patch('projects', 'sec', { name: 'x' })])).body.results[0].v.desc).toBeUndefined();
  });
});

describe('A6 moving a task takes its comments, files and activity along', () => {
  it('re-scopes them and updates viewers of both projects', async () => {
    const { t, ada, adaId, bob, dan } = await people();
    await ada.sync([
      put('projects', project('one', { private: true, members: [adaId, 'mdan'] })),
      put('projects', project('two', { private: true, members: [adaId, 'mbob'] })),
      put('tasks', task('t1', 'one')),
      put('comments', comment('c1', 't1')),
      put('activity', { id: 'a1', by: adaId, verb: 'created', task: 't1', project: 'one', at: Date.now() }),
    ]);
    const f = (await upload(t, ada, { project: 'one', task: 't1', name: 'brief.txt' })).body.file;
    const seen = listen(t, 'mbob', 'mdan');

    const r = await ada.sync([patch('tasks', 't1', { project: 'two' })]);
    expect(r.body.results[0].v.key).toMatch(/^TWO-/);
    for (const [table, id] of [
      ['comments', 'c1'],
      ['files', f.id],
      ['activity', 'a1'],
    ]) {
      const row = t.db.get(`SELECT project_id, data FROM ${table} WHERE id = ?`, id);
      expect([row.project_id, JSON.parse(row.data).project]).toEqual(['two', 'two']);
    }
    const b = await boot(bob);
    // The upload logged a second entry for the task.
    expect([b.tasks.length, b.comments.length, b.files.length, b.activity.filter(a => a.task === 't1').length]).toEqual([1, 1, 1, 2]);
    expect((await t.app.request(f.url, { headers: { cookie: bob.cookie } })).status).toBe(200);
    expect((await boot(dan)).comments).toEqual([]);

    const by = (list, c) => list.filter(x => x.c === c);
    expect(by(seen.mbob, 'tasks')[0].v.project).toBe('two');
    expect(by(seen.mbob, 'comments')[0].v.project).toBe('two');
    expect(by(seen.mdan, 'tasks')).toEqual([{ c: 'tasks', id: 't1', v: null }]);
    expect(by(seen.mdan, 'comments')).toEqual([{ c: 'comments', id: 'c1', v: null }]);
    expect(by(seen.mdan, 'files')).toEqual([{ c: 'files', id: f.id, v: null }]);
  });

  it('needs edit rights in both projects', async () => {
    const { ada, adaId, bob } = await people();
    await ada.sync([
      put('projects', project('one', { members: [adaId, 'mbob'] })),
      put('projects', project('two', { members: [adaId, 'mbob'], perms: { mbob: 'Can view' } })),
      put('tasks', task('t1', 'one')),
    ]);
    const r = await bob.sync([patch('tasks', 't1', { project: 'two' })]);
    expect(r.body.results[0]).toMatchObject({ ok: false, error: 'You can only view this project.', v: { project: 'one' } });
  });
});
