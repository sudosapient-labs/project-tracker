import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';

/* The app re-reads a record with an empty patch (src/shell/sync.js) when someone else changed it
   while its own change was on the way. That read must change nothing and show nothing the person
   can't already see. */
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const project = (id, key, extra = {}) => ({
  id,
  key,
  name: key,
  icon: 'code',
  color: 'teal',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const task = (id, pid, title) => ({
  id,
  project: pid,
  title,
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
});

describe('sync guards', () => {
  it('returns the current record without changing it, and nothing for one the person can’t see', async () => {
    const t = setup();
    const ada = (await account(t)).c;
    await ada.sync([
      put('members', { id: 'mbob', name: 'Bob', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
    ]);
    const bob = (await account(t, { name: 'Bob', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] })).c;
    const r0 = await ada.sync([
      put('projects', project('pub', 'PUB')),
      put('projects', project('sec', 'SEC', { private: true })),
      put('tasks', task('t1', 'pub', 'Open')),
      put('tasks', task('t2', 'sec', 'Hidden')),
    ]);
    expect(r0.body.results.every(x => x.ok)).toBe(true);
    const before = t.db.get('SELECT * FROM tasks WHERE id = ?', 't1');

    const seen = await bob.sync([{ c: 'tasks', id: 't1', k: 'patch', v: {} }]);
    expect(seen.body.results[0]).toMatchObject({ ok: true, v: { id: 't1', title: 'Open' } });
    expect(t.db.get('SELECT * FROM tasks WHERE id = ?', 't1')).toEqual(before);

    const hidden = await bob.sync([{ c: 'tasks', id: 't2', k: 'patch', v: {} }]);
    expect(JSON.stringify(hidden.body)).not.toContain('Hidden');
    // Exactly what a record that doesn't exist gets, so hidden ids can't be probed.
    const missing = await bob.sync([{ c: 'tasks', id: 'nope', k: 'patch', v: {} }]);
    expect(hidden.body.results[0]).toEqual(missing.body.results[0]);
    expect(hidden.body.results[0]).toMatchObject({ ok: false, status: 404 });
  });

  it('refuses changes a tab sends for someone who is no longer the one signed in', async () => {
    const t = setup();
    const ada = await account(t);
    const me = (await ada.c.get('/api/bootstrap')).body.user?.id ?? (await ada.c.get('/api/auth/session')).body.user.id;
    const ops = [put('projects', project('pw', 'WHO'))];
    const other = await ada.c.post('/api/sync', { ops }, { 'x-sudo-user': 'someone-else' });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('other_user');
    expect(t.db.get('SELECT COUNT(*) n FROM projects WHERE id = ?', 'pw').n).toBe(0);
    const mine = await ada.c.post('/api/sync', { ops }, { 'x-sudo-user': me });
    expect(mine.status).toBe(200);
    expect(mine.body.results[0].ok).toBe(true);
  });
});
