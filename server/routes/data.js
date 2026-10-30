/* /api: bootstrap, sync, per-person state, data export, Web Push and the live event stream. */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { parseBody } from '../lib/http.js';
import { TIMEZONES } from '../../src/core/constants.js';
import { bootstrap } from '../sync/bootstrap.js';
import { canSee, projectFor } from '../sync/rules.js';
import { newId } from '../lib/crypto.js';
import { pushEndpointAllowed } from '../lib/push.js';

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
    const { repo, engine } = c.var;
    repo.saveUserState(c.var.auth.member.id, patch);
    // Show the person's local city on their profile, from their time-zone preference.
    const city = TIMEZONES.some(z => z.id === prefs?.tz) && prefs.tz.split('/').pop().replace(/_/g, ' ');
    const m = repo.get('members', c.var.auth.member.id);
    if (city && m && m.tz !== city) {
      m.tz = city;
      repo.put('members', m);
      engine.publish([{ c: 'members', id: m.id, v: m }]);
    }
    return c.json({ ok: true });
  });

  /* Download your data: profile, preferences, your notifications, tasks assigned to you and your
     comments, in projects you can see. The Owner also gets the workspace: people, teams and every
     project's settings, but the work (tasks, comments, files, …) only of projects they can open,
     like everywhere else. Never secrets. Each workspace export is logged and shows in Activity. */
  r.get('/me/export', requireAuth(), c => {
    const { db, repo, engine } = c.var;
    const { member, user } = c.var.auth;
    const vis = new Set(
      repo
        .all('projects')
        .filter(p => canSee(p, member))
        .map(p => p.id),
    );
    const mine = (coll, field) =>
      repo.all(coll, `WHERE json_extract(data, '$.${field}') = ? ORDER BY created_at, rowid`, member.id).filter(x => vis.has(x.project));
    const { prefs, views, projOrder, recentSearches, notifPrefs } = repo.userState(member.id);
    const out = {
      exportedAt: new Date().toISOString(),
      profile: { ...member, email: user.email, createdAt: user.created_at, twoFactor: !!user.totp_enabled },
      preferences: { prefs, views, projOrder, recentSearches, notifPrefs },
      notifications: db.all('SELECT data FROM notifications WHERE user_id = ? ORDER BY created_at', member.id).map(r => JSON.parse(r.data)),
      tasks: mine('tasks', 'assignee'),
      comments: mine('comments', 'by'),
    };
    if (member.role === 'Owner') {
      const { onboarded, ...ws } = repo.workspace() || {};
      const ids = JSON.stringify([...vis]);
      const IN = 'project_id IN (SELECT value FROM json_each(?))';
      out.workspace = {
        ws,
        members: repo.all('members', 'ORDER BY created_at, rowid'),
        teams: repo.all('teams', 'ORDER BY created_at, rowid'),
        projects: repo
          .all('projects', 'ORDER BY created_at, rowid')
          .map(p => projectFor(p, member))
          .filter(Boolean),
      };
      for (const coll of ['tasks', 'comments', 'savedViews']) out.workspace[coll] = repo.all(coll, `WHERE ${IN} ORDER BY created_at, rowid`, ids);
      for (const coll of ['activity', 'files', 'events'])
        out.workspace[coll] = repo.all(coll, `WHERE project_id IS NULL OR ${IN} ORDER BY created_at, rowid`, ids);
      const a = { id: newId('a'), by: member.id, verb: 'exported the workspace data', task: null, project: null, at: Date.now(), extra: '' };
      repo.put('activity', a, null);
      engine.publish([{ c: 'activity', id: a.id, v: a, pid: null }]);
      c.var.log.info?.(
        `[export] ${member.name} <${user.email}> (${member.id}) exported the workspace: ${vis.size} of ${out.workspace.projects.length} projects in full`,
      );
    }
    c.header('Content-Disposition', `attachment; filename="sudo-sapient-export-${new Date().toISOString().slice(0, 10)}.json"`);
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  });

  /* ---------- Web Push ---------- */
  r.get('/push/key', requireAuth(), c => c.json({ publicKey: c.var.pusher.publicKey }));
  const pushSub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
  r.post('/push/subscriptions', requireAuth(), async c => {
    const b = await parseBody(c, pushSub);
    if (b.error) return b.error;
    if (!pushEndpointAllowed(b.data.endpoint)) return c.json({ error: 'That isn’t a push service this server can send to.' }, 400);
    c.var.pusher.subscribe(c.var.auth.member.id, b.data, c.req.header('user-agent') || '', c.var.auth.session.id);
    return c.json({ ok: true }, 201);
  });
  r.post('/push/unsubscribe', requireAuth('session'), async c => {
    const b = await parseBody(c, z.object({ endpoint: z.string().max(1000) }));
    if (b.error) return b.error;
    c.var.pusher.unsubscribe(c.var.auth.member.id, b.data.endpoint);
    return c.json({ ok: true });
  });

  /* Live updates. The client reconnects (and re-bootstraps) whenever the stream drops. */
  r.get('/events', requireAuth(), c => {
    const { db, engine, config } = c.var;
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
        await stream.sleep(config.ssePingMs ?? PING_MS);
        // The stream ends with its session (signed out elsewhere, revoked or expired).
        const s = db.get('SELECT expires_at FROM sessions WHERE id = ?', session.id);
        if (!s || s.expires_at < Date.now()) break;
        if (open) await stream.writeSSE({ event: 'ping', data: '' }).catch(() => (open = false));
      }
      engine.disconnect(conn);
    });
  });

  return r;
}
