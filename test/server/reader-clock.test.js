/* History and calendar events on the reader's clock. An activity entry that sets a start or due keeps
   the value (`when`) and each reader gets it in words on their own clock; entries from before keep
   the writer's words. A timed event is one moment (`when`), so a 10:00 standup set in India is at
   8:30 in Dubai. The suite runs with the machine on Pacific time, which must never show through. */
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, apiKey, keyClient, setup } from './helpers.js';
import { dayOf } from '../../packages/client/dates.js';
import migrate from '../../server/migrations/015_event_moments.js';

const machineTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (machineTz === undefined) delete process.env.TZ;
  else process.env.TZ = machineTz;
});

const P = { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] };
const invite = (id, name, email) => ({
  c: 'members',
  id,
  k: 'put',
  v: { id, name, email, role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
});

/* Ada (Owner) in India, Bob in Dubai, Lia in London, each with their zone saved; project WEB. */
async function workspace() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([invite('mbob', 'Bob Lee', 'bob@example.com'), invite('mlia', 'Lia Moss', 'lia@example.com')]);
  const join = email => t.lastLink(email).split('#invite/')[1];
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: join('bob@example.com') });
  const lia = await account(t, { name: 'Lia Moss', email: 'lia@example.com', invite: join('lia@example.com') });
  await ada.c.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
  await bob.c.put('/api/me/state', { prefs: { tz: 'Asia/Dubai' } });
  await lia.c.put('/api/me/state', { prefs: { tz: 'Europe/London' } });
  await ada.c.sync([{ c: 'projects', id: 'p1', k: 'put', v: P }]);
  return {
    t,
    adaId: ada.user.id,
    ada: ada.c,
    bob: bob.c,
    api: keyClient(t.app, await apiKey(ada.c)),
    bobApi: keyClient(t.app, await apiKey(bob.c)),
    liaApi: keyClient(t.app, await apiKey(lia.c)),
  };
}
const stored = (t, table, id) => JSON.parse(t.db.get(`SELECT data FROM ${table} WHERE id = ?`, id).data);
// The newest entry with this verb (the list is newest first).
const entry = async (api, key, verb) => (await api.get(`/tasks/${key}/activity`)).body.data.find(a => a.verb === verb);

