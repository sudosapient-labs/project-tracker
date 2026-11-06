// @ts-check
/* Personal API keys. A key is `ssk_` + 32 random bytes; only its SHA-256 is stored (like sessions:
   it's high-entropy, so a fast hash is enough), with a short prefix for the list in Settings → API.
   A key acts as the member it belongs to (a person, or a bot an admin made it for; see bots.js),
   with that member's current role and project access. `created_by` records who made it. */
import { newId, sha256, token } from '../lib/crypto.js';

export const KEY_PREFIX = 'ssk_';
export const MAX_KEYS = 25;
const DAY = 86_400_000;
const TOUCH_MS = 60_000;

/* The shape Settings → API renders; never the hash. */
const view = k => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  scope: k.scope,
  createdAt: k.created_at,
  lastUsedAt: k.last_used_at,
  expiresAt: k.expires_at,
  createdBy: k.created_by ?? null,
});

export const listKeys = (db, userId) => db.all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', userId).map(view);

/* Returns { key, token }: the token is shown once and can't be recovered. `createdBy` is the person
   making it: the owner of a personal key, or the Owner/Admin making a key for a bot. */
export function createKey(db, userId, { name, scope, expiresInDays, createdBy = userId }, now = Date.now()) {
  const raw = KEY_PREFIX + token(32);
  const row = {
    id: newId('k'),
    user_id: userId,
    name,
    prefix: raw.slice(0, 12),
    token_hash: sha256(raw),
    scope,
    created_at: now,
    last_used_at: null,
    expires_at: expiresInDays ? now + expiresInDays * DAY : null,
    created_by: createdBy,
  };
  db.run(
    'INSERT INTO api_keys (id, user_id, name, prefix, token_hash, scope, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    row.id,
    row.user_id,
    row.name,
    row.prefix,
    row.token_hash,
    row.scope,
    row.created_at,
    row.expires_at,
    row.created_by,
  );
  return { key: view(row), token: raw };
}

export const revokeKey = (db, userId, id) => db.run('DELETE FROM api_keys WHERE id = ? AND user_id = ?', id, userId).changes > 0;

/* Resolve a presented key to { key, user, member }, or { error } naming why it can't be used. */
export function readKey(db, raw, now = Date.now()) {
  if (!raw?.startsWith(KEY_PREFIX)) return { error: 'invalid_key' };
  const k = db.get('SELECT * FROM api_keys WHERE token_hash = ?', sha256(raw));
  if (!k) return { error: 'invalid_key' };
  if (k.expires_at && k.expires_at < now) return { error: 'expired_key' };
  const user = db.get('SELECT * FROM users WHERE id = ?', k.user_id);
  const mrow = user && db.get('SELECT data FROM members WHERE id = ?', user.id);
  if (!mrow) return { error: 'invalid_key' };
  if (!k.last_used_at || now - k.last_used_at > TOUCH_MS) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now, k.id);
  return { key: k, user, member: JSON.parse(mrow.data) };
}
