/* /api/auth: sign up, email verification, sign in (with optional TOTP), sign out, password reset,
   password change, sessions and two-factor setup. */
import { Hono } from 'hono';
import { z } from 'zod';
import QRCode from 'qrcode';
import { TEAMS_SEED } from '../../src/core/constants.js';
import { clearSessionCookie, createSession, listSessions, readSession, requireAuth } from '../auth.js';
import { burnPasswordCheck, hashPassword, newId, newRecoveryCodes, newTotpSecret, sha256, token, verifyPassword, verifyTotp } from '../lib/crypto.js';
import { parseBody } from '../lib/http.js';

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const email = z.string().trim().toLowerCase().max(254).regex(EMAIL_RE, 'Enter a valid email, like name@company.com');
const password = z
  .string()
  .max(200)
  .refine(p => p.length >= 10 && /[0-9\W]/.test(p), 'Use at least 10 characters, including a number or symbol');

const AVATAR_COLORS = ['#5A67D8', '#C54B78', '#3B82C4', '#23918A', '#C48A1E', '#8662C9', '#3D8E5F', '#C0612B'];
export const avatarColor = seed => AVATAR_COLORS[[...seed].reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_COLORS.length];

const MIN = 60_000;
const TTL = { verify: 48 * 60 * MIN, reset: 30 * MIN, invite: 14 * 24 * 60 * MIN };
const LINK = { verify: 'verify', reset: 'reset', invite: 'invite' };

/* Single-use tokens. Issuing a new verify/reset token retires older unused ones for that email. */
export function issueToken(db, config, kind, emailAddr, userId = null) {
  const raw = token();
  const now = Date.now();
  if (kind !== 'invite') db.run('UPDATE auth_tokens SET used_at = ? WHERE email = ? AND kind = ? AND used_at IS NULL', now, emailAddr, kind);
  db.run(
    'INSERT INTO auth_tokens (token_hash, kind, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(raw),
    kind,
    userId,
    emailAddr,
    now,
    now + TTL[kind],
  );
  return `${config.appUrl}/#${LINK[kind]}/${raw}`;
}
function findToken(db, kind, raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = db.get('SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ?', sha256(raw), kind);
  if (!t || t.used_at || t.expires_at < Date.now()) return null;
  return t;
}
const useToken = (db, t) => db.run('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?', Date.now(), t.token_hash);