describe('history on the reader’s clock', () => {
  it('a due set at 6:30 PM in India reads 5:00 PM in Dubai, set through the API', async () => {
    const { t, api, bobApi } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    expect((await api.patch(`/tasks/${task.key}`, { due: '2026-11-10T18:30:00+05:30' })).status).toBe(200);

    const mine = await entry(api, task.key, 'changed due date of');
    expect(mine).toMatchObject({ extra: 'to Nov 10, 6:30 PM', when: '2026-11-10T13:00:00.000Z' });
    expect(await entry(bobApi, task.key, 'changed due date of')).toMatchObject({ extra: 'to Nov 10, 5:00 PM', when: '2026-11-10T13:00:00.000Z' });
    // The workspace feed says the same.
    const feed = (await bobApi.get('/activity')).body.data.find(a => a.id === mine.id);
    expect(feed).toMatchObject({ extra: 'to Nov 10, 5:00 PM', when: '2026-11-10T13:00:00.000Z' });
    // Stored: the value, and the writer's words for apps from before.
    expect(stored(t, 'activity', mine.id)).toMatchObject({ extra: 'to Nov 10, 6:30 PM', when: '2026-11-10T13:00:00.000Z' });

    // A time just after midnight in India is the previous day in Dubai.
    await api.patch(`/tasks/${task.key}`, { start: '2026-11-09T00:30:00+05:30' });
    expect((await entry(bobApi, task.key, 'changed start date of')).extra).toBe('to Nov 8, 11:00 PM');
    // A day is the same day for everyone, and clearing says so.
    await api.patch(`/tasks/${task.key}`, { due: '2026-11-20' });
    expect((await entry(bobApi, task.key, 'changed due date of')).extra).toBe('to Nov 20');
    await api.patch(`/tasks/${task.key}`, { due: null });
    expect(await entry(bobApi, task.key, 'changed due date of')).toMatchObject({ extra: '(cleared)', when: null });

    // A subtask's due, too.
    const sub = (await api.post(`/tasks/${task.key}/subtasks`, { title: 'QA' })).body.subtasks.at(-1);
    await api.patch(`/tasks/${task.key}/subtasks/${sub.id}`, { due: '2026-11-10T18:30:00+05:30' });
    expect(await entry(api, task.key, 'set a subtask due date on')).toMatchObject({ extra: 'Nov 10, 6:30 PM' });
    expect(await entry(bobApi, task.key, 'set a subtask due date on')).toMatchObject({ extra: 'Nov 10, 5:00 PM', when: '2026-11-10T13:00:00.000Z' });
    // Entries about anything else carry no value.
    expect((await entry(bobApi, task.key, 'created')).when).toBeUndefined();
  });

  it('a due set at 6:30 PM in India reads 5:00 PM in Dubai, set in the app (sync)', async () => {
    const { t, ada, adaId, api, bobApi } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    // What the app sends for a due change (actions.js applyPatch): the task, and the entry with the value.
    const r = await ada.sync([
      { c: 'tasks', id: task.id, k: 'patch', v: { due: '2026-11-10T13:00:00.000Z' } },
      {
        c: 'activity',
        id: 'a_due',
        k: 'put',
        v: {
          id: 'a_due',
          by: adaId,
          verb: 'changed due date of',
          task: task.id,
          project: 'p1',
          at: Date.now(),
          extra: 'to Nov 10, 6:30 PM',
          when: '2026-11-10T13:00:00.000Z',
        },
      },
    ]);
    expect(r.body.results.every(x => x.ok)).toBe(true);
    expect(await entry(bobApi, task.key, 'changed due date of')).toMatchObject({ id: 'a_due', extra: 'to Nov 10, 5:00 PM' });
    expect(stored(t, 'activity', 'a_due').extra).toBe('to Nov 10, 6:30 PM');

    // A value that isn't one of the two stored shapes is refused.
    const bad = await ada.sync([
      {
        c: 'activity',
        id: 'a_bad',
        k: 'put',
        v: { id: 'a_bad', by: adaId, verb: 'changed due date of', task: task.id, project: 'p1', at: Date.now(), extra: 'to Nov 10', when: '2026-11-10T18:30' },
      },
    ]);
    expect(bad.body.results[0]).toMatchObject({ ok: false, status: 400 });
  });

  it('entries from before keep the words they were written with', async () => {
    const { ada, adaId, api, bobApi } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    await ada.sync([
      {
        c: 'activity',
        id: 'a_old',
        k: 'put',
        v: { id: 'a_old', by: adaId, verb: 'changed due date of', task: task.id, project: 'p1', at: Date.now(), extra: 'to Nov 10, 6:30 PM' },
      },
    ]);
    const old = await entry(bobApi, task.key, 'changed due date of');
    expect(old.extra).toBe('to Nov 10, 6:30 PM');
    expect('when' in old).toBe(false);
  });
});

