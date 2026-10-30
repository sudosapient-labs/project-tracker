/* Process entry: open the database, start the HTTP server, run housekeeping, shut down cleanly. */
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { housekeep, runDigests, runReminders } from './jobs.js';
import { backup, backupDue, backupUploads } from './lib/backup.js';

// Log what would otherwise vanish or kill the process silently. An uncaught exception leaves the
// process in an unknown state, so it still exits (the host restarts it).
process.on('unhandledRejection', e => console.error('[process] unhandled rejection', e));
process.on('uncaughtException', e => {
  console.error('[process] uncaught exception', e);
  process.exit(1);
});

const config = loadConfig();
const db = openDb(config.dbPath);
const deps = createApp({ db, config });
const { app, mailer } = deps;

const { engine } = deps;
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  console.info(`[api] listening on http://${info.address}:${info.port} (${config.env}${config.prod ? ', production security' : ''})`);
  if (!config.resendApiKey && config.prod)
    console.warn(
      `[api] WARNING: RESEND_API_KEY is not set, so no email is sent: verification, password reset and invite emails are lost. Only recipient and subject are logged${config.logEmailLinks ? ', plus the link (LOG_EMAIL_LINKS=true)' : ''}.`,
    );
  else if (!config.resendApiKey) console.info('[api] RESEND_API_KEY not set: emails are logged to this console instead of sent');
  if (!config.secretKey && config.prod) console.warn('[api] WARNING: SECRET_KEY is not set, so two-factor secrets are stored unencrypted.');
});

const housekeeping = setInterval(() => {
  try {
    housekeep({ db });
  } catch (e) {
    console.error('[housekeeping] failed', e);
  }
  mailer.drain();
}, 60_000);
housekeeping.unref();

const JOBS_MS = 5 * 60_000;
const jobs = setInterval(() => {
  for (const job of [runReminders, runDigests])
    try {
      job({ ...deps, db, config });
    } catch (e) {
      console.error(`[jobs] ${job.name} failed`, e);
    }
}, JOBS_MS);
jobs.unref();

// BACKUP_DIR set: a database backup a day, checked hourly so restarts don't skip or repeat one.
function dailyBackup() {
  try {
    if (!backupDue(config.backupDir, 86_400_000)) return;
    console.info(`[backup] wrote ${backup(db, config.backupDir, config.backupKeep)}`);
    console.info(`[backup] copied ${backupUploads(config.uploadDir, config.backupDir)} new uploaded file(s)`);
  } catch (e) {
    console.error('[backup] failed', e);
  }
}
let backups = null;
if (config.backupDir) {
  dailyBackup();
  backups = setInterval(dailyBackup, 3_600_000);
  backups.unref();
}

/* Stop taking work, end the live-update streams (otherwise server.close waits on them), let open
   requests finish, then close the database. Forced out after 3 seconds if something hangs. */
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(housekeeping);
  clearInterval(jobs);
  clearInterval(backups);
  engine.closeAll();
  server.close(() => {
    db.close();
    console.info('[api] stopped');
    process.exit(0);
  });
  // Keep-alive connections only close once idle, which a just-ended stream becomes a moment later.
  server.closeIdleConnections?.();
  setInterval(() => server.closeIdleConnections?.(), 100).unref();
  setTimeout(() => {
    console.error('[api] shutdown timed out; exiting');
    process.exit(1);
  }, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
