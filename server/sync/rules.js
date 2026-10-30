/* Per-collection rules for synced writes: who may create, change or delete a record, which fields
   the server owns, and the side effects (task keys, cascades, notifications, invite emails). Each
   hook receives `ctx` (see engine.js) and throws Reject to refuse a single operation. */
import { PR, ST } from '../../src/core/constants.js';
import { Reject } from '../lib/http.js';
import { mentioned, notify } from '../notify.js';
import { issueToken } from '../routes/auth.js';

const RANK = { Owner: 4, Admin: 3, Member: 2, Guest: 1 };
export const isAdmin = ctx => RANK[ctx.me.role] >= RANK.Admin;
const notGuest = (ctx, what) => {
  if (ctx.me.role === 'Guest') throw new Reject(`Guests can't ${what}.`);
};
/* Private projects are visible to their members only; guests only ever see projects they're added to. */
export const canSee = (p, m) => !!p && !!m && ((!p.private && m.role !== 'Guest') || (p.members || []).includes(m.id));

/* The project a record belongs to must exist and be visible to the actor. */
function needProject(ctx, pid) {
  const p = ctx.repo.get('projects', pid);
  if (!p) throw new Reject('That project no longer exists.', 404);
  if (!canSee(p, ctx.me)) throw new Reject("You don't have access to that project.");
  return p;
}
function needMember(ctx, mid, what = 'person') {
  if (mid == null) return;
  if (!ctx.repo.get('members', mid)) throw new Reject(`That ${what} is no longer in the workspace.`, 400);
}

/* ---------- notifications ---------- */
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const dueSnippet = t => [t.due ? `Due ${t.due.slice(0, 10)}` : null, `${PR[t.priority]?.name || 'No'} priority`].filter(Boolean).join(' · ');

/* ---------- task keys ---------- */
function keyTaken(ctx, key, id) {
  return !!ctx.db.get("SELECT 1 FROM tasks WHERE json_extract(data, '$.key') = ? AND id != ?", key, id);
}
function bumpSeq(ctx, p, n) {
  if ((p.seq || 0) >= n) return;
  p.seq = n;
  ctx.repo.put('projects', p);
  ctx.emit('projects', p);
}
/* Keep the client's optimistic key when it is free; otherwise take the project's next number. */
function settleKey(ctx, t, p) {
  const prefix = p.key + '-';
  const n = +t.key?.slice(prefix.length);
  if (t.key?.startsWith(prefix) && Number.isInteger(n) && !keyTaken(ctx, t.key, t.id)) return bumpSeq(ctx, p, n);
  const row = ctx.db.get(
    "SELECT MAX(CAST(substr(json_extract(data, '$.key'), ?) AS INTEGER)) n FROM tasks WHERE json_extract(data, '$.key') LIKE ?",
    prefix.length + 1,
    prefix + '%',
  );
  const next = Math.max(p.seq || 200, row?.n || 0) + 1;
  t.key = prefix + next;
  bumpSeq(ctx, p, next);
}

function deleteTaskCascade(ctx, t) {
  for (const c of ctx.repo.all('comments', "WHERE json_extract(data, '$.task') = ?", t.id)) {
    ctx.repo.del('comments', c.id);
    ctx.emitDel('comments', c.id, c.project ?? t.project);
  }
  for (const o of ctx.repo.all('tasks', "WHERE EXISTS (SELECT 1 FROM json_each(data, '$.deps') WHERE value = ?)", t.id)) {
    o.deps = o.deps.filter(d => d !== t.id);
    ctx.repo.put('tasks', o, o.project);
    ctx.emit('tasks', o);
  }
  ctx.db.run("DELETE FROM favorites WHERE kind = 'tasks' AND entity_id = ?", t.id);
}

function deleteFileRow(ctx, f) {
  const row = ctx.db.get('SELECT storage_key FROM files WHERE id = ?', f.id);
  ctx.repo.del('files', f.id);
  ctx.emitDel('files', f.id, f.project);
  if (row?.storage_key) ctx.blobGc.add(row.storage_key);
}

