/* Middleware for token-authenticated endpoints (/api/v1, /api/mcp): bearer keys, scopes, per-person
   rate limits and idempotent retries. These endpoints never read the session cookie, which is why
   they don't need the CSRF header: a cross-site page can't make a browser attach a bearer key. */
import { sha256 } from '../lib/crypto.js';
import { readKey } from './keys.js';

const MIN = 60_000;
const CODES = {
  400: 'invalid_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  422: 'unprocessable',
  429: 'rate_limited',
};
const KEY_ERRORS = {
  invalid_key: 'That API key isn’t valid. It may have been revoked; create a new one in Settings → API.',
  expired_key: 'That API key has expired. Create a new one in Settings → API.',
};

/* The one error shape of the public API: { error, code, field? }. */
export const fail = (c, status, error, code = CODES[status] || 'server_error', field) => c.json({ error, code, ...(field ? { field } : {}) }, status);

/* What made a change, for "Ada via Claude" in activity: the client's own label (X-Sudo-Client, sent
   by the CLI and MCP server), else the key's name. Printable text only, kept short. */
const printable = s =>
  String(s || '')
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
export function viaLabel(c, key) {
  let raw = c.req.header('x-sudo-client') || '';
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* not encoded: use it as sent */
  }
  return (printable(raw) || printable(key.name) || 'API').slice(0, 40);
}

/* Authorization: Bearer <key>. Sets c.var.auth ({ key, user, member }, the shape the sync engine
   takes) and c.var.via. Requests are limited per person, across all their keys, so making more
   keys doesn't raise the limit (RateLimit-* headers; 429 with Retry-After). */
export const bearer =
  ({ limit }) =>
  async (c, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
    if (!m) return fail(c, 401, 'Send a personal API key: Authorization: Bearer <key>. Create one in Settings → API.');
    const { db, config } = c.var;
    // A bad key is refused before the body is read. A good one is checked again once the whole
    // request has arrived, not only before a slow body (writes check it again in their
    // transaction; see engine.apply).
    let a = readKey(db, m[1]);
    if (!a.error && c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      await c.req.arrayBuffer();
      a = readKey(db, m[1]);
    }
    if (a.error) return fail(c, 401, KEY_ERRORS[a.error], a.error);
    // A bot has no email to verify (see bots.js); its keys were made by a signed-in admin.
    if (config.requireVerification && a.user.kind !== 'bot' && !a.user.email_verified_at)
      return fail(c, 403, 'Verify your email to use the API.', 'unverified');
    const r = limit.take(`api:${a.user.id}`, config.apiRateLimit, MIN);
    c.header('RateLimit-Limit', String(r.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, r.remaining)));
    c.header('RateLimit-Reset', String(r.reset));
    if (!r.ok) {
      c.header('Retry-After', String(r.reset));
      return fail(c, 429, `Your API keys are limited to ${r.limit} requests a minute together. Try again in ${r.reset} s.`);
    }
    c.set('auth', a);
    c.set('via', viaLabel(c, a.key));
    return next();
  };

/* Read keys may only read. */
export const scoped = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.var.auth.key.scope !== 'write')
    return fail(c, 403, 'This API key is read-only. Create a key with write access to make changes.', 'insufficient_scope');
  return next();
};

/* Idempotency-Key on mutating requests: the first response (unless it was a server error) is kept
   for 24 hours and replayed for retries with the same key, method, path and body. The same key with
   a different request is refused; one still being handled answers 409. */
const inflight = new Set();
export const idempotent = async (c, next) => {
  const idem = c.req.header('idempotency-key');
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || idem == null) return next();
  if (!/^[\x21-\x7e]{1,255}$/.test(idem)) return fail(c, 400, 'Idempotency-Key must be 1–255 printable characters.', 'invalid_request', 'Idempotency-Key');
  const { db } = c.var;
  const keyId = c.var.auth.key.id;
  const fingerprint = sha256(`${c.req.method} ${c.req.path}\n${await c.req.text()}`);
  const seen = db.get('SELECT * FROM api_idempotency WHERE key_id = ? AND idem_key = ?', keyId, idem);
  if (seen) {
    if (seen.fingerprint !== fingerprint) return fail(c, 422, 'This Idempotency-Key was already used for a different request.', 'idempotency_mismatch');
    c.header('Idempotent-Replayed', 'true');
    return c.body(seen.body, seen.status, { 'content-type': 'application/json' });
  }
  const lock = `${keyId}:${idem}`;
  if (inflight.has(lock)) return fail(c, 409, 'A request with this Idempotency-Key is still being handled.', 'idempotency_in_progress');
  inflight.add(lock);
  try {
    await next();
    // A write that committed is recorded even if answering then failed, so a retry can't repeat it.
    if (c.res.status < 500 || c.get('committed'))
      db.run(
        'INSERT OR REPLACE INTO api_idempotency (key_id, idem_key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        keyId,
        idem,
        fingerprint,
        c.res.status,
        await c.res.clone().text(),
        Date.now(),
      );
  } finally {
    inflight.delete(lock);
  }
};
