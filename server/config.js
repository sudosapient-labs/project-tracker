/* Runtime configuration, read once from the environment. Every value has a safe local default so
   `pnpm dev` works with no .env file; production deployments override what they need. */
export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const prod = nodeEnv === 'production';
  const resendApiKey = env.RESEND_API_KEY || '';
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
    trustProxy: env.TRUST_PROXY === 'true',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : prod,
    maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 250) * 1024 * 1024,
    // Without a mail transport, non-production API responses include the emailed link so the
    // verify / reset screens can offer it directly. Never on in production.
    exposeEmailLinks: !prod && !resendApiKey,
    rateLimit: env.DISABLE_RATE_LIMIT !== 'true',
  };
}
