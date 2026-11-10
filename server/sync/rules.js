// @ts-check
/* Per-collection rules for synced writes: who may create, change or delete a record, which fields
   the server owns, and the side effects (task keys, cascades, notifications, invite emails). Each
   hook receives `ctx` (see engine.js) and throws Reject to refuse a single operation. */
import { PR, ST } from '../../src/core/constants.js';
import { COMMENT, EDIT, PERMS, VIEW, canManageProject, canSeeProject, isAdminRole, projectLevel } from '../../src/core/access.js';
import { fileType, fsize } from '../../src/core/file-types.js';
import { Reject } from '../lib/http.js';
import { cleanCheckedRich, richTextProblem } from '../lib/rich-text.js';
import { RICH_MS_PER_REQUEST } from './budget.js';
import { mentioned, notify } from '../notify.js';
import { issueToken } from '../routes/auth.js';
import { dayOf, fromWallClock, isCanonical, label, timeOf } from '../../packages/client/dates.js';
import { clockOf } from '../lib/clock.js';
import { LIFECYCLE, createdStatus, settleStatus } from './task-status.js';

export { projectLevel };
export const isAdmin = ctx => isAdminRole(ctx.me);
export const canSee = canSeeProject;
const notGuest = (ctx, what) => {
  if (ctx.me.role === 'Guest') throw new Reject(`Guests can't ${what}.`);
};

/* The project record as person `m` may receive it: whole when they can see it; otherwise a stub for
   the locked card and request-access page, plus the settings Owners/Admins need to restore access;
   nothing at all for Guests. */
const STUB = ['id', 'key', 'name', 'icon', 'color', 'lead', 'archived'];
const SETTINGS = ['members', 'perms', 'access', 'archivedAt'];
export function projectFor(p, m) {
  if (!p || canSee(p, m)) return p;
  if (!m || m.role === 'Guest') return null;
  const out = {};
  for (const k of [...STUB, ...(isAdminRole(m) ? SETTINGS : [])]) if (k in p) out[k] = p[k];
  return { ...out, private: true };
}

/* A member record as person `m` may receive it. Guests only see the email of people they share a
   project with (and their own); `projects` is every project, to work out which ones those are. */
export function memberFor(x, m, projects) {
  if (!x || !m || m.role !== 'Guest' || x.id === m.id || !x.email) return x;
  for (const p of projects) if (canSee(p, m) && (p.lead === x.id || (p.members || []).includes(x.id))) return x;
  return { ...x, email: '' };
}

const DENIED = {
  [VIEW]: 'You can only view this project.',
  [COMMENT]: 'You can only comment in this project.',
  [EDIT]: 'Only people with full access can change this project’s settings.',
};
/* The project a record belongs to must exist and the actor needs at least `level` in it. */
function needProject(ctx, pid, level = EDIT) {
  const p = ctx.repo.get('projects', pid);
  if (!p) throw new Reject('That project no longer exists.', 404);
  const have = projectLevel(p, ctx.me);
  if (!have) throw new Reject("You don't have access to that project.");
  if (have < level) throw new Reject(DENIED[have]);
  return p;
}
function needMember(ctx, mid, what = 'person') {
  if (mid == null) return;
  if (!ctx.repo.get('members', mid)) throw new Reject(`That ${what} is no longer in the workspace.`, 400);
}
/* Work can only be assigned to someone who can open the project. */
function needAssignee(ctx, p, mid) {
  if (mid == null) return;
  const m = ctx.repo.get('members', mid);
  if (!m) throw new Reject('That assignee is no longer in the workspace.', 400);
  if (!canSee(p, m)) throw new Reject(`Add ${m.name} to the project first.`, 400);
}
/* Subtask assignees follow the same rule; only newly set ones are checked (unless the task moved),
   so editing a task never trips over an assignment made before. */
function needSubAssignees(ctx, p, t, before = null) {
  const had = new Set((before?.subtasks || []).map(s => `${s.id}:${s.assignee}`));
  for (const s of t.subtasks || []) if (s?.assignee != null && !had.has(`${s.id}:${s.assignee}`)) needAssignee(ctx, p, s.assignee);
}

