-- Personal API keys (Settings → API). A key acts as the person who made it; only its SHA-256 is
-- stored, plus a short prefix so the list can tell keys apart. `scope` is 'read' or 'write'.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER
);
CREATE INDEX api_keys_user ON api_keys(user_id);

-- Responses to mutating /api/v1 requests sent with an Idempotency-Key, replayed for 24 hours.
CREATE TABLE api_idempotency (
  key_id     TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idem_key   TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status     INTEGER NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, idem_key)
);
