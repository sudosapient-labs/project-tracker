/* /api: workspace setup, invite links, resending invites and access requests. */
import { Hono } from 'hono';
import { requireAuth } from '../auth.js';
import { issueToken } from './auth.js';
import { canSee } from '../sync/rules.js';
import { notify } from '../notify.js';

export function workspaceRoutes() {
  const r = new Hono();

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
     link turns the previous one off. */
  r.post('/workspace/invite-link', requireAuth(), c => {
    const { db, config } = c.var;
    if (c.var.auth.member.role === 'Guest') return c.json({ error: "Guests can't invite people." }, 403);
    const link = db.tx(() => {
      db.run("UPDATE auth_tokens SET used_at = ? WHERE kind = 'join' AND used_at IS NULL", Date.now());
      return issueToken(db, config, 'join', '*', c.var.auth.member.id);
    });
    return c.json({ link });
  });

  r.post('/members/:id/resend-invite', requireAuth(), c => {
    const { db, repo, config, mailer } = c.var;
    const me = c.var.auth.member;
    if (me.role === 'Guest') return c.json({ error: "Guests can't invite people." }, 403);
    const m = repo.get('members', c.req.param('id'));
    if (!m) return c.json({ error: 'That person is no longer in the workspace.' }, 404);
    if (m.status !== 'invited') return c.json({ error: `${m.name} has already joined.` }, 400);
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
    return c.json({ ok: true, ...(config.exposeEmailLinks ? { devLink: link } : {}) });
  });

  /* Ask the lead of a project you can't see to add you. */
  r.post('/projects/:id/request-access', requireAuth(), c => {
    const { db, repo, engine } = c.var;
    const me = c.var.auth.member;
    const p = repo.get('projects', c.req.param('id'));
    if (!p) return c.json({ error: 'That project no longer exists.' }, 404);
    if (canSee(p, me)) return c.json({ ok: true, already: true });
    const to = (p.lead && repo.get('members', p.lead)) || repo.all('members').find(m => m.role === 'Owner');
    const ctx = { repo, uid: me.id, now: Date.now(), changes: [] };
    db.tx(() => notify(ctx, to?.id, 'access', { type: 'update', project: p.id, text: `requested access to ${p.name}`, snippet: `${me.name} (${me.email})` }));
    engine.publish(ctx.changes);
    return c.json({ ok: true, to: to?.name || null });
  });

  return r;
}
