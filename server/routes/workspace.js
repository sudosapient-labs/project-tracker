/* /api: workspace setup, invite links, resending invites, access requests and resetting another
   person's two-factor. */
import { Hono } from 'hono';
import { z } from 'zod';
import { GONE, currentAuthSamePassword, requireAuth } from '../auth.js';
import { parseBody } from '../lib/http.js';
import { disableTwoFactor, endOtherSessions, issueToken, passwordError, retireEmailChanges } from './auth.js';
import { HOUR, INVITES_PER_HOUR, canSee } from '../sync/rules.js';
import { isAdminRole } from '../../src/core/access.js';
import { notify } from '../notify.js';

/* Shared with the public API (api/v1-more.js), so a link, invite or request made there is exactly
   the app's. Each takes the request's vars ({ db, repo, config, mailer, engine }) and the acting member. */

/* A new reusable join link; the previous one stops working. The caller checks the role. */
export function makeInviteLink({ db, config }, me) {
  return db.tx(() => {
    db.run("UPDATE auth_tokens SET used_at = ? WHERE kind = 'join' AND used_at IS NULL", Date.now());
    return issueToken(db, config, 'join', '*', me.id);
  });
}

/* Send invited person `m` a fresh invite (the old link stops working). { error, status } or { link }. */
export function resendInvite({ db, repo, config, mailer }, me, m) {
  if (me.role === 'Guest') return { error: "Guests can't invite people.", status: 403 };
  if (!m) return { error: 'That person is no longer in the workspace.', status: 404 };
  if (m.kind === 'bot') return { error: 'Bots can’t be invited: they only use API keys.', status: 400 };
  if (m.status !== 'invited') return { error: `${m.name} has already joined.`, status: 400 };
  const ws = repo.workspace();
  const link = db.tx(() => {
    db.run("UPDATE auth_tokens SET used_at = ? WHERE kind = 'invite' AND email = ? AND used_at IS NULL", Date.now(), m.email);
    const l = issueToken(db, config, 'invite', m.email);
    mailer.queue({
      to: m.email,
      subject: `${me.name} invited you to ${ws?.name || 'Sudo Sapient'}`,
      intro: `${me.name} invited you to join ${ws?.name || 'their workspace'} on Sudo Sapient.`,
      action: 'Accept invite',
      link: l,
      outro: 'The invite expires in 14 days.',
    });
    return l;
  });
  mailer.drain();
  return { link };
}

/* Ask the lead of project `p` (or the Owner, when it has none) for access. The same answer whether
   or not it exists, and nothing about who leads it. */
export function requestAccess({ db, repo, engine }, me, p) {
  if (p && canSee(p, me)) return { ok: true, already: true };
  if (!p) return { ok: true };
  const to = (p.lead && repo.get('members', p.lead)) || repo.all('members').find(m => m.role === 'Owner');
  const ctx = { repo, uid: me.id, now: Date.now(), changes: [] };
  db.tx(() => notify(ctx, to?.id, 'access', { type: 'update', project: p.id, text: `requested access to ${p.name}`, snippet: `${me.name} (${me.email})` }));
  engine.publish(ctx.changes);
  return { ok: true };
}

