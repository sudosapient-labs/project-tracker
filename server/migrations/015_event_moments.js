/* A calendar event is now `when`, the two shapes of a start or due (packages/client/dates.js): its
   day for an all-day event, or the UTC moment it starts for a timed one, so each person sees it on
   their own clock. Until now it was a day and an 'HH:MM' with no zone, shown as saved to everyone.

   Read those on the workspace's clock (migration 014 gave most workspaces one), else UTC, the clock
   of the people who had none. `date` and `time` stay as they were: apps from before `when` show those
   (the sync rules keep them as the day and time on the saver's clock). An event whose day doesn't
   exist is left as it is; the API shows it with `when: null`. */
import { validTz } from '../../src/core/constants.js';
import { fromWallClock, isAllDay, isCanonical } from '../../packages/client/dates.js';

export default function migrate(db) {
  const ws = JSON.parse(db.prepare('SELECT data FROM workspace WHERE id = 1').get()?.data || '{}');
  const tz = validTz(ws.tz) || 'UTC';
  const put = db.prepare('UPDATE events SET data = ? WHERE id = ?');
  for (const { id, data } of db.prepare('SELECT id, data FROM events').all()) {
    const e = JSON.parse(data);
    if (isCanonical(e.when) || !isAllDay(e.date) || !isCanonical(e.date)) continue;
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(e.time || '') ? e.time : '';
    put.run(JSON.stringify({ ...e, when: time ? fromWallClock(e.date, time, tz) : e.date }), id);
  }
}
