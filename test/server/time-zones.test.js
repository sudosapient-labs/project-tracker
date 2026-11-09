/* Whose clock: a person's saved time zone, else the workspace's, else UTC; never the server
   machine's (server/lib/clock.js). The suite runs with the machine on Pacific time to prove it. */
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { account, apiKey, bot, keyClient, setup } from './helpers.js';
import { clockOf, workspaceClock } from '../../server/lib/clock.js';
import { runReminders } from '../../server/jobs.js';
import migrate from '../../server/migrations/014_workspace_time_zone.js';

const machineTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'America/Los_Angeles';
});
afterAll(() => {
  if (machineTz === undefined) delete process.env.TZ;
  else process.env.TZ = machineTz;
});

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
const invite = (id, name, email, role) => ({
  c: 'members',
  id,
  k: 'put',
  v: { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
});

/* Ada (Owner), Bob (Member) and Gus (Guest), none with a time zone saved; project WEB. */
async function workspace() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([invite('mbob', 'Bob Lee', 'bob@example.com', 'Member'), invite('mgus', 'Gus Guest', 'gus@example.com', 'Guest')]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  const gus = await account(t, { name: 'Gus Guest', email: 'gus@example.com', invite: t.lastLink('gus@example.com').split('#invite/')[1] });
  await ada.c.sync([{ c: 'projects', id: 'p1', k: 'put', v: P }]);
  return {
    t,
    adaId: ada.user.id,
    ada: ada.c,
    bob: bob.c,
    gus: gus.c,
    api: keyClient(t.app, await apiKey(ada.c)),
    bobApi: keyClient(t.app, await apiKey(bob.c)),
    gusApi: keyClient(t.app, await apiKey(gus.c)),
  };
}

describe('whose clock', () => {
  it('is the person’s zone, else the workspace’s, else UTC; never the machine’s', async () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/Los_Angeles');
    const { t, adaId, ada, api } = await workspace();
    expect(clockOf(t.repo, adaId)).toEqual({ tz: 'UTC', time: '12', source: 'default' });
    expect(workspaceClock(t.repo)).toEqual({ tz: 'UTC', source: 'default' });
    expect((await api.get('/me')).body).toMatchObject({ timeZone: 'UTC', timeZoneSource: 'default' });

    expect((await api.patch('/workspace', { timeZone: 'Asia/Dubai' })).body).toMatchObject({ timeZone: 'Asia/Dubai' });
    expect(clockOf(t.repo, adaId)).toEqual({ tz: 'Asia/Dubai', time: '12', source: 'workspace' });

    // A saved value that isn't a zone (older saves stored a label) counts as none.
    await ada.put('/api/me/state', { prefs: { tz: 'India Standard Time (GMT+05:30)', timeFmt: '24' } });
    expect(clockOf(t.repo, adaId)).toEqual({ tz: 'Asia/Dubai', time: '24', source: 'workspace' });

    // (Preferences are saved key by key: each one changed is sent.)
    await ada.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata', timeFmt: '12' } });
    expect(clockOf(t.repo, adaId)).toEqual({ tz: 'Asia/Kolkata', time: '12', source: 'person' });

    // Unset again, the workspace's has no zone: UTC, not Pacific time.
    await api.patch('/workspace', { timeZone: null });
    await ada.put('/api/me/state', { prefs: { tz: '' } });
    expect(clockOf(t.repo, adaId).tz).toBe('UTC');
  });

  it('writes activity for someone with no zone on the workspace’s clock', async () => {
    const { api } = await workspace();
    await api.patch('/workspace', { timeZone: 'Asia/Kolkata' });
    const { body: task } = await api.post('/tasks', { project: 'WEB', title: 'Ship it' });
    // 20:30 UTC on Nov 9 is 2:00 AM on Nov 10 in India (and 12:30 PM on Nov 9 in Los Angeles).
    await api.patch(`/tasks/${task.key}`, { due: '2026-11-09T20:30:00Z' });
    const log = (await api.get(`/tasks/${task.key}/activity`)).body.data;
    expect(log.find(a => a.verb === 'changed due date of').extra).toBe('to Nov 10, 2:00 AM');
  });

  it('reminds someone with no zone on the workspace’s clock', async () => {
    const { t, ada, bob } = await workspace();
    await ada.sync([{ c: 'ws', k: 'patch', v: { tz: 'Asia/Kolkata' } }]);
    await ada.sync([
      { c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob', due: '2026-11-09' }) },
      { c: 'tasks', id: 't2', k: 'put', v: T('t2', { assignee: 'mbob', due: '2026-11-11' }) },
    ]);
    const notes = async () =>
      (await bob.get('/api/bootstrap')).body.data.notifs
        .filter(n => n.text === 'is overdue' || n.text === 'is due tomorrow')
        .map(n => `${n.task} ${n.text}`)
        .sort();
    runReminders(t, Date.parse('2026-11-09T18:00:00Z')); // 11:30 PM on Nov 9 in India
    expect(await notes()).toEqual([]);
    runReminders(t, Date.parse('2026-11-09T18:30:00Z')); // midnight, Nov 10, in India; 10:30 AM Nov 9 in LA
    expect(await notes()).toEqual(['t1 is overdue', 't2 is due tomorrow']);
  });

  it('a new workspace takes its owner’s zone when setup finishes, if it has none', async () => {
    const t = setup();
    const ada = await account(t);
    await ada.c.put('/api/me/state', { prefs: { tz: 'Asia/Dubai' } });
    expect((await ada.c.post('/api/workspace/onboarded')).body.ws.tz).toBe('Asia/Dubai');
    expect((await ada.c.get('/api/bootstrap')).body.data.ws.tz).toBe('Asia/Dubai');
  });
});

describe('the workspace time zone', () => {
  it('only Owners and Admins set it, to a zone that exists', async () => {
    const { api, bob, bobApi } = await workspace();
    expect((await api.get('/workspace')).body).toEqual({ name: expect.any(String), color: expect.any(String), brand: false, timeZone: null });
    expect((await bobApi.patch('/workspace', { timeZone: 'Asia/Dubai' })).status).toBe(403);
    const sync = await bob.sync([{ c: 'ws', k: 'patch', v: { tz: 'Asia/Dubai' } }]);
    expect(sync.body.results[0]).toMatchObject({ ok: false });
    const bad = await api.patch('/workspace', { timeZone: 'Mars/Olympus_Mons' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: 'timeZone' });
    expect((await api.patch('/workspace', { timeZone: '+04:00' })).status).toBe(400);
    expect((await api.get('/workspace')).body.timeZone).toBeNull();
    expect((await api.patch('/workspace', { timeZone: 'Australia/Sydney' })).body.timeZone).toBe('Australia/Sydney');
    expect((await bob.get('/api/bootstrap')).body.data.ws.tz).toBe('Australia/Sydney');
  });

  it('is kept when an app that doesn’t know it saves the whole workspace', async () => {
    const { t, ada, api } = await workspace();
    await api.patch('/workspace', { timeZone: 'Asia/Dubai' });
    const r = await ada.sync([{ c: 'ws', k: 'put', v: { name: 'Renamed', c: '#5A67D8' } }]);
    expect(r.body.results[0].ok).toBe(true);
    expect(t.repo.workspace()).toMatchObject({ name: 'Renamed', tz: 'Asia/Dubai' });
    await ada.sync([{ c: 'ws', k: 'put', v: { name: 'Renamed', c: '#5A67D8', tz: null } }]);
    expect(t.repo.workspace().tz).toBeNull();
  });
});

describe('the effective zone in the API', () => {
  it('shows each member’s zone and where it comes from, to anyone who can see them, bots included', async () => {
    const { t, ada, api, gusApi } = await workspace();
    await api.patch('/workspace', { timeZone: 'Asia/Dubai' });
    await ada.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
    const { token } = await bot(ada);
    const botApi = keyClient(t.app, token);
    const byName = list => Object.fromEntries(list.map(m => [m.name, [m.timeZone, m.timeZoneSource]]));
    for (const c of [api, gusApi, botApi]) {
      const people = byName((await c.get('/members')).body.data);
      expect(people['Ada Owner']).toEqual(['Asia/Kolkata', 'person']);
      expect(people['Bob Lee']).toEqual(['Asia/Dubai', 'workspace']);
      expect(people['Release Bot']).toEqual(['Asia/Dubai', 'workspace']);
      expect((await c.get('/members/mbob')).body).toMatchObject({ timeZone: 'Asia/Dubai', timeZoneSource: 'workspace' });
    }
    expect((await botApi.get('/me')).body).toMatchObject({ kind: 'bot', timeZone: 'Asia/Dubai', timeZoneSource: 'workspace' });
  });

  it('GET /me and /me/preferences give the zone in use; preferences.tz stays what was saved', async () => {
    const { api } = await workspace();
    await api.patch('/workspace', { timeZone: 'Asia/Dubai' });
    let p = (await api.get('/me/preferences')).body;
    expect(p.preferences.tz).toBeUndefined();
    expect(p).toMatchObject({ timeZone: 'Asia/Dubai', timeZoneSource: 'workspace' });
    // Any IANA zone, not only the few the picker used to list.
    const r = await api.patch('/me/preferences', { preferences: { tz: 'Australia/Sydney' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ preferences: { tz: 'Australia/Sydney' }, timeZone: 'Australia/Sydney', timeZoneSource: 'person' });
    expect((await api.get('/me')).body).toMatchObject({ timeZone: 'Australia/Sydney', timeZoneSource: 'person' });
    p = (await api.patch('/me/preferences', { preferences: { tz: 'Nowhere/Special' } })).body;
    expect(p).toMatchObject({ code: 'invalid_request', field: 'preferences' });
    expect(p.error).toMatch(/IANA time zone/);
  });

  it('a zone set through the API stays when an open tab saves another setting', async () => {
    const { ada, api } = await workspace();
    // The tab loaded with India, and saved it (and its theme) as the app does.
    await ada.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata', theme: 'light', dateFmt: 'MMM d' } });
    // Elsewhere (the CLI, MCP): Dubai.
    expect((await api.patch('/me/preferences', { preferences: { tz: 'Asia/Dubai' } })).status).toBe(200);
    // The tab changes its theme, sending only that, with its views.
    expect((await ada.put('/api/me/state', { prefs: { theme: 'dark' }, views: {} })).status).toBe(200);
    expect((await api.get('/me/preferences')).body).toMatchObject({
      preferences: { tz: 'Asia/Dubai', theme: 'dark', dateFmt: 'MMM d' },
      timeZone: 'Asia/Dubai',
      timeZoneSource: 'person',
    });
    // The REST PATCH still changes only what it's sent.
    await api.patch('/me/preferences', { preferences: { dateFmt: 'yyyy-MM-dd' } });
    expect((await api.get('/me/preferences')).body.preferences).toMatchObject({ tz: 'Asia/Dubai', theme: 'dark', dateFmt: 'yyyy-MM-dd' });
    // Clearing the zone is sending it empty.
    await ada.put('/api/me/state', { prefs: { tz: '' } });
    expect((await api.get('/me/preferences')).body).toMatchObject({ timeZone: 'UTC', timeZoneSource: 'default' });
  });

  it('documents the fields in the OpenAPI spec', async () => {
    const { t } = await workspace();
    const spec = await (await t.app.request('/api/v1/openapi.json')).json();
    const s = spec.components.schemas;
    for (const name of ['Member', 'Me', 'Preferences']) expect(Object.keys(s[name].properties)).toEqual(expect.arrayContaining(['timeZone', 'timeZoneSource']));
    expect(s.Workspace.properties.timeZone).toBeTruthy();
  });
});

describe('updatedSince on the caller’s clock', () => {
  it('reads a day from its start on the caller’s clock, takes a moment with its zone, and refuses one without', async () => {
    const { ada, api } = await workspace();
    await ada.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
    const at = async (iso, title) => {
      vi.useFakeTimers({ now: Date.parse(iso), toFake: ['Date'] });
      try {
        return (await api.post('/tasks', { project: 'WEB', title })).body;
      } finally {
        vi.useRealTimers();
      }
    };
    // 23:30 on Nov 9 and 00:30 on Nov 10 in India (both Nov 9 in UTC).
    await at('2026-11-09T18:00:00Z', 'Late Monday');
    await at('2026-11-09T19:00:00Z', 'Early Tuesday');
    const titles = async (since, h) => {
      const r = await api.get(`/tasks?updatedSince=${encodeURIComponent(since)}`, h);
      return r.status === 200 ? r.body.data.map(t => t.title).filter(t => t !== 'Task t1') : r;
    };
    expect(await titles('2026-11-10')).toEqual(['Early Tuesday']);
    expect(await titles('2026-11-09')).toEqual(['Early Tuesday', 'Late Monday']);
    expect(await titles('2026-11-09T18:30:00Z')).toEqual(['Early Tuesday']);
    expect(await titles('2026-11-10T00:00:00+05:30')).toEqual(['Early Tuesday']);
    expect(await titles(String(Date.parse('2026-11-09T18:30:00Z')))).toEqual(['Early Tuesday']);
    // On the clock the client names: Nov 10 starts later in Dubai.
    expect(await titles('2026-11-10', { 'sudo-time-zone': 'Asia/Dubai' })).toEqual([]);
    // Without a zone it's a different moment for each reader: refused, like dates sent to the API.
    const noZone = await titles('2026-11-10T00:00:00');
    expect(noZone.status).toBe(400);
    expect(noZone.body).toMatchObject({ code: 'invalid_request', field: 'updatedSince' });
    expect(noZone.body.error).toMatch(/time zone/);
    expect((await titles('2026-02-31')).status).toBe(400);
    expect((await titles('yesterday')).status).toBe(400);
  });

  it('says so in the OpenAPI spec', async () => {
    const { api } = await workspace();
    const spec = (await api.get('/openapi.json')).body;
    const p = spec.paths['/tasks'].get.parameters.find(x => x.name === 'updatedSince');
    expect(p.description).toMatch(/with its zone/);
    expect(p.description).toMatch(/start of that day on your clock/);
  });
});

describe('migration 014', () => {
  const db = () => {
    const d = new DatabaseSync(':memory:');
    d.exec(`CREATE TABLE workspace (id INTEGER PRIMARY KEY, data TEXT NOT NULL, onboarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE members (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE user_state (user_id TEXT PRIMARY KEY, prefs TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);`);
    d.prepare('INSERT INTO workspace VALUES (1, ?, 1, 0)').run(JSON.stringify({ name: 'Engines', c: '#5A67D8' }));
    return d;
  };
  const person = (d, id, prefs, at, member = true) => {
    if (member) d.prepare("INSERT INTO members VALUES (?, '{}')").run(id);
    d.prepare('INSERT INTO user_state VALUES (?, ?, ?)').run(id, typeof prefs === 'string' ? prefs : JSON.stringify(prefs), at);
  };
  const ws = d => JSON.parse(d.prepare('SELECT data FROM workspace WHERE id = 1').get().data);

  it('gives the workspace the zone most of its people saved', () => {
    const d = db();
    person(d, 'm1', { tz: 'Europe/London' }, 1);
    person(d, 'm2', { tz: 'Asia/Kolkata' }, 2);
    person(d, 'm3', { tz: 'Asia/Kolkata', theme: 'dark' }, 3);
    person(d, 'm4', { tz: 'India Standard Time (GMT+05:30)' }, 4);
    person(d, 'm5', { tz: 'Not/AZone' }, 5);
    person(d, 'm6', 'not json', 6);
    // People who left don't count.
    person(d, 'gone1', { tz: 'Europe/London' }, 7, false);
    person(d, 'gone2', { tz: 'Europe/London' }, 8, false);
    migrate(d);
    expect(ws(d)).toEqual({ name: 'Engines', c: '#5A67D8', tz: 'Asia/Kolkata' });
  });

  it('breaks a tie with the zone saved first, and keeps a zone already set', () => {
    const d = db();
    person(d, 'm1', { tz: 'Asia/Dubai' }, 2);
    person(d, 'm2', { tz: 'Europe/Berlin' }, 1);
    migrate(d);
    expect(ws(d).tz).toBe('Europe/Berlin');
    d.prepare('INSERT INTO members VALUES (?, ?)').run('m3', '{}');
    d.prepare('INSERT INTO user_state VALUES (?, ?, ?)').run('m3', JSON.stringify({ tz: 'Asia/Dubai' }), 3);
    migrate(d);
    expect(ws(d).tz).toBe('Europe/Berlin');
  });

  it('leaves it unset when nobody saved a zone', () => {
    const d = db();
    person(d, 'm1', {}, 1);
    person(d, 'm2', { tz: '' }, 2);
    migrate(d);
    expect(ws(d)).toEqual({ name: 'Engines', c: '#5A67D8' });
    // A database with no workspace yet (a fresh install) is left alone.
    const empty = new DatabaseSync(':memory:');
    empty.exec(
      'CREATE TABLE workspace (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE members (id TEXT PRIMARY KEY); CREATE TABLE user_state (user_id TEXT, prefs TEXT, updated_at INTEGER);',
    );
    expect(() => migrate(empty)).not.toThrow();
  });
});
