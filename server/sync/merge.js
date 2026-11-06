// @ts-check
/* Three-way merges for fields that hold a whole list or map (a project's members and permissions, a
   task's subtasks, labels and dependencies). A client edits its copy and sends the new value along
   with the value it started from (`base`); only its own additions, removals and changes relative to
   that base are applied to the value as it is now. So a stale write (an offline queue, a tab that
   hadn't caught up) can't undo what someone else did meanwhile: someone removed from a project by
   one person can't be put back by another person's unrelated edit. */

export const MERGED = { projects: ['members', 'perms'], tasks: ['subtasks', 'labels', 'deps'] };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
/* Subtasks are matched by id; everything else is a list of plain values. */
const keyOf = x => (isObj(x) ? `id:${x.id}` : `v:${JSON.stringify(x)}`);

/* The fields of `mine` that differ from `base`, applied to `cur`. */
function mergeObject(base, mine, cur) {
  const out = { ...cur };
  for (const k of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (same(base[k], mine[k])) continue;
    if (k in mine) out[k] = mine[k];
    else delete out[k];
  }
  return out;
}

/* `mine` in its order, without what someone else removed since `base`, with each entry's own
   changes applied to its current version; then what others added since that `mine` doesn't have. */
function mergeList(base, mine, cur) {
  const inBase = new Map(base.map(x => [keyOf(x), x]));
  const inCur = new Map(cur.map(x => [keyOf(x), x]));
  const out = [];
  const seen = new Set();
  for (const x of mine) {
    const k = keyOf(x);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!inBase.has(k)) out.push(inCur.has(k) && isObj(x) ? mergeObject(inCur.get(k), x, inCur.get(k)) : x);
    else if (inCur.has(k)) out.push(isObj(x) && isObj(inCur.get(k)) ? mergeObject(inBase.get(k), x, inCur.get(k)) : inCur.get(k));
    // In base and mine but not current: someone else removed it. It stays removed.
  }
  for (const x of cur) {
    const k = keyOf(x);
    if (!seen.has(k) && !inBase.has(k)) out.push(x);
  }
  return out;
}

/* The value to store for `field`: `mine` merged onto `cur` relative to `base`. Anything that isn't
   a well-formed list or map falls back to `mine` (the whole value, as before), for the schema to judge. */
export function mergeField(base, mine, cur) {
  if (Array.isArray(base) && Array.isArray(mine)) return mergeList(base, mine, Array.isArray(cur) ? cur : []);
  if (isObj(base) && isObj(mine)) return mergeObject(base, mine, isObj(cur) ? cur : {});
  return mine;
}
