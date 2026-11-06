/* Bot members (#13): automation with its own role, project access and API keys, which never signs
   in, gets no email or notifications, and outlives the admin who made its key. */
import { describe, expect, it } from 'vitest';
import { PW, account, apiKey, bot, keyClient, setup } from './helpers.js';
import { issueToken } from '../../server/routes/auth.js';
import { sha256 } from '../../server/lib/crypto.js';

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
const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const patch = (c, id, v) => ({ c, id, k: 'patch', v });
const boot = async c => (await c.get('/api/bootstrap')).body.data;

/* Ada (Owner), Bob (Member), Gus (Guest); open WEB, private SEC (Ada only), OPS lists Gus. */
async function workspace(env) {
  const t = setup(env);
  const ada = await account(t);
  const join = async (id, name, email, role) => {
    await ada.c.sync([put('members', { id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' })]);
    return (await account(t, { name, email, invite: t.lastLink(email).split('#invite/')[1] })).c;
  };
  const bob = await join('mbob', 'Bob Lee', 'bob@example.com', 'Member');
  const gus = await join('mgus', 'Gus Guest', 'gus@example.com', 'Guest');
  await ada.c.sync([
    put('projects', project('pweb', 'WEB')),
    put('projects', project('psec', 'SEC', { private: true })),
    put('projects', project('pops', 'OPS', { members: ['mgus'], perms: { mgus: 'Can comment' } })),
  ]);
  return { t, ada: ada.c, adaId: ada.user.id, bob, gus };
}

describe('managing bots', () => {
  it('Owners and Admins create, rename, re-scope and remove bots, and create and revoke their keys', async () => {
    const { t, ada, bob } = await workspace();
    const made = await ada.post('/api/bots', { name: 'Release Bot', role: 'Guest', projects: ['pops'] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: 'Release Bot', role: 'Guest', projects: ['pops'], keys: [] });
    const id = made.body.id;
    // A member with kind 'bot' that the app lists like anyone else.
    expect((await boot(bob)).members.find(m => m.id === id)).toMatchObject({ name: 'Release Bot', kind: 'bot', status: 'active' });
    expect((await boot(ada)).bots.map(b => b.id)).toEqual([id]);
    expect((await boot(bob)).bots).toEqual([]);

    const p = await ada.patch(`/api/bots/${id}`, { name: 'Deploy Bot', role: 'Member', projects: ['pweb', 'psec'] });
    expect(p).toMatchObject({ status: 200, body: { name: 'Deploy Bot', role: 'Member', projects: ['pweb', 'psec'] } });
    const projects = (await boot(ada)).projects;
    expect(projects.find(x => x.id === 'pops').members).not.toContain(id);
    expect(projects.find(x => x.id === 'psec').members).toContain(id);

    // Never Owner or Admin.
    expect((await ada.patch(`/api/bots/${id}`, { role: 'Admin' })).status).toBe(400);
    expect((await ada.post('/api/bots', { name: 'Root Bot', role: 'Owner' })).status).toBe(400);

    // Keys: shown once, need the admin's password, and belong to the bot, not to the admin.
    expect((await ada.post(`/api/bots/${id}/keys`, { name: 'CI', scope: 'write', expiresInDays: null, password: 'wrong' })).body.field).toBe('password');
    const k = await ada.post(`/api/bots/${id}/keys`, { name: 'CI', scope: 'write', expiresInDays: 30, password: PW });
    expect(k.status).toBe(201);
    expect(k.body.token).toMatch(/^ssk_/);
    expect(k.body.key).toMatchObject({ name: 'CI', scope: 'write', createdBy: (await boot(ada)).me });
    expect(k.body.bot.keys.map(x => x.id)).toEqual([k.body.key.id]);
    expect((await ada.get('/api/keys')).body).toEqual([]);
    const api = keyClient(t.app, k.body.token);
    expect((await api.get('/me')).body).toMatchObject({ id, name: 'Deploy Bot', kind: 'bot' });

    const rev = await ada.del(`/api/bots/${id}/keys/${k.body.key.id}`);
    expect(rev.body.keys).toEqual([]);
    expect((await api.get('/me')).body.code).toBe('invalid_key');

    const again = await bot(ada, { name: 'Gone Bot' });
    const del = await ada.del(`/api/bots/${again.id}`);
    expect(del.body.map(b => b.name)).toEqual(['Deploy Bot']);
    expect(t.db.get('SELECT COUNT(*) n FROM users WHERE id = ?', again.id).n).toBe(0);
  });

  it('Members, Guests and API keys can’t manage bots (403), nor can the app’s sync edit one', async () => {
    const { t, ada, bob, gus } = await workspace();
    const b = await bot(ada);
    for (const c of [bob, gus]) {
      expect((await c.get('/api/bots')).status).toBe(403);
      expect((await c.post('/api/bots', { name: 'Mine' })).status).toBe(403);
      expect((await c.patch(`/api/bots/${b.id}`, { name: 'Mine' })).status).toBe(403);
      expect((await c.del(`/api/bots/${b.id}`)).status).toBe(403);
      expect((await c.post(`/api/bots/${b.id}/keys`, { name: 'x', scope: 'write', expiresInDays: null, password: PW })).status).toBe(403);
    }
    // A key (the bot's own, or an Owner's) is refused even alongside the Owner's session.
    for (const token of [b.token, await apiKey(ada)]) {
      const auth = { authorization: `Bearer ${token}` };
      expect((await ada.get('/api/bots', auth)).status).toBe(403);
      expect((await ada.post('/api/bots', { name: 'Key Bot' }, auth)).status).toBe(403);
      expect((await ada.post(`/api/bots/${b.id}/keys`, { name: 'x', scope: 'write', expiresInDays: null, password: PW }, auth)).status).toBe(403);
      expect((await ada.del(`/api/bots/${b.id}/keys/${b.keyId}`, auth)).status).toBe(403);
      expect((await t.app.request('/api/bots', { headers: auth })).status).toBe(403);
    }
    // The session still needs its CSRF header.
    const noCsrf = await t.app.request('/api/bots', {
      method: 'POST',
      headers: { cookie: ada.cookie, 'content-type': 'application/json' },
      body: '{"name":"x"}',
    });
    expect(noCsrf.status).toBe(403);
    // Through sync, nobody (not even the Owner) can rename or promote a bot, or make a member a bot.
    const r = await ada.sync([
      patch('members', b.id, { role: 'Admin' }),
      patch('members', b.id, { name: 'Renamed' }),
      put('members', {
        id: 'mfake',
        name: 'Fake',
        email: 'fake@example.com',
        role: 'Member',
        team: '',
        title: '',
        c: '#6B7280',
        status: 'invited',
        tz: '',
        kind: 'bot',
      }),
      patch('members', 'mbob', { kind: 'bot' }),
    ]);
    expect(r.body.results.map(x => x.ok)).toEqual([false, false, true, true]);
    expect(r.body.results[0].error).toBe('Manage bots in Settings → API → Bots.');
    const members = (await boot(ada)).members;
    expect(members.find(m => m.id === b.id)).toMatchObject({ role: 'Member', name: 'Release Bot' });
    expect(members.find(m => m.id === 'mfake').kind).toBeUndefined();
    expect(members.find(m => m.id === 'mbob').kind).toBeUndefined();
    expect(t.db.get("SELECT COUNT(*) n FROM users WHERE kind = 'bot'").n).toBe(1);
  });
});

describe('a bot key acts with the bot’s role and projects only', () => {
  it('as a Guest bot: only listed projects, and Can comment is enforced', async () => {
    const { t, ada } = await workspace();
    const owner = keyClient(t.app, await apiKey(ada));
    const web = (await owner.post('/tasks', { project: 'WEB', title: 'Workspace task' })).body;
    const ops = (await owner.post('/tasks', { project: 'OPS', title: 'Ops task' })).body;
    const b = await bot(ada, { role: 'Guest', projects: ['pops'] });
    await ada.sync([patch('projects', 'pops', { perms: { mgus: 'Can comment', [b.id]: 'Can comment' } })]);
    const api = keyClient(t.app, b.token);
    expect((await api.get('/projects')).body.data.map(p => p.key)).toEqual(['OPS']);
    expect((await api.get(`/tasks/${web.key}`)).status).toBe(404);
    expect((await api.post(`/tasks/${ops.key}/comments`, { text: 'Build passed' })).status).toBe(201);
    expect((await api.post(`/tasks/${ops.key}/complete`)).body.error).toBe('You can only comment in this project.');
    expect((await api.post('/tasks', { project: 'OPS', title: 'Mine' })).status).toBe(403);
    // Guest limits: no emails of people it shares no project with.
    expect((await api.get('/members')).body.data.find(m => m.id === 'mbob').email).toBe('');
  });

  it('as a Member bot: private projects stay invisible and Can view is enforced', async () => {
    const { t, ada } = await workspace();
    const owner = keyClient(t.app, await apiKey(ada));
    const sec = (await owner.post('/tasks', { project: 'SEC', title: 'Payroll' })).body;
    const web = (await owner.post('/tasks', { project: 'WEB', title: 'Read me' })).body;
    const b = await bot(ada, { role: 'Member' });
    const api = keyClient(t.app, b.token);
    expect((await api.get('/projects')).body.data.map(p => p.key)).toEqual(['WEB', 'OPS']);
    expect((await api.get(`/tasks/${sec.key}`)).status).toBe(404);
    expect((await api.get('/search?q=payroll')).body.tasks).toEqual([]);
    // The Owner's key can't assign SEC work to the bot either: it can't open SEC.
    expect((await owner.patch(`/tasks/${sec.key}`, { assignee: b.id })).body.error).toBe('Add Release Bot to the project first.');

    await ada.sync([patch('projects', 'pweb', { members: [b.id], perms: { [b.id]: 'Can view' } })]);
    expect((await api.get(`/tasks/${web.key}`)).status).toBe(200);
    expect((await api.post(`/tasks/${web.key}/comments`, { text: 'x' })).body.error).toBe('You can only view this project.');
    expect((await api.post(`/tasks/${web.key}/archive`)).status).toBe(403);
  });

  it('has its own rate-limit budget, separate from the admin who made its key', async () => {
    const { t, ada } = await workspace({ DISABLE_RATE_LIMIT: 'false', API_RATE_LIMIT: '2' });
    const b = await bot(ada);
    const mine = keyClient(t.app, await apiKey(ada));
    await mine.get('/me');
    await mine.get('/me');
    expect((await mine.get('/me')).status).toBe(429);
    expect((await keyClient(t.app, b.token).get('/me')).status).toBe(200);
  });
});

describe('attribution', () => {
  it('tasks, comments and activity made with a bot key are by the bot, “via” the key, never the admin', async () => {
    const { t, ada, adaId } = await workspace();
    const b = await bot(ada);
    const seen = [];
    t.engine.connect(
      { uid: 'mbob', sessionId: 's-bob', clientId: 'tab-bob' },
      (e, d) => e === 'changes' && seen.push(...d),
      () => {},
    );
    const api = keyClient(t.app, b.token);
    const task = (await api.post('/tasks', { project: 'WEB', title: 'Release 1.4' })).body;
    await api.post(`/tasks/${task.key}/comments`, { text: 'Deployed to staging' });
    await api.post(`/tasks/${task.key}/complete`);

    const d = await boot(ada);
    const acts = d.activity.filter(a => a.task === task.id);
    expect(acts.map(a => [a.verb, a.by, a.via])).toEqual([
      ['completed', b.id, 'GitHub Actions'],
      ['commented on', b.id, 'GitHub Actions'],
      ['created', b.id, 'GitHub Actions'],
    ]);
    expect(d.comments.find(c => c.task === task.id).by).toBe(b.id);
    expect(seen.filter(x => x.c === 'activity').every(x => x.v.by === b.id)).toBe(true);
    // Nothing anywhere points at the admin who made the key.
    expect(JSON.stringify(t.db.all('SELECT data FROM activity UNION ALL SELECT data FROM comments'))).not.toContain(adaId);
    expect((await api.get(`/tasks/${task.key}/comments`)).body.data[0].author).toBe(b.id);
  });

  it('/api/v1/me reports kind “bot” for a bot key and “person” otherwise; /members marks bots', async () => {
    const { t, ada } = await workspace();
    const b = await bot(ada);
    const me = (await keyClient(t.app, b.token).get('/me')).body;
    expect(me).toMatchObject({ id: b.id, name: 'Release Bot', kind: 'bot', email: '', role: 'Member', key: { name: 'GitHub Actions' } });
    expect((await keyClient(t.app, await apiKey(ada)).get('/me')).body).toMatchObject({ kind: 'person', email: 'ada@example.com' });
    const people = (await keyClient(t.app, b.token).get('/members')).body.data;
    expect(people.find(m => m.id === b.id)).toMatchObject({ kind: 'bot', email: '' });
    expect(people.find(m => m.id === 'mbob').kind).toBe('person');
  });
});

describe('bots never sign in or get mail', () => {
  it('can’t sign in, reset a password, verify, use the app’s session routes or be sent links', async () => {
    const { t, ada } = await workspace();
    const b = await bot(ada);
    const user = t.db.get('SELECT * FROM users WHERE id = ?', b.id);
    expect(user).toMatchObject({ kind: 'bot', password_hash: null, email: `${b.id}@bot.invalid` });
    const outbox = () => t.db.get('SELECT COUNT(*) n FROM outbox').n;
    const before = outbox();

    const anon = t.client();
    expect((await anon.post('/api/auth/login', { email: user.email, password: 'anything-at-all-1' })).status).toBe(401);
    expect((await anon.post('/api/auth/login', { email: user.email, password: '' })).status).toBe(400);
    expect(anon.session).toBe('');
    expect((await anon.post('/api/auth/forgot', { email: user.email })).body).toEqual({ ok: true });
    expect(t.db.get('SELECT COUNT(*) n FROM auth_tokens WHERE email = ? OR user_id = ?', user.email, b.id).n).toBe(0);
    // Its address is taken, so nobody can sign up as it either.
    expect((await anon.post('/api/auth/signup', { name: 'Imposter', email: user.email, password: PW })).status).toBe(409);
    // Even a reset or verify token minted by hand wouldn't touch it, and none can be issued.
    expect(() => issueToken(t.db, t.config, 'reset', user.email, b.id)).toThrow(/Bots/);
    const plant = (kind, raw) =>
      t.db.run(
        'INSERT INTO auth_tokens (token_hash, kind, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, 0, 9e15)',
        sha256(raw),
        kind,
        b.id,
        user.email,
      );
    plant('verify', 'verify-tok');
    plant('reset', 'reset-tok');
    await anon.post('/api/auth/verify', { token: 'verify-tok' });
    expect(t.db.get('SELECT email_verified_at v FROM users WHERE id = ?', b.id).v).toBeNull();
    expect((await anon.post('/api/auth/reset', { token: 'reset-tok', password: 'taken-over-pass-1' })).status).toBe(400);
    expect(t.db.get('SELECT password_hash h FROM users WHERE id = ?', b.id).h).toBeNull();
    // A session planted for it is ignored.
    t.db.run(
      'INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, 0, 0, 9e15)',
      'sebot',
      sha256('bot-sid'),
      b.id,
    );
    const planted = t.client();
    planted.cookie = 'ss_sid=bot-sid';
    expect((await planted.get('/api/bootstrap')).status).toBe(401);
    expect((await planted.get('/api/auth/session')).body.user ?? null).toBeNull();
    // Its key opens /api/v1 only: never the app's session routes or sync.
    const auth = { authorization: `Bearer ${b.token}` };
    for (const [m, url] of [
      ['GET', '/api/bootstrap'],
      ['POST', '/api/sync'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/keys'],
    ])
      expect(
        (
          await t.app.request(url, {
            method: m,
            headers: { ...auth, 'x-requested-with': 'sudo-sapient', 'content-type': 'application/json' },
            body: m === 'GET' ? undefined : '{"ops":[]}',
          })
        ).status,
        url,
      ).toBe(401);
    expect((await ada.post(`/api/members/${b.id}/resend-invite`)).status).toBe(400);
    expect(outbox()).toBe(before);
  });

  it('get no notifications, emails or push, even when assigned or @mentioned', async () => {
    const { t, ada, bob } = await workspace();
    const pushes = [];
    t.pusher.notify = uid => pushes.push(uid);
    const b = await bot(ada, { projects: ['pweb'] });
    const owner = keyClient(t.app, await apiKey(ada));
    const bobApi = keyClient(t.app, await apiKey(bob));
    const task = (await owner.post('/tasks', { project: 'WEB', title: 'Ship it', assignee: b.id })).body;
    expect(task.assignee).toBe(b.id);
    await bobApi.post(`/tasks/${task.key}/comments`, { text: 'Hey @Release Bot, and @workspace' });
    await bobApi.post(`/tasks/${task.key}/complete`);
    expect(t.db.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ?', b.id).n).toBe(0);
    expect(t.db.get("SELECT COUNT(*) n FROM outbox WHERE to_addr LIKE '%@bot.invalid'").n).toBe(0);
    expect(pushes).not.toContain(b.id);
    // The mailer itself refuses a bot's address, whoever asks.
    t.mailer.queue({ to: `${b.id}@bot.invalid`, subject: 's', intro: 'i', action: 'a', link: 'l' });
    expect(t.db.get("SELECT COUNT(*) n FROM outbox WHERE to_addr LIKE '%@bot.invalid'").n).toBe(0);
  });
});

describe('lifecycle', () => {
  it('removing the admin who made a bot’s key keeps the key; removing the bot revokes its keys', async () => {
    const { t, ada } = await workspace();
    await ada.sync([patch('members', 'mbob', { role: 'Admin' })]);
    const bob = t.client();
    await bob.post('/api/auth/login', { email: 'bob@example.com', password: PW });
    const b = await bot(bob);
    expect(t.db.get('SELECT created_by FROM api_keys WHERE id = ?', b.keyId).created_by).toBe('mbob');
    // Bot keys aren't Bob's personal keys.
    expect((await bob.get('/api/keys')).body).toEqual([]);

    await ada.sync([{ c: 'members', id: 'mbob', k: 'del' }]);
    const api = keyClient(t.app, b.token);
    expect((await api.get('/me')).body).toMatchObject({ id: b.id, kind: 'bot' });
    expect(t.db.get('SELECT created_by FROM api_keys WHERE id = ?', b.keyId).created_by).toBeNull();
    expect((await ada.get('/api/bots')).body[0].keys[0]).toMatchObject({ id: b.keyId, createdBy: null });

    await ada.del(`/api/bots/${b.id}`);
    expect(t.db.get('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?', b.id).n).toBe(0);
    expect((await api.get('/me')).status).toBe(401);
    expect((await boot(ada)).members.some(m => m.id === b.id)).toBe(false);
  });

  it('removing a bot from the Members page (sync) revokes its keys too', async () => {
    const { t, ada } = await workspace();
    const b = await bot(ada);
    expect((await ada.sync([{ c: 'members', id: b.id, k: 'del' }])).body.results[0].ok).toBe(true);
    expect((await keyClient(t.app, b.token).get('/me')).status).toBe(401);
  });

  it('recovering an admin’s account with a password reset also revokes bot keys they made', async () => {
    const { t, ada } = await workspace();
    const b = await bot(ada);
    await t.client().post('/api/auth/forgot', { email: 'ada@example.com' });
    const token = t.lastLink('ada@example.com').split('#reset/')[1];
    expect((await t.client().post('/api/auth/reset', { token, password: 'recovered-pass-3' })).status).toBe(200);
    expect((await keyClient(t.app, b.token).get('/me')).body.code).toBe('invalid_key');
    // The bot itself stays.
    expect(t.db.get('SELECT kind FROM users WHERE id = ?', b.id).kind).toBe('bot');
  });
});
