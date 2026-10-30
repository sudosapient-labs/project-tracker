import { describe, expect, it } from 'vitest';
import { account, setup } from './helpers.js';
import { runDigests, runReminders } from '../../server/jobs.js';

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

async function pair() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    {
      c: 'members',
      id: 'mbob',
      k: 'put',
      v: { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: 'eng', title: '', c: '#6B7280', status: 'invited', tz: '' },
    },
    { c: 'projects', id: 'p1', k: 'put', v: P },
  ]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  const mails = to => t.db.all('SELECT subject, body_text, link FROM outbox WHERE to_addr = ? ORDER BY id', to);
  const notifs = async c => (await c.get('/api/bootstrap')).body.data.notifs;
  return { t, ada: ada.c, adaId: ada.user.id, bob: bob.c, mails, notifs };
}

describe('notification preferences', () => {
  it('emails assignments and mentions by default, with a link to the task', async () => {
    const { ada, mails } = await pair();
    await ada.sync([{ c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob' }) }]);
    await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: { id: 'c1', task: 't1', by: 'x', at: 1, text: 'Ping @Bob Lee', re: {} } }]);
    const m = mails('bob@example.com').slice(1); // the first is the invite
    expect(m.map(x => x.subject)).toEqual(['Ada Owner assigned you WEB-201: Task t1', 'Ada Owner mentioned you in WEB-201: Task t1']);
    expect(m[0].link).toBe('http://app.test/#task/WEB-201');
  });

  it('respects switched-off preferences for the app and for email', async () => {
    const { ada, bob, mails, notifs } = await pair();
    await bob.sync([{ c: 'notifPrefs', k: 'patch', v: { assign_self: false, email_mention: false } }]);
    await ada.sync([{ c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob' }) }]);
    await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: { id: 'c1', task: 't1', by: 'x', at: 1, text: 'Ping @Bob Lee', re: {} } }]);
    expect((await notifs(bob)).map(n => n.type)).toEqual(['mention']);
    expect(mails('bob@example.com')).toHaveLength(1);
  });

  it('reaches whole teams with @Team and everyone with @workspace only when they opt in', async () => {
    const { ada, bob, notifs } = await pair();
    await ada.sync([{ c: 'tasks', id: 't1', k: 'put', v: T('t1') }]);
    await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: { id: 'c1', task: 't1', by: 'x', at: 1, text: '@Engineering please look', re: {} } }]);
    expect((await notifs(bob)).map(n => n.type)).toEqual(['mention']);
    await ada.sync([{ c: 'comments', id: 'c2', k: 'put', v: { id: 'c2', task: 't1', by: 'x', at: 1, text: 'Heads up @workspace', re: {} } }]);
    expect(await notifs(bob)).toHaveLength(1);
    await bob.sync([{ c: 'notifPrefs', k: 'patch', v: { mention_ws: true } }]);
    await ada.sync([{ c: 'comments', id: 'c3', k: 'put', v: { id: 'c3', task: 't1', by: 'x', at: 1, text: 'Heads up @workspace', re: {} } }]);
    expect(await notifs(bob)).toHaveLength(2);
  });
});

describe('scheduled jobs', () => {
  it('reminds assignees the day before a task is due and once when it is overdue', async () => {
    const { t, ada, bob, notifs } = await pair();
    const now = Date.parse('2026-11-04T12:00:00Z');
    await bob.put('/api/me/state', { prefs: { tz: 'UTC' } });
    await ada.sync([
      { c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob', due: '2026-11-05' }) },
      { c: 'tasks', id: 't2', k: 'put', v: T('t2', { assignee: 'mbob', due: '2026-11-01' }) },
      { c: 'tasks', id: 't3', k: 'put', v: T('t3', { assignee: 'mbob', due: '2026-11-01', status: 'done' }) },
      { c: 'tasks', id: 't4', k: 'put', v: T('t4', { assignee: 'mbob', due: '2026-11-20' }) },
    ]);
    const before = (await notifs(bob)).length;
    expect(runReminders(t, now)).toBe(2);
    expect(runReminders(t, now + 60_000)).toBe(0);
    const n = (await notifs(bob)).slice(0, (await notifs(bob)).length - before);
    expect(n.map(x => [x.task, x.text, x.by]).sort()).toEqual([
      ['t1', 'is due tomorrow', null],
      ['t2', 'is overdue', null],
    ]);
  });

  it('sends a weekday digest after 8:00 local time, once a day, only with unread news', async () => {
    const { t, ada, bob, mails } = await pair();
    await bob.put('/api/me/state', { prefs: { tz: 'Asia/Kolkata' } });
    await bob.sync([{ c: 'notifPrefs', k: 'patch', v: { email_digest: true } }]);
    await ada.sync([{ c: 'tasks', id: 't1', k: 'put', v: T('t1', { assignee: 'mbob' }) }]);
    const thu9 = Date.parse('2026-11-05T03:30:00Z'); // Thursday 09:00 in Kolkata
    t.db.run("UPDATE notifications SET created_at = ? WHERE user_id = 'mbob'", thu9 - 3_600_000);
    const digests = () => mails('bob@example.com').filter(m => m.subject.startsWith('Your Sudo Sapient digest'));

    expect(runDigests(t, thu9 - 2.5 * 3_600_000)).toBe(0); // 06:30: too early
    expect(runDigests(t, thu9)).toBe(1);
    expect(runDigests(t, thu9 + 600_000)).toBe(0); // already sent today
    expect(digests()).toHaveLength(1);
    expect(digests()[0].body_text).toContain('Ada Owner assigned you WEB-201 Task t1');
    expect(runDigests(t, Date.parse('2026-11-07T03:30:00Z'))).toBe(0); // Saturday
  });
});
