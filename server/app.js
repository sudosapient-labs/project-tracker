/* The HTTP application. Built from injected dependencies so tests can run it against an
   in-memory database without opening a port. */
import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { createRepo } from './repo.js';
import { createMailer } from './lib/mailer.js';
import { createPusher } from './lib/push.js';
import { rateLimiter } from './lib/rate-limit.js';
import { csrfGuard } from './auth.js';
import { createEngine } from './sync/engine.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { fileRoutes } from './routes/files.js';
import { workspaceRoutes } from './routes/workspace.js';

export function createApp({ db, config, log = console, pushSend }) {
  const repo = createRepo(db);
  const mailer = createMailer(db, config, log);
  const pusher = createPusher(db, config, log, pushSend);
  const engine = createEngine({ db, repo, config, mailer, pusher, log });
  const limit = rateLimiter({ enabled: config.rateLimit });
  const app = new Hono();

  app.use('*', async (c, next) => {
    const sock = c.env?.incoming?.socket?.remoteAddress || '';
    const fwd = config.trustProxy ? (c.req.header('x-forwarded-for') || '').split(',')[0].trim() : '';
    c.set('ip', (fwd || sock || 'local').replace(/^::ffff:/, ''));
    Object.entries({ db, repo, config, mailer, engine, pusher }).forEach(([k, v]) => c.set(k, v));
    return next();
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const api = new Hono();
  api.use('*', csrfGuard);
  api.route('/auth', authRoutes({ limit }));
  api.route('/files', fileRoutes());
  api.route('/', dataRoutes());
  api.route('/', workspaceRoutes());
  api.get('/health', c => c.json({ ok: true }));
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
