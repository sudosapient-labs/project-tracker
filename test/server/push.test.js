import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createPusher } from '../../server/lib/push.js';
import { account, setup } from './helpers.js';

const sub = n => ({ endpoint: `https://push.example.com/send/${n}`, keys: { p256dh: 'BKey' + n, auth: 'auth' + n } });

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
  return { t, ada: ada.c, bob: bob.c, sent, assign, flush: () => new Promise(r => setTimeout(r, 20)) };
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
    expect(sent[0].msg).toMatchObject({ title: 'Ada Owner assigned you', url: '/#task/WEB-201' });
    expect(sent[0].msg.body).toContain('WEB-201 Hero');
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
});
