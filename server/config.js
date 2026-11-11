// @ts-check
/* Runtime configuration, read once from the environment. `pnpm dev` sets NODE_ENV=development and
   needs no .env file. Only NODE_ENV `development` and `test` relax security; any other value, or
   none at all, runs with production behaviour (Secure cookies, setup token, no emailed links in API
   responses), so a mistyped or unusual NODE_ENV fails closed. */
import fs from 'node:fs';

/* A size setting in MB: a non-negative number (fractions allowed), else `fallback`. */
const megabytes = (v, fallback) => (v != null && v !== '' && Number(v) >= 0 ? Number(v) : fallback);

/* The Android app (a Trusted Web Activity) that /.well-known/assetlinks.json vouches for. A wrong
   value would make Android quietly show the address bar, so a malformed one stops the server from
   starting instead, like a short SECRET_KEY. Fingerprints are keytool's SHA-256 form (32
   colon-separated hex bytes), comma separated; either case and spaces are accepted. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CERT_SHA256 = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/;
function androidApp(env) {
  const packageName = (env.ANDROID_PACKAGE_NAME || '').trim();
  if (packageName && !ANDROID_PACKAGE.test(packageName))
    throw new Error(`ANDROID_PACKAGE_NAME must be an Android application id such as dev.sudosapient.app (got "${packageName}").`);
  const raw = (env.ANDROID_CERT_FINGERPRINTS || '').trim();
  const fingerprints = [
    ...new Set(
      raw
        .split(',')
        .map(f => f.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const bad = fingerprints.find(f => !CERT_SHA256.test(f));
  if (bad || (raw && !fingerprints.length))
    throw new Error(
      `ANDROID_CERT_FINGERPRINTS must be SHA-256 certificate fingerprints (32 colon-separated hex bytes, as keytool prints them), comma separated (got "${bad ?? raw}").`,
    );
  return { packageName, fingerprints };
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'production';
  const dev = nodeEnv === 'development' || nodeEnv === 'test';
  const prod = !dev;
  const resendApiKey = env.RESEND_API_KEY || '';
  const secretKey = env.SECRET_KEY || '';
  if (secretKey && Buffer.byteLength(secretKey) < 32) throw new Error('SECRET_KEY must be at least 32 bytes long (e.g. `openssl rand -base64 32`).');
  return {
    env: nodeEnv,
    prod,
    test: nodeEnv === 'test',
    port: Number(env.PORT) || 8787,
    host: env.HOST || (prod ? '0.0.0.0' : '127.0.0.1'),
    // Legacy default from before the rename: keep using an existing local data/gr8r.db.
    dbPath: env.DATABASE_PATH || (!fs.existsSync('data/sudo-sapient.db') && fs.existsSync('data/gr8r.db') ? 'data/gr8r.db' : 'data/sudo-sapient.db'),
    uploadDir: env.UPLOAD_DIR || 'data/uploads',
    staticDir: env.STATIC_DIR || 'dist',
    serveStatic: env.SERVE_STATIC ? env.SERVE_STATIC === 'true' : prod,
    appUrl: (env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
    resendApiKey,
    mailFrom: env.MAIL_FROM || 'Sudo Sapient <no-reply@localhost>',
    // After the first account creates the workspace, new accounts need an invite unless this is on.
    allowOpenSignup: env.ALLOW_OPEN_SIGNUP === 'true',
    requireVerification: env.REQUIRE_EMAIL_VERIFICATION !== 'false',
    // Reverse proxies in front of the app that append to X-Forwarded-For: `true` means one.
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : Math.max(0, Math.floor(Number(env.TRUST_PROXY) || 0)),
    // Required to create the first (Owner) account; in production one is generated when unset.
    setupToken: env.SETUP_TOKEN || '',
    // Daily in-process backups (see scripts/backup.js) when set.
    backupDir: env.BACKUP_DIR || '',
    backupKeep: Math.max(1, Number(env.BACKUP_KEEP) || 14),
    // Web Push. Keys are generated and stored on first start when not set.
    vapidPublicKey: env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || '',
    vapidSubject: env.VAPID_SUBJECT || `mailto:${(env.MAIL_FROM || '').match(/<([^>]+)>/)?.[1] || 'admin@localhost'}`,
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : prod,
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 250) * 1024 * 1024,
    // All stored files together (copies share their bytes), so uploads can't fill the volume that
    // also holds the database; uploads also stop while the volume has less than minFreeDiskBytes free.
    uploadQuotaBytes: Math.round(megabytes(env.UPLOAD_QUOTA_MB, 5 * 1024) * 1024 * 1024),
    minFreeDiskBytes: Math.round(megabytes(env.MIN_FREE_DISK_MB, 1024) * 1024 * 1024),
    // Uploads each person may start an hour.
    uploadsPerHour: Math.max(1, Math.floor(Number(env.UPLOADS_PER_HOUR) || 60)),
    // Without a mail transport, development and test API responses include the emailed link so
    // the verify / reset screens can offer it directly. Never otherwise.
    exposeEmailLinks: dev && !resendApiKey,
    // Production without RESEND_API_KEY logs only recipient and subject; this also logs the link.
    logEmailLinks: env.LOG_EMAIL_LINKS === 'true',
    // Encrypts TOTP secrets at rest (AES-256-GCM) when set; see lib/crypto.js.
    secretKey,
    rateLimit: env.DISABLE_RATE_LIMIT !== 'true',
    // Requests per minute for each person's API keys together (/api/v1 and /api/mcp), counted in this process.
    apiRateLimit: Math.max(1, Math.floor(Number(env.API_RATE_LIMIT) || 120)),
    // ANDROID_PACKAGE_NAME and ANDROID_CERT_FINGERPRINTS: served as /.well-known/assetlinks.json
    // when both are set.
    android: androidApp(env),
  };
}
