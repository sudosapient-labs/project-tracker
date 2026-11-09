/* Starts and dues are now exactly one of two shapes (packages/client/dates.js): 'YYYY-MM-DD' for all
   day, or a UTC instant as Date#toISOString writes it ('2026-11-09T18:29:00.000Z'). The API used to
   store a date-time as it was sent, with an offset or with no zone at all, so bring those in line:
   an offset is converted to UTC, and a date-time without a zone is read as UTC, which is how the
   server (running in UTC) has always read it. A value that isn't a date at all is cleared. */
import { checkWhen, isCanonical } from '../../packages/client/dates.js';

const fix = v => {
  if (v == null || v === '' || isCanonical(v)) return v;
  if (typeof v !== 'string') return null;
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(v) ? v + 'Z' : v;
  const c = checkWhen(zoned);
  return c.ok ? c.value : null;
};

export default function migrate(db) {
  const each = (table, change) => {
    const put = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    for (const { id, data } of db.prepare(`SELECT id, data FROM ${table}`).all()) {
      const v = JSON.parse(data);
      const before = JSON.stringify(v);
      change(v);
      const after = JSON.stringify(v);
      if (after !== before) put.run(after, id);
    }
  };
  const fields = (o, keys) => {
    for (const k of keys) if (o && k in o) o[k] = fix(o[k]);
  };
  each('tasks', t => {
    fields(t, ['start', 'due']);
    if (Array.isArray(t.subtasks)) for (const s of t.subtasks) fields(s, ['due']);
  });
  each('projects', p => {
    fields(p, ['start', 'due']);
    if (Array.isArray(p.milestones)) for (const m of p.milestones) fields(m, ['date']);
  });
}
