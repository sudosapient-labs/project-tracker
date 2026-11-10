/* A task's status lifecycle belongs to the server (server/sync/task-status.js): finishing a task
   stamps when, reopening clears it, a repeating task finished with a due date gets exactly one next
   occurrence, and reopening removes that occurrence only if it came from this task and nobody has
   worked on it since. Whatever a client sends for those fields is ignored, through sync and the
   REST API alike. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { account, apiKey, keyClient, setup } from './helpers.js';
import migrate from '../../server/migrations/013_repeat_links.js';
import { fingerprint } from '../../server/sync/task-status.js';

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
const task = (id, pid, key, extra = {}) => ({
  id,
  key,
  project: pid,
  title: 'Water the plants',
  status: 'todo',
  assignee: null,
  priority: 'none',
  due: null,
  start: null,
  labels: [],
  subtasks: [],
  attachments: [],
  deps: [],
  desc: '',
  estimate: null,
  created: 1,
  updated: 1,
  order: 1,
  recur: null,
  ...extra,
});
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });

/* Ada (Owner) and Bob (Member) on an open project WEB with a weekly task due Nov 20. */
async function workspace() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    put('members', { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
  ]);
  const bob = (await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] })).c;
  await ada.c.sync([put('projects', project('pweb', 'WEB')), put('tasks', task('trec', 'pweb', 'WEB-201', { recur: 'Weekly', due: '2026-11-20' }))]);
  const key = async c => keyClient(t.app, await apiKey(c), { client: 'Test' });
  const get = id => t.repo.get('tasks', id);
  const copies = () => t.repo.all('tasks', "WHERE json_extract(data, '$.title') = 'Water the plants' AND id != 'trec'");
  return { t, ada: ada.c, bob, key, get, copies };
}

describe('completing and reopening through sync', () => {
  it('stamps completedAt from the server’s clock and clears it on reopen, whatever the client sends', async () => {
    const { ada, get } = await workspace();
    const before = Date.now();
    const r = await ada.sync([patch('tasks', 'trec', { status: 'done', completedAt: 5, prevStatus: 'review' })]);
    expect(r.body.results[0].ok).toBe(true);
    expect(get('trec').completedAt).toBeGreaterThanOrEqual(before);
    expect(get('trec').prevStatus).toBe('todo');
    // A completion time on a task that isn't done is ignored.
    await ada.sync([patch('tasks', 'trec', { status: 'progress' })]);
    expect(get('trec')).toMatchObject({ status: 'progress' });
    expect(get('trec').completedAt).toBeUndefined();
    expect(get('trec').prevStatus).toBeUndefined();
    await ada.sync([patch('tasks', 'trec', { completedAt: 123, prevStatus: 'review' })]);
    expect(get('trec').completedAt).toBeUndefined();
    expect(get('trec').prevStatus).toBeUndefined();
    // Created as done: finished now.
    await ada.sync([put('tasks', task('tdone', 'pweb', 'WEB-202', { title: 'Done already', status: 'done', completedAt: 7 }))]);
    expect(get('tdone').completedAt).toBeGreaterThanOrEqual(before);
  });

  it('a repeating task schedules one next occurrence, and the tab that finished it receives it', async () => {
    const { ada, get, copies } = await workspace();
    const r = await ada.sync([patch('tasks', 'trec', { status: 'done', updated: Date.now() })]);
    expect(copies()).toHaveLength(1);
    const n = copies()[0];
    expect(n).toMatchObject({ status: 'todo', due: '2026-11-27', start: '2026-11-27', recur: 'Weekly', repeatOf: { id: 'trec' } });
    expect(get('trec').nextId).toBe(n.id);
    expect(r.body.results[0].v.nextId).toBe(n.id);
    // The new task is in the answer to the batch that made it (the live stream skips this tab).
    expect(r.body.changes).toContainEqual({ c: 'tasks', id: n.id, v: expect.objectContaining({ key: n.key, status: 'todo' }) });
    // Reopened: the untouched occurrence goes, and the tab hears of it the same way.
    const back = await ada.sync([patch('tasks', 'trec', { status: 'todo' })]);
    expect(copies()).toHaveLength(0);
    expect(get('trec').nextId).toBeUndefined();
    expect(back.body.changes).toContainEqual({ c: 'tasks', id: n.id, v: null });
  });

  it('two people finishing the same repeating task at once make one next occurrence', async () => {
    const { ada, bob, copies } = await workspace();
    // Both tabs still show it open and send the same change; the second arrives once it's done.
    await Promise.all([ada.sync([patch('tasks', 'trec', { status: 'done' })]), bob.sync([patch('tasks', 'trec', { status: 'done' })])]);
    expect(copies()).toHaveLength(1);
    // And twice in one batch.
    await ada.sync([patch('tasks', 'trec', { status: 'todo' })]);
    await ada.sync([patch('tasks', 'trec', { status: 'done' }), patch('tasks', 'trec', { status: 'review' }), patch('tasks', 'trec', { status: 'done' })]);
    expect(copies()).toHaveLength(1);
  });

  it('a nextId sent by a client is ignored, so reopening never deletes an unrelated task', async () => {
    const { ada, bob, key, get } = await workspace();
    await ada.sync([put('tasks', task('tother', 'pweb', 'WEB-202', { title: 'Someone else’s work', created: 1, updated: 1 }))]);
    // Done without a due date: nothing to schedule. Bob points it at an unrelated untouched task.
    await ada.sync([patch('tasks', 'trec', { due: null })]);
    await ada.sync([patch('tasks', 'trec', { status: 'done' })]);
    const r = await bob.sync([patch('tasks', 'trec', { nextId: 'tother' })]);
    // Reopening, through the API and through sync, leaves it alone.
    const api = await key(ada);
    expect((await api.patch('/tasks/WEB-201', { status: 'todo' })).status).toBe(200);
    expect(get('tother')).toMatchObject({ title: 'Someone else’s work' });
    expect(r.body.results[0].v.nextId).toBeUndefined();
    expect(get('trec').nextId).toBeUndefined();
    await ada.sync([patch('tasks', 'trec', { status: 'done' })]);
    await bob.sync([patch('tasks', 'trec', { nextId: 'tother' })]);
    await ada.sync([patch('tasks', 'trec', { status: 'todo' })]);
    expect(get('tother')).toMatchObject({ title: 'Someone else’s work' });
  });

  it('an occurrence someone has worked on stays when the original is reopened, whatever its timestamps say', async () => {
    const { ada, bob, key, get, copies } = await workspace();
    const api = await key(ada);
    await api.post('/tasks/WEB-201/complete');
    const n = copies()[0];
    // Bob raises its priority but his client leaves `updated` as it was.
    await bob.sync([patch('tasks', n.id, { priority: 'high', updated: n.created })]);
    await api.patch('/tasks/WEB-201', { status: 'todo' });
    expect(get(n.id)).toMatchObject({ priority: 'high' });
    // Still linked, so finishing again adds no other.
    expect(get('trec').nextId).toBe(n.id);
    await ada.sync([patch('tasks', 'trec', { status: 'done' })]);
    expect(copies()).toHaveLength(1);
  });

  it('an occurrence whose only change is a newer `updated` still counts as untouched', async () => {
    const { ada, get, copies } = await workspace();
    await ada.sync([patch('tasks', 'trec', { status: 'done' })]);
    const n = copies()[0];
    await ada.sync([patch('tasks', n.id, { updated: Date.now() + 60_000 })]);
    await ada.sync([patch('tasks', 'trec', { status: 'todo' })]);
    expect(get(n.id)).toBeNull();
  });
});

