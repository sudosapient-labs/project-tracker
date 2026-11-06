/* /api/bots: bot members and their keys (Settings → API → Bots). Owners and Admins only, with a
   signed-in session and its CSRF header, like personal keys; making a key also needs the admin's
   current password. API keys can never manage bots, even alongside a session. */
import { Hono } from 'hono';
import { z } from 'zod';
import { GONE, currentAuthSamePassword, requireAuth } from '../auth.js';
import { isAdminRole } from '../../src/core/access.js';
import { parseBody } from '../lib/http.js';
import { passwordError } from './auth.js';
import { MAX_KEYS, createKey, revokeKey } from '../api/keys.js';
import { BOT_ROLES, MAX_BOTS, createBot, getBot, listBots, updateBot } from '../api/bots.js';

const HOUR = 3_600_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const name = z.string().trim().min(1, 'Name the bot, e.g. “Release Bot”').max(80, 'Keep the name under 80 characters');
const role = z.enum(BOT_ROLES, { error: 'A bot can be a Member or a Guest.' });
const projects = z.array(id).max(1000);

export function botRoutes({ limit }) {
  const r = new Hono();

  r.use('*', async (c, next) => {
    if (/^Bearer\s/i.test(c.req.header('authorization') || ''))
      return c.json({ error: 'API keys can’t manage bots. Use Settings → API → Bots.', code: 'forbidden' }, 403);
    return next();
  });
  r.use('*', requireAuth());
  r.use('*', async (c, next) => {
    if (!isAdminRole(c.var.auth.member)) return c.json({ error: 'Only owners and admins can manage bots.', code: 'forbidden' }, 403);
    return next();
  });
  /* The bot named in the path, or a 404 response. */
  const bot = c => {
    const m = c.var.repo.get('members', c.req.param('id'));
    return m?.kind === 'bot' ? m : null;
  };
  const gone = c => c.json({ error: 'That bot no longer exists.', code: 'not_found' }, 404);
  const unknownProject = (repo, ids) => ids.find(p => !repo.get('projects', p));

  r.get('/', c => c.json(listBots(c.var.db, c.var.repo)));

  r.post('/', async c => {
    const b = await parseBody(c, z.object({ name, role: role.default('Member'), projects: projects.default([]) }));
    if (b.error) return b.error;
    const { db, repo, engine } = c.var;
    if (unknownProject(repo, b.data.projects)) return c.json({ error: 'That project no longer exists.', field: 'projects' }, 400);
    if (db.get("SELECT COUNT(*) n FROM users WHERE kind = 'bot'").n >= MAX_BOTS)
      return c.json({ error: `A workspace can have up to ${MAX_BOTS} bots. Remove one you no longer use first.` }, 400);
    const { member, changes } = db.tx(() => createBot(db, repo, b.data));
    engine.publish(changes);
    return c.json(getBot(db, repo, member.id), 201);
  });

  r.patch('/:id', async c => {
    const b = await parseBody(c, z.object({ name: name.optional(), role: role.optional(), projects: projects.optional() }));
    if (b.error) return b.error;
    const { db, repo, engine } = c.var;
    const m = bot(c);
    if (!m) return gone(c);
    if (b.data.projects && unknownProject(repo, b.data.projects)) return c.json({ error: 'That project no longer exists.', field: 'projects' }, 400);
    engine.publish(db.tx(() => updateBot(repo, m, b.data)));
    return c.json(getBot(db, repo, m.id));
  });

  // The same cascade as removing a person; its keys go with its users row (ON DELETE CASCADE).
  r.delete('/:id', c => {
    const { db, repo, engine } = c.var;
    const m = bot(c);
    if (!m) return gone(c);
    engine.removeAccount({ member: m });
    return c.json(listBots(db, repo));
  });

  r.post(
    '/:id/keys',
    limit('api-key', 20, HOUR, { keyOf: c => c.var.auth.member.id, message: 'You’ve created a lot of keys. Try again in an hour.' }),
    async c => {
      const b = await parseBody(
        c,
        z.object({
          name: z.string().trim().min(1, 'Name the key, e.g. “GitHub Actions”').max(60, 'Keep the name under 60 characters'),
          scope: z.enum(['read', 'write']),
          expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
          password: z.string().min(1, 'Enter your current password').max(200),
        }),
      );
      if (b.error) return b.error;
      const { db, repo } = c.var;
      const m = bot(c);
      if (!m) return gone(c);
      const wrong = await passwordError(c, limit, b.data.password);
      if (wrong) return wrong;
      const { password, ...opts } = b.data;
      // Re-checked in the transaction that makes the key: the admin's session, password and role,
      // and the bot, as they are now (see routes/keys.js).
      const out = db.tx(() => {
        const a = currentAuthSamePassword(db, c.var.auth);
        if (!a) return GONE;
        if (!isAdminRole(a.member)) return 'forbidden';
        if (!bot(c)) return 'gone';
        if (db.get('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?', m.id).n >= MAX_KEYS) return 'full';
        return createKey(db, m.id, { ...opts, createdBy: a.member.id });
      });
      if (out === GONE) return c.json(GONE, 401);
      if (out === 'forbidden') return c.json({ error: 'Only owners and admins can manage bots.', code: 'forbidden' }, 403);
      if (out === 'gone') return gone(c);
      if (out === 'full') return c.json({ error: `A bot can have up to ${MAX_KEYS} keys. Revoke one it no longer uses first.` }, 400);
      return c.json({ ...out, bot: getBot(db, repo, m.id) }, 201);
    },
  );

  r.delete('/:id/keys/:keyId', c => {
    const { db, repo } = c.var;
    const m = bot(c);
    if (!m) return gone(c);
    if (!revokeKey(db, m.id, c.req.param('keyId'))) return c.json({ error: 'That key no longer exists.', code: 'not_found' }, 404);
    return c.json(getBot(db, repo, m.id));
  });

  return r;
}
