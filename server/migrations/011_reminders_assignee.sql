-- Reminders fire once per task, due date and assignee, so a task reassigned after its reminder
-- still reminds the new assignee. Earlier rows are credited to whoever the task is assigned to now.
CREATE TABLE reminders_new (
  task_id  TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('due_soon', 'overdue')),
  due      TEXT NOT NULL,
  assignee TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind, due, assignee)
);
INSERT INTO reminders_new (task_id, kind, due, assignee, sent_at)
  SELECT r.task_id, r.kind, r.due, COALESCE((SELECT json_extract(t.data, '$.assignee') FROM tasks t WHERE t.id = r.task_id), ''), r.sent_at
  FROM reminders r;
DROP TABLE reminders;
ALTER TABLE reminders_new RENAME TO reminders;

-- When each person's last daily digest was put together: the next one covers everything since.
ALTER TABLE user_state ADD COLUMN last_digest_at INTEGER;