/* Attachments on a task are rebuilt from the files they point to, so their name, size, type and url
   are the server's, never the client's. Entries without a stored file (older demo records) keep
   their name and get a type from it, a size only if it looks like one, and no url. */
const SIZE_RE = /^\d+(\.\d)? (B|KB|MB)$/;
function settleAttachments(ctx, t) {
  const list = Array.isArray(t.attachments) ? t.attachments : [];
  const ids = JSON.stringify(list.map(a => a?.id));
  const rows = new Map(
    ctx.db
      .all('SELECT id, data, bytes, storage_key FROM files WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))', t.project, ids)
      .map(r => [r.id, r]),
  );
  t.attachments = list.map(a => {
    const row = rows.get(a?.id);
    if (!row) return { id: a?.id, name: a?.name, type: fileType(a?.name), size: SIZE_RE.test(a?.size) ? a.size : '', by: a?.by ?? null, at: a?.at };
    const f = JSON.parse(row.data);
    const size = row.bytes != null ? fsize(row.bytes) : SIZE_RE.test(f.size) ? f.size : '';
    const url = row.storage_key ? { url: `/api/files/${f.id}/${encodeURIComponent(f.name)}` } : {};
    return { id: f.id, name: f.name, type: fileType(f.name), size, by: f.by ?? null, at: f.at, ...url };
  });
}
/* A file can only point at a task in its own project. */
function needFileTask(ctx, f) {
  if (f.task != null && ctx.repo.get('tasks', f.task)?.project !== f.project) throw new Reject('That task no longer exists.', 400);
}

/* A description is checked before it's sanitised: sanitising very long or deeply nested markup is
   slow enough to stall the server. Each request also has a budget of rich text, in characters
   (ctx.richLeft) and in time spent checking and sanitising it (ctx.richMsLeft), so a batch can't
   multiply the cost and a description the checks misjudge can't stall the server for long. Ops past
   the budget are refused with `retry` (the app sends them again in a later request); one that is
   too slow on its own is refused for good. */
const busy = () => Object.assign(new Reject('desc: This batch has too much formatted text. Send it in smaller batches.', 413), { retry: true });
function richDesc(ctx, desc, pid) {
  if (typeof desc === 'string') {
    if (desc.length > ctx.richLeft || ctx.richMsLeft <= 0) {
      ctx.richLeft = 0;
      throw busy();
    }
    ctx.richLeft -= desc.length;
  }
  const fresh = ctx.richMsLeft === RICH_MS_PER_REQUEST;
  const t0 = performance.now();
  let out, err;
  try {
    out = settleDesc(ctx, desc, pid);
  } catch (e) {
    err = e;
  }
  ctx.richMsLeft -= performance.now() - t0;
  // Over the time budget: refused even if it was sanitised (alone in its request: for good).
  if (ctx.richMsLeft < 0 && typeof desc === 'string')
    throw fresh ? new Reject('desc: This description takes too long to process. Simplify its formatting.', 413) : busy();
  if (err) throw err;
  return out;
}
function settleDesc(ctx, desc, pid) {
  const problem = richTextProblem(desc);
  if (!problem) return cleanCheckedRich(desc);
  // A description already stored (it was sanitised then, before nesting was limited) may be copied
  // as it is, e.g. into the next repeat of a task: an old record must not block that.
  if (problem.includes('nested') && ctx.db.get("SELECT 1 FROM tasks WHERE project_id = ? AND json_extract(data, '$.desc') = ? LIMIT 1", pid, desc)) return desc;
  throw new Reject(`desc: ${problem}`, 400);
}

function needEventScope(ctx, pid) {
  if (pid) return needProject(ctx, pid);
  if (!isAdmin(ctx)) throw new Reject('Only admins can change workspace-wide events.');
}
/* An event is `when`: a day (all day) or the UTC instant it starts. `date` and `time` are its day and
   time on the saver's clock, kept for apps from before `when` (they show those). Such an app sends
   only `date` and `time`: they're read on its person's clock (server/lib/clock.js), as the API reads
   them. `changed`: the fields this write changes (none given: a new event). */
