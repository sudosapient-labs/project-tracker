// @ts-check
/* ---------- vocab ---------- */
/* ---------- time zones ----------
   Any IANA time zone the JavaScript engine knows. Whose clock a start or due is read on is decided
   in one place: server/lib/clock.js on the server and src/core/clock.js in the app (the person's
   saved zone, then the workspace's, then UTC). Nothing reads the machine's own zone; on a server
   that is UTC, not the person's. */
/* Shown first in the picker. */
const COMMON_TZ = [
  { id: 'Asia/Kolkata', name: 'India Standard Time (GMT+05:30)' },
  { id: 'Asia/Dubai', name: 'Dubai, Gulf Standard Time (GMT+04:00)' },
  { id: 'Europe/London', name: 'London (GMT+00:00 / +01:00)' },
  { id: 'Europe/Berlin', name: 'Berlin (GMT+01:00 / +02:00)' },
  { id: 'Asia/Singapore', name: 'Singapore (GMT+08:00)' },
  { id: 'America/New_York', name: 'Eastern Time (GMT−05:00 / −04:00)' },
  { id: 'America/Los_Angeles', name: 'Pacific Time (GMT−08:00 / −07:00)' },
  { id: 'UTC', name: 'UTC' },
];
/* Old names some engines still list (and report as the browser's zone), under today's names. */
const RENAMED = {
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
};
const tzChecked = new Map();
/**
 * `v` when it names a time zone (an IANA name like 'Asia/Dubai', or 'UTC'), else null. Never a
 * fallback: the caller decides whose clock to use instead (see server/lib/clock.js).
 * @param {unknown} v
 * @returns {string | null}
 */
export function validTz(v) {
  // Offsets ('+05:30') aren't zones: they don't follow daylight saving.
  if (typeof v !== 'string' || !v || v.length > 64 || /^[+-]/.test(v)) return null;
  if (!tzChecked.has(v)) {
    let ok = false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      ok = true;
    } catch {
      /* not a zone this engine knows */
    }
    if (tzChecked.size < 1000) tzChecked.set(v, ok);
    else return ok ? v : null;
  }
  return tzChecked.get(v) ? v : null;
}
/** A zone under its current name ('Asia/Calcutta' → 'Asia/Kolkata'); null when it isn't one.
 * @param {unknown} v */
export const modernTz = v => {
  const tz = validTz(v);
  return tz && validTz(RENAMED[tz]) ? RENAMED[tz] : tz;
};
/** The city a zone is named after: 'America/New_York' → 'New York'. @param {string} tz */
export const tzCity = tz =>
  String(tz || '')
    .split('/')
    .pop()
    .replace(/_/g, ' ');
/* 'GMT+04:00', or 'GMT−05:00 / −04:00' for a zone with daylight saving (offsets in January and July). */
function tzOffsets(tz) {
  const year = new Date().getUTCFullYear();
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
  const at = m => {
    const o = f.formatToParts(Date.UTC(year, m, 1)).find(p => p.type === 'timeZoneName')?.value || 'GMT';
    return o === 'GMT' ? 'GMT+00:00' : o;
  };
  const mins = o => {
    const [, sign, h, m] = /([+-])(\d+):(\d+)/.exec(o) || ['', '+', '0', '0'];
    return (sign === '-' ? -1 : 1) * (+h * 60 + +m);
  };
  // Standard time first: daylight saving moves the clock forward.
  const [std, dst] = [at(0), at(6)].sort((a, b) => mins(a) - mins(b)).map(o => o.replace('-', '−'));
  return std === dst ? std : `${std} / ${dst.slice(3)}`;
}
let zoneList = null;
/**
 * Every zone people can pick: the common ones first, then the rest by name, each with a readable
 * name and its offset ('Dubai, Asia (GMT+04:00)'). Built on first use (it takes a moment).
 * @returns {{ id: string, name: string, common?: boolean }[]}
 */
