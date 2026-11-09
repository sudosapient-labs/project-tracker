/* =====================================================================
   QUIRE — core: utils, icons, seed data, store, render loop, events
   ===================================================================== */
import { randomHex } from './random.js';
import * as D from '../../packages/client/dates.js';
// Web fonts load without blocking first paint (the link starts as media=print).
document.querySelectorAll('link[data-font]').forEach(l => {
  l.media = 'all';
});
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/* Ids are minted on the client and must stay unique across everyone's devices. */
export const uid = (p = 'x') => p + randomHex(14);
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
/* Whose clock: set from core/clock.js (store.js on load, theme.js on every render). */
export let timeZone = 'UTC';
export function setTimeZone(tz) {
  if (tz) timeZone = tz;
}
export let timeFormat = '12';
export function setTimeFormat(f) {
  timeFormat = String(f) === '24' ? '24' : '12';
}

/* ---------- times and zones ----------
   A start/due is either 'YYYY-MM-DD' (all day) or a UTC ISO instant ('2026-10-30T12:00:00.000Z').
   The rules for both shapes live in packages/client/dates.js (shared with the server, CLI, MCP and
   Slack bot); these read them in the selected time zone. */
export const hasTime = D.isTimed;
/* Wall-clock 'YYYY-MM-DD' + 'HH:MM' in the selected zone → UTC ms. */
export const zonedMs = (day, hm = '00:00', tz = timeZone) => Date.parse(D.fromWallClock(day, hm, tz));
/* The 'YYYY-MM-DD' a value (string of either shape, Date or ms) falls on in the selected zone. */
export const dayKey = v => (v == null || v === '' ? '' : D.dayOf(v, timeZone));
/* Today in the selected zone, as a local-midnight Date. Computed on each call, never stale. */
export const today = () => parse(dayKey(Date.now()));
/* UTC ms of a value. All-day values count as the start of the day, or its end when `end` is set. */
export const instant = (v, end) => D.instant(v, timeZone, end);
/* Soonest first, no value last, on the selected zone (an all-day value sorts as the end of its day). */
export const compareDue = (a, b) => D.compareDue(a, b, timeZone);
export const toDate = (v, end) => new Date(instant(v, end));
/* 'HH:MM' (24h) of a timed value in the selected zone; '' for all-day values. */
export const timeOf = v => D.timeOf(v, timeZone);
/* Set the wall-clock time of a value; an empty time makes it all day. */
export const withTime = (v, hm) => (!v ? null : hm ? D.fromWallClock(dayKey(v), hm, timeZone) : dayKey(v));
/* Move a value to another day, keeping its time of day. */
export const withDay = (v, day) => (hasTime(v) ? withTime(day, timeOf(v)) : day);
export const shiftD = (v, n) => withDay(v, iso(addD(parse(v), n)));
export const isPast = v => D.isOverdue(v, timeZone);
export const dueSoon = v => hasTime(v) && instant(v) >= Date.now() && instant(v) - Date.now() <= 2 * 36e5;
/* Display an 'HH:MM' wall-clock time in the selected time format. */
export const fmtHM = hm => D.fmtHM(hm, timeFormat === '24' ? '24' : '12');
export const fmtTime = v => fmtHM(timeOf(v));
/* Read a typed time ('4', '4p', '4:30 pm', '16:30', '1630') as 'HH:MM'; '' when empty, null when unreadable. */
export const parseTime = D.parseTime;
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
