/* The next occurrence of a repeating task used to be made by the app (or the API) and linked one way
   only: `nextId` on the task that was finished. The server now makes it and links it both ways
   (server/sync/task-status.js): the occurrence names the task it came from (`repeatOf`) with a
   fingerprint of how it was made, and reopening that task removes it only while it still matches.

   Link the occurrences already there. One that passed the old "untouched" test (`updated` still equal
   to `created`, still to do) and still has the original's title and project gets the fingerprint of
   how it is now, so reopening removes it as before; any other is linked but always kept. A `nextId`
   that points at a task that's gone, or that another task already claims, is dropped. A task that
   isn't done loses `completedAt` and `prevStatus`, which reopening never used to clear.

   These fields are the server's now and checked on every save, so values clients could store before
   (`nextId: null` from the API, any `prevStatus`, a `repeatOf` of their own) are cleared: kept, they
   would stop the task from being saved again. */
import { STATUSES } from '../../src/core/constants.js';
import { fingerprint } from '../sync/task-status.js';

const STATUS_IDS = new Set(STATUSES.map(s => s.id));

export default function migrate(db) {
  const rows = db.prepare('SELECT id, data FROM tasks ORDER BY created_at, rowid').all();
  const tasks = new Map(rows.map(r => [r.id, JSON.parse(r.data)]));
  const before = new Map(rows.map(r => [r.id, r.data]));
  // No task has been linked yet: any `repeatOf` there is a client's.
  for (const t of tasks.values()) delete t.repeatOf;
  for (const t of tasks.values()) {
    if (t.status !== 'done' || !STATUS_IDS.has(t.prevStatus)) delete t.prevStatus;
    if (t.status !== 'done') delete t.completedAt;
    if (typeof t.nextId !== 'string' || !t.nextId) {
      delete t.nextId;
      continue;
    }
    const n = tasks.get(t.nextId);
    if (!n || n.id === t.id || (n.repeatOf && n.repeatOf.id !== t.id)) {
      delete t.nextId;
      continue;
    }
    if (n.repeatOf) continue;
    const untouched = n.updated === n.created && n.status === 'todo' && n.title === t.title && n.project === t.project;
    n.repeatOf = { id: t.id, sum: untouched ? fingerprint(n) : null };
  }
  const put = db.prepare('UPDATE tasks SET data = ? WHERE id = ?');
  for (const [id, t] of tasks) {
    const data = JSON.stringify(t);
    if (data !== before.get(id)) put.run(data, id);
  }
}
