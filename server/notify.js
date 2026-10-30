/* Notifications: in-app records (pushed live to the recipient) plus email, both gated by the
   recipient's notification preferences (Settings → Notifications). */
import { newId } from './lib/crypto.js';

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

/* `reason` picks the preference; `n` is the record the inbox renders ({ type, task, project, text, snippet }).
   Pass the task itself as `task` when it may not be saved yet (e.g. while it's being created).
   ctx needs { repo, uid, now, changes } and, for email, { mailer, config }. */
export function notify(ctx, to, reason, n, task = null) {
  if (!to || to === ctx.uid) return null;
  const { repo } = ctx;
  const m = repo.get('members', to);
  if (!m || m.status !== 'active') return null;
  const prefs = notifPrefs(repo, to);
  if (GATE[reason] && prefs[GATE[reason]] === false) return null;
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
  ctx.changes.push({ c: 'notifs', id: row.id, v: row, uid: to });

  if (ctx.mailer && EMAIL[reason] && prefs[EMAIL[reason]]) {
    const t = task || (n.task && repo.get('tasks', n.task));
    const who = ctx.uid ? repo.get('members', ctx.uid)?.name || 'Someone' : 'Gr8r Studio';
    const subject = t ? `${who} ${n.text} ${t.key}: ${t.title}` : `${who} ${n.text}`;
    ctx.mailer.queue({
      to: m.email,
      subject: subject.slice(0, 200),
      intro: n.snippet ? `${subject}\n\n“${n.snippet}”` : subject,
      action: t ? 'Open task' : 'Open Gr8r Studio',
      link: `${ctx.config.appUrl}/#${t ? `task/${t.key}` : 'inbox'}`,
      outro: 'You can change which emails you get in Settings → Notifications.',
    });
  }
  return row;
}

/* People an @mention in `text` reaches: named members, members of a named team, or everyone. */
export function mentioned(repo, text) {
  const out = new Map();
  const members = repo.all('members').filter(m => m.status === 'active');
  for (const m of members) if (text.includes('@' + m.name)) out.set(m.id, 'mention');
  for (const t of repo.all('teams')) if (text.includes('@' + t.name)) for (const m of members) if (m.team === t.id && !out.has(m.id)) out.set(m.id, 'team');
  if (/@(workspace|everyone)\b/i.test(text)) for (const m of members) if (!out.has(m.id)) out.set(m.id, 'everyone');
  return out;
}
