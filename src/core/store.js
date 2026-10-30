/* ---------- store ---------- */
import { iso, isPast, setTimeZone, today, uid } from './utils.js';
import { DEFAULT_TZ, PCOLORS, TEAMS_SEED, validTz } from './constants.js';
import { COMMENT, EDIT, canManageProject, projectLevel } from './access.js';

/* Only display preferences are cached in the browser (so the theme applies before the first
   request finishes). Workspace data always comes from the server. */
export const PREFS_KEY = 'gr8r.prefs';
export const DEFAULT_PREFS = {
  theme: 'system',
  accent: 'indigo',
  side: 'comfortable',
  density: 'comfortable',
  weekStart: 1,
  dateFmt: 'MMM d',
  lang: 'English (US)',
  tz: DEFAULT_TZ,
  timeFmt: '12',
  motion: 'system',
  home: 'home',
  openTasks: 'drawer',
  name: '',
  title: '',
};
/* The shape of the workspace graph the server's /api/bootstrap returns, with nothing in it. */
export const emptyData = () => ({
  ws: { name: '', c: '#5A67D8' },
  me: null,
  members: [],
  teams: [],
  projects: [],
  tasks: [],
  comments: [],
  activity: [],
  notifs: [],
  files: [],
  events: [],
  projOrder: [],
  savedViews: [],
  recentSearches: [],
  sessions: [],
  tfa: false,
  notifPrefs: {},
});
function cachedPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (p && typeof p === 'object') return { ...p, tz: validTz(p.tz) };
  } catch {
    /* storage blocked or corrupt: use defaults */
  }
  return {};
}
const cached = cachedPrefs();
setTimeZone(cached.tz || DEFAULT_TZ);
export const S = {
  data: emptyData(),
  prefs: Object.assign({}, DEFAULT_PREFS, cached),
  views: {},
  ui: {
    fx: {},
    auth: null,
    authStep: 'login',
    onb: 0,
    onbData: { use: 'product', team: 'kanban', size: '2-10', ws: '', proj: 'Website Launch', tmpl: 'web', invites: '' },
    route: 'home',
    params: {},
    history: [],
    collapsed: false,
    mnav: false,
    expanded: { p1: true },
    drawer: null,
    drawerFull: false,
    drawerTab: 'comments',
    modals: [],
    pop: null,
    palette: null,
    loading: false,
    offline: false,
    sel: new Set(),
    composer: null,
    editCell: null,
    openTasks: {},
    collapsedGroups: {},
    calDate: iso(today()),
    calMode: 'month',
    tlZoom: 'week',
    tlGroup: 'status',
    fileView: 'grid',
    projView: 'grid',
    homeTab: 'upcoming',
    inboxCat: 'all',
    inboxUnread: false,
    inboxSel: null,
    notifFilter: 'all',
    settings: 'appearance',
    searchQ: '',
    searchCat: 'all',
    myView: 'list',
    membersTab: 'members',
    collapsedCols: {},
    errors: {},
    drafts: {},
  },
};
/* `save()` marks the store dirty. The sync layer (core/sync.js) registers the handler that diffs
   S.data against what the server last confirmed and sends the changes. */
export const saveHooks = { onSave: () => {} };
export let _saveT;
export function save() {
  document.documentElement.dataset.sync = 'saving';
  clearTimeout(_saveT);
  _saveT = setTimeout(() => saveHooks.onSave(), 150);
}

/* ---------- lookups ---------- */
export const D = () => S.data;
export const me = () => D().members.find(m => m.id === D().me);
export const mem = id => D().members.find(m => m.id === id);
/* A person's name; references to someone who has left the workspace read "Former member". */
export const memName = id => mem(id)?.name || (id ? 'Former member' : '');
export const proj = id => D().projects.find(p => p.id === id);
export const task = id => D().tasks.find(t => t.id === id);
export const pColor = p => PCOLORS[p?.color] || PCOLORS.slate;
export const visibleProjects = () =>
  D()
    .projOrder.map(proj)
    .filter(Boolean)
    .filter(p => !p.archived);
/* What I may do in a project (core/access.js; the server enforces the same rules). Private projects
   are visible to their members only; guests only see projects they're added to. Projects I can't
   open arrive as stubs: id, key, name, icon, colour, lead (and, for admins, who has access). */
export const projLevel = p => projectLevel(p, me());
export const canSee = p => projLevel(p) > 0;
export const canComment = p => projLevel(p) >= COMMENT;
export const canEdit = p => projLevel(p) >= EDIT;
export const canManage = p => canManageProject(p, me());
/* `data-ro` for markup inside a project I can only view or comment in (styles hide edit controls). */
export const roAttr = p => (canEdit(p) ? '' : `data-ro="${canComment(p) ? 'comment' : 'view'}"`);
export const tasksOf = pid => D().tasks.filter(t => t.project === pid && !t.archived);
export const allTasks = () => D().tasks.filter(t => !t.archived && canSee(proj(t.project)));
export const isOver = t => t.status !== 'done' && isPast(t.due);
export const commentsOf = tid => D().comments.filter(c => c.task === tid);
export function progressOf(pid) {
  const ts = tasksOf(pid);
  if (!ts.length) return 0;
  return Math.round((ts.filter(t => t.status === 'done').length / ts.length) * 100);
}
export function taskProg(t) {
  if (t.status === 'done') return 100;
  if (t.subtasks.length) return Math.round((t.subtasks.filter(s => s.done).length / t.subtasks.length) * 100);
  return { backlog: 0, todo: 5, progress: 45, review: 80 }[t.status] || 0;
}

/* ---------- activity + notification helpers ---------- */
export function logAct(verb, t, extra = '') {
  D().activity.unshift({ id: uid('a'), by: D().me, verb, task: t?.id || null, project: t?.project || null, at: Date.now(), extra });
  if (t) t.updated = Date.now();
}

/* ---------- teams (workspace data, seeded on first use) ---------- */
export const NO_TEAM = { id: '', name: 'No team', icon: 'users', c: '#8A867E', desc: '' };
export function teamsList() {
  const d = D();
  if (!d.teams) d.teams = TEAMS_SEED.map(t => ({ ...t }));
  return d.teams;
}
export function team(id) {
  return teamsList().find(t => t.id === id) || null;
}
export const TM = new Proxy({}, { get: (_, k) => team(k) || NO_TEAM });
