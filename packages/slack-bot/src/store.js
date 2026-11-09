/* The bot's own state, in its own SQLite file (node:sqlite), separate from the tracker's database
   and from the agent's conversation checkpoints:

   - people:   Slack user → tracker member (matched by email, or linked by a tracker admin)
   - channels: Slack channel → the tracker project it's about (`/sudo project WEB`)
   - threads:  task ↔ Slack thread it was created from or linked to (for synced threads later)
   - confirmations: changes waiting for a Confirm button. Each card has its own id, and names the
               conversation and the exact interrupts it shows, who asked, and where it was posted.
               A click marks it taken (`taken_at`, `taken_by`, `approve`), `resumed_at` once the
               agent starts acting on it, and it's deleted only when the card shows the outcome, so
               a restart in between can tell the person (handlers.js recover())
   - runs:     replies still "Working on it…": deleted when the reply replaces the placeholder, so
               the ones left after a restart can say the bot stopped before finishing
   - guidance: instructions admins give the agent, workspace-wide or per channel
   - seen:     Slack events already handled (Slack retries; Socket Mode can redeliver)
   - conversations: one per Slack thread per person (or per DM per day). `round` starts a fresh
               agent conversation when the old one can't continue (a change was superseded, or a
               run broke off); `cursor` is the last Slack message the agent saw, so a follow-up
               sends only what's new */
import { randomBytes } from 'node:crypto';
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
CREATE TABLE IF NOT EXISTS confirmations (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  interrupts TEXT NOT NULL,
  requester TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT,
  message_ts TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  taken_at INTEGER,
  taken_by TEXT,
  approve INTEGER,
  resumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS confirmations_by_thread ON confirmations (thread_id);
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
CREATE TABLE IF NOT EXISTS conversations (
  base TEXT PRIMARY KEY,
  round INTEGER NOT NULL DEFAULT 0,
  cursor TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  channel TEXT NOT NULL,
  ts TEXT NOT NULL,
  thread_ts TEXT,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (channel, ts)
);
`;

/* Columns added after a table was first made: CREATE TABLE IF NOT EXISTS leaves a table from an
   older version as it was, so they're added to it here. */
const ADDED = { confirmations: ['taken_at INTEGER', 'taken_by TEXT', 'approve INTEGER', 'resumed_at INTEGER'] };

export function openStore(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  for (const [table, cols] of Object.entries(ADDED)) {
    const has = new Set(
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(c => c.name),
    );
    for (const col of cols) if (!has.has(col.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const row = r => (r ? { ...r, interrupts: JSON.parse(r.interrupts), data: JSON.parse(r.data) } : null);

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

    /* A confirmation card: returns its id (the button's value). */
    saveConfirmation: ({ threadId, interrupts, requester, channel, threadTs, messageTs = null, data }, now = Date.now()) => {
      const id = randomBytes(12).toString('base64url');
      run(
        'INSERT INTO confirmations (id, thread_id, interrupts, requester, channel, thread_ts, message_ts, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        threadId,
        JSON.stringify(interrupts),
        requester,
        channel,
        threadTs,
        messageTs,
        JSON.stringify(data),
        now,
      );
      return id;
    },
    /* A card still waiting for its click (not one already taken). */
    confirmation: id => row(one('SELECT * FROM confirmations WHERE id = ? AND taken_at IS NULL', id)),
    /* Take a confirmation, once: two clicks on Confirm can't both act on it. It stays, marked taken,
       until finishConfirmation, so a restart before then finds it (takenConfirmations). */
    takeConfirmation: (id, { by = null, approve = null } = {}, now = Date.now()) =>
      row(
        one(
          'UPDATE confirmations SET taken_at = ?, taken_by = ?, approve = ? WHERE id = ? AND taken_at IS NULL RETURNING *',
          now,
          by,
          approve == null ? null : approve ? 1 : 0,
          id,
        ),
      ),
    /* The agent is about to act on a taken confirmation: from here a change may have been made. */
    markResuming: (id, now = Date.now()) => run('UPDATE confirmations SET resumed_at = ? WHERE id = ?', now, id),
    /* Waiting for a click again (a restart came before anything was done). */
    untakeConfirmation: id => run('UPDATE confirmations SET taken_at = NULL, taken_by = NULL, approve = NULL, resumed_at = NULL WHERE id = ?', id),
    /* The card shows what happened: the confirmation is done with. */
    finishConfirmation: id => run('DELETE FROM confirmations WHERE id = ?', id),
    /* Confirmations taken but not finished (what a restart interrupted). */
    takenConfirmations: () => all('SELECT * FROM confirmations WHERE taken_at IS NOT NULL ORDER BY taken_at').map(row),
    /* Every confirmation still open in a conversation, taken (to mark their cards superseded). */
    takeConfirmationsIn: threadId => all('DELETE FROM confirmations WHERE thread_id = ? AND taken_at IS NULL RETURNING *', threadId).map(row),

    /* A reply in progress: its "Working on it…" placeholder, until the reply replaces it. */
    startRun: ({ channel, threadTs = null, ts }, now = Date.now()) =>
      run('INSERT OR REPLACE INTO runs (channel, ts, thread_ts, started_at) VALUES (?, ?, ?, ?)', channel, ts, threadTs, now),
    endRun: (channel, ts) => run('DELETE FROM runs WHERE channel = ? AND ts = ?', channel, ts),
    runs: () => all('SELECT * FROM runs ORDER BY started_at'),

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

    /* The agent's thread id for a conversation, `<base>#<round>`. */
    conversation: base => {
      const r = one('SELECT round, cursor FROM conversations WHERE base = ?', base);
      return { threadId: `${base}#${r?.round || 0}`, cursor: r?.cursor || null };
    },
    /* Start a fresh round: the agent forgets the old one, and the whole Slack thread is sent again. */
    nextRound: base => {
      run('INSERT INTO conversations (base, round, cursor) VALUES (?, 1, NULL) ON CONFLICT (base) DO UPDATE SET round = round + 1, cursor = NULL', base);
      return `${base}#${one('SELECT round FROM conversations WHERE base = ?', base).round}`;
    },
    setCursor: (base, ts) =>
      run('INSERT INTO conversations (base, round, cursor) VALUES (?, 0, ?) ON CONFLICT (base) DO UPDATE SET cursor = excluded.cursor', base, ts),
  };
}
