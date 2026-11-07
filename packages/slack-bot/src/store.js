/* The bot's own state, in its own SQLite file (node:sqlite), separate from the tracker's database
   and from the agent's conversation checkpoints:

   - people:   Slack user → tracker member (matched by email, or linked by a tracker admin)
   - channels: Slack channel → the tracker project it's about (`/sudo project WEB`)
   - threads:  task ↔ Slack thread it was created from or linked to (for synced threads later)
   - pending:  writes waiting for a Confirm button, with who asked and where
   - guidance: instructions admins give the agent, workspace-wide or per channel
   - seen:     Slack events already handled (Slack retries; Socket Mode can redeliver)
   - cursors:  the last Slack message the agent saw in a thread, so a follow-up mention sends only
               what's new */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  slack_user TEXT PRIMARY KEY,
  member_id TEXT,
  email TEXT,
  manual INTEGER NOT NULL DEFAULT 0,
  linked_by TEXT,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  channel TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  set_by TEXT,
  set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  task TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  permalink TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task, channel, thread_ts)
);
CREATE INDEX IF NOT EXISTS threads_by_thread ON threads (channel, thread_ts);
CREATE TABLE IF NOT EXISTS pending (
  thread_id TEXT PRIMARY KEY,
  requester TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT,
  message_ts TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guidance (
  scope TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  set_by TEXT,
  set_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seen (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cursors (
  thread_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL
);
`;

export function openStore(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);

  return {
    close: () => db.close(),

    person: slackUser => one('SELECT * FROM people WHERE slack_user = ?', slackUser) || null,
    savePerson: ({ slackUser, memberId, email, manual = false, linkedBy = null }, now = Date.now()) =>
      run(
        `INSERT INTO people (slack_user, member_id, email, manual, linked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (slack_user) DO UPDATE SET member_id = excluded.member_id, email = excluded.email,
           manual = excluded.manual, linked_by = excluded.linked_by, checked_at = excluded.checked_at`,
        slackUser,
        memberId,
        email,
        manual ? 1 : 0,
        linkedBy,
        now,
      ),
    forgetPerson: slackUser => run('DELETE FROM people WHERE slack_user = ?', slackUser),
    slackUserOf: memberId => one('SELECT slack_user FROM people WHERE member_id = ? ORDER BY manual DESC, checked_at DESC', memberId)?.slack_user || null,

    channelProject: channel => one('SELECT project FROM channels WHERE channel = ?', channel)?.project || null,
    setChannelProject: (channel, project, setBy, now = Date.now()) =>
      project
        ? run(
            `INSERT INTO channels (channel, project, set_by, set_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (channel) DO UPDATE SET project = excluded.project, set_by = excluded.set_by, set_at = excluded.set_at`,
            channel,
            project,
            setBy,
            now,
          )
        : run('DELETE FROM channels WHERE channel = ?', channel),

    linkThread: ({ task, channel, threadTs, permalink }, now = Date.now()) =>
      run(
        'INSERT OR IGNORE INTO threads (task, channel, thread_ts, permalink, created_at) VALUES (?, ?, ?, ?, ?)',
        task,
        channel,
        threadTs,
        permalink || null,
        now,
      ),
    threadsOf: task => all('SELECT * FROM threads WHERE task = ? ORDER BY created_at', task),
    tasksIn: (channel, threadTs) => all('SELECT task FROM threads WHERE channel = ? AND thread_ts = ? ORDER BY created_at', channel, threadTs).map(r => r.task),

    pending: threadId => {
      const r = one('SELECT * FROM pending WHERE thread_id = ?', threadId);
      return r ? { ...r, data: JSON.parse(r.data) } : null;
    },
    savePending: ({ threadId, requester, channel, threadTs, messageTs = null, data }, now = Date.now()) =>
      run(
        `INSERT INTO pending (thread_id, requester, channel, thread_ts, message_ts, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET requester = excluded.requester, channel = excluded.channel, thread_ts = excluded.thread_ts,
           message_ts = excluded.message_ts, data = excluded.data, created_at = excluded.created_at`,
        threadId,
        requester,
        channel,
        threadTs,
        messageTs,
        JSON.stringify(data),
        now,
      ),
    setPendingMessage: (threadId, messageTs) => run('UPDATE pending SET message_ts = ? WHERE thread_id = ?', messageTs, threadId),
    /* Take a pending confirmation, once: two clicks on Confirm can't both resume it. */
    takePending: threadId => {
      const r = one('DELETE FROM pending WHERE thread_id = ? RETURNING *', threadId);
      return r ? { ...r, data: JSON.parse(r.data) } : null;
    },

    guidance: scope => one('SELECT text FROM guidance WHERE scope = ?', scope)?.text || '',
    setGuidance: (scope, text, setBy, now = Date.now()) =>
      text
        ? run(
            `INSERT INTO guidance (scope, text, set_by, set_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (scope) DO UPDATE SET text = excluded.text, set_by = excluded.set_by, set_at = excluded.set_at`,
            scope,
            text,
            setBy,
            now,
          )
        : run('DELETE FROM guidance WHERE scope = ?', scope),

    /* True the first time an id is seen; false for a redelivery. Old ids are dropped after a day. */
    firstTime: (id, now = Date.now()) => {
      run('DELETE FROM seen WHERE at < ?', now - 86_400_000);
      return run('INSERT OR IGNORE INTO seen (id, at) VALUES (?, ?)', id, now).changes === 1;
    },

    cursor: threadId => one('SELECT ts FROM cursors WHERE thread_id = ?', threadId)?.ts || null,
    setCursor: (threadId, ts) => run('INSERT INTO cursors (thread_id, ts) VALUES (?, ?) ON CONFLICT (thread_id) DO UPDATE SET ts = excluded.ts', threadId, ts),
  };
}
