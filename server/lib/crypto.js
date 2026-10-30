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
/* Accept the previous, current and next step to tolerate clock drift. */
export function verifyTotp(secret, code, t = Date.now()) {
  if (!secret || !/^\d{6}$/.test(code || '')) return false;
  return [-1, 0, 1].some(d => {
    const a = Buffer.from(totpAt(secret, t + d * 30000));
    return crypto.timingSafeEqual(a, Buffer.from(code));
  });
}

export function newRecoveryCodes(n = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from(crypto.randomBytes(4), b => chars[b % chars.length]).join('');
  return Array.from({ length: n }, () => `${part()}-${part()}`);
}