export function authRoutes({ limit }) {
  const r = new Hono();

  const sessionState = c => {
    const { db, repo, config } = c.var;
    const a = readSession(c, db);
    const ws = repo.workspace();
    return {
      user: a
        ? {
            id: a.user.id,
            email: a.user.email,
            name: a.member.name,
            role: a.member.role,
            verified: !!a.user.email_verified_at || !config.requireVerification,
            twoFactorPending: !!a.session.pending_2fa,
          }
        : null,
      workspace: ws ? { name: ws.name, onboarded: ws.onboarded } : null,
    };
  };
  const devLink = (c, link) => (c.var.config.exposeEmailLinks ? { devLink: link } : {});

  r.get('/session', c => c.json(sessionState(c)));

  /* ---------- sign up ---------- */
  r.post('/signup', limit('signup', 10, 10 * MIN), async c => {
    const b = await parseBody(
      c,
      z.object({ name: z.string().trim().min(1, 'Enter your name').max(80), email, password, invite: z.string().max(200).optional() }),
    );
    if (b.error) return b.error;
    const { db, repo, config, mailer, engine } = c.var;
    const { name, email: em, password: pw, invite } = b.data;
    if (db.get('SELECT 1 FROM users WHERE email = ?', em))
      return c.json({ error: 'An account with this email already exists. Sign in instead.', field: 'email' }, 409);

    const hash = await hashPassword(pw);
    const inviteTok = invite && findToken(db, 'invite', invite);
    const inviteOk = inviteTok && inviteTok.email.toLowerCase() === em;
    let out;
    try {
      out = db.tx(() => {
        let ws = repo.workspace();
        const now = Date.now();
        let member;
        if (!ws) {
          // First account: create the workspace and make this person its Owner.
          ws = { name: '', c: '#5A67D8', onboarded: false };
          repo.saveWorkspace(ws);
          for (const t of TEAMS_SEED) repo.put('teams', { ...t });
          member = { id: newId('m'), name, email: em, role: 'Owner', team: '', title: '', c: avatarColor(em), status: 'active', last: 0, tz: '' };
        } else {
          const invited = repo.all('members', "WHERE lower(json_extract(data, '$.email')) = ?", em)[0];
          if (invited && invited.status === 'invited') member = { ...invited, name, status: 'active', last: 0 };
          else if (config.allowOpenSignup)
            member = { id: newId('m'), name, email: em, role: 'Member', team: '', title: '', c: avatarColor(em), status: 'active', last: 0, tz: '' };
          else throw Object.assign(new Error('invite-only'), { status: 403 });
        }
        repo.put('members', member);
        db.run(
          'INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)',
          member.id,
          em,
          hash,
          inviteOk ? now : null,
          now,
        );
        if (inviteOk) useToken(db, inviteTok);
        const link = inviteOk ? null : issueToken(db, config, 'verify', em, member.id);
        if (link)
          mailer.queue({
            to: em,
            subject: 'Verify your email for Gr8r Studio',
            intro: `Hi ${name}, confirm this is your email address to finish setting up your Gr8r Studio account.`,
            action: 'Verify email',
            link,
            outro: 'The link expires in 48 hours. If you didn’t create an account, you can ignore this email.',
          });
        return { member, link };
      });
    } catch (e) {
      if (e.status === 403) return c.json({ error: `This workspace is invite-only. Ask an admin to invite ${em}.`, field: 'email', code: 'invite_only' }, 403);
      throw e;
    }
    mailer.drain();
    engine.publish([{ c: 'members', id: out.member.id, v: out.member }]);
    createSession(c, db, out.member.id, { remember: true });
    return c.json({ ...sessionState(c), ...(out.link ? devLink(c, out.link) : {}) }, 201);
  });

  /* Prefill for the sign-up screen when someone opens an invite link. */
  r.get('/invite/:token', c => {
    const { db, repo } = c.var;
    const t = findToken(db, 'invite', c.req.param('token'));
    if (!t) return c.json({ error: 'This invite link has expired or was already used.' }, 404);
    const m = repo.all('members', "WHERE lower(json_extract(data, '$.email')) = ?", t.email.toLowerCase())[0];
    return c.json({ email: t.email, name: m?.status === 'invited' ? '' : m?.name || '', workspace: repo.workspace()?.name || '' });
  });

  /* ---------- email verification ---------- */
  r.post('/verify', limit('verify', 20, 10 * MIN), async c => {
    const b = await parseBody(c, z.object({ token: z.string().max(200) }));
    if (b.error) return b.error;
    const { db } = c.var;
    const t = findToken(db, 'verify', b.data.token);
    if (!t) return c.json({ error: 'This verification link has expired or was already used. Request a new one.' }, 400);
    db.tx(() => {
      useToken(db, t);
      db.run('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE email = ?', Date.now(), t.email);
    });
    return c.json(sessionState(c));
  });

  r.post('/verify/resend', limit('resend', 5, 10 * MIN), requireAuth('account'), c => {
    const { db, config, mailer } = c.var;
    const { user, member } = c.var.auth;
    if (user.email_verified_at) return c.json(sessionState(c));
    const link = issueToken(db, config, 'verify', user.email, user.id);
    mailer.queue({
      to: user.email,
      subject: 'Verify your email for Gr8r Studio',
      intro: `Hi ${member.name}, confirm this is your email address to finish setting up your Gr8r Studio account.`,
      action: 'Verify email',
      link,
      outro: 'The link expires in 48 hours.',
    });
    mailer.drain();
    return c.json({ ok: true, ...devLink(c, link) });
  });

  /* ---------- sign in / out ---------- */
  r.post('/login', limit('login', 10, MIN), async c => {
    const b = await parseBody(c, z.object({ email, password: z.string().min(1, 'Enter your password').max(200), remember: z.boolean().optional() }));
    if (b.error) return b.error;
    const { db } = c.var;
    const user = db.get('SELECT * FROM users WHERE email = ?', b.data.email);
    if (!user) {
      await burnPasswordCheck(b.data.password);
      return c.json({ error: 'Incorrect email or password.' }, 401);
    }
    if (!(await verifyPassword(b.data.password, user.password_hash))) return c.json({ error: 'Incorrect email or password.' }, 401);
    createSession(c, db, user.id, { remember: b.data.remember !== false, pending2fa: !!user.totp_enabled });
    return c.json({ ...sessionState(c), twoFactor: !!user.totp_enabled });
  });

  r.post('/2fa/verify', limit('2fa', 10, MIN), requireAuth('session'), async c => {
    const b = await parseBody(c, z.object({ code: z.string().trim().max(20) }));
    if (b.error) return b.error;
    const { db } = c.var;
    const { session, user } = c.var.auth;
    if (!session.pending_2fa) return c.json(sessionState(c));
    const code = b.data.code.replace(/\s/g, '');
    let ok = verifyTotp(user.totp_secret, code);
    if (!ok) {
      const codes = JSON.parse(user.recovery_codes || '[]');
      const h = sha256(code.toUpperCase());
      if (codes.includes(h)) {
        ok = true;
        db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(codes.filter(x => x !== h)), user.id);
      }
    }
    if (!ok) return c.json({ error: "That code didn't work. Check your authenticator app and try again.", field: 'code' }, 401);
    db.run('UPDATE sessions SET pending_2fa = 0 WHERE id = ?', session.id);
    return c.json(sessionState(c));
  });

  r.post('/logout', c => {
    const a = readSession(c, c.var.db);
    if (a) c.var.db.run('DELETE FROM sessions WHERE id = ?', a.session.id);
    if (a) c.var.engine.disconnectSession(a.session.id);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  /* ---------- password reset ---------- */
  r.post('/forgot', limit('forgot', 5, 10 * MIN), async c => {
    const b = await parseBody(c, z.object({ email }));
    if (b.error) return b.error;
    const { db, config, mailer } = c.var;
    const user = db.get('SELECT * FROM users WHERE email = ?', b.data.email);
    // Same response whether or not the account exists.
    if (!user) return c.json({ ok: true });
    const link = issueToken(db, config, 'reset', user.email, user.id);
    mailer.queue({
      to: user.email,
      subject: 'Reset your Gr8r Studio password',
      intro: 'We got a request to reset the password for your Gr8r Studio account.',
      action: 'Choose a new password',
      link,
      outro: 'The link expires in 30 minutes. If you didn’t ask for this, you can ignore this email.',
    });
    mailer.drain();
    return c.json({ ok: true, ...devLink(c, link) });
  });

  r.get('/reset/:token', c => {
    const t = findToken(c.var.db, 'reset', c.req.param('token'));
    if (!t) return c.json({ error: 'This reset link has expired or was already used. Request a new one.' }, 404);
    return c.json({ email: t.email });
  });

  r.post('/reset', limit('reset', 10, 10 * MIN), async c => {
    const b = await parseBody(c, z.object({ token: z.string().max(200), password }));
    if (b.error) return b.error;
    const { db, engine } = c.var;
    const t = findToken(db, 'reset', b.data.token);
    if (!t) return c.json({ error: 'This reset link has expired or was already used. Request a new one.' }, 400);
    const hash = await hashPassword(b.data.password);
    const user = db.get('SELECT id FROM users WHERE email = ?', t.email);
    if (!user) return c.json({ error: 'This reset link has expired or was already used. Request a new one.' }, 400);
    const ids = db.all('SELECT id FROM sessions WHERE user_id = ?', user.id).map(s => s.id);
    db.tx(() => {
      useToken(db, t);
      // Following an emailed link also proves the address.
      db.run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hash, Date.now(), user.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    });
    ids.forEach(id => engine.disconnectSession(id));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  /* ---------- signed-in account management ---------- */
  r.post('/password', limit('password', 10, 10 * MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ current: z.string().min(1, 'Enter your current password').max(200), password }));
    if (b.error) return b.error;
    const { user } = c.var.auth;
    if (!(await verifyPassword(b.data.current, user.password_hash))) return c.json({ error: 'Your current password is incorrect.', field: 'current' }, 400);
    c.var.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(b.data.password), user.id);
    return c.json({ ok: true });
  });

  r.get('/sessions', requireAuth('account'), c => c.json(listSessions(c.var.db, c.var.auth.user.id, c.var.auth.session.id)));

  r.delete('/sessions/:id', requireAuth('account'), c => {
    const { db, engine } = c.var;
    const { user, session } = c.var.auth;
    const id = c.req.param('id');
    if (id === session.id) return c.json({ error: 'Use Sign out to end this session.' }, 400);
    db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, user.id);
    engine.disconnectSession(id);
    return c.json(listSessions(db, user.id, session.id));
  });

  r.post('/sessions/revoke-others', requireAuth('account'), c => {
    const { db, engine } = c.var;
    const { user, session } = c.var.auth;
    const ids = db.all('SELECT id FROM sessions WHERE user_id = ? AND id != ?', user.id, session.id).map(s => s.id);
    db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', user.id, session.id);
    ids.forEach(id => engine.disconnectSession(id));
    return c.json(listSessions(db, user.id, session.id));
  });

  /* ---------- two-factor setup ---------- */
  r.post('/2fa/setup', requireAuth('account'), async c => {
    const { db } = c.var;
    const { user } = c.var.auth;
    if (user.totp_enabled) return c.json({ error: 'Two-factor authentication is already on.' }, 400);
    const secret = newTotpSecret();
    db.run('UPDATE users SET totp_secret = ? WHERE id = ?', secret, user.id);
    const label = encodeURIComponent(`Gr8r Studio:${user.email}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Gr8r Studio')}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toString(otpauth, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    return c.json({ secret, otpauth, qr });
  });

  r.post('/2fa/enable', limit('2fa-enable', 10, MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ code: z.string().trim().max(10) }));
    if (b.error) return b.error;
    const { db } = c.var;
    const { user } = c.var.auth;
    if (!user.totp_secret || !verifyTotp(user.totp_secret, b.data.code))
      return c.json({ error: 'That code didn’t match. Enter the current 6-digit code from your app.', field: 'code' }, 400);
    const codes = newRecoveryCodes();
    db.run('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', JSON.stringify(codes.map(x => sha256(x))), user.id);
    return c.json({ ok: true, recoveryCodes: codes });
  });

  r.post('/2fa/disable', requireAuth('account'), c => {
    c.var.db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]' WHERE id = ?", c.var.auth.user.id);
    return c.json({ ok: true });
  });

  return r;
}
