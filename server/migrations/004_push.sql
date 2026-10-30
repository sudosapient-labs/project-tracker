-- Web Push: one row per browser that turned on push notifications.
CREATE TABLE push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- Keys the server generates for itself on first start (e.g. the VAPID pair for Web Push).
CREATE TABLE server_keys (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
