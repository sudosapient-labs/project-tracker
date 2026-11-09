/* The workspace gets a time zone (`tz` on its doc): the clock of everyone who hasn't set their own,
   bots such as the Slack bot's account among them (server/lib/clock.js). Until now the server read
   those people's starts and dues on its own machine's zone, UTC.

   Give a workspace without one the zone most of its people saved in Settings → Date and time
   (a tie goes to the zone of whoever saved their settings first). When nobody saved a valid one it stays unset, and those people
   stay on UTC until an Owner or Admin sets it in Settings → Workspace.

   Later migrations read it as `JSON.parse(db.prepare('SELECT data FROM workspace WHERE id = 1')
   .get()?.data || '{}').tz`, valid when validTz (validZone in packages/client/dates.js) says so. */
import { validTz } from '../../src/core/constants.js';

export default function migrate(db) {
  const row = db.prepare('SELECT data FROM workspace WHERE id = 1').get();
  if (!row) return;
  const ws = JSON.parse(row.data);
  if (validTz(ws.tz)) return;
  const counts = new Map();
  // People still in the workspace; `updated_at` stands in for when they saved it.
  const rows = db.prepare('SELECT prefs FROM user_state WHERE user_id IN (SELECT id FROM members) ORDER BY updated_at, user_id').all();
  for (const { prefs } of rows) {
    let tz = null;
    try {
      tz = validTz(JSON.parse(prefs)?.tz);
    } catch {
      /* unreadable prefs count for nothing */
    }
    if (tz) counts.set(tz, (counts.get(tz) || 0) + 1);
  }
  if (!counts.size) return;
  // Map order is first-saved order, and sort is stable: a tie goes to the zone saved first.
  const [[tz]] = [...counts].sort((a, b) => b[1] - a[1]);
  db.prepare('UPDATE workspace SET data = ? WHERE id = 1').run(JSON.stringify({ ...ws, tz }));
}