describe('calendar events on the reader’s clock', () => {
  it('a 10:00 event set in India is at 08:30 in Dubai, and one at 01:00 is the day before in London', async () => {
    const { t, api, bobApi, liaApi } = await workspace();
    const { status, body: standup } = await api.post('/events', { title: 'Standup', date: '2026-11-20', time: '10:00', project: 'WEB' });
    expect(status).toBe(201);
    expect(standup).toMatchObject({ date: '2026-11-20', time: '10:00', when: '2026-11-20T04:30:00.000Z' });
    // Stored as the moment, plus the day and time on the saver's clock for apps from before.
    expect(stored(t, 'events', standup.id)).toMatchObject({ when: '2026-11-20T04:30:00.000Z', date: '2026-11-20', time: '10:00' });

    const early = (await api.post('/events', { title: 'Deploy', date: '2026-11-21', time: '01:00', project: 'WEB' })).body;
    const allDay = (await api.post('/events', { title: 'Offsite', date: '2026-11-21', project: 'WEB' })).body;
    expect(allDay).toMatchObject({ date: '2026-11-21', time: '', when: '2026-11-21' });

    const view = async (a, q = '') => (await a.get('/events' + q)).body.data.map(e => `${e.date} ${e.time || 'all day'} ${e.title}`);
    expect(await view(bobApi)).toEqual(['2026-11-20 08:30 Standup', '2026-11-20 23:30 Deploy', '2026-11-21 all day Offsite']);
    expect(await view(liaApi)).toEqual(['2026-11-20 04:30 Standup', '2026-11-20 19:30 Deploy', '2026-11-21 all day Offsite']);
    // Days to filter on are the reader's.
    expect(await view(liaApi, '?from=2026-11-21')).toEqual(['2026-11-21 all day Offsite']);
    // An all-day event comes first on its day.
    expect(await view(api, '?from=2026-11-21')).toEqual(['2026-11-21 all day Offsite', '2026-11-21 01:00 Deploy']);
    expect(await view(liaApi, '?to=2026-11-20')).toEqual(['2026-11-20 04:30 Standup', '2026-11-20 19:30 Deploy']);

    // Moving it in Dubai: a new time keeps the day as Bob sees it; Ada sees it on her clock.
    expect((await bobApi.patch(`/events/${standup.id}`, { time: '09:00' })).body).toMatchObject({
      date: '2026-11-20',
      time: '09:00',
      when: '2026-11-20T05:00:00.000Z',
    });
    expect((await api.get('/events')).body.data.find(e => e.id === standup.id)).toMatchObject({ date: '2026-11-20', time: '10:30' });
    // A new day keeps the time; an empty time makes it all day.
    expect((await bobApi.patch(`/events/${standup.id}`, { date: '2026-11-23' })).body).toMatchObject({ date: '2026-11-23', time: '09:00' });
    expect((await bobApi.patch(`/events/${standup.id}`, { time: '' })).body).toMatchObject({ date: '2026-11-23', time: '', when: '2026-11-23' });
    expect((await api.patch(`/events/${early.id}`, { time: '25:00' })).status).toBe(400);
  });

  it('reads an older app’s day and time on its person’s clock, and keeps them for older apps', async () => {
    const { t, ada, bob, bobApi } = await workspace();
    // An app from before `when` sends a day and a time (Ada is in India).
    const put = await ada.sync([{ c: 'events', id: 'e_old', k: 'put', v: { id: 'e_old', title: 'Review', date: '2026-11-22', time: '10:00', project: 'p1' } }]);
    expect(put.body.results[0].ok).toBe(true);
    expect(stored(t, 'events', 'e_old')).toMatchObject({ when: '2026-11-22T04:30:00.000Z', date: '2026-11-22', time: '10:00' });
    expect((await bobApi.get('/events')).body.data[0]).toMatchObject({ date: '2026-11-22', time: '08:30' });
    // Bob's older app moves it to noon, on his clock (Dubai).
    await bob.sync([{ c: 'events', id: 'e_old', k: 'patch', v: { time: '12:00' } }]);
    expect(stored(t, 'events', 'e_old')).toMatchObject({ when: '2026-11-22T08:00:00.000Z', date: '2026-11-22', time: '12:00' });
    // A current app sends `when`; the day and time for older apps follow, on the saver's clock.
    await ada.sync([{ c: 'events', id: 'e_old', k: 'patch', v: { when: '2026-11-22T20:00:00.000Z' } }]);
    expect(stored(t, 'events', 'e_old')).toMatchObject({ when: '2026-11-22T20:00:00.000Z', date: '2026-11-23', time: '01:30' });
    // A rename leaves them alone.
    await bob.sync([{ c: 'events', id: 'e_old', k: 'patch', v: { title: 'Design review' } }]);
    expect(stored(t, 'events', 'e_old')).toMatchObject({ date: '2026-11-23', time: '01:30' });
    // What can't be read is refused, never stored as some other moment.
    const bad = await ada.sync([
      { c: 'events', id: 'e_bad1', k: 'put', v: { id: 'e_bad1', title: 'x', date: '2026-02-31', time: '10:00', project: 'p1' } },
      { c: 'events', id: 'e_bad2', k: 'put', v: { id: 'e_bad2', title: 'x', date: '2026-11-22', time: '24:00', project: 'p1' } },
      { c: 'events', id: 'e_bad3', k: 'put', v: { id: 'e_bad3', title: 'x', when: '2026-11-22T10:00', project: 'p1' } },
      { c: 'events', id: 'e_bad4', k: 'put', v: { id: 'e_bad4', title: 'x', project: 'p1' } },
    ]);
    expect(bad.body.results.map(r => r.status)).toEqual([400, 400, 400, 400]);
  });
});

/* Sudo-Time-Zone: a client acting for someone on another clock (the Slack bot, one key for a team)
   names their zone, and for that request the API words and reads days on it. Ada's key is India's. */
