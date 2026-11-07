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
import { createUploads, fileRoutes } from './routes/files.js';
import { workspaceRoutes } from './routes/workspace.js';
import { keyRoutes } from './routes/keys.js';
import { botRoutes } from './routes/bots.js';
import { docsRoutes } from './routes/docs.js';
import { v1Routes } from './api/v1.js';
import { openapi } from './api/openapi.js';
import { mcpRoutes } from './routes/mcp.js';

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

  // Behind a proxy without TRUST_PROXY every request seems to come from the proxy, so all clients
  // share one rate-limit budget. Say so once.
  let proxyWarned = false;
  app.use('*', async (c, next) => {
    if (config.prod && !config.trustProxy && !proxyWarned && c.req.header('x-forwarded-for')) {
      proxyWarned = true;
      log.error?.(
        '[security] WARNING: requests carry X-Forwarded-For but TRUST_PROXY is not set, so rate limits count every client as the proxy. Set TRUST_PROXY to the number of proxies in front of the app (see docs/configuration.md).',
      );
    }
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
    // Matches frame-ancestors 'none' for browsers that only know the older header.
    xFrameOptions: 'DENY',
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
  // Nothing the API answers (data, files, errors) is kept by the browser or a shared cache, so it
  // can't be read back from disk or by whoever uses the browser next.
  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  api.use('*', (c, next) => {
    const p = c.req.path;
    if (c.req.method === 'POST' && /^\/api\/(v1\/)?files\/?$/.test(p)) return next();
    return (p.startsWith('/api/auth/') ? caps.auth : p === '/api/sync' ? caps.sync : caps.other)(c, next);
  });
  // The token API only takes bearer keys, never the session cookie, so it needs no CSRF header.
  const tokenApi = p => p.startsWith('/api/v1/') || p === '/api/mcp';
  api.use('*', (c, next) => (tokenApi(c.req.path) ? next() : csrfGuard(c, next)));
  const uploads = createUploads({ limit });
  const v1 = v1Routes({ limit, uploads });
  api.route('/v1', v1.routes);
  api.route('/docs', docsRoutes({ spec: c => openapi(v1.R, { appUrl: c.var.config.appUrl }) }));
  // MCP tools call /api/v1 in-process, through the same middleware as any other API request.
  api.route('/mcp', mcpRoutes({ limit, request: (url, init) => app.request(url, init) }));
  api.route('/keys', keyRoutes({ limit }));
  api.route('/bots', botRoutes({ limit }));
  api.route('/auth', authRoutes({ limit }));
  api.route('/files', fileRoutes({ uploads }));
  api.route('/', dataRoutes({ limit }));
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
