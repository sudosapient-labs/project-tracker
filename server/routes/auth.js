/* /api/auth: sign up, email verification, sign in (with optional TOTP), sign out, password reset,
   password and email change, sessions, two-factor setup and deleting your account. */
import { Hono } from 'hono';
import { z } from 'zod';
import QRCode from 'qrcode';
import { TEAMS_SEED } from '../../src/core/constants.js';
import { clearSessionCookie, createSession, forgetDevices, listSessions, readDevice, readSession, rememberDevice, requireAuth } from '../auth.js';
import {
  burnPasswordCheck,
  hashPassword,
  newId,
  newRecoveryCodes,
  newTotpSecret,
  seal,
  sha256,
  token,
  totpStep,
  unseal,
  verifyPassword,
} from '../lib/crypto.js';
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
const TTL = { verify: 48 * 60 * MIN, reset: 30 * MIN, invite: 14 * 24 * 60 * MIN, join: 30 * 24 * 60 * MIN, email: 24 * 60 * MIN };
const LINK = { verify: 'verify', reset: 'reset', invite: 'invite', join: 'join', email: 'email' };
// Failed sign-ins per email (whatever the IP) or, from a browser that signed in to the account
// before, per device; wrong codes per session waiting for two-factor, and per account.
const LOGIN_FAILS = 10;
const LOGIN_FAIL_MS = 15 * MIN;
const TFA_FAILS = 5;
const TFA_ACCOUNT_FAILS = 10;
const TFA_LOCK_MS = 15 * MIN;

/* Single-use tokens. Issuing a new verify/reset token retires older unused ones for that email, and
   a new email-change token retires the person's earlier ones. */