describe('a request on the clock the client names (Sudo-Time-Zone)', () => {
  const DUBAI = { 'sudo-time-zone': 'Asia/Dubai' };

  it('words history on that clock, keeping the key’s person’s time format', async () => {
    const { ada, api } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    await api.patch(`/tasks/${task.key}`, { due: '2026-11-10T18:30:00+05:30' });
    const extra = async h => (await api.get(`/tasks/${task.key}/activity`, h)).body.data.find(a => a.verb === 'changed due date of').extra;
    expect(await extra()).toBe('to Nov 10, 6:30 PM');
    expect(await extra(DUBAI)).toBe('to Nov 10, 5:00 PM');
    expect(await extra({ 'sudo-time-zone': ' Asia/Dubai ' })).toBe('to Nov 10, 5:00 PM');
    // The workspace feed too.
    expect((await api.get('/activity', DUBAI)).body.data.find(a => a.verb === 'changed due date of').extra).toBe('to Nov 10, 5:00 PM');
    // 24-hour time is Ada's setting, and stays hers.
    await ada.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata', timeFmt: '24' } });
    expect(await extra(DUBAI)).toBe('to Nov 10, 17:00');
    expect(await extra()).toBe('to Nov 10, 18:30');
  });

  it('ignores a value that isn’t a time zone', async () => {
    const { api } = await workspace();
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    await api.patch(`/tasks/${task.key}`, { due: '2026-11-10T18:30:00+05:30' });
    for (const tz of ['+04:00', 'Mars/Olympus_Mons', 'Dubai', '', 'x'.repeat(65)]) {
      const r = await api.get(`/tasks/${task.key}/activity`, { 'sudo-time-zone': tz });
      expect(r.status, tz).toBe(200);
      expect(r.body.data.find(a => a.verb === 'changed due date of').extra, tz).toBe('to Nov 10, 6:30 PM');
    }
  });

  it('reads and words events, sort=due and “today” on that clock', async () => {
    const { api } = await workspace();
    // Sent from Dubai: 10:00 there is 11:30 in India.
    const { body: ev } = await api.post('/events', { title: 'Standup', date: '2026-11-20', time: '10:00', project: 'WEB' }, DUBAI);
    expect(ev).toMatchObject({ date: '2026-11-20', time: '10:00', when: '2026-11-20T06:00:00.000Z' });
    expect((await api.get('/events')).body.data[0]).toMatchObject({ date: '2026-11-20', time: '11:30' });
    // 01:00 on Nov 21 in India is still Nov 20 in Dubai, for the answer and for `from` / `to`.
    await api.post('/events', { title: 'Deploy', date: '2026-11-21', time: '01:00', project: 'WEB' });
    expect((await api.get('/events?from=2026-11-21')).body.data.map(e => e.title)).toEqual(['Deploy']);
    expect((await api.get('/events?from=2026-11-21', DUBAI)).body.data).toEqual([]);
    expect((await api.get('/events?to=2026-11-20', DUBAI)).body.data.map(e => `${e.time} ${e.title}`)).toEqual(['10:00 Standup', '23:30 Deploy']);

    // Nov 10 all day, and 20:00 UTC on Nov 10 (01:30 on Nov 11 in India, 20:00 in London).
    await api.post('/tasks', { project: 'WEB', title: 'all day', due: '2026-11-10' });
    await api.post('/tasks', { project: 'WEB', title: 'timed', due: '2026-11-10T20:00:00Z' });
    const order = async h => (await api.get('/tasks?sort=due', h)).body.data.map(x => x.title);
    expect(await order()).toEqual(['all day', 'timed']);
    expect(await order({ 'sudo-time-zone': 'Europe/London' })).toEqual(['timed', 'all day']);

    // A new project starts today on that clock (UTC+14 and UTC−11 are always on different days).
    const start = async tz => (await api.post('/projects', { name: `From ${tz}` }, { 'sudo-time-zone': tz })).body.start;
    const east = await start('Pacific/Kiritimati');
    const west = await start('Pacific/Pago_Pago');
    expect([east, west]).toEqual([dayOf(Date.now(), 'Pacific/Kiritimati'), dayOf(Date.now(), 'Pacific/Pago_Pago')]);
    expect(east).not.toBe(west);
  });

  it('saves no zone and leaves everyone else’s clock alone', async () => {
    const { t, adaId, api, bobApi } = await workspace();
    // Ada's own zone is still what she and others are told.
    expect((await api.get('/me/preferences', DUBAI)).body).toMatchObject({
      timeZone: 'Asia/Kolkata',
      timeZoneSource: 'person',
      preferences: { tz: 'Asia/Kolkata' },
    });
    expect((await api.get('/me', DUBAI)).body).toMatchObject({ timeZone: 'Asia/Kolkata', timeZoneSource: 'person' });
    expect((await api.get('/members', DUBAI)).body.data.find(m => m.id === 'mbob')).toMatchObject({ timeZone: 'Asia/Dubai' });
    expect(t.repo.userState(adaId).prefs.tz).toBe('Asia/Kolkata');

    // Bob is told about a task assigned to him on his clock, whatever clock the request was on.
    await api.post('/tasks', { project: 'WEB', title: 'For Bob', assignee: 'mbob', due: '2026-11-09T20:30:00.000Z' }, { 'sudo-time-zone': 'America/New_York' });
    expect((await bobApi.get('/notifications')).body.data.find(n => n.type === 'assign').snippet).toBe('Due 2026-11-10 12:30 AM · No priority');

    // A repeating task keeps its time of day on Ada's clock (India has no daylight saving; London
    // leaves it on Oct 25, which would move it an hour).
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Weekly report', due: '2026-10-20T23:59+05:30', recurrence: 'Weekly' });
    await api.post(`/tasks/${task.key}/complete`, {}, { 'sudo-time-zone': 'Europe/London' });
    const next = (await api.get('/tasks?status=open')).body.data.find(x => x.title === 'Weekly report');
    expect(next.due).toBe('2026-10-27T18:29:00.000Z');
  });
});

