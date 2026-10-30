/* =====================================================================
   QUIRE — core: utils, icons, seed data, store, render loop, events
   ===================================================================== */
// Web fonts load without blocking first paint (the link starts as media=print).
document.querySelectorAll('link[data-font]').forEach(l => {
  l.media = 'all';
});
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/* Ids are minted on the client and must stay unique across everyone's devices. */
export const uid = (p = 'x') => p + crypto.randomUUID().replace(/-/g, '').slice(0, 14);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

/* ---------- dates ---------- */
export const DAY = 864e5;
export const sod = d => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
export const iso = d => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};
/* A calendar day as a local-midnight Date. Timed values (UTC instants) resolve to their day in
   the selected time zone, so day math (diffD, addD, fmtDate) works on both value shapes. */
export const parse = s => {
  if (!s) return null;
  if (hasTime(s)) s = dayKey(s);
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addD = (d, n) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const dOff = n => iso(addD(today(), n));
export const diffD = (a, b) => Math.round((sod(a) - sod(b)) / DAY);
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* Set from preferences on every render (core/theme.js), so utils never depends on the store. */
export let dateFormat = 'MMM d';
export function setDateFormat(f) {
  dateFormat = f || 'MMM d';
}
export let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export function setTimeZone(tz) {
  if (tz) timeZone = tz;
}
export let timeFormat = '12';
export function setTimeFormat(f) {
  timeFormat = String(f) === '24' ? '24' : '12';
}

/* ---------- times and zones ----------
   A start/due is either 'YYYY-MM-DD' (all day) or a UTC ISO instant ('2026-10-30T12:00:00.000Z'). */
export const hasTime = v => typeof v === 'string' && v.length > 10 && v.includes('T');
const zoneFmts = {};
function zoneParts(ms, tz = timeZone) {
  const f = (zoneFmts[tz] ||= new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }));
  const o = {};
  for (const p of f.formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value;
  return o;
}
const zoneOffset = (ms, tz) => {
  const o = zoneParts(ms, tz);
  return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) - Math.floor(ms / 1e3) * 1e3;
};
/* Wall-clock 'YYYY-MM-DD' + 'HH:MM' in the selected zone → UTC ms. */
export function zonedMs(day, hm = '00:00', tz = timeZone) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const ms = guess - zoneOffset(guess, tz);
  return guess - zoneOffset(ms, tz);
}
/* The 'YYYY-MM-DD' a value (string of either shape, Date or ms) falls on in the selected zone. */
export function dayKey(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' && !hasTime(v)) return v.slice(0, 10);
  const o = zoneParts(typeof v === 'string' ? Date.parse(v) : +v);
  return `${o.year}-${String(o.month).padStart(2, '0')}-${String(o.day).padStart(2, '0')}`;
}
/* Today in the selected zone, as a local-midnight Date. Computed on each call, never stale. */
export const today = () => parse(dayKey(Date.now()));
/* UTC ms of a value. All-day values count as the start of the day, or its end when `end` is set. */
export function instant(v, end) {
  if (!v) return NaN;
  if (hasTime(v)) return Date.parse(v);
  return end ? zonedMs(iso(addD(parse(v), 1))) - 1 : zonedMs(v);
}
export const toDate = (v, end) => new Date(instant(v, end));
/* 'HH:MM' (24h) of a timed value in the selected zone; '' for all-day values. */
export function timeOf(v) {
  if (!hasTime(v)) return '';
  const o = zoneParts(Date.parse(v));
  return `${String(o.hour % 24).padStart(2, '0')}:${String(o.minute).padStart(2, '0')}`;
}
/* Set the wall-clock time of a value; an empty time makes it all day. */
export const withTime = (v, hm) => (!v ? null : hm ? new Date(zonedMs(dayKey(v), hm)).toISOString() : dayKey(v));
/* Move a value to another day, keeping its time of day. */
export const withDay = (v, day) => (hasTime(v) ? withTime(day, timeOf(v)) : day);
export const shiftD = (v, n) => withDay(v, iso(addD(parse(v), n)));
export const isPast = v => !!v && Date.now() > instant(v, true);
export const dueSoon = v => hasTime(v) && instant(v) >= Date.now() && instant(v) - Date.now() <= 2 * 36e5;
/* Display an 'HH:MM' wall-clock time in the selected time format. */
export function fmtHM(hm) {
  if (!hm) return '';
  if (timeFormat === '24') return hm;
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export const fmtTime = v => fmtHM(timeOf(v));
/* Read a typed time ('4', '4p', '4:30 pm', '16:30', '1630') as 'HH:MM'; '' when empty, null when unreadable. */
export function parseTime(s) {
  s = (s || '').trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/^(\d{1,2})(?:[:.]?(\d{2}))?\s*(?:([ap])\.?m?\.?)?$/);
  if (!m) return null;
  let h = +m[1];
  const min = +(m[2] || 0);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === 'p' ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
export const fmtDateTime = (v, long) => (v ? fmtDate(v, long) + (hasTime(v) ? ', ' + fmtTime(v) : '') : '');
export function fmtDate(s, long) {
  const d = typeof s === 'string' ? parse(s) : s;
  if (!d) return '';
  const fmt = dateFormat;
  if (fmt === 'd/M') return `${d.getDate()}/${d.getMonth() + 1}${long ? '/' + d.getFullYear() : ''}`;
  if (fmt === 'M/d') return `${d.getMonth() + 1}/${d.getDate()}${long ? '/' + d.getFullYear() : ''}`;
  if (fmt === 'yyyy-MM-dd') return iso(d);
  return `${MON[d.getMonth()]} ${d.getDate()}${long || d.getFullYear() !== today().getFullYear() ? ', ' + d.getFullYear() : ''}`;
}
/* Relative day ('Today', 'Fri', 'Oct 30'), plus the time when the value has one. */
export function relDate(s) {
  if (!s) return '';
  const n = diffD(parse(s), today());
  const t = hasTime(s) ? fmtTime(s) : '';
  const day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 1 && n < 7 ? WD[parse(s).getDay()] : '';
  if (day) return t ? `${day} ${t}` : day;
  return t ? `${fmtDate(s)}, ${t}` : fmtDate(s);
}
export function ago(ts) {
  const m = Math.round((Date.now() - ts) / 6e4);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 7) return d + 'd ago';
  return fmtDate(dayKey(ts));
}
export const minsAgo = m => Date.now() - m * 6e4;
export function dayBucket(ts) {
  const n = diffD(parse(dayKey(ts)), today());
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  if (n > -7) return 'This week';
  return 'Earlier';
}
