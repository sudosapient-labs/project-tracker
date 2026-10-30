/* Process entry: open the database, start the HTTP server, run housekeeping, shut down cleanly. */
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const { app, mailer } = createApp({ db, config });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.info(`[api] listening on http://${info.address}:${info.port} (${config.env})`);
  if (!config.smtpUrl) console.info('[api] SMTP_URL not set: emails are logged to this console instead of sent');
});

const housekeeping = setInterval(() => {
  const now = Date.now();
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  db.run('DELETE FROM auth_tokens WHERE expires_at < ?', now - 7 * 86_400_000);
  mailer.drain();
}, 60_000);
housekeeping.unref();

function shutdown() {
  clearInterval(housekeeping);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
