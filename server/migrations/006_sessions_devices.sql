-- Push subscriptions belong to the session that made them and end with it. Older rows have no
-- session, so they go; the browser subscribes again on its next load (actions/push.js refreshPush).
DELETE FROM push_subscriptions;
ALTER TABLE push_subscriptions ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE;
CREATE INDEX push_subscriptions_session ON push_subscriptions(session_id);

-- Wrong two-factor codes per account (whatever the session): after 10 in 15 minutes, two-factor
-- sign-in pauses for 15 minutes. A correct code resets the count.
ALTER TABLE users ADD COLUMN tfa_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN tfa_failed_since INTEGER;
ALTER TABLE users ADD COLUMN tfa_locked_until INTEGER;

-- Browsers that have signed in to an account before ("device cookies", OWASP). Sign-ins from them
-- skip the per-email lockout, so strangers can't lock the owner out by failing on purpose. Only the
-- cookie's SHA-256 is stored.
CREATE TABLE devices (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices(user_id);
