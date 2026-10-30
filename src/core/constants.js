/* ---------- vocab ---------- */
export const TIMEZONES = [
  { id: 'Asia/Kolkata', name: 'India Standard Time (GMT+05:30)' },
  { id: 'Asia/Dubai', name: 'Dubai, Gulf Standard Time (GMT+04:00)' },
  { id: 'Europe/London', name: 'London (GMT+00:00 / +01:00)' },
  { id: 'Europe/Berlin', name: 'Berlin (GMT+01:00 / +02:00)' },
  { id: 'Asia/Singapore', name: 'Singapore (GMT+08:00)' },
  { id: 'America/New_York', name: 'Eastern Time (GMT−05:00 / −04:00)' },
  { id: 'America/Los_Angeles', name: 'Pacific Time (GMT−08:00 / −07:00)' },
  { id: 'UTC', name: 'UTC' },
];
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const DEFAULT_TZ = TIMEZONES.some(z => z.id === browserTz) ? browserTz : 'Asia/Kolkata';
/* Older saves stored a display label; anything outside the list falls back to the default. */
export const validTz = v => (TIMEZONES.some(z => z.id === v) ? v : DEFAULT_TZ);
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
export const TEAMS_SEED = [
  { id: 'design', name: 'Design', icon: 'palette', c: '#8662C9', desc: 'Product design, brand, and research' },
  { id: 'eng', name: 'Engineering', icon: 'code', c: '#3B82C4', desc: 'Web, mobile, and platform engineering' },
  { id: 'mkt', name: 'Marketing', icon: 'megaphone', c: '#C54B78', desc: 'Campaigns, content, and growth' },
  { id: 'product', name: 'Product', icon: 'target', c: '#C48A1E', desc: 'Roadmap, planning, and QA' },
];
