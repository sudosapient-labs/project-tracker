-- Accounts and authentication ------------------------------------------------------------------

-- One row per person who can sign in. `id` is shared with their row in `members`.
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT,
  email_verified_at INTEGER,
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  recovery_codes    TEXT NOT NULL DEFAULT '[]',
  created_at        INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  pending_2fa  INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Single-use emailed tokens: email verification, password reset, workspace invites.
CREATE TABLE auth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset', 'invite')),
  user_id    TEXT,
  email      TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX auth_tokens_email ON auth_tokens(email, kind);

-- Workspace (single tenant) ---------------------------------------------------------------------

CREATE TABLE workspace (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL CHECK (json_valid(data)),
  onboarded  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Synced entities. Each row stores the client-facing object in `data`; columns beside it are
-- denormalised for lookups and visibility checks.
CREATE TABLE members (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX members_email ON members(lower(json_extract(data, '$.email')));

CREATE TABLE teams (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX projects_key ON projects(json_extract(data, '$.key'));

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX tasks_project ON tasks(project_id);
CREATE UNIQUE INDEX tasks_key ON tasks(json_extract(data, '$.key'));

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX comments_project ON comments(project_id);
CREATE INDEX comments_task ON comments(json_extract(data, '$.task'));

CREATE TABLE activity (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX activity_created ON activity(created_at DESC);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  data        TEXT NOT NULL CHECK (json_valid(data)),
  storage_key TEXT,
  mime        TEXT,
  bytes       INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX files_project ON files(project_id);

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE saved_views (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-person data -------------------------------------------------------------------------------

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, created_at DESC);

CREATE TABLE favorites (
  user_id   TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('projects', 'tasks')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, entity_id)
);

-- Preferences, view settings, sidebar order and other things only the owner sees.
CREATE TABLE user_state (
  user_id     TEXT PRIMARY KEY,
  prefs       TEXT NOT NULL DEFAULT '{}',
  views       TEXT NOT NULL DEFAULT '{}',
  proj_order  TEXT NOT NULL DEFAULT '[]',
  recent      TEXT NOT NULL DEFAULT '[]',
  notif_prefs TEXT NOT NULL DEFAULT '{}',
  collapsed   INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);

-- Outgoing email. Rows are written in the same transaction as the change that caused them and
-- delivered afterwards, so a crash never sends mail for a rolled-back change.
CREATE TABLE outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  link       TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER,
  attempts   INTEGER NOT NULL DEFAULT 0,
  error      TEXT
);
