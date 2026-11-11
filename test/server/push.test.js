import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createPusher } from '../../server/lib/push.js';
import { runReminders } from '../../server/jobs.js';
import { account, setup } from './helpers.js';

const sub = n => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${n}`, keys: { p256dh: 'BKey' + n, auth: 'auth' + n } });

/* Owner plus Bob (invited, signed up), with a push-service stand-in that records deliveries. */
async function pair(statuses = []) {
  const sent = [];
  const pushSend = async (s, payload) => {
    sent.push({ endpoint: s.endpoint, msg: JSON.parse(payload) });
    const code = statuses.shift();
    if (code) throw Object.assign(new Error('gone'), { statusCode: code });
  };
  const t = setup({}, { pushSend });
  const ada = await account(t);
  await ada.c.sync([
    {
      c: 'members',
      id: 'mbob',
      k: 'put',
      v: { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' },
    },
    {
      c: 'projects',
      id: 'p1',
      k: 'put',
      v: { id: 'p1', key: 'WEB', name: 'Web', icon: 'globe', color: 'indigo', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] },
    },
  ]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  const assign = id =>
    ada.c.sync([
      {
        c: 'tasks',
        id,
        k: 'put',
        v: {
          id,
          key: 'WEB-201',
          project: 'p1',
          title: 'Hero',
          status: 'todo',
          assignee: 'mbob',
          priority: 'high',
          labels: [],
          subtasks: [],
          attachments: [],
          deps: [],
          desc: '',
          created: 1,
          updated: 1,
          order: 1,
        },
      },
    ]);
  return { t, ada: ada.c, adaId: ada.user.id, bob: bob.c, sent, assign, flush: () => new Promise(r => setTimeout(r, 20)) };
}

describe('web push', () => {
  it('generates VAPID keys once and keeps them', () => {
    const db = openDb(':memory:');
    const config = loadConfig({ NODE_ENV: 'test' });
    const a = createPusher(db, config);
    expect(a.publicKey).toMatch(/^B[A-Za-z0-9_-]{80,}$/);
    expect(createPusher(db, config).publicKey).toBe(a.publicKey);
  });

  it('pushes a notification to every browser the person subscribed, linking to the task', async () => {
    const { bob, sent, assign, flush } = await pair();
    expect((await bob.get('/api/push/key')).body.publicKey).toMatch(/^B/);
    expect((await bob.post('/api/push/subscriptions', sub(1))).status).toBe(201);
    expect((await bob.post('/api/push/subscriptions', sub(2))).status).toBe(201);
    expect((await bob.post('/api/push/subscriptions', { ...sub(3), endpoint: 'http://insecure.example.com/x' })).status).toBe(400);
    await assign('t1');
    await flush();
    expect(sent.map(s => s.endpoint).sort()).toEqual([sub(1).endpoint, sub(2).endpoint]);
    expect(sent[0].msg).toMatchObject({ title: 'Ada Owner assigned you WEB-201: Hero', body: 'High priority', url: '/#task/WEB-201' });
  });

  it('respects the Push preference and forgets subscriptions the push service says are gone', async () => {
    const { bob, sent, assign, flush, t } = await pair([410]);
    await bob.post('/api/push/subscriptions', sub(1));
    await assign('t1');
    await flush();
    expect(sent).toHaveLength(1);
    expect(t.db.get('SELECT COUNT(*) n FROM push_subscriptions').n).toBe(0);

    await bob.post('/api/push/subscriptions', sub(2));
    await bob.sync([{ c: 'notifPrefs', k: 'patch', v: { push_assign: false } }]);
    await assign('t2');
    await flush();
    expect(sent).toHaveLength(1);
  });

  it('a signed-out browser stops receiving pushes', async () => {
    const { bob, sent, assign, flush } = await pair();
    await bob.post('/api/push/subscriptions', sub(1));
    await bob.post('/api/push/unsubscribe', { endpoint: sub(1).endpoint });
    await assign('t1');
    await flush();
    expect(sent).toEqual([]);
  });

  /* Phones cut a notification's title short, so each kind's title is a complete phrase that starts
     with who and what and names the task; the body adds the comment or details. */
  it('every kind of push has a complete title, key information first', async () => {
    const { t, ada, adaId, bob, sent, assign, flush } = await pair();
    await bob.post('/api/push/subscriptions', sub(1));
    await ada.post('/api/push/subscriptions', sub(2));
    const to = e => sent.filter(s => s.endpoint === sub(e).endpoint).map(s => s.msg);
    await assign('t1');
    await ada.sync([{ c: 'comments', id: 'c1', k: 'put', v: { id: 'c1', task: 't1', by: 'x', at: 1, text: 'Ping @Bob Lee about the hero copy', re: {} } }]);
    await ada.sync([{ c: 'comments', id: 'c2', k: 'put', v: { id: 'c2', task: 't1', by: 'x', at: 2, text: 'Looks good now', re: {} } }]);
    await ada.sync([{ c: 'tasks', id: 't1', k: 'patch', v: { due: '2026-11-05' } }]);
    runReminders(t, Date.parse('2026-11-04T12:00:00Z'));
    runReminders(t, Date.parse('2026-11-06T12:00:00Z'));
    const made = await ada.sync([
      {
        c: 'projects',
        id: 'p2',
        k: 'put',
        v: {
          id: 'p2',
          key: 'SEC',
          name: 'Security',
          icon: 'lock',
          color: 'rose',
          status: 'active',
          team: '',
          lead: adaId,
          members: [],
          desc: '',
          milestones: [],
          private: true,
        },
      },
    ]);
    expect(made.body.results[0].ok).toBe(true);
    expect((await bob.post('/api/projects/p2/request-access')).status).toBe(200);
    await flush();
    expect(to(1).map(m => [m.title, m.body])).toEqual([
      ['Ada Owner assigned you WEB-201: Hero', 'High priority'],
      ['Ada Owner mentioned you in WEB-201: Hero', 'Ping @Bob Lee about the hero copy'],
      ['Ada Owner commented on WEB-201: Hero', 'Looks good now'],
      ['WEB-201 is due tomorrow: Hero', 'Web'],
      ['WEB-201 is overdue: Hero', 'Web'],
    ]);
    expect(to(2)).toEqual([expect.objectContaining({ title: 'Bob Lee requested access to Security', body: 'Bob Lee (bob@example.com)', url: '/#inbox' })]);
  });

  /* Settings says "Push is off" when every kind is off, so nothing is pushed then, not even access
     requests (which otherwise always push). They still reach the Inbox. */
  it('with every kind of push off, nothing is pushed, access requests included', async () => {
    const { ada, adaId, bob, sent, flush, t } = await pair();
    await ada.post('/api/push/subscriptions', sub(2));
    await ada.sync([{ c: 'notifPrefs', k: 'patch', v: { push_mention: false, push_assign: false, push_comment: false, push_due: false } }]);
    const p2 = {
      id: 'p2',
      key: 'SEC',
      name: 'Security',
      icon: 'lock',
      color: 'rose',
      status: 'active',
      team: '',
      lead: adaId,
      members: [],
      desc: '',
      milestones: [],
      private: true,
    };
    expect((await ada.sync([{ c: 'projects', id: 'p2', k: 'put', v: p2 }])).body.results[0].ok).toBe(true);
    expect((await bob.post('/api/projects/p2/request-access')).status).toBe(200);
    await flush();
    expect(sent).toEqual([]);
    expect(t.db.get("SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND data LIKE '%requested access%'", adaId).n).toBe(1);

    // One kind back on: access requests push again.
    await ada.sync([{ c: 'notifPrefs', k: 'patch', v: { push_due: true } }]);
    expect((await bob.post('/api/projects/p2/request-access')).status).toBe(200);
    await flush();
    expect(sent.map(s => s.msg.title)).toEqual(['Bob Lee requested access to Security']);
  });
});