export function workspaceRoutes({ limit }) {
  const r = new Hono();
  const byUser = c => c.var.auth.member.id;

  /* The owner finished (or skipped) first-run setup. */
  r.post('/workspace/onboarded', requireAuth(), c => {
    const { repo } = c.var;
    if (c.var.auth.member.role !== 'Owner') return c.json({ error: 'Only the workspace owner can finish setup.' }, 403);
    const ws = repo.workspace();
    repo.saveWorkspace({ ...ws, name: ws.name || 'My Workspace', onboarded: true });
    const { onboarded, ...pub } = repo.workspace();
    c.var.engine.publish([{ c: 'ws', v: pub }]);
    return c.json({ ok: true, ws: pub });
  });

  /* A reusable link anyone can use to join as a Member (still verifying their email). Making a new
     link turns the previous one off, so only Owners and Admins may. */
  r.post(
    '/workspace/invite-link',
    requireAuth(),
    limit('invite-link', 10, HOUR, { keyOf: byUser, message: 'You’ve made a lot of invite links. Try again in an hour.' }),
    c => {
      if (!isAdminRole(c.var.auth.member)) return c.json({ error: 'Only admins can create the workspace invite link.' }, 403);
      return c.json({ link: makeInviteLink(c.var, c.var.auth.member) });
    },
  );

  // Shares its allowance with invites sent through sync (rules.js members.create).
  r.post(
    '/members/:id/resend-invite',
    requireAuth(),
    limit('invite', INVITES_PER_HOUR, HOUR, { keyOf: byUser, message: 'You’ve sent a lot of invites. Try again in an hour.' }),
    c => {
      const out = resendInvite(c.var, c.var.auth.member, c.var.repo.get('members', c.req.param('id')));
      if (out.error) return c.json({ error: out.error }, out.status);
      return c.json({ ok: true, ...(c.var.config.exposeEmailLinks ? { devLink: out.link } : {}) });
    },
  );

  /* Ask the lead of a project you can't see to add you. */
  r.post(
    '/projects/:id/request-access',
    requireAuth(),
    limit('request-access', 3, HOUR, {
      keyOf: c => `${byUser(c)}:${c.req.param('id')}`,
      message: 'You already asked for access. Give the lead a little time to respond.',
    }),
    c => c.json(requestAccess(c.var, c.var.auth.member, c.var.repo.get('projects', c.req.param('id')))),
  );

  /* The Owner turns off someone else's two-factor (a lost phone). Needs the Owner's password; the
     person is told by email and signed out everywhere. */
  r.post('/members/:id/reset-2fa', requireAuth(), limit('reset-2fa', 10, HOUR, { keyOf: byUser }), async c => {
    const b = await parseBody(c, z.object({ password: z.string().min(1, 'Enter your password').max(200) }));
    if (b.error) return b.error;
    const { db, repo, config, mailer, engine } = c.var;
    const { member: me } = c.var.auth;
    if (me.role !== 'Owner') return c.json({ error: 'Only the workspace owner can reset someone’s two-factor authentication.' }, 403);
    const wrong = await passwordError(c, limit, b.data.password);
    if (wrong) return wrong;
    const m = repo.get('members', c.req.param('id'));
    const target = m && db.get('SELECT id, email, totp_enabled FROM users WHERE id = ?', m.id);
    if (!target) return c.json({ error: 'That person is no longer in the workspace.' }, 404);
    if (target.id === me.id) return c.json({ error: 'Turn off your own two-factor authentication in Settings → Two-factor.' }, 400);
    if (!target.totp_enabled) return c.json({ error: `${m.name} doesn’t use two-factor authentication.` }, 400);
    // The Owner's session, password and role as they are now, after the password check.
    const a = currentAuthSamePassword(db, c.var.auth);
    if (!a) return c.json(GONE, 401);
    if (a.member.role !== 'Owner') return c.json({ error: 'Only the workspace owner can reset someone’s two-factor authentication.' }, 403);
    db.tx(() => {
      disableTwoFactor(db, target.id);
      retireEmailChanges(db, target.id);
      endOtherSessions(db, engine, target.id);
      mailer.queue({
        to: target.email,
        subject: 'Your Sudo Sapient two-factor authentication was reset',
        intro: `${me.name}, the workspace owner, turned off two-factor authentication for your Sudo Sapient account and signed you out everywhere. Sign in with your password, then set two-factor up again in Settings. If you didn’t ask for this, contact ${me.name} straight away.`,
        action: 'Sign in',
        link: config.appUrl,
      });
    });
    mailer.drain();
    return c.json({ ok: true });
  });

  return r;
}
