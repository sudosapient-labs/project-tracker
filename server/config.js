/* Runtime configuration, read once from the environment. `pnpm dev` sets NODE_ENV=development and
   needs no .env file. Only NODE_ENV `development` and `test` relax security; any other value, or
   none at all, runs with production behaviour (Secure cookies, setup token, no emailed links in API
   responses), so a mistyped or unusual NODE_ENV fails closed. */
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
    dbPath: env.DATABASE_PATH || 'data/gr8r.db',
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
    // Without a mail transport, development and test API responses include the emailed link so
    // the verify / reset screens can offer it directly. Never otherwise.
    exposeEmailLinks: dev && !resendApiKey,
    // Production without RESEND_API_KEY logs only recipient and subject; this also logs the link.
    logEmailLinks: env.LOG_EMAIL_LINKS === 'true',
    // Encrypts TOTP secrets at rest (AES-256-GCM) when set; see lib/crypto.js.
    secretKey,
    rateLimit: env.DISABLE_RATE_LIMIT !== 'true',
  };
}