function settleEventWhen(ctx, e, changed) {
  const { tz } = clockOf(ctx.repo, ctx.uid);
  const legacy = e.when == null || (changed && !changed.includes('when') && (changed.includes('date') || changed.includes('time')));
  if (legacy) {
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date) || !isCanonical(e.date)) throw new Reject('date: Invalid date', 400);
    const time = e.time ?? '';
    if (typeof time !== 'string' || !/^(([01]\d|2[0-3]):[0-5]\d)?$/.test(time)) throw new Reject('time: Invalid time', 400);
    e.when = time ? fromWallClock(e.date, time, tz) : e.date;
  } else if (changed && !changed.includes('when')) return e;
  if (!isCanonical(e.when)) throw new Reject('when: Invalid date', 400);
  e.date = dayOf(e.when, tz);
  e.time = timeOf(e.when, tz);
  return e;
}

export const HOUR = 3_600_000;
export const INVITES_PER_HOUR = 50;

/* ---------- notifications ---------- */
const clip = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/* "Due 2026-11-09 11:59 PM · High priority": the due on the clock of the person notified. */
const dueSnippet = (ctx, t, uid) => {
  const { tz, time } = clockOf(ctx.repo, uid);
  const due = t.due ? label(t.due, tz, { time }) : '';
  return [due ? `Due ${due}` : null, PR[t.priority] && t.priority !== 'none' ? `${PR[t.priority].name} priority` : 'No priority'].filter(Boolean).join(' · ');
};

/* ---------- task keys ---------- */
/* Task keys are PROJECT-1234567 at most (schemas.js). The project's counter (`seq`) is the server's:
   clients can't set it, and a client's optimistic key is only kept when it doesn't jump past the
   counter, so nobody can push the numbers to the end and stop task creation. */
const MAX_KEY_NUM = 9_999_999;
function keyTaken(ctx, key, id) {
  return !!ctx.db.get("SELECT 1 FROM tasks WHERE json_extract(data, '$.key') = ? AND id != ?", key, id);
}
function bumpSeq(ctx, p, n) {
  if ((p.seq || 0) >= n) return;
  p.seq = n;
  ctx.repo.put('projects', p);
  ctx.emit('projects', p);
}
/* Keep the client's optimistic key when it is free and no higher than the project's next number;
   otherwise take the next number, or once those run out, the lowest free one. */
function settleKey(ctx, t, p) {
  const prefix = p.key + '-';
  const n = +t.key?.slice(prefix.length);
  if (t.key?.startsWith(prefix) && Number.isInteger(n) && n > 0 && n <= Math.min((p.seq || 200) + 1, MAX_KEY_NUM) && !keyTaken(ctx, t.key, t.id))
    return bumpSeq(ctx, p, n);
  const nums = "SELECT CAST(substr(json_extract(data, '$.key'), ?) AS INTEGER) n FROM tasks WHERE json_extract(data, '$.key') LIKE ? AND id != ?";
  const args = [prefix.length + 1, prefix + '%', t.id];
  const top = ctx.db.get(`SELECT MAX(n) n FROM (${nums})`, ...args)?.n || 0;
  const next = Math.max(p.seq || 200, top) + 1;
  if (next <= MAX_KEY_NUM) {
    t.key = prefix + next;
    return bumpSeq(ctx, p, next);
  }
  const free = ctx.db.get(
    `SELECT MIN(n + 1) n FROM (SELECT n FROM (${nums}) UNION SELECT 200) WHERE n + 1 <= ? AND n + 1 NOT IN (SELECT n FROM (${nums}))`,
    ...args,
    MAX_KEY_NUM,
    ...args,
  )?.n;
  if (!free) throw new Reject('This project has run out of task numbers.', 409);
  t.key = prefix + free;
}

function deleteTaskCascade(ctx, t) {
  for (const c of ctx.repo.all('comments', "WHERE json_extract(data, '$.task') = ?", t.id)) {
    ctx.keepDeleted?.('comments', c);
    ctx.repo.del('comments', c.id);
    ctx.emitDel('comments', c.id, c.project ?? t.project);
  }
  for (const o of ctx.repo.all('tasks', "WHERE EXISTS (SELECT 1 FROM json_each(data, '$.deps') WHERE value = ?)", t.id)) {
    o.deps = o.deps.filter(d => d !== t.id);
    ctx.repo.put('tasks', o, o.project);
    ctx.emit('tasks', o);
  }
  // Files stay in the project; they just stop pointing at the task.
  for (const f of ctx.repo.all('files', "WHERE json_extract(data, '$.task') = ?", t.id)) {
    f.task = null;
    ctx.repo.put('files', f, f.project);
    ctx.emit('files', f);
  }
  ctx.db.run("DELETE FROM favorites WHERE kind = 'tasks' AND entity_id = ?", t.id);
}