describe('completing and reopening through the API', () => {
  it('reopening clears completedAt', async () => {
    const { ada, key } = await workspace();
    const api = await key(ada);
    expect((await api.post('/tasks/WEB-201/complete')).body.completedAt).toBeGreaterThan(0);
    expect((await api.patch('/tasks/WEB-201', { status: 'review' })).body.completedAt).toBeNull();
  });

  it('two completions at once make one next occurrence', async () => {
    const { ada, bob, key, copies } = await workspace();
    const [a, b] = [await key(ada), await key(bob)];
    await Promise.all([a.post('/tasks/WEB-201/complete'), b.post('/tasks/WEB-201/complete')]);
    expect(copies()).toHaveLength(1);
  });

  it('a duplicate or a task created done carries no lifecycle links', async () => {
    const { ada, key, get, copies } = await workspace();
    const api = await key(ada);
    await api.post('/tasks/WEB-201/complete');
    const n = copies()[0];
    const dup = (await api.post(`/tasks/${n.key}/duplicate`)).body;
    expect(get(dup.id).repeatOf).toBeUndefined();
    const dup2 = (await api.post('/tasks/WEB-201/duplicate')).body;
    expect(get(dup2.id).nextId).toBeUndefined();
    expect(dup2.completedAt).toBeGreaterThan(0);
    const created = (await api.post('/tasks', { project: 'WEB', title: 'Was done', status: 'done' })).body;
    expect(created.completedAt).toBeGreaterThan(0);
  });
});

describe('migration 013', () => {
  it('links the next occurrences made before, keeping any someone has worked on', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT, created_at INTEGER)');
    const rows = [
      task('a', 'p1', 'WEB-201', { status: 'done', nextId: 'a2', completedAt: 5, prevStatus: 'todo' }),
      task('a2', 'p1', 'WEB-202', { created: 9, updated: 9 }),
      task('b', 'p1', 'WEB-203', { title: 'Report', status: 'done', nextId: 'b2' }),
      task('b2', 'p1', 'WEB-204', { title: 'Report', created: 9, updated: 12 }),
      // Pointed (by a client) at an unrelated task, already claimed by another, or at one that's gone.
      task('c', 'p1', 'WEB-205', { title: 'Other', status: 'done', nextId: 'a2' }),
      task('d', 'p1', 'WEB-206', { title: 'Gone', status: 'done', nextId: 'nope' }),
      // Reopened without clearing when it was finished.
      task('e', 'p1', 'WEB-207', { title: 'Open again', completedAt: 5, prevStatus: 'review' }),
      // What clients could store before: a cleared link from the API, any prevStatus, a link of their own.
      task('f', 'p1', 'WEB-208', { title: 'Odd', status: 'done', nextId: null, prevStatus: 'whatever', repeatOf: 'a' }),
    ];
    rows.forEach((r, i) => db.prepare('INSERT INTO tasks VALUES (?, ?, ?)').run(r.id, JSON.stringify(r), i));
    migrate(db);
    const read = id => JSON.parse(db.prepare('SELECT data FROM tasks WHERE id = ?').get(id).data);
    expect(read('a')).toMatchObject({ nextId: 'a2', completedAt: 5, prevStatus: 'todo' });
    expect(read('a2').repeatOf).toEqual({ id: 'a', sum: fingerprint(read('a2')) });
    expect(read('b2').repeatOf).toEqual({ id: 'b', sum: null });
    expect(read('c').nextId).toBeUndefined();
    expect(read('d').nextId).toBeUndefined();
    expect(read('e').completedAt).toBeUndefined();
    expect(read('e').prevStatus).toBeUndefined();
    expect('nextId' in read('f') || 'prevStatus' in read('f') || 'repeatOf' in read('f')).toBe(false);
  });
});
