/* /api/keys: the signed-in person's personal API keys (Settings → API). Managed with the session
   (and its CSRF header) only; a key can't create or list keys. Creating one needs the current
   password, so a signed-in browser alone can't mint a credential that outlives its session. */
import { Hono } from 'hono';
import { z } from 'zod';
import { GONE, currentAuthSamePassword, requireAuth } from '../auth.js';
import { parseBody } from '../lib/http.js';
import { verifyPassword } from '../lib/crypto.js';
import { MAX_KEYS, createKey, listKeys, revokeKey } from '../api/keys.js';

const HOUR = 3_600_000;

export function keyRoutes({ limit }) {
  const r = new Hono();
  r.get('/', requireAuth(), c => c.json(listKeys(c.var.db, c.var.auth.member.id)));

  r.post(
    '/',
    requireAuth(),
    limit('api-key', 20, HOUR, { keyOf: c => c.var.auth.member.id, message: 'You’ve created a lot of keys. Try again in an hour.' }),
    async c => {
      const b = await parseBody(
        c,
        z.object({
          name: z.string().trim().min(1, 'Name the key, e.g. “Laptop CLI”').max(60, 'Keep the name under 60 characters'),
          scope: z.enum(['read', 'write']),
          expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
          password: z.string().min(1, 'Enter your current password').max(200),
        }),
      );
      if (b.error) return b.error;
      const { db } = c.var;
      const uid = c.var.auth.member.id;
      if (!(await verifyPassword(b.data.password, c.var.auth.user.password_hash)))
        return c.json({ error: 'Your password is incorrect.', field: 'password' }, 400);
      const { password, ...opts } = b.data;
      // Made in one transaction with a fresh look at the session and password: either may have
      // changed while the request was on its way (a stolen session, then the owner changed the
      // password), and the key must not outlive that.
      const out = db.tx(() => {
        if (!currentAuthSamePassword(db, c.var.auth)) return GONE;
        if (db.get('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?', uid).n >= MAX_KEYS) return 'full';
        return createKey(db, uid, opts);
      });
      if (out === GONE) return c.json(GONE, 401);
      if (out === 'full') return c.json({ error: `You can have up to ${MAX_KEYS} keys. Revoke one you no longer use first.` }, 400);
      return c.json(out, 201);
    },
  );

  r.delete('/:id', requireAuth(), c => {
    const { db } = c.var;
    const uid = c.var.auth.member.id;
    if (!revokeKey(db, uid, c.req.param('id'))) return c.json({ error: 'That key no longer exists.' }, 404);
    return c.json(listKeys(db, uid));
  });
  return r;
}
