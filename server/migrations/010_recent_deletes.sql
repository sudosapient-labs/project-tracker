-- What a person deleted in the last few minutes, so Undo can put it back as it was (author, time,
-- reactions) instead of creating it anew. Only the server writes these rows, and only the person who
-- deleted a record can restore it, once, within the window (see sync/engine.js).
CREATE TABLE recent_deletes (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX recent_deletes_at ON recent_deletes (deleted_at);
