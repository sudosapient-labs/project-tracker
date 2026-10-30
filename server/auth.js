/* Sessions and request authentication. A session is an opaque random token in an httpOnly cookie;
   only its SHA-256 is stored, so a database leak doesn't hand out live sessions. */
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { newId, sha256, token } from './lib/crypto.js';

export const COOKIE = 'gr8r_sid';
const DAY = 86_400_000;
const REMEMBER_MS = 30 * DAY;
const SESSION_MS = DAY;
const TOUCH_MS = 60_000;

export function createSession(c, db, userId, { remember = true, pending2fa = false } = {}) {
  const raw = token();
  const now = Date.now();
  const ttl = remember ? REMEMBER_MS : SESSION_MS;
  const id = newId('se');
  db.run(
    'INSERT INTO sessions (id, token_hash, user_id, user_agent, ip, pending_2fa, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    sha256(raw),
    userId,
    (c.req.header('user-agent') || '').slice(0, 400),
    c.get('ip') || '',
    pending2fa ? 1 : 0,
    now,
    now,
    now + ttl,
  );
  c.set('sessionToken', raw);
  setCookie(c, COOKIE, raw, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: c.get('config').secureCookies,
    path: '/',
    ...(remember ? { maxAge: ttl / 1000 } : {}),
  });
  return id;
}

export function clearSessionCookie(c) {
  c.set('sessionToken', '');
  deleteCookie(c, COOKIE, { path: '/', secure: c.get('config').secureCookies });
}

/* Resolve the cookie to { session, user, member }. Never throws; returns null when signed out. */
export function readSession(c, db) {
  // A session issued earlier in this same request takes precedence over the incoming cookie.
  const issued = c.get('sessionToken');
  const raw = issued ?? getCookie(c, COOKIE);
  if (!raw) return null;
  const s = db.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(raw));
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now) {
    db.run('DELETE FROM sessions WHERE id = ?', s.id);
    return null;
  }
  const user = db.get('SELECT * FROM users WHERE id = ?', s.user_id);
  const mrow = user && db.get('SELECT data FROM members WHERE id = ?', user.id);
  if (!user || !mrow) return null;
  if (now - s.last_seen_at > TOUCH_MS) db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, s.id);
  return { session: s, user, member: JSON.parse(mrow.data) };
}

/* Middleware: populate c.var.auth. `level` decides what a request needs:
   'session' any signed-in session (even mid-2FA), 'account' 2FA complete, 'member' also email verified. */
export const requireAuth =
  (level = 'member') =>
  async (c, next) => {
    const a = readSession(c, c.get('db'));
    if (!a) return c.json({ error: 'Sign in to continue.', code: 'unauthenticated' }, 401);
    if (level !== 'session' && a.session.pending_2fa) return c.json({ error: 'Enter your two-factor code to continue.', code: 'two_factor' }, 401);
    if (level === 'member' && c.get('config').requireVerification && !a.user.email_verified_at)
      return c.json({ error: 'Verify your email to continue.', code: 'unverified' }, 403);
    c.set('auth', a);
    return next();
  };

/* Mutating requests must carry a custom header. Browsers can't add one cross-site without a CORS
   preflight (which this API never approves), so together with SameSite cookies this blocks CSRF. */
export const csrfGuard = async (c, next) => {
  const m = c.req.method;
  if (m !== 'GET' && m !== 'HEAD' && c.req.header('x-requested-with') !== 'gr8r') return c.json({ error: 'Missing request header.' }, 403);
  return next();
};

export function describeAgent(ua = '') {
  const os = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Unknown device';
  const br = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  return `${os} · ${br}`;
}

export function relTime(ts, now = Date.now()) {
  const m = Math.round((now - ts) / 60000);
  if (m < 5) return 'Active now';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? 'Yesterday' : `${d} days ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* Sessions in the shape the settings page renders. */
export function listSessions(db, userId, currentId) {
  return db.all('SELECT * FROM sessions WHERE user_id = ? AND expires_at > ? AND pending_2fa = 0 ORDER BY last_seen_at DESC', userId, Date.now()).map(s => ({
    id: s.id,
    dev: describeAgent(s.user_agent),
    loc: s.ip || 'Unknown location',
    at: s.id === currentId ? 'Active now' : relTime(s.last_seen_at),
    cur: s.id === currentId,
  }));
}
