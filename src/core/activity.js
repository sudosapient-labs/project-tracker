// @ts-check
/* ---------- activity that records a start or due ----------
   History is read by people on other clocks than the writer's, so an entry that sets a start or due
   keeps the value itself (`when`: 'YYYY-MM-DD' or a UTC instant, as stored on the task; null when
   it was cleared), and each reader words it on their own clock. `extra` still holds the writer's
   words: entries from before `when` have only those, and apps from before read only those.
   The app, the server's REST views and the API's writes all go through here. */
import { isCanonical } from '../../packages/client/dates.js';

/* The entries that carry a value, and the words before it. */
const WHEN_VERBS = /** @type {Record<string, string>} */ ({
  'changed due date of': 'to ',
  'changed start date of': 'to ',
  'set a subtask due date on': '',
});

/**
 * The words after an entry's verb, for a reader: from `when` on their clock when the entry has one,
 * else the writer's `extra`.
 * @param {{ verb: string, extra?: string, when?: string | null }} a
 * @param {(v: string) => string} fmt  shows a start or due on the reader's clock
 */
export function actExtra(a, fmt) {
  const pre = WHEN_VERBS[a.verb];
  if (pre === undefined || a.when === undefined || (a.when !== null && !isCanonical(a.when))) return a.extra || '';
  return a.when ? pre + fmt(a.when) : '(cleared)';
}

/**
 * The fields of an entry that sets a start or due to `v` (null or '' when cleared), worded on the
 * writer's clock by `fmt`.
 * @param {string} verb  one of the verbs above
 * @param {string | null | undefined} v
 * @param {(v: string) => string} fmt
 * @returns {{ extra: string, when: string | null }}
 */
export function whenAct(verb, v, fmt) {
  const when = v || null;
  return { when, extra: actExtra({ verb, when }, fmt) };
}