export const RULES = {
  tasks: {
    scope: v => v.project,
    personal: ['fav'],
    create(ctx, t) {
      const p = needProject(ctx, t.project);
      needMember(ctx, t.assignee, 'assignee');
      settleKey(ctx, t, p);
      if (t.assignee) notify(ctx, t.assignee, 'assign', { type: 'assign', task: t.id, text: 'assigned you', snippet: dueSnippet(t) }, t);
      return t;
    },
    update(ctx, before, t, keys) {
      needProject(ctx, before.project);
      if (keys.includes('project')) settleKey(ctx, t, needProject(ctx, t.project));
      else if (keys.includes('key') && keyTaken(ctx, t.key, t.id)) t.key = before.key;
      if (keys.includes('assignee')) {
        needMember(ctx, t.assignee, 'assignee');
        if (t.assignee) notify(ctx, t.assignee, 'assign', { type: 'assign', task: t.id, text: 'assigned you', snippet: dueSnippet(t) }, t);
      }
      if (keys.includes('status') && t.assignee && !keys.includes('assignee')) {
        const done = t.status === 'done';
        notify(
          ctx,
          t.assignee,
          'status',
          {
            type: 'update',
            task: t.id,
            text: done ? 'completed' : `moved to ${ST[t.status].name}`,
            snippet: done ? t.title : `${ST[before.status]?.name} → ${ST[t.status].name}`,
          },
          t,
        );
      }
      return t;
    },
    remove(ctx, t) {
      needProject(ctx, t.project);
      deleteTaskCascade(ctx, t);
    },
  },

  projects: {
    personal: ['fav'],
    serverOwned: ['key'],
    create(ctx, p) {
      notGuest(ctx, 'create projects');
      needMember(ctx, p.lead, 'project lead');
      while (ctx.db.get("SELECT 1 FROM projects WHERE json_extract(data, '$.key') = ?", p.key)) p.key += 'X';
      p.members = [...new Set([ctx.uid, ...(p.members || [])])].filter(m => ctx.repo.get('members', m));
      return p;
    },
    update(ctx, before, p, keys) {
      if (!canSee(before, ctx.me)) throw new Reject("You don't have access to that project.");
      if (keys.includes('lead')) needMember(ctx, p.lead, 'project lead');
      if (keys.includes('seq')) p.seq = Math.max(before.seq || 0, p.seq || 0);
      if (keys.includes('members')) {
        p.members = [...new Set(p.members)].filter(m => ctx.repo.get('members', m));
        // People gaining or losing a private project need its tasks, files and comments re-sent.
        if (p.private || before.private) {
          const a = new Set(before.members),
            b = new Set(p.members);
          [...a, ...b].filter(m => a.has(m) !== b.has(m)).forEach(m => ctx.resync.add(m));
        }
      }
      if (keys.includes('private')) ctx.resync.add('*');
      return p;
    },
    remove(ctx, p) {
      if (!isAdmin(ctx) && p.lead !== ctx.uid) throw new Reject('Only admins and the project lead can delete a project.');
      if (!canSee(p, ctx.me)) throw new Reject("You don't have access to that project.");
      for (const t of ctx.repo.all('tasks', 'WHERE project_id = ?', p.id)) {
        deleteTaskCascade(ctx, t);
        ctx.repo.del('tasks', t.id);
        ctx.emitDel('tasks', t.id, p.id);
      }
      for (const f of ctx.repo.all('files', 'WHERE project_id = ?', p.id)) deleteFileRow(ctx, f);
      for (const c of ['events', 'savedViews'])
        for (const x of ctx.repo.all(c, 'WHERE project_id = ?', p.id)) {
          ctx.repo.del(c, x.id);
          ctx.emitDel(c, x.id, p.id);
        }
      ctx.db.run("DELETE FROM favorites WHERE kind = 'projects' AND entity_id = ?", p.id);
    },
  },

  comments: {
    scope: v => v.project,
    create(ctx, cm) {
      const t = ctx.repo.get('tasks', cm.task);
      if (!t) throw new Reject('That task no longer exists.', 404);
      needProject(ctx, t.project);
      cm.by = ctx.uid;
      cm.at = ctx.now;
      cm.re ||= {};
      cm.project = t.project;
      const reached = mentioned(ctx.repo, cm.text);
      for (const [id, reason] of reached) notify(ctx, id, reason, { type: 'mention', task: t.id, text: 'mentioned you in', snippet: clip(cm.text) });
      if (t.assignee && !reached.has(t.assignee))
        notify(ctx, t.assignee, 'comment', { type: 'comment', task: t.id, text: 'commented on', snippet: clip(cm.text) });
      return cm;
    },
    update(ctx, before, cm, keys) {
      needProject(ctx, before.project);
      cm.by = before.by;
      cm.task = before.task;
      cm.project = before.project;
      if (before.by === ctx.uid) return cm;
      // Other people may only add or remove their own reactions.
      const mine = (a = {}, b = {}) =>
        [...new Set([...Object.keys(a), ...Object.keys(b)])].every(e => {
          const x = new Set(a[e] || []),
            y = new Set(b[e] || []);
          return [...x].every(i => y.has(i) || i === ctx.uid) && [...y].every(i => x.has(i) || i === ctx.uid);
        });
      if (keys.some(k => k !== 're') || !mine(before.re, cm.re)) throw new Reject('You can only edit your own comments.');
      return cm;
    },
    remove(ctx, cm) {
      if (cm.by !== ctx.uid && !isAdmin(ctx)) throw new Reject('You can only delete your own comments.');
    },
  },

  activity: {
    scope: v => v.project,
    create(ctx, a) {
      if (a.project) needProject(ctx, a.project);
      a.by = ctx.uid;
      if (!(Math.abs(a.at - ctx.now) < 5 * 60_000)) a.at = ctx.now;
      return a;
    },
    update() {
      throw new Reject('Activity history is read-only.');
    },
    remove(ctx, a) {
      // An undo removes the entry its action logged; nobody else's history can be rewritten.
      if (a.by !== ctx.uid) throw new Reject('Activity history is read-only.');
    },
  },

  members: {
    serverOwned: ['email', 'status', 'last'],
    create(ctx, m) {
      notGuest(ctx, 'invite people');
      m.email = m.email.trim().toLowerCase();
      if (ctx.db.get("SELECT 1 FROM members WHERE lower(json_extract(data, '$.email')) = ?", m.email))
        throw new Reject(`${m.email} is already in the workspace.`, 409);
      if (m.role === 'Owner' || (m.role === 'Admin' && !isAdmin(ctx))) m.role = 'Member';
      m.status = 'invited';
      m.last = null;
      const ws = ctx.repo.workspace();
      const link = issueToken(ctx.db, ctx.config, 'invite', m.email);
      ctx.mailer.queue({
        to: m.email,
        subject: `${ctx.me.name} invited you to ${ws?.name || 'Gr8r Studio'}`,
        intro: `${ctx.me.name} invited you to join ${ws?.name || 'their workspace'} on Gr8r Studio.`,
        action: 'Accept invite',
        link,
        outro: 'The invite expires in 14 days.',
      });
      ctx.links.push(link);
      return m;
    },
    update(ctx, before, m, keys) {
      const self = before.id === ctx.uid;
      const adminKeys = ['role', 'team', 'title', 'name'];
      const selfKeys = ['name', 'title', 'c', 'tz', 'team'];
      const teamOnly = keys.every(k => k === 'team');
      for (const k of keys) {
        const ok = (self && selfKeys.includes(k)) || (isAdmin(ctx) && adminKeys.includes(k)) || (teamOnly && ctx.me.role !== 'Guest');
        if (!ok) throw new Reject(k === 'role' ? 'Only admins can change roles.' : "You can't edit other people's profiles.");
      }
      if (keys.includes('role')) {
        if (self) throw new Reject("You can't change your own role.");
        // Becoming or leaving Guest changes which projects this person can see.
        if (before.role === 'Guest' || m.role === 'Guest') ctx.resync.add(m.id);
        if ((m.role === 'Owner' || before.role === 'Owner') && ctx.me.role !== 'Owner') throw new Reject('Only an owner can change who owns the workspace.');
      }
      return m;
    },
    remove(ctx, m) {
      if (!isAdmin(ctx)) throw new Reject('Only admins can remove people.');
      if (m.id === ctx.uid) throw new Reject("You can't remove yourself.");
      if (m.role === 'Owner') throw new Reject("The workspace owner can't be removed.");
      for (const t of ctx.repo.all('tasks', "WHERE json_extract(data, '$.assignee') = ?", m.id)) {
        t.assignee = null;
        ctx.repo.put('tasks', t, t.project);
        ctx.emit('tasks', t);
      }
      for (const p of ctx.repo.all('projects', "WHERE EXISTS (SELECT 1 FROM json_each(data, '$.members') WHERE value = ?)", m.id)) {
        p.members = p.members.filter(x => x !== m.id);
        ctx.repo.put('projects', p);
        ctx.emit('projects', p);
      }
      ctx.removedUsers.push(m.id);
      for (const t of ['sessions', 'favorites', 'user_state', 'notifications']) ctx.db.run(`DELETE FROM ${t} WHERE user_id = ?`, m.id);
      ctx.db.run('DELETE FROM users WHERE id = ?', m.id);
      ctx.db.run('UPDATE auth_tokens SET used_at = ? WHERE email = ? AND used_at IS NULL', ctx.now, m.email);
    },
  },

  teams: {
    create(ctx, t) {
      notGuest(ctx, 'create teams');
      return t;
    },
    update(ctx, b, t) {
      notGuest(ctx, 'edit teams');
      return t;
    },
    remove(ctx) {
      notGuest(ctx, 'delete teams');
    },
  },

  notifs: {
    scope: v => v.uid,
    create() {
      throw new Reject('Notifications are created by the server.', 400);
    },
    update(ctx, before, n, keys) {
      if (keys.some(k => k !== 'read')) throw new Reject('Only the read state of a notification can change.', 400);
      return n;
    },
    remove() {
      throw new Reject('Notifications can only be marked read.', 400);
    },
  },

  files: {
    scope: v => v.project,
    create(ctx, f) {
      needProject(ctx, f.project);
      // New bytes arrive through POST /api/files. Through sync a file can only be a copy of one
      // the actor can already see, sharing its stored bytes.
      const srcId = /\/api\/files\/([A-Za-z0-9_-]+)\//.exec(f.url || '')?.[1];
      const src = srcId && ctx.db.get('SELECT project_id, storage_key, mime, bytes FROM files WHERE id = ?', srcId);
      if (!src?.storage_key || !canSee(ctx.repo.get('projects', src.project_id), ctx.me)) throw new Reject('Upload the file again to add it here.', 400);
      f.by = ctx.uid;
      f.url = `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
      ctx.afterPut.push(() => ctx.db.run('UPDATE files SET storage_key = ?, mime = ?, bytes = ? WHERE id = ?', src.storage_key, src.mime, src.bytes, f.id));
      return f;
    },
    update(ctx, before, f, keys) {
      needProject(ctx, before.project);
      if (keys.some(k => !['name', 'type', 'task', 'url'].includes(k))) throw new Reject('Only a file’s name can be changed.', 400);
      f.url = `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
      return f;
    },
    remove(ctx, f) {
      needProject(ctx, f.project);
      const row = ctx.db.get('SELECT storage_key FROM files WHERE id = ?', f.id);
      if (row?.storage_key) ctx.blobGc.add(row.storage_key);
    },
  },

  events: {
    scope: v => v.project,
    create(ctx, e) {
      if (e.project) needProject(ctx, e.project);
      return e;
    },
    update(ctx, b, e) {
      if (b.project) needProject(ctx, b.project);
      if (e.project) needProject(ctx, e.project);
      return e;
    },
    remove(ctx, e) {
      if (e.project) needProject(ctx, e.project);
    },
  },

  savedViews: {
    scope: v => v.project,
    create(ctx, v) {
      needProject(ctx, v.project);
      return v;
    },
    update(ctx, b, v) {
      needProject(ctx, b.project);
      v.project = b.project;
      return v;
    },
    remove(ctx, v) {
      needProject(ctx, v.project);
    },
  },
};
