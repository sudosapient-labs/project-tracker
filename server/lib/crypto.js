/* Passwords, opaque tokens, ids and TOTP, all on node:crypto. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [algo, N, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(key, expected);
}

/* A fixed hash compared against when the email is unknown, so login timing doesn't reveal accounts. */
let dummy;
export async function burnPasswordCheck(pw) {
  dummy ??= await hashPassword('not-a-real-password-1');
  await verifyPassword(pw, dummy);
}

export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/* Entity ids: prefix + 16 random base36-ish chars. Clients mint ids the same way (core/utils.js). */
export const newId = prefix => prefix + crypto.randomBytes(12).toString('base64url').replace(/[-_]/g, '').slice(0, 14).toLowerCase();

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0,
    val = 0,
    out = '';
  for (const b of buf) {
    val = (val << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0,
    val = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpAt(secret, t = Date.now()) {
  const counter = Math.floor(t / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
/* The time step a code belongs to, or null. Accepts the previous, current and next step to tolerate
   clock drift. Callers refuse steps at or before the last one accepted, so a code works once. */
export function totpStep(secret, code, t = Date.now()) {
  if (!secret || !/^\d{6}$/.test(code || '')) return null;
  const now = Math.floor(t / 30000);
  for (const d of [-1, 0, 1]) if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, (now + d) * 30000)), Buffer.from(code))) return now + d;
  return null;
}
export const verifyTotp = (secret, code, t) => totpStep(secret, code, t) != null;

export function newRecoveryCodes(n = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), b => chars[b % chars.length]).join('');
  return Array.from({ length: n }, () => `${part()}-${part()}`);
}

/* ---------- secrets at rest ---------- */
/* With SECRET_KEY set, TOTP secrets are stored as `enc:v1:<iv>.<tag>.<ciphertext>` (AES-256-GCM,
   base64url), keyed by SHA-256 of SECRET_KEY. Without it they stay as they are. */
const SEALED = 'enc:v1:';
const aesKey = secretKey => crypto.createHash('sha256').update(secretKey).digest();
export const isSealed = v => typeof v === 'string' && v.startsWith(SEALED);
export function seal(plain, secretKey) {
  if (!secretKey || plain == null || isSealed(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', aesKey(secretKey), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return SEALED + [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}
/* The plaintext, or null when it's sealed and SECRET_KEY is missing or wrong. */
export function unseal(stored, secretKey) {
  if (!isSealed(stored)) return stored ?? null;
  if (!secretKey) return null;
  try {
    const [iv, tag, body] = stored
      .slice(SEALED.length)
      .split('.')
      .map(s => Buffer.from(s, 'base64url'));
    const d = crypto.createDecipheriv('aes-256-gcm', aesKey(secretKey), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