/* A task moving to another project takes its comments, attached files and activity along. */
function moveTaskRecords(ctx, t, from) {
  for (const c of ['comments', 'files', 'activity'])
    for (const x of ctx.repo.all(c, "WHERE json_extract(data, '$.task') = ?", t.id)) {
      x.project = t.project;
      ctx.repo.put(c, x, t.project);
      ctx.emit(c, x, from);
    }
}

/* Project settings: changing them needs full access (or Owner/Admin). */
const SETTINGS_KEYS = ['members', 'private', 'access', 'perms', 'lead', 'archived', 'archivedAt'];
const validPerms = perms => Object.fromEntries(Object.entries(perms || {}).filter(([, v]) => PERMS.includes(v)));
/* `private` is canonical; `access` mirrors it for the share dialog. Whichever one changed wins. */
function settlePrivacy(p, keys) {
  if (keys.includes('access') && !keys.includes('private') && p.access != null) p.private = p.access === 'private';
  p.private = !!p.private;
  p.access = p.private ? 'private' : 'workspace';
}

function deleteFileRow(ctx, f) {
  const row = ctx.db.get('SELECT storage_key FROM files WHERE id = ?', f.id);
  ctx.repo.del('files', f.id);
  ctx.emitDel('files', f.id, f.project);
  if (row?.storage_key) ctx.blobGc.add(row.storage_key);
}

/* Everything that goes when a person leaves (an admin removes them, or they delete their account);
   the caller deletes the member record itself. */
export function removeMemberCascade(ctx, m) {
  const subOf = "EXISTS (SELECT 1 FROM json_each(data, '$.subtasks') WHERE json_extract(value, '$.assignee') = ?)";
  for (const t of ctx.repo.all('tasks', `WHERE json_extract(data, '$.assignee') = ? OR ${subOf}`, m.id, m.id)) {
    if (t.assignee === m.id) t.assignee = null;
    t.subtasks = (t.subtasks || []).map(s => (s.assignee === m.id ? { ...s, assignee: null } : s));
    ctx.repo.put('tasks', t, t.project);
    ctx.emit('tasks', t);
  }
  const listed = "EXISTS (SELECT 1 FROM json_each(data, '$.members') WHERE value = ?)";
  for (const p of ctx.repo.all('projects', `WHERE json_extract(data, '$.lead') = ? OR ${listed}`, m.id, m.id)) {
    p.members = (p.members || []).filter(x => x !== m.id);
    if (p.perms) delete p.perms[m.id];
    if (p.lead === m.id) p.lead = null;
    ctx.repo.put('projects', p);
    ctx.emit('projects', p);
  }
  ctx.removedUsers.push(m.id);
  // Sessions take their push subscriptions with them; devices go with the user row.
  for (const t of ['sessions', 'favorites', 'user_state', 'notifications', 'push_subscriptions', 'recent_deletes'])
    ctx.db.run(`DELETE FROM ${t} WHERE user_id = ?`, m.id);
  // Their deleted comments kept for someone else's Undo go too, so nothing they wrote outlives them there.
  ctx.db.run("DELETE FROM recent_deletes WHERE json_extract(data, '$.by') = ?", m.id);
  ctx.db.run('DELETE FROM users WHERE id = ?', m.id);
  ctx.db.run('UPDATE auth_tokens SET used_at = ? WHERE (email = ? OR user_id = ?) AND used_at IS NULL', ctx.now, m.email, m.id);
}