export function timeZones() {
  if (zoneList) return zoneList;
  const ids = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const common = new Set(COMMON_TZ.map(z => z.id));
  const rest = [...new Set(ids.map(modernTz))]
    .filter(id => id && !common.has(id))
    .map(id => {
      const parts = id.split('/');
      const where = parts.length > 1 ? `, ${parts.slice(0, -1).join(' / ').replace(/_/g, ' ')}` : '';
      return { id, name: `${tzCity(id)}${where} (${tzOffsets(id)})` };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  zoneList = [...COMMON_TZ.map(z => ({ ...z, common: true })), ...rest];
  return zoneList;
}
export const STATUSES = [
  { id: 'backlog', name: 'Backlog' },
  { id: 'todo', name: 'To Do' },
  { id: 'progress', name: 'In Progress' },
  { id: 'review', name: 'Review' },
  { id: 'done', name: 'Done' },
];
export const ST = Object.fromEntries(STATUSES.map(s => [s.id, s]));
export const PRIOS = [
  { id: 'urgent', name: 'Urgent', w: 4 },
  { id: 'high', name: 'High', w: 3 },
  { id: 'medium', name: 'Medium', w: 2 },
  { id: 'low', name: 'Low', w: 1 },
  { id: 'none', name: 'No priority', w: 0 },
];
export const PR = Object.fromEntries(PRIOS.map(p => [p.id, p]));
export const LABELS = [
  { id: 'design', name: 'Design', c: 'var(--violet)' },
  { id: 'frontend', name: 'Frontend', c: 'var(--blue)' },
  { id: 'backend', name: 'Backend', c: 'var(--teal)' },
  { id: 'research', name: 'Research', c: 'var(--amber)' },
  { id: 'content', name: 'Content', c: 'var(--rose)' },
  { id: 'bug', name: 'Bug', c: 'var(--red)' },
  { id: 'qa', name: 'QA', c: 'var(--green)' },
  { id: 'growth', name: 'Growth', c: 'var(--orange)' },
];
export const LB = Object.fromEntries(LABELS.map(l => [l.id, l]));
export const PSTAT = {
  planning: { name: 'Planning', c: 'var(--gray)' },
  active: { name: 'In Progress', c: 'var(--blue)' },
  risk: { name: 'At Risk', c: 'var(--red)' },
  hold: { name: 'On Hold', c: 'var(--amber)' },
  complete: { name: 'Completed', c: 'var(--green)' },
};
export const PCOLORS = {
  indigo: '#5A67D8',
  blue: '#3B82C4',
  violet: '#8662C9',
  teal: '#23918A',
  rose: '#C54B78',
  amber: '#C48A1E',
  green: '#3D8E5F',
  slate: '#6B7280',
};
export const PICONS = [
  'globe',
  'smartphone',
  'megaphone',
  'rocket',
  'component',
  'building-2',
  'layout-grid',
  'palette',
  'code',
  'briefcase',
  'target',
  'layers',
  'zap',
  'heart',
  'folder',
  'sparkles',
];
export const ROLES = ['Owner', 'Admin', 'Member', 'Guest'];
/* Repeat choices for a task (the drawer's Repeat menu); the server accepts only these. */
export const RECUR = ['Daily', 'Weekly', 'Every 2 weeks', 'Monthly'];
/* Days between occurrences; completing a repeating task schedules the next one this far ahead. */
export const RECUR_DAYS = { Daily: 1, Weekly: 7, 'Every 2 weeks': 14, Monthly: 30 };
/* The comment reaction picker; the server accepts only these as reaction keys. */
export const REACTIONS = ['👍', '🎉', '❤️', '👀', '🚀', '✅'];
/* Fields a task filter can test (shell/view-engine.js FIELDS); saved views are checked against them. */
export const FILTER_FIELDS = ['status', 'assignee', 'priority', 'due', 'project', 'labels', 'created', 'updated'];
export const TEAMS_SEED = [
  { id: 'design', name: 'Design', icon: 'palette', c: '#8662C9', desc: 'Product design, brand, and research' },
  { id: 'eng', name: 'Engineering', icon: 'code', c: '#3B82C4', desc: 'Web, mobile, and platform engineering' },
  { id: 'mkt', name: 'Marketing', icon: 'megaphone', c: '#C54B78', desc: 'Campaigns, content, and growth' },
  { id: 'product', name: 'Product', icon: 'target', c: '#C48A1E', desc: 'Roadmap, planning, and QA' },
];
