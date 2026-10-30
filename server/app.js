/* The HTTP application. Built from injected dependencies so tests can run it against an
   in-memory database without opening a port. */
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { createRepo } from './repo.js';
import { isSealed, seal, token } from './lib/crypto.js';
import { createMailer } from './lib/mailer.js';
import { createPusher } from './lib/push.js';
import { rateLimiter } from './lib/rate-limit.js';
import { csrfGuard } from './auth.js';
import { createEngine } from './sync/engine.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { fileRoutes } from './routes/files.js';
import { workspaceRoutes } from './routes/workspace.js';

const KB = 1024;
const tooLarge = c => c.json({ error: 'This request is too large.' }, 413);

/* The client address: the socket, or with TRUST_PROXY=<hops> the X-Forwarded-For entry that many
   from the right. Entries further left were written by the client and can't be trusted. */
export function clientIp(c, hops) {
  const sock = c.env?.incoming?.socket?.remoteAddress || '';
  const fwd = hops
    ? (c.req.header('x-forwarded-for') || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
    : [];
  return (fwd[Math.max(0, fwd.length - hops)] || sock || 'local').replace(/^::ffff:/, '');
}

export function createApp({ db, config, log = console, pushSend }) {
  const repo = createRepo(db);
  const mailer = createMailer(db, config, log);
  const pusher = createPusher(db, config, log, pushSend);
  const limit = rateLimiter({ enabled: config.rateLimit });
  const engine = createEngine({ db, repo, config, mailer, pusher, log, limit: limit.hit });
  const app = new Hono();

  // In production the first account needs the setup token, so whoever reaches a fresh deployment
  // first can't claim it. Without SETUP_TOKEN one is generated for this run and logged.
  const setup = { token: config.setupToken };
  if (config.prod && !setup.token && !repo.workspace()) {
    setup.token = token(24);
    log.info?.(`[setup] No workspace yet. Create the owner account at ${config.appUrl}/#setup/${setup.token}`);
  }

  // TOTP secrets at rest: with SECRET_KEY, seal any still stored in plaintext (see lib/crypto.js).
  const plainTotp = db.all("SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL AND totp_secret NOT LIKE 'enc:%'");
  if (config.secretKey)
    db.tx(() => plainTotp.forEach(u => db.run('UPDATE users SET totp_secret = ? WHERE id = ?', seal(u.totp_secret, config.secretKey), u.id)));
  else if (db.all('SELECT totp_secret FROM users WHERE totp_secret IS NOT NULL').some(u => isSealed(u.totp_secret)))
    log.error?.('[security] Two-factor secrets are encrypted but SECRET_KEY is not set: authenticator codes will fail until it is restored.');

  app.use('*', async (c, next) => {
    c.set('ip', clientIp(c, config.trustProxy));
    Object.entries({ db, repo, config, mailer, engine, pusher, setup, log }).forEach(([k, v]) => c.set(k, v));
    return next();
  });
  if (config.prod)
    app.use('*', async (c, next) => {
      const t = performance.now();
      await next();
      // Method, path and status only: never bodies, cookies, query strings or tokens (some auth links
      // carry one in the path).
      const p = c.req.path.replace(/^(\/api\/auth\/(?:reset|invite|join)\/)[^/]+/, '$1…');
      log.info?.(`[http] ${c.req.method} ${p} ${c.res.status} ${Math.round(performance.now() - t)}ms`);
    });
  // Served files carry their own sandboxing CSP (routes/files.js); everything else gets the app's.
  const appHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      // Markup that slips into the page still can't re-point relative URLs, post forms elsewhere or
      // load plugins.
      baseUri: ["'none'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
    crossOriginEmbedderPolicy: false,
  });
  const fileHeaders = secureHeaders({ crossOriginEmbedderPolicy: false });
  app.use('*', (c, next) => (c.req.method === 'GET' && c.req.path.startsWith('/api/files/') ? fileHeaders : appHeaders)(c, next));

  // Request body caps. File uploads stream to disk under their own limit (MAX_UPLOAD_MB).
  const caps = {
    auth: bodyLimit({ maxSize: 64 * KB, onError: tooLarge }),
    sync: bodyLimit({ maxSize: 10 * KB * KB, onError: tooLarge }),
    other: bodyLimit({ maxSize: KB * KB, onError: tooLarge }),
  };
  const api = new Hono();
  api.use('*', (c, next) => {
    const p = c.req.path;
    if (c.req.method === 'POST' && /^\/api\/files\/?$/.test(p)) return next();
    return (p.startsWith('/api/auth/') ? caps.auth : p === '/api/sync' ? caps.sync : caps.other)(c, next);
  });
  api.use('*', csrfGuard);
  api.route('/auth', authRoutes({ limit }));
  api.route('/files', fileRoutes());
  api.route('/', dataRoutes());
  api.route('/', workspaceRoutes({ limit }));
  api.get('/health', c => {
    try {
      db.get('SELECT 1');
      return c.json({ ok: true });
    } catch (e) {
      log.error?.('[health] database check failed', e);
      return c.json({ ok: false, error: 'Database unavailable.' }, 503);
    }
  });
  api.all('*', c => c.json({ error: 'Not found.' }, 404));
  app.route('/api', api);

  app.onError((err, c) => {
    log.error?.('[http]', c.req.method, c.req.path, err);
    return c.json({ error: 'Something went wrong on our side. Try again in a moment.' }, 500);
  });

  // Production (or SERVE_STATIC=true): serve the built client and fall back to index.html for client-side routes.
  const index = path.join(config.staticDir, 'index.html');
  if (config.serveStatic && fs.existsSync(index)) {
    app.use('/assets/*', async (c, next) => {
      await next();
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    });
    // The service worker and manifest must be re-checked on every load so updates roll out.
    app.use('/sw.js', async (c, next) => {
      await next();
      c.header('Cache-Control', 'no-cache');
    });
    app.use('/manifest.webmanifest', async (c, next) => {
      await next();
      c.header('Content-Type', 'application/manifest+json');
      c.header('Cache-Control', 'no-cache');
    });
    app.use('*', serveStatic({ root: config.staticDir }));
    app.get('*', c => c.html(fs.readFileSync(index, 'utf8')));
  }

  return { app, repo, mailer, engine, pusher };
}