describe('migration 015', () => {
  const db = ws => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE workspace (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE events (id TEXT PRIMARY KEY, project_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
    if (ws) d.prepare('INSERT INTO workspace VALUES (1, ?)').run(JSON.stringify(ws));
    return d;
  };
  const add = (d, e) => d.prepare('INSERT INTO events VALUES (?, ?, ?, 0, 0)').run(e.id, e.project ?? null, JSON.stringify(e));
  const get = (d, id) => JSON.parse(d.prepare('SELECT data FROM events WHERE id = ?').get(id).data);

  it('reads timed events on the workspace’s clock and leaves all-day ones a day', () => {
    const d = db({ name: 'Engines', tz: 'Asia/Kolkata' });
    add(d, { id: 'e1', title: 'Standup', date: '2026-11-20', time: '10:00', project: 'p1' });
    add(d, { id: 'e2', title: 'Late', date: '2026-11-20', time: '01:00', project: null });
    add(d, { id: 'e3', title: 'Offsite', date: '2026-11-21', time: '', project: 'p1' });
    add(d, { id: 'e4', title: 'Already', date: '2026-11-20', time: '10:00', when: '2026-11-20T10:00:00.000Z', project: 'p1' });
    add(d, { id: 'e5', title: 'No such day', date: '2026-02-31', time: '10:00', project: 'p1' });
    migrate(d);
    expect(get(d, 'e1')).toEqual({ id: 'e1', title: 'Standup', date: '2026-11-20', time: '10:00', project: 'p1', when: '2026-11-20T04:30:00.000Z' });
    expect(get(d, 'e2').when).toBe('2026-11-19T19:30:00.000Z');
    expect(get(d, 'e3')).toMatchObject({ when: '2026-11-21', date: '2026-11-21', time: '' });
    expect(get(d, 'e4').when).toBe('2026-11-20T10:00:00.000Z');
    expect('when' in get(d, 'e5')).toBe(false);
  });

  it('reads them as UTC when the workspace has no zone, or there is no workspace yet', () => {
    const d = db({ name: 'Engines' });
    add(d, { id: 'e1', title: 'Standup', date: '2026-11-20', time: '10:00', project: 'p1' });
    migrate(d);
    expect(get(d, 'e1').when).toBe('2026-11-20T10:00:00.000Z');
    const fresh = db(null);
    expect(() => migrate(fresh)).not.toThrow();
  });

  it('an event the migration couldn’t read still lists, with the day and time it was saved with', async () => {
    const { t, api } = await workspace();
    t.repo.put('events', { id: 'e_odd', title: 'Odd', date: '2026-02-31', time: '10:00', project: 'p1' }, 'p1');
    expect((await api.get('/events')).body.data).toEqual([{ id: 'e_odd', title: 'Odd', date: '2026-02-31', time: '10:00', when: null, project: 'p1' }]);
  });
});
