// @ts-check
/* Start and due values: the one definition the web app, the server, the CLI, the MCP server and the
   Slack bot all use. Don't handle these values anywhere without going through this file.

   A value (a task's start or due, a subtask's due, a project's start or due, a milestone's date, a
   calendar event's start, the value an activity entry set) is one of exactly two shapes:

     all day   'YYYY-MM-DD'                a calendar day with no time and no time zone: Nov 9 is
                                           Nov 9 wherever it's read. It counts as the *end* of that
                                           day for "overdue" and for ordering.
     timed     'YYYY-MM-DDTHH:MM:SS.sssZ'  one moment, always stored in UTC (the trailing Z, as
                                           Date#toISOString writes it). Shown in the reader's time
                                           zone, so its day there can differ from its UTC day.

   So never read a value's day with value.slice(0, 10), and never compare two values as strings:
   use dayOf, timeOf, instant and compareDue with the reader's time zone.

   People and language models speak in wall-clock time ("Friday 5pm", in some time zone); code turns
   that into a value with parseWhen / fromWallClock, and back into words with dayOf / timeOf / label. */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** @typedef {string | number | Date} When  a value, or a moment as Unix ms or a Date */

/** A day that exists on the calendar (2026-02-31 doesn't). */
const realDay = (/** @type {string} */ day) => {
  const d = new Date(day + 'T00:00:00Z');
  return !Number.isNaN(+d) && d.toISOString().startsWith(day);
};

/** 'YYYY-MM-DD', an all-day value. */
export const isAllDay = (/** @type {unknown} */ v) => typeof v === 'string' && DAY_RE.test(v);
/** A timed value (any ISO date-time; stored ones are always canonical). */
export const isTimed = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 10 && v[10] === 'T';
/** Exactly one of the two stored shapes. */
export const isCanonical = (/** @type {unknown} */ v) =>
  typeof v === 'string' && ((DAY_RE.test(v) && realDay(v)) || (CANONICAL_RE.test(v) && realDay(v.slice(0, 10)) && new Date(v).toISOString() === v));

/**
 * Check a value given to the API and bring it to its stored shape: a real 'YYYY-MM-DD', or an ISO
 * date-time *with* a zone (Z or ±HH:MM), stored as UTC. A date-time without a zone is refused: it
 * would mean a different moment depending on whose clock reads it.
 * @param {string} v
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function checkWhen(v) {
  if (typeof v !== 'string') return { ok: false, error: 'Use YYYY-MM-DD or an ISO date-time' };
  if (DAY_RE.test(v)) return realDay(v) ? { ok: true, value: v } : { ok: false, error: 'That date doesn’t exist' };
  const m = ISO_RE.exec(v);
  if (!m) return { ok: false, error: 'Use YYYY-MM-DD or an ISO date-time' };
  if (!realDay(m[1]) || +m[2] > 23 || +m[3] > 59 || +(m[4] || 0) > 59) return { ok: false, error: 'That date doesn’t exist' };
  if (!m[5]) return { ok: false, error: 'Give the time zone: end with Z (UTC) or an offset like +05:30' };
  return { ok: true, value: new Date(v).toISOString() };
}

/* ---------- time zones ----------
   A zone is any IANA name the JavaScript engine knows ('Asia/Kolkata', 'UTC'). This checks one; it
   never picks one: whose clock to read on is the server's server/lib/clock.js, the app's
   src/core/clock.js, or `timeZone` from the API in clients. */
/* Old names some engines (and Slack profiles, and browsers) still give, under today's names. */
const RENAMED = /** @type {Record<string, string>} */ ({
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Enderbury': 'Pacific/Kanton',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
});
/** @type {Map<string, boolean>} */
const zoneChecked = new Map();
/**
 * `v` when it names a time zone this engine knows (an IANA name like 'Asia/Dubai', or 'UTC'), else
 * null. Never a fallback: the caller decides whose clock to use instead.
 * @param {unknown} v
 * @returns {string | null}
 */
export function validZone(v) {
  // Offsets ('+05:30') aren't zones: they don't follow daylight saving.
  if (typeof v !== 'string' || !v || v.length > 64 || /^[+-]/.test(v)) return null;
  let ok = zoneChecked.get(v);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      ok = true;
    } catch {
      ok = false; // not a zone this engine knows
    }
    // Bounded: these can come from requests.
    if (zoneChecked.size < 1000) zoneChecked.set(v, ok);
  }
  return ok ? v : null;
}
/**
 * A zone under its current name ('Asia/Calcutta' → 'Asia/Kolkata'); null when it isn't one.
 * @param {unknown} v
 * @returns {string | null}
 */
