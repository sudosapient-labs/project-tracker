// @ts-check
/* Scheduled work, run every few minutes by server/index.js: due-date reminders, overdue alerts and
   the weekday morning email digest. Each takes `now` so tests can run it at any moment. */
import { canSeeProject } from '../src/core/access.js';
import { dayOf, isOverdue, zoneParts } from '../packages/client/dates.js';
import { clockOf } from './lib/clock.js';
import { notifLine, notify, notifPrefs } from './notify.js';
import { MAX_ATTEMPTS } from './lib/mailer.js';
import { RESTORE_MS } from './sync/engine.js';

const DAY = 86_400_000;
const tzOf = (repo, uid) => clockOf(repo, uid).tz;

/* "Due tomorrow" (Push → Due date reminders) and "overdue" (Assignments → overdue) for assignees,
   once per task, due date and assignee (someone it's reassigned to is reminded too), judged by the
   assignee's own time zone. */
export function runReminders({ db, repo, engine, mailer, config }, now = Date.now()) {
  const ctx = { repo, uid: null, now, changes: [], mailer, config };
  const tasks = repo.all(
    'tasks',
    "WHERE json_extract(data, '$.status') != 'done' AND json_extract(data, '$.assignee') IS NOT NULL AND json_extract(data, '$.due') IS NOT NULL AND COALESCE(json_extract(data, '$.archived'), 0) = 0",
  );
  const tzs = new Map();
  db.tx(() => {
    for (const t of tasks) {
      if (!tzs.has(t.assignee)) tzs.set(t.assignee, tzOf(repo, t.assignee));
      const tz = tzs.get(t.assignee);
      // Overdue once its time has passed (an all-day one, once its day has), as the app shows it.
      const kind = dayOf(t.due, tz) === dayOf(now + DAY, tz) ? 'due_soon' : isOverdue(t.due, tz, now) ? 'overdue' : null;
      if (!kind || db.get('SELECT 1 FROM reminders WHERE task_id = ? AND kind = ? AND due = ? AND assignee = ?', t.id, kind, t.due, t.assignee)) continue;
      db.run('INSERT INTO reminders (task_id, kind, due, assignee, sent_at) VALUES (?, ?, ?, ?, ?)', t.id, kind, t.due, t.assignee, now);
      notify(ctx, t.assignee, kind === 'due_soon' ? 'due' : 'overdue', {
        type: 'update',
        task: t.id,
        text: kind === 'due_soon' ? 'is due tomorrow' : 'is overdue',
        snippet: t.title,
      });
    }
  });
  engine.publish(ctx.changes);
  mailer.drain();
  return ctx.changes.length;
}

/* Email → Daily digest: on weekdays from 8:00 local time, one email listing unread notifications
   since the last digest (so Monday's covers the weekend), at most DIGEST_MAX_DAYS back. Nothing is
   sent when there's nothing new. */
const DIGEST_MAX_DAYS = 7;
export function runDigests({ db, repo, mailer, config }, now = Date.now()) {
  let sent = 0;
  for (const m of repo.all('members')) {
    if (m.status !== 'active' || m.kind === 'bot' || !db.get('SELECT 1 FROM users WHERE id = ?', m.id)) continue;
    if (!notifPrefs(repo, m.id).email_digest) continue;
    const l = zoneParts(now, tzOf(repo, m.id));
    if (l.weekday === 6 || l.weekday === 0 || l.hour < 8) continue;
    const last = db.get('SELECT last_digest, last_digest_at FROM user_state WHERE user_id = ?', m.id);
    if (last?.last_digest === l.day) continue;
    const since = Math.max(last?.last_digest_at ?? now - DAY, now - DIGEST_MAX_DAYS * DAY);
    const unread = db
      .all('SELECT data FROM notifications WHERE user_id = ? AND created_at > ? ORDER BY created_at DESC', m.id, since)
      .map(r => JSON.parse(r.data))
      .filter(n => !n.read);
    repo.saveUserState(m.id, {});
    db.run('UPDATE user_state SET last_digest = ?, last_digest_at = ? WHERE user_id = ?', l.day, now, m.id);
    if (!unread.length) continue;
    // Tasks are read as they are now: one that has since moved somewhere this person can't see is
    // mentioned without its key, title or what happened to it.
    const line = n => {
      const t = n.task && repo.get('tasks', n.task);
      if (t && !canSeeProject(repo.get('projects', t.project), m)) return '• An update on work you no longer have access to';
      return `• ${notifLine(n.by ? repo.get('members', n.by)?.name || 'Someone' : null, n.text, t)}`;
    };
    mailer.queue({
      to: m.email,
      subject: `Your Sudo Sapient digest: ${unread.length} update${unread.length > 1 ? 's' : ''}`,
      intro: `Here's what you missed since your last digest:\n\n${unread.slice(0, 15).map(line).join('\n')}${unread.length > 15 ? `\n…and ${unread.length - 15} more` : ''}`,
      action: 'Open your inbox',
      link: `${config.appUrl}/#inbox`,
      outro: 'You get this because Daily digest is on in Settings → Notifications → Email.',
    });
    sent++;
  }
  mailer.drain();
  return sent;
}

/* Every minute (server/index.js): drop expired sessions (and with them their push subscriptions)
   and devices, old tokens, mail sent (or given up on) more than 30 days ago, read notifications older
   than 180 days, reminder records for tasks that are gone or done, and deleted records kept for Undo
   once they can no longer be restored. Also run once at startup. */
export function housekeep({ db }, now = Date.now()) {
  db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  db.run('DELETE FROM devices WHERE expires_at < ?', now);
  db.run("DELETE FROM notifications WHERE created_at < ? AND json_extract(data, '$.read')", now - 180 * DAY);
  db.run('DELETE FROM auth_tokens WHERE expires_at < ?', now - 7 * DAY);
  db.run('DELETE FROM outbox WHERE COALESCE(sent_at, CASE WHEN attempts >= ? THEN created_at END) < ?', MAX_ATTEMPTS, now - 30 * DAY);
  db.run('DELETE FROM api_idempotency WHERE created_at < ?', now - DAY);
  db.run('DELETE FROM recent_deletes WHERE deleted_at < ?', now - RESTORE_MS);
  db.run("DELETE FROM reminders WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = reminders.task_id AND json_extract(t.data, '$.status') != 'done')");
}
