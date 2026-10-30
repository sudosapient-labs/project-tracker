/* /api: bootstrap, sync, per-person state, onboarding and the live event stream. */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { parseBody } from '../lib/http.js';
import { bootstrap } from '../sync/bootstrap.js';

const MAX_OPS = 500;
const PING_MS = 25_000;

export function dataRoutes() {
  const r = new Hono();

  r.get('/bootstrap', requireAuth(), c => c.json(bootstrap(c.var, c.var.auth)));

  r.post('/sync', requireAuth(), async c => {
    const b = await parseBody(c, z.object({ ops: z.array(z.looseObject({ c: z.string(), k: z.string() })).max(MAX_OPS) }));
    if (b.error) return b.error;
    const { results, links } = c.var.engine.apply(c.var.auth, b.data.ops, c.req.header('x-client-id'));
    return c.json({ results, ...(c.var.config.exposeEmailLinks && links.length ? { links } : {}) });
  });

  r.put('/me/state', requireAuth(), async c => {
    const b = await parseBody(c, z.object({ prefs: z.looseObject({}).optional(), views: z.looseObject({}).optional(), collapsed: z.boolean().optional() }));
    if (b.error) return b.error;
    const { prefs, views, collapsed } = b.data;
    if (JSON.stringify(prefs || {}).length > 32_000 || JSON.stringify(views || {}).length > 512_000)
      return c.json({ error: 'Settings are too large to save.' }, 413);
    const patch = {};
    if (prefs) {
      // Name and title live on the member record; prefs only mirrors them.
      const { name, title, ...rest } = prefs;
      patch.prefs = rest;
    }
    if (views) patch.views = views;
    if (collapsed != null) patch.collapsed = collapsed;
    c.var.repo.saveUserState(c.var.auth.member.id, patch);
    return c.json({ ok: true });
  });

  /* Live updates. The client reconnects (and re-bootstraps) whenever the stream drops. */
  r.get('/events', requireAuth(), c => {
    const { engine } = c.var;
    const { member, session } = c.var.auth;
    return streamSSE(c, async stream => {
      let open = true;
      const conn = engine.connect(
        { uid: member.id, sessionId: session.id, clientId: c.req.query('client') || null },
        (event, data) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}),
        () => {
          open = false;
          stream.abort();
        },
      );
      stream.onAbort(() => {
        open = false;
        engine.disconnect(conn);
      });
      await stream.writeSSE({ event: 'hello', data: '{}' });
      while (open) {
        await stream.sleep(PING_MS);
        if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => (open = false));
      }
      engine.disconnect(conn);
    });
  });

  return r;
}