export function modernZone(v) {
  const tz = validZone(v);
  return tz && validZone(RENAMED[tz]) ? RENAMED[tz] : tz;
}

const formatters = new Map();
/**
 * The wall clock of a moment in a time zone.
 * @param {number} ms
 * @param {string} tz IANA zone, e.g. 'Asia/Kolkata'
 */
export function zoneParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  /** @type {Record<string, number>} */
  const o = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value;
  const day = `${o.year}-${pad(o.month)}-${pad(o.day)}`;
  return { day, year: o.year, month: o.month, date: o.day, hour: o.hour % 24, minute: o.minute, second: o.second, weekday: weekdayOf(day) };
}
const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const offset = (/** @type {number} */ ms, /** @type {string} */ tz) => {
  const o = zoneParts(ms, tz);
  return Date.UTC(o.year, o.month - 1, o.date, o.hour, o.minute, o.second) - Math.floor(ms / 1e3) * 1e3;
};
/** 0 Sunday … 6 Saturday, for a 'YYYY-MM-DD'. */
const weekdayOf = (/** @type {string} */ day) => new Date(day + 'T00:00:00Z').getUTCDay();
/** Calendar arithmetic on a 'YYYY-MM-DD': the day `n` days later. */
export const addDaysToDay = (/** @type {string} */ day, /** @type {number} */ n) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/**
 * A wall-clock day and time in a time zone, as a stored timed value (UTC).
 * @param {string} day 'YYYY-MM-DD'
 * @param {string} hm 'HH:MM' (24h)
 * @param {string} tz
 */
export function fromWallClock(day, hm, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  // Two passes, so a time next to a daylight-saving change lands on the right side of it.
  const ms = guess - offset(guess, tz);
  return new Date(guess - offset(ms, tz)).toISOString();
}

/* ---------- reading values ---------- */
/**
 * The day a value or moment falls on in a time zone, 'YYYY-MM-DD'. An all-day value is its own day.
 * @param {When} v
 * @param {string} tz
 */
export function dayOf(v, tz) {
  if (typeof v === 'string' && !isTimed(v)) return v.slice(0, 10);
  return zoneParts(typeof v === 'string' ? Date.parse(v) : +v, tz).day;
}
/**
 * The wall-clock time of a timed value in a time zone, 'HH:MM' (24h); '' for an all-day value.
 * @param {string | null | undefined} v
 * @param {string} tz
 */
export function timeOf(v, tz) {
  if (!isTimed(v)) return '';
  const o = zoneParts(Date.parse(/** @type {string} */ (v)), tz);
  return `${pad(o.hour)}:${pad(o.minute)}`;
}
/**
 * The moment a value stands for, in Unix ms. An all-day value is the start of its day in `tz`, or
 * its end (the last millisecond) when `end` is set; NaN for no value.
 * @param {string | null | undefined} v
 * @param {string} tz
 * @param {boolean} [end]
 */
export function instant(v, tz, end = false) {
  if (!v) return NaN;
  if (isTimed(v)) return Date.parse(v);
  return end ? Date.parse(fromWallClock(addDaysToDay(v, 1), '00:00', tz)) - 1 : Date.parse(fromWallClock(v, '00:00', tz));
}
/**
 * Past due: after the moment for a timed value, after the whole day for an all-day one.
 * @param {string | null | undefined} v
 * @param {string} tz
 * @param {number} [now]
 */
export const isOverdue = (v, tz, now = Date.now()) => !!v && now > instant(v, tz, true);
/**
 * Soonest first; no value last. An all-day value sorts as the end of its day, after that day's
 * timed values, as the app's lists do.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @param {string} tz
 */
export function compareDue(a, b, tz) {
  const x = a ? instant(a, tz, true) : Infinity;
  const y = b ? instant(b, tz, true) : Infinity;
  return x === y ? 0 : x < y ? -1 : 1;
}
/**
 * The same value `n` days later, keeping its shape and, for a timed one, its wall-clock time in `tz`.
 * @param {string} v
 * @param {number} n
 * @param {string} tz
 */