export const RULES = {
  tasks: {
    scope: v => v.project,
    personal: ['fav'],
    // When it was finished, where it was before, and the links between repeats (task-status.js).
    serverOwned: LIFECYCLE,
    create(ctx, t) {
      const p = needProject(ctx, t.project);
      needAssignee(ctx, p, t.assignee);
      needSubAssignees(ctx, p, t);
      t.desc = richDesc(ctx, t.desc, t.project);
      settleAttachments(ctx, t);
      settleKey(ctx, t, p);
      createdStatus(ctx, t);
      if (t.assignee) notify(ctx, t.assignee, 'assign', { type: 'assign', task: t.id, text: 'assigned you', snippet: dueSnippet(ctx, t, t.assignee) }, t);
      return t;
    },
    update(ctx, before, t, keys) {
      const from = needProject(ctx, before.project);
      // Moving needs edit rights in both projects.
      const moved = keys.includes('project');
      const p = moved ? needProject(ctx, t.project) : from;
      // A key only changes when the task moves to another project.
      if (moved) settleKey(ctx, t, p);
      else if (keys.includes('key')) t.key = before.key;
      if (moved || keys.includes('assignee')) needAssignee(ctx, p, t.assignee);
      if (moved || keys.includes('subtasks')) needSubAssignees(ctx, p, t, moved ? null : before);
      if (keys.includes('desc')) t.desc = richDesc(ctx, t.desc, t.project);
      if (moved) moveTaskRecords(ctx, t, before.project);
      // Every save re-checks attachments, so older records with foreign links heal too.
      settleAttachments(ctx, t);
      if (keys.includes('assignee')) {
        if (t.assignee) notify(ctx, t.assignee, 'assign', { type: 'assign', task: t.id, text: 'assigned you', snippet: dueSnippet(ctx, t, t.assignee) }, t);
      }
      if (keys.includes('status')) settleStatus(ctx, before, t, { create: RULES.tasks.create, cascade: deleteTaskCascade });
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
    /* Undo of a delete, from the server's copy: the same access as creating it, but nobody is told
       again. An assignee who can no longer open the project is dropped; a key taken meanwhile moves on. */
    restore(ctx, t) {
      const p = needProject(ctx, t.project);
      if (t.assignee != null && !canSee(p, ctx.repo.get('members', t.assignee))) t.assignee = null;
      t.subtasks = (t.subtasks || []).map(s => (s.assignee != null && !canSee(p, ctx.repo.get('members', s.assignee)) ? { ...s, assignee: null } : s));
      settleAttachments(ctx, t);
      if (keyTaken(ctx, t.key, t.id)) {
        t.key = null;
        settleKey(ctx, t, p);
      }
      return t;
    },
  },

  projects: {
    personal: ['fav'],
    // `seq` is the task-key counter, moved on only by settleKey.
    serverOwned: ['key', 'last', 'seq'],
    create(ctx, p) {
      notGuest(ctx, 'create projects');
      delete p.seq;
      needMember(ctx, p.lead, 'project lead');
      while (ctx.db.get("SELECT 1 FROM projects WHERE json_extract(data, '$.key') = ?", p.key)) p.key += 'X';
      p.members = [...new Set([ctx.uid, ...(p.members || [])])].filter(m => ctx.repo.get('members', m));
      p.perms = { ...validPerms(p.perms), [ctx.uid]: 'Full access' };
      settlePrivacy(p, 'private' in p ? ['private'] : ['access']);
      p.last = 0;
      return p;
    },
    update(ctx, before, p, keys) {
      const settings = keys.filter(k => SETTINGS_KEYS.includes(k));
      if (settings.length < keys.length) needProject(ctx, before.id);
      if (settings.length && !canManageProject(before, ctx.me))
        throw new Reject(canSee(before, ctx.me) ? DENIED[EDIT] : "You don't have access to that project.");
      if (keys.includes('lead')) needMember(ctx, p.lead, 'project lead');
      if (keys.includes('members')) p.members = [...new Set(p.members)].filter(m => ctx.repo.get('members', m));
      if (keys.includes('perms')) p.perms = validPerms(p.perms);
      settlePrivacy(p, keys);
      // People gaining or losing sight of the project need its tasks, files and comments re-sent.
      if (settings.length) for (const m of ctx.repo.all('members')) if (canSee(before, m) !== canSee(p, m)) ctx.resync.add(m.id);
      return p;
    },
    remove(ctx, p) {
      if (!canManageProject(p, ctx.me)) throw new Reject('Only admins and people with full access can delete a project.');
      for (const t of ctx.repo.all('tasks', 'WHERE project_id = ?', p.id)) {
        deleteTaskCascade(ctx, t);
        ctx.repo.del('tasks', t.id);
        ctx.emitDel('tasks', t.id, p.id);
      }
      for (const f of ctx.repo.all('files', 'WHERE project_id = ?', p.id)) deleteFileRow(ctx, f);
      for (const c of ['events', 'savedViews', 'activity'])
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
      needProject(ctx, t.project, COMMENT);
      cm.by = ctx.uid;
      cm.at = ctx.now;
      // Reactions are added afterwards, each by the person reacting.
      cm.re = {};
      cm.project = t.project;
      const reached = mentioned(ctx.repo, cm.text);
      for (const [id, reason] of reached) notify(ctx, id, reason, { type: 'mention', task: t.id, text: 'mentioned you in', snippet: clip(cm.text) });
      if (t.assignee && !reached.has(t.assignee))
        notify(ctx, t.assignee, 'comment', { type: 'comment', task: t.id, text: 'commented on', snippet: clip(cm.text) });
      return cm;
    },
    update(ctx, before, cm, keys) {
      needProject(ctx, before.project, COMMENT);
      cm.by = before.by;
      cm.task = before.task;
      cm.project = before.project;
      // The author may change the text; everyone (the author too) may only add or remove their own
      // reactions. Who wrote it and when stay the server's.
      const mine = (a = {}, b = {}) =>
        [...new Set([...Object.keys(a), ...Object.keys(b)])].every(e => {
          const x = new Set(a[e] || []),
            y = new Set(b[e] || []);
          return [...x].every(i => y.has(i) || i === ctx.uid) && [...y].every(i => x.has(i) || i === ctx.uid);
        });
      const editable = before.by === ctx.uid ? ['text', 're'] : ['re'];
      if (keys.some(k => !editable.includes(k))) throw new Reject('You can only edit your own comments.');
      if (!mine(before.re, cm.re)) throw new Reject('You can only add or remove your own reactions.');
      return cm;
    },
    remove(ctx, cm) {
      if (cm.project) needProject(ctx, cm.project, COMMENT);
      if (cm.by !== ctx.uid && !isAdmin(ctx)) throw new Reject('You can only delete your own comments.');
    },
    /* Undo of a delete, from the server's copy: its author, time and reactions stay, and nobody is
       notified again. The task must still exist and the person may still comment there. */
    restore(ctx, cm) {
      const t = ctx.repo.get('tasks', cm.task);
      if (!t) throw new Reject('That task no longer exists.', 404);
      needProject(ctx, t.project, COMMENT);
      cm.project = t.project;
      return cm;
    },
  },

  activity: {
    scope: v => v.project,
    create(ctx, a) {
      // Workspace-wide entries (no project) are only written by the server itself.
      if (!a.project) throw new Reject('Activity has to belong to a project.', 400);
      // Commenting logs an entry too, so people who can only comment may log that.
      needProject(ctx, a.project, a.verb === 'commented on' ? COMMENT : EDIT);
      a.by = ctx.uid;
      if (!(Math.abs(a.at - ctx.now) < 5 * 60_000)) a.at = ctx.now;
      // "Ada via Claude": set by the server from the API key or client, never taken from the record.
      if (ctx.via) a.via = ctx.via;
      else delete a.via;
      return a;
    },
    update() {
      throw new Reject('Activity history is read-only.');
    },
    remove(ctx, a) {
      // An undo removes the entry its action logged; nobody else's history can be rewritten.
      if (a.by !== ctx.uid || !a.project) throw new Reject('Activity history is read-only.');
      needProject(ctx, a.project, COMMENT);
    },
  },

  members: {
    // `kind` ('bot' for bot members) is only ever set by /api/bots.
    serverOwned: ['email', 'status', 'last', 'kind'],
    create(ctx, m) {
      notGuest(ctx, 'invite people');
      delete m.kind;
      m.email = m.email.trim().toLowerCase();
      if (ctx.db.get("SELECT 1 FROM members WHERE lower(json_extract(data, '$.email')) = ?", m.email))
        throw new Reject(`${m.email} is already in the workspace.`, 409);
      if (!ctx.limit(`invite:${ctx.uid}`, INVITES_PER_HOUR, HOUR)) throw new Reject('You’ve sent a lot of invites. Try again in an hour.', 429);
      if (m.role === 'Owner' || (m.role === 'Admin' && !isAdmin(ctx))) m.role = 'Member';
      m.status = 'invited';
      m.last = null;
      const ws = ctx.repo.workspace();
      const link = issueToken(ctx.db, ctx.config, 'invite', m.email);
      ctx.mailer.queue({
        to: m.email,
        subject: `${ctx.me.name} invited you to ${ws?.name || 'Sudo Sapient'}`,
        intro: `${ctx.me.name} invited you to join ${ws?.name || 'their workspace'} on Sudo Sapient.`,
        action: 'Accept invite',
        link,
        outro: 'The invite expires in 14 days.',
      });
      ctx.links.push(link);
      return m;
    },
    update(ctx, before, m, keys) {
      // A bot's name and role change in Settings → API → Bots, which keeps it a Member or Guest.
      if (before.kind === 'bot') throw new Reject('Manage bots in Settings → API → Bots.');
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
        // Becoming or leaving Admin changes which project settings they receive.
        if (before.role === 'Guest' || m.role === 'Guest' || isAdminRole(before) !== isAdminRole(m)) ctx.resync.add(m.id);
        if ((m.role === 'Owner' || before.role === 'Owner') && ctx.me.role !== 'Owner') throw new Reject('Only an owner can change who owns the workspace.');
        // Against the members as they are in this transaction, so concurrent changes can't leave none.
        if (before.role === 'Owner' && m.role !== 'Owner' && !ctx.repo.all('members').some(x => x.id !== m.id && x.role === 'Owner'))
          throw new Reject('The workspace needs at least one owner.');
        // Only Owners and Admins may make the join link, so one made by someone who no longer is stops working.
        if (isAdminRole(before) && !isAdminRole(m))
          ctx.db.run("UPDATE auth_tokens SET used_at = ? WHERE kind = 'join' AND user_id = ? AND used_at IS NULL", ctx.now, before.id);
      }
      return m;
    },
    remove(ctx, m) {
      if (!isAdmin(ctx)) throw new Reject('Only admins can remove people.');
      if (m.id === ctx.uid) throw new Reject("You can't remove yourself.");
      if (m.role === 'Owner') throw new Reject("The workspace owner can't be removed.");
      removeMemberCascade(ctx, m);
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
      needFileTask(ctx, f);
      f.by = ctx.uid;
      f.url = `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
      // Type and size describe the stored bytes, not what the client says.
      f.type = fileType(f.name);
      f.size = fsize(src.bytes || 0);
      ctx.afterPut.push(() => ctx.db.run('UPDATE files SET storage_key = ?, mime = ?, bytes = ? WHERE id = ?', src.storage_key, src.mime, src.bytes, f.id));
      return f;
    },
    update(ctx, before, f, keys) {
      needProject(ctx, before.project);
      if (keys.some(k => !['name', 'type', 'task', 'url'].includes(k))) throw new Reject('Only a file’s name can be changed.', 400);
      if (keys.includes('task')) needFileTask(ctx, f);
      f.url = `/api/files/${f.id}/${encodeURIComponent(f.name)}`;
      f.type = fileType(f.name);
      return f;
    },
    remove(ctx, f) {
      needProject(ctx, f.project);
      const row = ctx.db.get('SELECT storage_key FROM files WHERE id = ?', f.id);
      if (row?.storage_key) ctx.blobGc.add(row.storage_key);
    },
  },

  // Project events need edit rights there; workspace-wide ones (no project) are for admins.
  events: {
    scope: v => v.project,
    create(ctx, e) {
      needEventScope(ctx, e.project);
      return settleEventWhen(ctx, e);
    },
    update(ctx, b, e, changed) {
      needEventScope(ctx, b.project);
      if (e.project !== b.project) needEventScope(ctx, e.project);
      return settleEventWhen(ctx, e, changed);
    },
    remove(ctx, e) {
      needEventScope(ctx, e.project);
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
