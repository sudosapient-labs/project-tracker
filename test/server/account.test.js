import { describe, expect, it } from 'vitest';
import { PW, account, setup } from './helpers.js';

const P = (id, extra = {}) => ({
  id,
  key: id.toUpperCase(),
  name: id,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const T = (id, project, extra = {}) => ({
  id,
  key: 'X-' + id.slice(1),
  project,
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
const put = (c, v) => ({ c, id: v.id, k: 'put', v });

async function pair() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    put('members', { id: 'mbob', name: 'Bob Lee', email: 'bob@example.com', role: 'Member', team: '', title: '', c: '#6B7280', status: 'invited', tz: '' }),
  ]);
  const bob = await account(t, { name: 'Bob Lee', email: 'bob@example.com', invite: t.lastLink('bob@example.com').split('#invite/')[1] });
  return { t, ada: ada.c, adaId: ada.user.id, bob: bob.c };
}

describe('E24 changing your email', () => {
  it('needs the password, confirms through the new address, notifies the old one and signs out other sessions', async () => {
    const { t, ada, bob } = await pair();
    const phone = t.client();
    await phone.post('/api/auth/login', { email: 'bob@example.com', password: PW });

    expect((await bob.post('/api/auth/email', { email: 'robert@example.com', password: 'wrong-pass-1' })).body.field).toBe('password');
    expect((await bob.post('/api/auth/email', { email: 'ada@example.com', password: PW })).status).toBe(409);
    const r = await bob.post('/api/auth/email', { email: 'Robert@Example.com', password: PW });
    expect(r.body.devLink).toBe(t.lastLink('robert@example.com'));
    // Nothing changes until the link is followed.
    expect((await t.client().post('/api/auth/login', { email: 'bob@example.com', password: PW })).status).toBe(200);

    const token = r.body.devLink.split('#email/')[1];
    const ok = await bob.post('/api/auth/email/confirm', { token });
    expect(ok.body.user.email).toBe('robert@example.com');
    expect((await bob.post('/api/auth/email/confirm', { token })).status).toBe(400);
    expect((await ada.get('/api/bootstrap')).body.data.members.find(m => m.id === 'mbob').email).toBe('robert@example.com');
    expect((await phone.get('/api/bootstrap')).status).toBe(401);
    expect((await bob.get('/api/bootstrap')).status).toBe(200);
    expect((await t.client().post('/api/auth/login', { email: 'bob@example.com', password: PW })).status).toBe(401);
    expect((await t.client().post('/api/auth/login', { email: 'robert@example.com', password: PW })).status).toBe(200);
    const notice = t.db.get("SELECT subject, body_text FROM outbox WHERE to_addr = 'bob@example.com' ORDER BY id DESC");
    expect(notice.subject).toBe('Your Sudo Sapient email was changed');
    expect(notice.body_text).toContain('robert@example.com');
  });
});

describe('E25 deleting your account', () => {
  it('needs the password, removes the person like an admin would, and is refused for Owners', async () => {
    const { t, ada, adaId, bob } = await pair();
    await ada.sync([put('projects', P('web', { members: [adaId, 'mbob'] })), put('tasks', T('t1', 'web', { assignee: 'mbob' }))]);
    expect((await ada.post('/api/auth/account/delete', { password: PW })).body.code).toBe('owner');
    expect((await bob.post('/api/auth/account/delete', { password: 'wrong-pass-1' })).status).toBe(400);
    expect((await bob.post('/api/auth/account/delete', { password: PW })).body).toEqual({ ok: true });

    expect((await bob.get('/api/bootstrap')).status).toBe(401);
    expect((await t.client().post('/api/auth/login', { email: 'bob@example.com', password: PW })).status).toBe(401);
    const d = (await ada.get('/api/bootstrap')).body.data;
    expect(d.members.map(m => m.id)).toEqual([adaId]);
    expect(d.tasks[0].assignee).toBeNull();
    expect(d.projects[0].members).toEqual([adaId]);
  });
});

describe('E26 data export', () => {
  it('exports your own data in projects you can see, and the whole workspace for the Owner, without secrets', async () => {
    const { ada, adaId, bob } = await pair();
    await ada.sync([
      put('projects', P('web')),
      put('projects', P('sec', { private: true, members: [adaId, 'mbob'] })),
      put('tasks', T('t1', 'web', { assignee: 'mbob' })),
      put('tasks', T('t2', 'sec', { assignee: 'mbob' })),
      put('tasks', T('t3', 'web')),
    ]);
    await bob.sync([put('comments', { id: 'c1', task: 't2', by: 'x', at: 1, text: 'secret note', re: {} })]);
    await ada.sync([{ c: 'projects', id: 'sec', k: 'patch', v: { members: [adaId] } }]);

    const r = await bob.get('/api/me/export');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="sudo-sapient-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.body.profile).toMatchObject({ id: 'mbob', email: 'bob@example.com', twoFactor: false });
    expect(r.body.tasks.map(t => t.id)).toEqual(['t1']);
    expect(r.body.comments).toEqual([]);
    expect(r.body.notifications.length).toBeGreaterThan(0);
    expect(r.body.workspace).toBeUndefined();

    const o = (await ada.get('/api/me/export')).body;
    expect(o.workspace.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3']);
    expect(o.workspace.comments.map(c => c.text)).toEqual(['secret note']);
    expect(o.workspace.members).toHaveLength(2);
    expect(JSON.stringify(o)).not.toMatch(/scrypt|password|token_hash|totp|recovery|storage_key/);
  });
});