export function issueToken(db, config, kind, emailAddr, userId = null) {
  const raw = token();
  const now = Date.now();
  if (kind === 'verify' || kind === 'reset')
    db.run('UPDATE auth_tokens SET used_at = ? WHERE email = ? AND kind = ? AND used_at IS NULL', now, emailAddr, kind);
  if (kind === 'email') db.run("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = 'email' AND used_at IS NULL", now, userId);
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
const sameSecret = (a, b) => typeof a === 'string' && sha256(a) === sha256(b);

/* A current authenticator code (each time step works once) or an unused recovery code. Accepting
   one uses it up. Both are checked against the stored row as it is now, not the copy read when the
   request started, and consumed with a conditional UPDATE, so concurrent requests can't share one. */
export function useSecondFactor(db, config, userId, raw) {
  const code = String(raw || '').replace(/\s/g, '');
  const user = db.get('SELECT totp_secret, recovery_codes FROM users WHERE id = ?', userId);
  if (!user) return false;
  const step = totpStep(unseal(user.totp_secret, config.secretKey), code);
  if (step != null)
    return db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', step, userId, step).changes > 0;
  const codes = JSON.parse(user.recovery_codes || '[]');
  const h = sha256(code.toUpperCase());
  if (!codes.includes(h)) return false;
  const rest = JSON.stringify(codes.filter(x => x !== h));
  return db.run('UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?', rest, userId, user.recovery_codes).changes > 0;
}
/* End every session of `userId` except `keepId`, closing their live-update streams too. Push
   subscriptions go with their session (ON DELETE CASCADE). */
export function endOtherSessions(db, engine, userId, keepId = null) {
  const ids = db.all('SELECT id FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, keepId).map(s => s.id);
  db.run('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?', userId, keepId);
  ids.forEach(id => engine.disconnectSession(id));
}
/* Pending email changes stop working whenever the account is secured again (password changed or
   reset, sessions revoked, two-factor changed, account deleted): a stolen session can't park one
   and confirm it later. */
export const retireEmailChanges = (db, userId) =>
  db.run("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND kind = 'email' AND used_at IS NULL", Date.now(), userId);

/* Count a wrong two-factor code against the account, whatever the session. Returns true when this
   one paused two-factor sign-in (TFA_ACCOUNT_FAILS within TFA_LOCK_MS). */
function tfaFailed(db, userId, now = Date.now()) {
  const u = db.get('SELECT tfa_failed, tfa_failed_since FROM users WHERE id = ?', userId);
  const fresh = !u.tfa_failed_since || now - u.tfa_failed_since > TFA_LOCK_MS;
  const n = fresh ? 1 : u.tfa_failed + 1;
  if (n >= TFA_ACCOUNT_FAILS) {
    db.run('UPDATE users SET tfa_failed = 0, tfa_failed_since = NULL, tfa_locked_until = ? WHERE id = ?', now + TFA_LOCK_MS, userId);
    return true;
  }
  db.run('UPDATE users SET tfa_failed = ?, tfa_failed_since = ? WHERE id = ?', n, fresh ? now : u.tfa_failed_since, userId);
  return false;
}
const TFA_LOCKED = 'Too many incorrect two-factor codes for this account. Two-factor sign-in is paused for 15 minutes; try again after that.';

export const disableTwoFactor = (db, userId) =>
  db.run(
    "UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]', totp_last_step = NULL, tfa_failed = 0, tfa_failed_since = NULL, tfa_locked_until = NULL WHERE id = ?",
    userId,
  );

/* Whether another account or member already has `em`. */
const emailTaken = ({ db }, em, exceptId) =>
  !!db.get('SELECT 1 FROM users WHERE email = ? AND id != ?', em, exceptId) ||
  !!db.get("SELECT 1 FROM members WHERE lower(json_extract(data, '$.email')) = ? AND id != ?", em, exceptId);

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
      z.object({
        name: z.string().trim().min(1, 'Enter your name').max(80),
        email,
        password,
        invite: z.string().max(200).optional(),
        join: z.string().max(200).optional(),
        setup: z.string().max(200).optional(),
      }),
    );
    if (b.error) return b.error;
    const { db, repo, config, mailer, engine, setup } = c.var;
    const { name, email: em, password: pw, invite, join } = b.data;
    if (!repo.workspace() && setup.token && !sameSecret(b.data.setup, setup.token))
      return c.json({ error: 'Open the setup link from the server log to create the first account.', code: 'setup_required' }, 403);
    if (db.get('SELECT 1 FROM users WHERE email = ?', em))
      return c.json({ error: 'An account with this email already exists. Sign in instead.', field: 'email' }, 409);

    const hash = await hashPassword(pw);
    const inviteTok = invite && findToken(db, 'invite', invite);
    const inviteOk = inviteTok && inviteTok.email.toLowerCase() === em;
    const joinOk = !!(join && findToken(db, 'join', join));
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
          // An invited address (and the role it was invited with) is only claimed through its invite link.
          if (invited && invited.status === 'invited') {
            if (!inviteOk) throw Object.assign(new Error('invite-required'), { status: 403, code: 'invite_required' });
            member = { ...invited, name, status: 'active', last: 0 };
          } else if (config.allowOpenSignup || joinOk)
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
            subject: 'Verify your email for Sudo Sapient',
            intro: `Hi ${name}, confirm this is your email address to finish setting up your Sudo Sapient account.`,
            action: 'Verify email',
            link,
            outro: 'The link expires in 48 hours. If you didn’t create an account, you can ignore this email.',
          });
        return { member, link };
      });
    } catch (e) {
      if (e.code === 'invite_required')
        return c.json({ error: `${em} has a pending invite. Use the invite link in that email to join.`, field: 'email', code: 'invite_required' }, 403);
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

  /* Prefill for the sign-up screen when someone opens a workspace invite link. */
  r.get('/join/:token', c => {
    if (!findToken(c.var.db, 'join', c.req.param('token'))) return c.json({ error: 'This invite link has expired. Ask for a new one.' }, 404);
    return c.json({ workspace: c.var.repo.workspace()?.name || '' });
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
      subject: 'Verify your email for Sudo Sapient',
      intro: `Hi ${member.name}, confirm this is your email address to finish setting up your Sudo Sapient account.`,
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
    // Guessing one account's password from many addresses still hits the per-email limit. A browser
    // that signed in to this account before (device cookie) only answers for its own failures, so
    // failing on purpose elsewhere can't lock the owner out; once it uses those up it's a stranger.
    const device = user && readDevice(c, db, user.id);
    const devKey = device && `login-fail-device:${device.token_hash}`;
    const failKey = devKey && !limit.blocked(devKey, LOGIN_FAILS) ? devKey : `login-fail:${b.data.email}`;
    const wait = limit.blocked(failKey, LOGIN_FAILS);
    if (wait) {
      c.header('Retry-After', String(wait));
      return c.json({ error: 'Too many failed sign-in attempts for this account. Try again in 15 minutes or reset your password.' }, 429);
    }
    const ok = user ? await verifyPassword(b.data.password, user.password_hash) : await burnPasswordCheck(b.data.password);
    if (!ok) {
      limit.hit(failKey, LOGIN_FAILS, LOGIN_FAIL_MS);
      return c.json({ error: 'Incorrect email or password.' }, 401);
    }
    createSession(c, db, user.id, { remember: b.data.remember !== false, pending2fa: !!user.totp_enabled });
    if (!user.totp_enabled) rememberDevice(c, db, user.id);
    return c.json({ ...sessionState(c), twoFactor: !!user.totp_enabled });
  });

  r.post('/2fa/verify', limit('2fa', 10, MIN), requireAuth('session'), async c => {
    const b = await parseBody(c, z.object({ code: z.string().trim().max(20) }));
    if (b.error) return b.error;
    const { db, config, mailer } = c.var;
    const { session, user } = c.var.auth;
    if (!session.pending_2fa) return c.json(sessionState(c));
    const now = Date.now();
    const locked = db.get('SELECT tfa_locked_until t FROM users WHERE id = ?', user.id).t;
    if (locked > now) {
      c.header('Retry-After', String(Math.ceil((locked - now) / 1000)));
      return c.json({ error: TFA_LOCKED, code: 'two_factor_locked' }, 429);
    }
    if (!useSecondFactor(db, config, user.id, b.data.code)) {
      if (tfaFailed(db, user.id, now)) {
        mailer.queue({
          to: user.email,
          subject: 'Someone is entering wrong two-factor codes for your Sudo Sapient account',
          intro: `There were ${TFA_ACCOUNT_FAILS} incorrect two-factor codes for your Sudo Sapient account in the last 15 minutes, so two-factor sign-in is paused for 15 minutes. Whoever entered them knew your password. If this wasn’t you, change your password now.`,
          action: 'Change your password',
          link: `${config.appUrl}/#settings/password`,
          outro: 'Your account stays protected by two-factor authentication.',
        });
        mailer.drain();
        return c.json({ error: TFA_LOCKED, code: 'two_factor_locked' }, 429);
      }
      db.run('UPDATE sessions SET failed_2fa = failed_2fa + 1 WHERE id = ?', session.id);
      if (db.get('SELECT failed_2fa n FROM sessions WHERE id = ?', session.id).n >= TFA_FAILS) {
        db.run('DELETE FROM sessions WHERE id = ?', session.id);
        clearSessionCookie(c);
        return c.json({ error: 'Too many incorrect codes. Sign in again to get another try.', code: 'unauthenticated' }, 401);
      }
      return c.json({ error: "That code didn't work. Check your authenticator app and try again.", field: 'code' }, 401);
    }
    db.run('UPDATE sessions SET pending_2fa = 0 WHERE id = ?', session.id);
    db.run('UPDATE users SET tfa_failed = 0, tfa_failed_since = NULL, tfa_locked_until = NULL WHERE id = ?', user.id);
    rememberDevice(c, db, user.id);
    return c.json(sessionState(c));
  });

  // The device cookie stays: this browser still counts as one that has signed in before.
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
      subject: 'Reset your Sudo Sapient password',
      intro: 'We got a request to reset the password for your Sudo Sapient account.',
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
      retireEmailChanges(db, user.id);
      forgetDevices(db, user.id);
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
    const { db, engine } = c.var;
    const hash = await hashPassword(b.data.password);
    // Anyone who knew the old password is signed out everywhere else, can't finish an email change
    // and loses the device trust it earned; this browser just proved the password and keeps it.
    db.tx(() => {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, user.id);
      endOtherSessions(db, engine, user.id, c.var.auth.session.id);
      retireEmailChanges(db, user.id);
      forgetDevices(db, user.id);
    });
    rememberDevice(c, db, user.id);
    return c.json({ ok: true, sessions: listSessions(db, user.id, c.var.auth.session.id) });
  });

  /* Change the sign-in email: confirmed from a link sent to the new address. */
  r.post('/email', limit('email-change', 5, 10 * MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ email, password: z.string().min(1, 'Enter your password').max(200) }));
    if (b.error) return b.error;
    const { db, config, mailer } = c.var;
    const { user, member } = c.var.auth;
    if (!(await verifyPassword(b.data.password, user.password_hash))) return c.json({ error: 'Your password is incorrect.', field: 'password' }, 400);
    const em = b.data.email;
    if (em === user.email.toLowerCase()) return c.json({ error: 'That’s already your email.', field: 'email' }, 400);
    if (emailTaken(c.var, em, user.id)) return c.json({ error: 'Someone in the workspace already uses this email.', field: 'email' }, 409);
    const link = db.tx(() => {
      const l = issueToken(db, config, 'email', em, user.id);
      mailer.queue({
        to: em,
        subject: 'Confirm your new email for Sudo Sapient',
        intro: `Hi ${member.name}, confirm that you want to sign in to Sudo Sapient with this email address.`,
        action: 'Confirm new email',
        link: l,
        outro: 'The link expires in 24 hours. Until then you keep signing in with your current email.',
      });
      // The current address hears about it straight away (no confirm link), so a change made from
      // someone else's hands doesn't go unnoticed.
      mailer.queue({
        to: user.email,
        subject: 'Someone asked to change your Sudo Sapient email',
        intro: `Hi ${member.name}, someone signed in to your Sudo Sapient account asked to change its email to ${em}. Nothing changes unless that address confirms. If this wasn’t you, change your password: that cancels the request.`,
        action: 'Open Sudo Sapient',
        link: `${config.appUrl}/#settings/password`,
      });
      return l;
    });
    mailer.drain();
    return c.json({ ok: true, ...devLink(c, link) });
  });

  r.post('/email/confirm', limit('verify', 20, 10 * MIN), async c => {
    const b = await parseBody(c, z.object({ token: z.string().max(200) }));
    if (b.error) return b.error;
    const { db, repo, config, mailer, engine } = c.var;
    const t = findToken(db, 'email', b.data.token);
    const user = t && db.get('SELECT * FROM users WHERE id = ?', t.user_id);
    const m = user && repo.get('members', user.id);
    if (!m) return c.json({ error: 'This link has expired or was already used. Change your email again from Settings.' }, 400);
    if (emailTaken(c.var, t.email, user.id)) return c.json({ error: 'Someone in the workspace already uses this email.' }, 409);
    const cur = readSession(c, db);
    const keep = cur?.user.id === user.id ? cur.session.id : null;
    const old = user.email;
    m.email = t.email.toLowerCase();
    db.tx(() => {
      useToken(db, t);
      db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', m.email, Date.now(), user.id);
      repo.put('members', m);
      // Links sent to the old address stop working.
      db.run('UPDATE auth_tokens SET used_at = ? WHERE email = ? AND used_at IS NULL', Date.now(), old);
      mailer.queue({
        to: old,
        subject: 'Your Sudo Sapient email was changed',
        intro: `The email for your Sudo Sapient account was changed from ${old} to ${m.email}. If you didn’t do this, contact your workspace admin straight away.`,
        action: 'Open Sudo Sapient',
        link: config.appUrl,
      });
    });
    endOtherSessions(db, engine, user.id, keep);
    mailer.drain();
    engine.publish([{ c: 'members', id: m.id, v: m }]);
    return c.json(sessionState(c));
  });

  /* Delete your own account. Owners hand the workspace to someone else first. */
  r.post('/account/delete', limit('account-delete', 5, 10 * MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ password: z.string().min(1, 'Enter your password').max(200) }));
    if (b.error) return b.error;
    const { user, member } = c.var.auth;
    if (!(await verifyPassword(b.data.password, user.password_hash))) return c.json({ error: 'Your password is incorrect.', field: 'password' }, 400);
    if (member.role === 'Owner')
      return c.json({ error: 'Owners can’t delete their account. Make someone else an Owner and ask them to change your role first.', code: 'owner' }, 400);
    c.var.engine.removeAccount(c.var.auth);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  r.get('/sessions', requireAuth('account'), c => c.json(listSessions(c.var.db, c.var.auth.user.id, c.var.auth.session.id)));

  r.delete('/sessions/:id', requireAuth('account'), c => {
    const { db, engine } = c.var;
    const { user, session } = c.var.auth;
    const id = c.req.param('id');
    if (id === session.id) return c.json({ error: 'Use Sign out to end this session.' }, 400);
    if (db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, user.id).changes) retireEmailChanges(db, user.id);
    engine.disconnectSession(id);
    return c.json(listSessions(db, user.id, session.id));
  });

  r.post('/sessions/revoke-others', requireAuth('account'), c => {
    const { db, engine } = c.var;
    const { user, session } = c.var.auth;
    endOtherSessions(db, engine, user.id, session.id);
    retireEmailChanges(db, user.id);
    return c.json(listSessions(db, user.id, session.id));
  });

  /* ---------- two-factor setup ---------- */
  /* Starting setup needs the current password, so a signed-in browser alone can't bind its own
     authenticator to the account. */
  r.post('/2fa/setup', limit('2fa-setup', 10, 10 * MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ password: z.string().min(1, 'Enter your current password').max(200) }));
    if (b.error) return b.error;
    const { db, config } = c.var;
    const { user } = c.var.auth;
    if (user.totp_enabled) return c.json({ error: 'Two-factor authentication is already on.' }, 400);
    if (!(await verifyPassword(b.data.password, user.password_hash))) return c.json({ error: 'Your password is incorrect.', field: 'password' }, 400);
    const secret = newTotpSecret();
    db.run('UPDATE users SET totp_secret = ? WHERE id = ?', seal(secret, config.secretKey), user.id);
    const label = encodeURIComponent(`Sudo Sapient:${user.email}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Sudo Sapient')}&algorithm=SHA1&digits=6&period=30`;
    const qr = await QRCode.toString(otpauth, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    return c.json({ secret, otpauth, qr });
  });

  r.post('/2fa/enable', limit('2fa-enable', 10, MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ code: z.string().trim().max(10) }));
    if (b.error) return b.error;
    const { db, config } = c.var;
    const { user } = c.var.auth;
    if (user.totp_enabled) return c.json({ error: 'Two-factor authentication is already on.' }, 400);
    const step = totpStep(unseal(user.totp_secret, config.secretKey), b.data.code);
    if (step == null) return c.json({ error: 'That code didn’t match. Enter the current 6-digit code from your app.', field: 'code' }, 400);
    const codes = newRecoveryCodes();
    db.tx(() => {
      db.run(
        'UPDATE users SET totp_enabled = 1, recovery_codes = ?, totp_last_step = ? WHERE id = ?',
        JSON.stringify(codes.map(x => sha256(x))),
        step,
        user.id,
      );
      retireEmailChanges(db, user.id);
    });
    return c.json({ ok: true, recoveryCodes: codes });
  });

  /* Turning two-factor off needs the password or a current code, not just a signed-in browser. */
  r.post('/2fa/disable', limit('2fa-disable', 10, 10 * MIN), requireAuth('account'), async c => {
    const b = await parseBody(c, z.object({ password: z.string().max(200).optional(), code: z.string().trim().max(20).optional() }));
    if (b.error) return b.error;
    const { db, config } = c.var;
    const { user } = c.var.auth;
    const ok =
      (b.data.password && (await verifyPassword(b.data.password, user.password_hash))) || (b.data.code && useSecondFactor(db, config, user.id, b.data.code));
    if (!ok) return c.json({ error: 'Enter your current password or a code from your authenticator app.', field: 'confirm' }, 400);
    db.tx(() => {
      disableTwoFactor(db, user.id);
      retireEmailChanges(db, user.id);
    });
    return c.json({ ok: true });
  });

  return r;
}
