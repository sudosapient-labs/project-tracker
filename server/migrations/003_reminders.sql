-- Due-date reminders and overdue alerts already sent, so each fires once per task and due date.
CREATE TABLE reminders (
  task_id TEXT NOT NULL,
  kind    TEXT NOT NULL CHECK (kind IN ('due_soon', 'overdue')),
  due     TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, due)
);

-- The local date of the last daily digest sent to each person.
ALTER TABLE user_state ADD COLUMN last_digest TEXT;
