/* The full object graph one person may see, in the same shape the prototype's seed data had, so
   the client swaps its data source without changing how anything renders. */
import { listSessions } from '../auth.js';
import { canSee } from './rules.js';

const ACTIVITY_LIMIT = 1000;
const NOTIF_LIMIT = 500;

export function bootstrap({ db, repo }, auth) {
  const uid = auth.member.id;
  const favs = repo.favorites(uid);
  const projects = repo.all('projects', 'ORDER BY created_at, rowid').map(p => ({ ...p, fav: favs.projects.has(p.id) }));
  const vis = JSON.stringify(projects.filter(p => canSee(p, uid)).map(p => p.id));
  const IN = 'project_id IN (SELECT value FROM json_each(?))';
  const OPT = `(project_id IS NULL OR ${IN})`;

  const lastSeen = new Map(db.all('SELECT user_id, MAX(last_seen_at) t FROM sessions GROUP BY user_id').map(r => [r.user_id, r.t]));
  const now = Date.now();
  const members = repo.all('members', 'ORDER BY created_at, rowid').map(m => ({
    ...m,
    last: m.status === 'invited' ? null : lastSeen.has(m.id) ? Math.max(0, Math.round((now - lastSeen.get(m.id)) / 60000)) : null,
  }));

  const state = repo.userState(uid);
  const ids = new Set(projects.map(p => p.id));
  const known = state.projOrder.filter(id => ids.has(id));
  // Projects this person hasn't placed yet go first, newest on top, like a fresh `unshift`.
  const unplaced = projects
    .filter(p => !known.includes(p.id))
    .map(p => p.id)
    .reverse();
  const ws = repo.workspace();
  const user = auth.user;

  return {
    data: {
      ws: { name: ws?.name || '', c: ws?.c || '#5A67D8', ...(ws?.brand ? { brand: true } : {}) },
      me: uid,
      members,
      teams: repo.all('teams', 'ORDER BY created_at, rowid'),
      projects,
      tasks: repo.all('tasks', `WHERE ${IN} ORDER BY created_at, rowid`, vis).map(t => ({ ...t, fav: favs.tasks.has(t.id) })),
      comments: repo.all('comments', `WHERE ${IN} ORDER BY created_at, rowid`, vis),
      activity: repo.all('activity', `WHERE ${OPT} ORDER BY created_at DESC, rowid DESC LIMIT ${ACTIVITY_LIMIT}`, vis),
      notifs: db.all('SELECT data FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', uid, NOTIF_LIMIT).map(r => JSON.parse(r.data)),
      files: repo.all('files', `WHERE ${OPT} ORDER BY created_at DESC, rowid DESC`, vis),
      events: repo.all('events', `WHERE ${OPT} ORDER BY created_at, rowid`, vis),
      projOrder: [...unplaced, ...known],
      savedViews: repo.all('savedViews', `WHERE ${IN} ORDER BY created_at, rowid`, vis),
      recentSearches: state.recentSearches,
      sessions: listSessions(db, uid, auth.session.id),
      tfa: !!user.totp_enabled,
      notifPrefs: state.notifPrefs,
    },
    prefs: { ...state.prefs, name: auth.member.name, title: auth.member.title || '' },
    views: state.views,
    collapsed: state.collapsed,
    workspace: { onboarded: !!ws?.onboarded },
  };
}
