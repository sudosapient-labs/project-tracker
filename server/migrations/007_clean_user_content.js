/* Records saved before these fields were checked on write may hold anything. Bring existing rows in
   line with what sync now accepts: task descriptions cleaned against the editor's allowlist
   (lib/rich-text.js), repeat settings and event times outside the UI's choices cleared, and comment
   reactions limited to the picker's emoji. */
import { REACTIONS, RECUR } from '../../src/core/constants.js';
import { cleanRich } from '../lib/rich-text.js';

export default function migrate(db) {
  const each = (table, fix) => {
    const put = db.prepare(`UPDATE ${table} SET data = ? WHERE id = ?`);
    for (const { id, data } of db.prepare(`SELECT id, data FROM ${table}`).all()) {
      const v = JSON.parse(data);
      if (fix(v)) put.run(JSON.stringify(v), id);
    }
  };
  each('tasks', t => {
    let changed = false;
    if (typeof t.desc === 'string' && t.desc && cleanRich(t.desc) !== t.desc) {
      t.desc = cleanRich(t.desc);
      changed = true;
    }
    if (t.recur != null && !RECUR.includes(t.recur)) {
      t.recur = null;
      changed = true;
    }
    return changed;
  });
  each('events', e => {
    if (typeof e.time === 'string' && /^(\d{2}:\d{2})?$/.test(e.time)) return false;
    e.time = '';
    return true;
  });
  each('comments', c => {
    const re = c.re && typeof c.re === 'object' ? c.re : {};
    const keep = Object.fromEntries(Object.entries(re).filter(([k, v]) => REACTIONS.includes(k) && Array.isArray(v)));
    if (JSON.stringify(keep) === JSON.stringify(c.re)) return false;
    c.re = keep;
    return true;
  });
}
