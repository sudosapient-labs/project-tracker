/* Starts and dues with a time of day, end to end on the server: what the API stores, how activity,
   notifications, reminders, repeats and sort=due read them, and the migration that brought older
   values to the two stored shapes (packages/client/dates.js). Ada works in India (UTC+05:30), where
   a time between midnight and 05:30 falls on the day after its UTC day: the case that reading a
   value's day with value.slice(0, 10) gets wrong. */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { account, apiKey, keyClient, setup } from './helpers.js';
import { runReminders } from '../../server/jobs.js';
import migrate from '../../server/migrations/012_canonical_dates.js';

const P = { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] };
const T = (id, extra = {}) => ({
  id,
  key: 'WEB-' + (200 + Number(id.slice(1))),
  project: 'p1',
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

async function workspace() {
  const t = setup();
  const ada = await account(t);
  await ada.c.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
  await ada.c.sync([
    {
      c: 'members',
      id: 'mbob',
      k: 'put',
      v: { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
    },
    { c: 'projects', id: 'p1', k: 'put', v: P },
  ]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  await bob.c.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
  const api = keyClient(t.app, await apiKey(ada.c));
  const notifs = async c => (await c.get('/api/bootstrap')).body.data.notifs;
  return { t, ada: ada.c, bob: bob.c, api, notifs };
}

describe('due times through the API', () => {
  it('stores a time given with a zone in UTC, and refuses a time without one', async () => {
    const { api } = await workspace();
    const r = await api.post('/tasks', { project: 'WEB', title: 'Ship it', due: '2026-11-10T02:00+05:30' });
    expect(r.status).toBe(201);
    expect(r.body.due).toBe('2026-11-09T20:30:00.000Z');

    const bad = await api.patch(`/tasks/${r.body.key}`, { due: '2026-11-10T02:00' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'due' });
    expect(bad.body.error).toMatch(/time zone/);

    // All-day values are kept as they are; subtasks follow the same rule.
    expect((await api.patch(`/tasks/${r.body.key}`, { due: '2026-11-10' })).body.due).toBe('2026-11-10');
    const s = await api.post(`/tasks/${r.body.key}/subtasks`, { title: 'Check', due: '2026-11-10T09:00:00+05:30' });
    expect(s.body.subtasks.find(x => x.title === 'Check').due).toBe('2026-11-10T03:30:00.000Z');
  });

  it('writes activity with the day and time the person sees, not the UTC day', async () => {
    const { api } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    await api.patch(`/tasks/${task.key}`, { due: '2026-11-10T02:00:00+05:30' });
    const log = (await api.get(`/tasks/${task.key}/activity`)).body.data;
    expect(log.find(a => a.verb === 'changed due date of').extra).toBe('to Nov 10, 2:00 AM');
  });

  it('keeps a repeating task’s time of day when it schedules the next one', async () => {
    const { api } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Weekly report', due: '2026-11-09T23:59+05:30' });
    await api.patch(`/tasks/${task.key}`, { recurrence: 'Weekly' });
    await api.post(`/tasks/${task.key}/complete`);
    const next = (await api.get('/tasks?status=open')).body.data.find(t => t.title === 'Weekly report');
    expect(next.due).toBe('2026-11-16T18:29:00.000Z');
  });

  it('sorts by the moment a task is due, an all-day due counting as the end of its day for the reader', async () => {
    const { ada, api } = await workspace();
    // Nov 10 (all day), and 20:00 UTC on Nov 10, which is 01:30 on Nov 11 in India.
    await api.post('/tasks', { project: 'WEB', title: 'all day', due: '2026-11-10' });
    await api.post('/tasks', { project: 'WEB', title: 'timed', due: '2026-11-10T20:00:00Z' });
    const order = async () => (await api.get('/tasks?sort=due')).body.data.map(x => x.title);
    // In India the all-day task's day ends first.
    expect(await order()).toEqual(['all day', 'timed']);
    // In London 20:00 on Nov 10 comes before the end of Nov 10.
    await ada.put('/api/me/state', { prefs: { tz: 'Europe/London' } });
    expect(await order()).toEqual(['timed', 'all day']);
  });
});

describe('due times in notifications and reminders', () => {
  it('tells the assignee the due on their own clock', async () => {
    const { ada, bob, notifs } = await workspace();
    await ada.sync([{ c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob', due: '2026-11-09T20:30:00.000Z' }) }]);
    expect((await notifs(bob)).find(n => n.type === 'assign').snippet).toBe('Due 2026-11-10 2:00 AM · No priority');
  });

  it('calls a timed task overdue once its time has passed, and an all-day one once its day has', async () => {
    const { t, ada, bob, notifs } = await workspace();
    await ada.sync([
      // 11:59 PM on Nov 9 in India, and all of Nov 9.
      { c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob', due: '2026-11-09T18:29:00.000Z' }) },
      { c: 'tasks', id: 't2', k: 'put', v: T('t2', { assignee: 'mbob', due: '2026-11-09' }) },
    ]);
    const overdue = async () =>
      (await notifs(bob))
        .filter(n => n.text === 'is overdue')
        .map(n => n.task)
        .sort();
    runReminders(t, Date.parse('2026-11-09T18:00:00Z')); // 11:30 PM in India
    expect(await overdue()).toEqual([]);
    runReminders(t, Date.parse('2026-11-09T18:29:30Z')); // 11:59:30 PM
    expect(await overdue()).toEqual(['t1']);
    runReminders(t, Date.parse('2026-11-09T18:30:00Z')); // midnight, Nov 10
    expect(await overdue()).toEqual(['t1', 't2']);
  });
});

describe('the sync API', () => {
  it('only takes the two stored shapes', async () => {
    const { ada } = await workspace();
    const r = await ada.sync([
      { c: 'tasks', id: 't1', k: 'put', v: T('t1', { due: '2026-11-09T23:59' }) },
      { c: 'tasks', id: 't2', k: 'put', v: T('t2', { due: '2026-11-09T23:59:00+05:30' }) },
      { c: 'tasks', id: 't3', k: 'put', v: T('t3', { due: '2026-11-09T18:29:00.000Z', start: '2026-11-09' }) },
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([false, false, true]);
  });
});

describe('migration 012', () => {
  it('brings stored starts and dues to the two shapes', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE projects (id TEXT PRIMARY KEY, data TEXT);');
    const task = {
      id: 't1',
      due: '2026-11-09T23:59:00+05:30',
      start: '2026-11-09T09:00',
      subtasks: [
        { id: 's1', due: '2026-11-09' },
        { id: 's2', due: 'soon' },
      ],
    };
    const untouched = { id: 't2', due: '2026-11-09T18:29:00.000Z', start: null };
    const project = { id: 'p1', start: '2026-11-01', due: '2026-12-01T10:00:00Z', milestones: [{ name: 'Beta', date: '2026-11-15T12:00+00:00' }] };
    db.prepare('INSERT INTO tasks VALUES (?, ?)').run('t1', JSON.stringify(task));
    db.prepare('INSERT INTO tasks VALUES (?, ?)').run('t2', JSON.stringify(untouched));
    db.prepare('INSERT INTO projects VALUES (?, ?)').run('p1', JSON.stringify(project));
    migrate(db);
    const read = (table, id) => JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id).data);
    expect(read('tasks', 't1')).toEqual({
      id: 't1',
      due: '2026-11-09T18:29:00.000Z',
      start: '2026-11-09T09:00:00.000Z',
      subtasks: [
        { id: 's1', due: '2026-11-09' },
        { id: 's2', due: null },
      ],
    });
    expect(read('tasks', 't2')).toEqual(untouched);
    expect(read('projects', 'p1')).toEqual({
      id: 'p1',
      start: '2026-11-01',
      due: '2026-12-01T10:00:00.000Z',
      milestones: [{ name: 'Beta', date: '2026-11-15T12:00:00.000Z' }],
    });
  });
});
