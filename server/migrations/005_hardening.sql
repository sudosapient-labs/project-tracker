-- Email change confirmations: add the 'email' token kind (sent to the new address).
CREATE TABLE auth_tokens_new (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset', 'invite', 'join', 'email')),
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

-- The last TOTP time step accepted for each account, so a code can't be used twice.
ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
-- Wrong two-factor codes entered in a session that is waiting for one.
ALTER TABLE sessions ADD COLUMN failed_2fa INTEGER NOT NULL DEFAULT 0;

-- Project privacy: `private` is canonical and `access` mirrors it. The share dialog used to set only
-- `access`, which nothing enforced.
UPDATE projects SET data = json_set(data, '$.private', json('true')) WHERE json_extract(data, '$.access') = 'private';
UPDATE projects SET data = json_set(
  data,
  '$.private', json(CASE WHEN json_extract(data, '$.private') THEN 'true' ELSE 'false' END),
  '$.access', CASE WHEN json_extract(data, '$.private') THEN 'private' ELSE 'workspace' END
);
