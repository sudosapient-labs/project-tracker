/* Storage for synced entities. Every collection the client holds in `S.data` maps to a table whose
   `data` column is the client-facing object, so responses keep the exact shape the UI renders. */

/* `scope` names the denormalised column kept beside `data`: project_id for project-scoped records,
   user_id for per-person ones. */
export const COLLS = {
  members: { table: 'members' },
  teams: { table: 'teams' },
  projects: { table: 'projects' },
  tasks: { table: 'tasks', scope: 'project_id' },
  comments: { table: 'comments', scope: 'project_id' },
  activity: { table: 'activity', scope: 'project_id' },
  files: { table: 'files', scope: 'project_id' },
  events: { table: 'events', scope: 'project_id' },
  savedViews: { table: 'saved_views', scope: 'project_id' },
  notifs: { table: 'notifications', scope: 'user_id' },
};

const parse = r => (r ? JSON.parse(r.data) : null);

export function createRepo(db) {
  const T = coll => {
    const c = COLLS[coll];
    if (!c) throw new Error(`Unknown collection ${coll}`);
    return c;
  };
  return {
    db,
    get(coll, id) {
      return parse(db.get(`SELECT data FROM ${T(coll).table} WHERE id = ?`, id));
    },
    all(coll, where = '', ...params) {
      return db.all(`SELECT data FROM ${T(coll).table} ${where}`, ...params).map(parse);
    },
    /* Insert or replace. `scopeValue` fills the project_id / user_id column. */
    put(coll, obj, scopeValue = null) {
      const c = T(coll);
      const now = Date.now();
      const data = JSON.stringify(obj);
      if (c.scope)
        db.run(
          `INSERT INTO ${c.table} (id, ${c.scope}, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET ${c.scope} = excluded.${c.scope}, data = excluded.data, updated_at = excluded.updated_at`,
          obj.id,
          scopeValue,
          data,
          now,
          now,
        );
      else
        db.run(
          `INSERT INTO ${c.table} (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
          obj.id,
          data,
          now,
          now,
        );
      return obj;
    },
    del(coll, id) {
      return db.run(`DELETE FROM ${T(coll).table} WHERE id = ?`, id).changes > 0;
    },

    /* ---------- workspace ---------- */
    workspace() {
      const r = db.get('SELECT data, onboarded FROM workspace WHERE id = 1');
      return r ? { ...JSON.parse(r.data), onboarded: !!r.onboarded } : null;
    },
    saveWorkspace(ws) {
      const { onboarded, ...data } = ws;
      db.run(
        `INSERT INTO workspace (id, data, onboarded, created_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, onboarded = excluded.onboarded`,
        JSON.stringify(data),
        onboarded ? 1 : 0,
        Date.now(),
      );
    },

    /* ---------- per-person state ---------- */
    userState(uid) {
      const r = db.get('SELECT * FROM user_state WHERE user_id = ?', uid);
      return {
        prefs: JSON.parse(r?.prefs || '{}'),
        views: JSON.parse(r?.views || '{}'),
        projOrder: JSON.parse(r?.proj_order || '[]'),
        recentSearches: JSON.parse(r?.recent || '[]'),
        notifPrefs: JSON.parse(r?.notif_prefs || '{}'),
        collapsed: !!r?.collapsed,
      };
    },
    saveUserState(uid, patch) {
      const cur = this.userState(uid);
      const s = { ...cur, ...patch };
      db.run(
        `INSERT INTO user_state (user_id, prefs, views, proj_order, recent, notif_prefs, collapsed, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, views = excluded.views, proj_order = excluded.proj_order,
           recent = excluded.recent, notif_prefs = excluded.notif_prefs, collapsed = excluded.collapsed, updated_at = excluded.updated_at`,
        uid,
        JSON.stringify(s.prefs),
        JSON.stringify(s.views),
        JSON.stringify(s.projOrder),
        JSON.stringify(s.recentSearches),
        JSON.stringify(s.notifPrefs),
        s.collapsed ? 1 : 0,
        Date.now(),
      );
      return s;
    },

    /* ---------- favorites ---------- */
    favorites(uid) {
      const out = { projects: new Set(), tasks: new Set() };
      for (const r of db.all('SELECT kind, entity_id FROM favorites WHERE user_id = ?', uid)) out[r.kind].add(r.entity_id);
      return out;
    },
    setFavorite(uid, kind, id, on) {
      if (on) db.run('INSERT OR IGNORE INTO favorites (user_id, kind, entity_id) VALUES (?, ?, ?)', uid, kind, id);
      else db.run('DELETE FROM favorites WHERE user_id = ? AND kind = ? AND entity_id = ?', uid, kind, id);
    },
  };
}