export function shiftDays(v, n, tz) {
  if (!isTimed(v)) return addDaysToDay(v.slice(0, 10), n);
  return fromWallClock(addDaysToDay(dayOf(v, tz), n), timeOf(v, tz), tz);
}

/* ---------- words ---------- */
/**
 * 'HH:MM' as 24h ('23:59') or 12h ('11:59 PM').
 * @param {string} hm
 * @param {'12' | '24'} [format]
 */
export function fmtHM(hm, format = '24') {
  if (!hm || format === '24') return hm;
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
/**
 * A value for people, in a time zone: 'iso' gives '2026-11-09' or '2026-11-09 23:59'; 'short' gives
 * 'Nov 9' or 'Nov 9, 11:59 PM'. '' for no value.
 * @param {string | null | undefined} v
 * @param {string} tz
 * @param {{ style?: 'iso' | 'short', time?: '12' | '24' }} [o]
 */
export function label(v, tz, { style = 'iso', time = '24' } = {}) {
  if (!v) return '';
  const day = dayOf(v, tz);
  const t = fmtHM(timeOf(v, tz), time);
  if (style === 'short') {
    const [, m, d] = day.split('-').map(Number);
    return `${MONTHS[m - 1]} ${d}${t ? ', ' + t : ''}`;
  }
  return t ? `${day} ${t}` : day;
}

/* ---------- reading what people type ---------- */
/**
 * A typed time ('4', '4p', '4:30 pm', '16:30', '1630', 'noon', 'midnight') as 'HH:MM'; '' when empty,
 * null when unreadable.
 * @param {string} s
 */
export function parseTime(s) {
  s = (s || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'noon') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?m?\.?)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

/**
 * Everyday words for a day, optionally with a time, read in a time zone: '2026-11-20', 'today',
 * 'tomorrow', 'friday' / 'fri' (its next occurrence; today counts), '+3d', '2w', 'next week', each
 * optionally followed by a time ('fri 5pm', 'today at 23:59', '2026-11-20 09:30', '2026-11-20T09:30').
 * An ISO date-time with a zone is taken as is. A time on its own means today. Returns the stored value
 * (all day without a time, timed with one), or null when it can't be read.
 * @param {string} s
 * @param {string} tz
 * @param {number | Date} [now]
 */
export function parseWhen(s, tz, now = Date.now()) {
  const raw = String(s ?? '').trim();
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(raw) && raw.length > 10) {
    const c = checkWhen(raw.replace(' ', 'T').replace(/z$/, 'Z'));
    return c.ok ? c.value : null;
  }
  const v = raw.toLowerCase().replace(/\s+/g, ' ');
  if (!v) return null;
  const today = dayOf(+now, tz);
  /** @type {[string | null, string]} */
  const [day, rest] = readDay(v, today);
  if (day === null) {
    // No day: a time on its own is today at that time.
    const hm = parseTime(v);
    return hm ? fromWallClock(today, hm, tz) : null;
  }
  if (!realDay(day)) return null;
  const tail = rest
    .trim()
    .replace(/^(t|at |@ ?|, ?)/, '')
    .trim();
  if (!tail) return day;
  const hm = parseTime(tail);
  return hm ? fromWallClock(day, hm, tz) : null;
}
/** @returns {[string | null, string]} the day read at the start of `v`, and what follows it */
function readDay(v, today) {
  let m = /^(\d{4}-\d{2}-\d{2})(.*)$/.exec(v);
  if (m) return [m[1], m[2]];
  m = /^(today|tomorrow|next week)\b(.*)$/.exec(v);
  if (m) {
    if (m[1] === 'today') return [today, m[2]];
    if (m[1] === 'tomorrow') return [addDaysToDay(today, 1), m[2]];
    return [addDaysToDay(today, (8 - weekdayOf(today)) % 7 || 7), m[2]];
  }
  m = /^\+?(\d{1,3}) ?(d|w)\b(.*)$/.exec(v);
  if (m) return [addDaysToDay(today, Number(m[1]) * (m[2] === 'w' ? 7 : 1)), m[3]];
  m = /^([a-z]+)\b(.*)$/.exec(v);
  if (m) {
    const wd = WEEKDAYS.findIndex(n => n === m[1] || n.slice(0, 3) === m[1]);
    if (wd >= 0) return [addDaysToDay(today, (wd - weekdayOf(today) + 7) % 7), m[2]];
  }
  return [null, v];
}
