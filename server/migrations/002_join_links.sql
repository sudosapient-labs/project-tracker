-- Reusable workspace invite links ("Copy invite link"): add the 'join' token kind.
CREATE TABLE auth_tokens_new (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset', 'invite', 'join')),
  user_id    TEXT,
  email      TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
INSERT INTO auth_tokens_new SELECT * FROM auth_tokens;
DROP TABLE auth_tokens;
ALTER TABLE auth_tokens_new RENAME TO auth_tokens;
CREATE INDEX auth_tokens_email ON auth_tokens(email, kind);
