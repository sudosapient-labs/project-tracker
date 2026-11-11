// @ts-check
/* Notifications: in-app records (pushed live to the recipient) plus email, both gated by the
   recipient's notification preferences (Settings → Notifications). */
import { newId } from './lib/crypto.js';
import { canSeeProject } from '../src/core/access.js';

export const DEFAULT_NOTIF_PREFS = {
  email_mention: true,
  email_assign: true,
  email_comment: false,
  email_digest: false,
  push_mention: true,
  push_assign: true,
  push_comment: true,
  push_due: true,
  mention_all: true,
  mention_team: true,
  mention_ws: false,
  assign_self: true,
  assign_status: true,
  assign_over: true,
};
export const notifPrefs = (repo, uid) => ({ ...DEFAULT_NOTIF_PREFS, ...repo.userState(uid).notifPrefs });

/* Which preference allows each kind of notification in the app, and which sends it by email. */
const GATE = {
  mention: 'mention_all',
  team: 'mention_team',
  everyone: 'mention_ws',
  assign: 'assign_self',
  status: 'assign_status',
  overdue: 'assign_over',
  due: 'push_due',
};
const EMAIL = { mention: 'email_mention', team: 'email_mention', everyone: 'email_mention', assign: 'email_assign', comment: 'email_comment' };
// Push → … preferences. Access requests always push; status changes stay in the inbox.
const PUSH = {
  mention: 'push_mention',
  team: 'push_mention',
  everyone: 'push_mention',
  assign: 'push_assign',
  comment: 'push_comment',
  due: 'push_due',
  overdue: 'push_due',
  access: true,
};

/* One line saying what happened, used as the push title, the email subject and the digest line.
   Key information first, and always a complete phrase: "Ada mentioned you in WEB-12: Fix login",
   "WEB-12 is due tomorrow: Fix login" (from the server itself, `who` is null), "Ada requested
   access to Website". `text` is the notification's verb phrase ("mentioned you in", "is overdue"). */
export function notifLine(who, text, t = null) {
  if (!t) return [who, text].filter(Boolean).join(' ');
  return who ? `${who} ${text} ${t.key}: ${t.title}` : `${t.key} ${text}: ${t.title}`;
}

/* `reason` picks the preference; `n` is the record the inbox renders ({ type, task, project, text, snippet }).
   Pass the task itself as `task` when it may not be saved yet (e.g. while it's being created).
   Nothing is sent about a project the recipient can't see, except an access request to its lead.
   ctx needs { repo, uid, now, changes } and, for email, { mailer, config }. */
export function notify(ctx, to, reason, n, task = null) {
  if (!to || to === ctx.uid) return null;
  const { repo } = ctx;
  const m = repo.get('members', to);
  // Bots get no notifications, emails or push: nobody reads them.
  if (!m || m.status !== 'active' || m.kind === 'bot') return null;
  const prefs = notifPrefs(repo, to);
  if (GATE[reason] && prefs[GATE[reason]] === false) return null;
  const t = task || (n.task && repo.get('tasks', n.task));
  const pid = t?.project || n.project;
  if (pid && reason !== 'access' && !canSeeProject(repo.get('projects', pid), m)) return null;
  const row = {
    id: newId('n'),
    type: n.type,
    by: ctx.uid || null,
    task: n.task || null,
    project: n.project || null,
    text: n.text,
    snippet: n.snippet || '',
    at: ctx.now,
    read: false,
  };
  repo.put('notifs', row, to);
  const who = ctx.uid ? repo.get('members', ctx.uid)?.name || 'Someone' : null;
  const want = PUSH[reason];
  const headline = notifLine(who, n.text, t);
  // Sent by engine.publish once the change is committed. Phones cut titles short, so the title is
  // the whole headline (who, what, which task first) and the body adds the comment or details.
  const push =
    want === true || (want && prefs[want])
      ? {
          title: headline,
          body: n.snippet && n.snippet !== t?.title ? n.snippet : t ? repo.get('projects', t.project)?.name || '' : '',
          tag: row.id,
          url: t ? `/#task/${t.key}` : '/#inbox',
        }
      : null;
  ctx.changes.push({ c: 'notifs', id: row.id, v: row, uid: to, ...(push ? { push } : {}) });

  if (ctx.mailer && EMAIL[reason] && prefs[EMAIL[reason]]) {
    ctx.mailer.queue({
      to: m.email,
      subject: headline.slice(0, 200),
      intro: n.snippet ? `${headline}\n\n“${n.snippet}”` : headline,
      action: t ? 'Open task' : 'Open Sudo Sapient',
      link: `${ctx.config.appUrl}/#${t ? `task/${t.key}` : 'inbox'}`,
      outro: 'You can change which emails you get in Settings → Notifications.',
    });
  }
  return row;
}

/* People an @mention in `text` reaches: named members, members of a named team, or everyone. Bots
   can't be mentioned. */
export function mentioned(repo, text) {
  const out = new Map();
  const members = repo.all('members').filter(m => m.status === 'active' && m.kind !== 'bot');
  for (const m of members) if (text.includes('@' + m.name)) out.set(m.id, 'mention');
  for (const t of repo.all('teams')) if (text.includes('@' + t.name)) for (const m of members) if (m.team === t.id && !out.has(m.id)) out.set(m.id, 'team');
  if (/@(workspace|everyone)\b/i.test(text)) for (const m of members) if (!out.has(m.id)) out.set(m.id, 'everyone');
  return out;
}
