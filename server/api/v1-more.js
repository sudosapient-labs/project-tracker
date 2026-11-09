/* The rest of /api/v1: everything else a person can do in the app (projects and sharing, teams,
   people, bots, files, events, saved views, notifications, favourites, preferences, the workspace
   and its activity). Like v1.js, each write builds the records and activity lines the app itself
   would send (src/actions/*.js) and runs them through engine.apply in atomic mode, so validation,
   permissions, notifications, emails and live updates are the app's. The few things the app does
   outside sync (uploads, invite links, resending invites, access requests, bots, display
   preferences) call the same server functions as the app's own routes.

   `h` carries v1.js's route table and helpers. */
import { PCOLORS, PSTAT, validTz } from '../../src/core/constants.js';
import { EDIT, canSeeProject, projectLevel } from '../../src/core/access.js';
import { newId } from '../lib/crypto.js';
import { RESTORE_MS } from '../sync/engine.js';
import { HOUR, INVITES_PER_HOUR, projectFor } from '../sync/rules.js';
import { DEFAULT_NOTIF_PREFS } from '../notify.js';
import { saveState } from '../routes/data.js';
import { makeInviteLink, requestAccess, resendInvite } from '../routes/workspace.js';
import { MAX_BOTS, createBot, getBot, listBots, updateBot } from './bots.js';
import { revokeKey } from './keys.js';
import * as S from './schemas.js';
import { dayOf, fromWallClock, instant } from '../../packages/client/dates.js';

export function registerMore(h) {
  const {
    route,
    ok,
    ApiFail,
    notFound,
    findProject,
    findTask,
    findMember,
    counts,
    write,
    actOp,
    pageOf,
    needAdmin,
    encodeCursor,
    decodeCursor,
    whenFields,
    clockOf,
    memberClock,
    zoneView,
  } = h;
  // Today on the caller's calendar (clockOf in v1.js), not UTC's.
  const today = x => dayOf(Date.now(), clockOf(x).tz);
  /* One use of a budget the app's own routes share (same key, size and message), refused with
     Retry-After as the app's limiter does. */
  const spend = (key, n, message) => {
    if (!h.limit.hit(key, n, HOUR)) throw new ApiFail(429, message, 'rate_limited', undefined, h.limit.blocked(key, n));
  };
  const put = (c, v, extra = {}) => ({ c, id: v.id, k: 'put', v, ...extra });
  const patchOp = (c, id, v, base) => ({ c, id, k: 'patch', v, ...(base ? { base } : {}) });
  const del = (c, id) => ({ c, id, k: 'del' });
  /* An activity line not about a task (the app logs these for projects). */
  const projectAct = (x, p, verb, extra = '') => {
    const id = newId('a');
    return put('activity', { id, by: x.me.id, verb, task: null, project: p.id, at: Date.now(), extra });
  };
  /* Keyset pages over a table, newest first (`created_at`, then id). */
  function newest(x, sql, args, q) {
    const where = [];
    if (q.cursor) {
      const k = decodeCursor(q.cursor);
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      args = [...args, k.at, k.at, k.id];
    }
    const n = q.limit || 50;
    const rows = x.db.all(`${sql}${where.length ? ` AND ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, n + 1);
    const page = rows.slice(0, n);
    return { rows: page.map(r => JSON.parse(r.data)), nextCursor: rows.length > n ? encodeCursor(page.at(-1).created_at, page.at(-1).id) : null };
  }
  const visibleIds = x => JSON.stringify(x.visible.map(p => p.id));
  /* The sidebar order as the app has it (sync/bootstrap.js): projects this person hasn't placed
     first, newest on top, then the order they saved. Saving the order sends the whole list, so it
     starts from this, never from the saved part alone (that would leave the open app showing only
     what's in it). */
  const sidebarOrder = x => {
    const ids = x.projects.filter(p => projectFor(p, x.me)).map(p => p.id);
    const known = x.repo.userState(x.me.id).projOrder.filter(id => ids.includes(id));
    return [...ids.filter(id => !known.includes(id)).reverse(), ...known];
  };

  /* ---------- projects ---------- */
  /* A project whose settings this person may manage or at least see: one they can open, or for an
     Owner or Admin any project (Admin recovery), which they then see as the app shows it to them. */
  const findManaged = (x, ref, field = 'ref') => {
    const up = String(ref).toUpperCase();
    const p = x.projects.find(p => p.id === ref || p.key === up);
    if (!p || !(canSeeProject(p, x.me) || x.admin)) throw notFound('project', field);
    return p;
  };
  const projectView = (x, p) => (canSeeProject(p, x.me) ? x.V.project(p, counts(x)) : x.V.project(projectFor(p, x.me)));
  const reread = (x, p) => projectView(x, x.repo.get('projects', p.id));
  const findTeam = (x, ref, field = 'team') => {
    const t = x.repo.get('teams', ref) || x.repo.all('teams').find(t => t.name.toLowerCase() === String(ref).toLowerCase());
    if (!t) throw new ApiFail(400, `No team matches “${ref}”.`, 'invalid_request', field);
    return t;
  };
  /* The app's key for a new project: initials of its name (or its first letters), unique. */
  const makeKey = (x, name) => {
    let k =
      name
        .split(/\s+/)
        .map(w => w[0] || '')
        .join('')
        .toUpperCase()
        .replace(/[^A-Z]/g, '') || '';
    if (k.length < 2)
      k =
        name
          .replace(/[^A-Za-z]/g, '')
          .slice(0, 3)
          .toUpperCase() || 'PRJ';
    k = k.slice(0, 8);
    while (x.projects.some(p => p.key === k)) k += 'X';
    return k;
  };
  const milestones = list => (list || []).map(m => ({ name: m.name, date: m.date ?? null }));
  /* The fields of a project create or update, as the record stores them. */
  function projectFields(x, b) {
    const f = {};
    if (b.name !== undefined) f.name = b.name;
    if (b.description !== undefined) f.desc = b.description;
    if (b.icon !== undefined) f.icon = b.icon;
    if (b.color !== undefined) f.color = b.color;
    if (b.status !== undefined) f.status = b.status;
    if (b.lead !== undefined) f.lead = b.lead === null ? null : findMember(x, b.lead, 'lead').id;
    if (b.team !== undefined) f.team = b.team === null ? '' : findTeam(x, b.team).id;
    if (b.start !== undefined) f.start = b.start;
    if (b.due !== undefined) f.due = b.due;
    if (b.private !== undefined) {
      f.private = b.private;
      f.access = b.private ? 'private' : 'workspace';
    }
    if (b.milestones !== undefined) f.milestones = milestones(b.milestones);
    return f;
  }

  route('post', '/projects', {
    id: 'createProject',
    tag: 'Projects',
    summary: 'Create a project',
    description: 'You’re listed on it with Full access; the lead defaults to you.',
    body: S.ProjectCreate,
    ok: ok(S.Project, 201),
    run: (x, { body: b }) => {
      const f = projectFields(x, b);
      const lead = f.lead === undefined ? x.me.id : f.lead;
      const listed = (b.members || []).map(e => ({ id: findMember(x, e.member, 'members').id, permission: e.permission }));
      const p = {
        id: newId('p'),
        key: b.key ? b.key.toUpperCase() : makeKey(x, b.name),
        name: b.name,
        icon: 'folder',
        color: 'indigo',
        status: 'planning',
        team: '',
        due: null,
        start: today(x),
        desc: '',
        milestones: [],
        ...f,
        lead,
        members: [...new Set([x.me.id, lead, ...listed.map(l => l.id)].filter(Boolean))],
        perms: Object.fromEntries(listed.filter(l => l.permission).map(l => [l.id, l.permission])),
        private: !!f.private,
        last: 0,
      };
      const order = sidebarOrder(x);
      const [saved] = write(x, [put('projects', p), projectAct(x, p, 'created project'), { c: 'projOrder', k: 'put', v: [p.id, ...order] }]);
      x.projects.push(saved);
      return x.V.project(saved, counts(x));
    },
  });

  route('patch', '/projects/{ref}', {
    id: 'updateProject',
    tag: 'Projects',
    summary: 'Change a project; only the fields sent change',
    description: 'Lead and privacy need Full access (or an Owner/Admin). `milestones` replaces the whole list.',
    params: S.RefParam,
    body: S.ProjectUpdate,
    ok: ok(S.Project),
    run: (x, { params, body }) => {
      const p = findManaged(x, params.ref);
      const f = projectFields(x, body);
      for (const k of Object.keys(f)) if (JSON.stringify(f[k] ?? null) === JSON.stringify(p[k] ?? null)) delete f[k];
      if (f.access && !('private' in f)) delete f.access;
      if (!Object.keys(f).length) return projectView(x, p);
      const ops = [];
      // A new lead is listed on the project too, as the app's edit dialog does.
      if (f.lead && !(p.members || []).includes(f.lead))
        ops.push(patchOp('projects', p.id, { ...f, members: [...(p.members || []), f.lead] }, { members: p.members || [] }));
      else ops.push(patchOp('projects', p.id, f));
      if (f.status) ops.push(projectAct(x, p, 'changed status of project', `to ${PSTAT[f.status].name}`));
      write(x, ops, { desc: 'description' });
      return reread(x, p);
    },
  });

  const archiveProject =
    on =>
    (x, { params }) => {
      const p = findManaged(x, params.ref);
      if (!!p.archived === on) return projectView(x, p);
      write(x, [patchOp('projects', p.id, { archived: on, archivedAt: on ? Date.now() : null })]);
      return reread(x, p);
    };
  route('post', '/projects/{ref}/archive', {
    id: 'archiveProject',
    tag: 'Projects',
    summary: 'Archive a project (hidden from lists; its work is kept)',
    params: S.RefParam,
    ok: ok(S.Project),
    run: archiveProject(true),
  });
  route('post', '/projects/{ref}/restore', {
    id: 'restoreProject',
    tag: 'Projects',
    summary: 'Restore an archived project',
    params: S.RefParam,
    ok: ok(S.Project),
    run: archiveProject(false),
  });

  route('delete', '/projects/{ref}', {
    id: 'deleteProject',
    tag: 'Projects',
    summary: 'Delete a project with its tasks, comments, files, events and saved views, for everyone',
    description: 'Needs Full access (or an Owner/Admin). This can’t be undone.',
    params: S.RefParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const p = findManaged(x, params.ref);
      const placed = x.repo.userState(x.me.id).projOrder.includes(p.id);
      const order = sidebarOrder(x).filter(id => id !== p.id);
      write(x, [del('projects', p.id), ...(placed ? [{ c: 'projOrder', k: 'put', v: order }] : [])]);
      return { deleted: true, id: p.id };
    },
  });

  route('post', '/projects/{ref}/duplicate', {
    id: 'duplicateProject',
    tag: 'Projects',
    summary: 'Copy a project and its tasks (as To Do), as the app’s Duplicate does',
    params: S.RefParam,
    ok: ok(S.Project, 201),
    run: (x, { params }) => {
      const src = findProject(x, params.ref, 'ref');
      const n = {
        id: newId('p'),
        key: makeKey(x, `${src.name} copy`),
        name: `${src.name} copy`.slice(0, 120),
        icon: src.icon,
        color: src.color,
        status: 'planning',
        team: src.team || '',
        lead: src.lead ?? null,
        due: src.due ?? null,
        start: today(x),
        members: [...new Set([x.me.id, src.lead].filter(Boolean))],
        desc: src.desc || '',
        milestones: [],
        // A copy of a private project stays private, so copying can't open its work to everyone.
        private: !!src.private,
        last: 0,
      };
      // Assignees who couldn't open the copy are left off (the app would have the change refused).
      const copy = { ...n, perms: { [x.me.id]: 'Full access' } };
      const canOpen = id => id == null || canSeeProject(copy, x.repo.get('members', id));
      const tasks = x.repo.all('tasks', 'WHERE project_id = ? ORDER BY created_at, rowid', src.id).filter(t => !t.archived);
      const ids = new Map(tasks.map(t => [t.id, newId('t')]));
      const now = Date.now();
      const ops = [put('projects', n), projectAct(x, n, 'created project')];
      // In the original's order, after every task there is (as the app's copies are).
      const first = h.newTask(x, { title: '' }).order;
      for (const [i, t] of tasks.entries()) {
        const base = h.newTask(x, { ...t, project: n.id, status: 'todo', attachments: [] }, first + i);
        const c = {
          ...base,
          id: ids.get(t.id),
          assignee: canOpen(t.assignee) ? (t.assignee ?? null) : null,
          subtasks: (t.subtasks || []).map(s => (canOpen(s.assignee) ? s : { ...s, assignee: null })),
          deps: (t.deps || []).map(d => ids.get(d)).filter(Boolean),
          created: now,
          updated: now,
        };
        ops.push(put('tasks', c), actOp(x, c, 'created'));
      }
      ops.push({ c: 'projOrder', k: 'put', v: [n.id, ...sidebarOrder(x)] });
      let saved;
      try {
        [saved] = write(x, ops);
      } catch (e) {
        // One request has a budget of formatted text to check (sync/budget.js); the app sends a big
        // copy in several requests, but a request here is all or nothing.
        if (e.status === 413)
          throw new ApiFail(413, 'This project’s tasks have too much formatted text to copy in one request. Duplicate it in the app.', 'too_large');
        throw e;
      }
      return x.V.project(saved, counts(x));
    },
  });

  route('put', '/projects/{ref}/members/{member}', {
    id: 'shareProject',
    tag: 'Projects',
    summary: 'List someone on a project, or change their permission',
    description: 'As the share dialog does; needs Full access (or an Owner/Admin).',
    params: S.ProjectMemberParams,
    body: S.ProjectShare,
    ok: ok(S.Project),
    run: (x, { params, body }) => {
      const p = findManaged(x, params.ref);
      const m = findMember(x, params.member, 'member');
      const members = p.members || [];
      const perms = { ...(p.perms || {}) };
      if (body.permission) perms[m.id] = body.permission;
      const v = { members: members.includes(m.id) ? members : [...members, m.id], perms };
      if (JSON.stringify(v.members) === JSON.stringify(members) && JSON.stringify(perms) === JSON.stringify(p.perms || {})) return projectView(x, p);
      write(x, [patchOp('projects', p.id, v, { members, perms: p.perms || {} })]);
      return reread(x, p);
    },
  });

  route('delete', '/projects/{ref}/members/{member}', {
    id: 'unshareProject',
    tag: 'Projects',
    summary: 'Take someone off a project',
    description: 'On a private project they lose access (unless they lead it). Needs Full access (or an Owner/Admin).',
    params: S.ProjectMemberParams,
    ok: ok(S.Project),
    run: (x, { params }) => {
      const p = findManaged(x, params.ref);
      const m = findMember(x, params.member, 'member');
      const members = p.members || [];
      if (!members.includes(m.id) && !p.perms?.[m.id]) return projectView(x, p);
      const { [m.id]: _gone, ...perms } = p.perms || {};
      write(x, [patchOp('projects', p.id, { members: members.filter(id => id !== m.id), perms }, { members, perms: p.perms || {} })]);
      return reread(x, p);
    },
  });

  route('post', '/projects/{ref}/request-access', {
    id: 'requestProjectAccess',
    tag: 'Projects',
    summary: 'Ask the lead of a project you can’t open to add you',
    description: 'Answers the same whether or not the project exists, and names nobody.',
    params: S.RefParam,
    ok: ok(S.Ok),
    run: (x, { params }) => {
      const up = params.ref.toUpperCase();
      // By key only where the person gets the project's locked card (Guests get nothing, so they
      // can't guess keys); by id, like the app.
      const p = x.projects.find(p => p.id === params.ref || (p.key === up && projectFor(p, x.me))) || null;
      spend(`request-access:${x.me.id}:${p?.id || up}`, 3, 'You already asked for access. Give the lead a little time to respond.');
      requestAccess(x.c.var, x.me, p);
      return { ok: true };
    },
  });

  route('put', '/projects/{ref}/favorite', {
    id: 'favoriteProject',
    tag: 'Projects',
    summary: 'Star a project (for the key’s person only)',
    params: S.RefParam,
    ok: ok(S.Project),
    run: (x, { params }) => setFav(x, 'projects', findProject(x, params.ref, 'ref'), true),
  });
  route('delete', '/projects/{ref}/favorite', {
    id: 'unfavoriteProject',
    tag: 'Projects',
    summary: 'Unstar a project',
    params: S.RefParam,
    ok: ok(S.Project),
    run: (x, { params }) => setFav(x, 'projects', findProject(x, params.ref, 'ref'), false),
  });
  function setFav(x, c, rec, on) {
    if (x.favorites()[c].has(rec.id) !== on) {
      write(x, [patchOp(c, rec.id, { fav: on })]);
      x.resetFavorites();
    }
    const now = x.repo.get(c, rec.id);
    return c === 'tasks' ? x.V.task(now) : x.V.project(now, counts(x));
  }

  /* ---------- tasks: delete, undelete, duplicate, subtasks, favourites ---------- */
  /* Undelete is for records that are gone: one still there would be replaced by the restore. */
  const notDeleted = (x, c, id, what) => {
    if (x.repo.get(c, id)) throw new ApiFail(409, `That ${what} isn’t deleted.`, 'conflict', 'id');
  };
  route('delete', '/tasks/{ref}', {
    id: 'deleteTask',
    tag: 'Tasks',
    summary: 'Delete a task and its comments',
    description: 'Its files stay in the project. The same key can undo it with POST /tasks/{id}/undelete for 10 minutes.',
    params: S.RefParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const t = findTask(x, params.ref);
      write(x, [del('tasks', t.id)]);
      return { deleted: true, id: t.id, restoreUntil: Date.now() + RESTORE_MS };
    },
  });

  route('post', '/tasks/{id}/undelete', {
    id: 'undeleteTask',
    tag: 'Tasks',
    summary: 'Undo deleting a task (within 10 minutes, by whoever deleted it)',
    description: 'Puts it back as it was, with its key, comments and reactions, and notifies nobody again (the app’s Undo).',
    params: S.IdParam,
    ok: ok(S.Task),
    run: (x, { params }) => {
      notDeleted(x, 'tasks', params.id, 'task');
      const since = Date.now() - RESTORE_MS;
      const comments = x.db
        .all(
          "SELECT id FROM recent_deletes WHERE coll = 'comments' AND user_id = ? AND deleted_at >= ? AND json_extract(data, '$.task') = ?",
          x.me.id,
          since,
          params.id,
        )
        .map(r => put('comments', { id: r.id }, { restore: true }));
      const [t] = write(x, [put('tasks', { id: params.id }, { restore: true }), ...comments]);
      return x.V.task(x.repo.get('tasks', t.id));
    },
  });

  route('post', '/tasks/{ref}/duplicate', {
    id: 'duplicateTask',
    tag: 'Tasks',
    summary: 'Copy a task (title + “ (copy)”), as the app’s Duplicate does',
    params: S.RefParam,
    ok: ok(S.Task, 201),
    run: (x, { params }) => {
      const t = findTask(x, params.ref);
      const now = Date.now();
      // A copy starts its own lifecycle: the server sets when it was finished and drops the links between repeats.
      const { fav, ...rest } = t;
      const n = { ...h.newTask(x, rest), ...rest, id: newId('t'), title: `${t.title} (copy)`.slice(0, 500), created: now, updated: now };
      delete n.key;
      const [saved] = write(x, [put('tasks', n), actOp(x, n, 'created')]);
      return x.V.task(saved);
    },
  });

  route('put', '/tasks/{ref}/favorite', {
    id: 'favoriteTask',
    tag: 'Tasks',
    summary: 'Star a task (for the key’s person only)',
    params: S.RefParam,
    ok: ok(S.Task),
    run: (x, { params }) => setFav(x, 'tasks', findTask(x, params.ref), true),
  });
  route('delete', '/tasks/{ref}/favorite', {
    id: 'unfavoriteTask',
    tag: 'Tasks',
    summary: 'Unstar a task',
    params: S.RefParam,
    ok: ok(S.Task),
    run: (x, { params }) => setFav(x, 'tasks', findTask(x, params.ref), false),
  });

  /* Subtasks are one list on the task. Each change is sent with the list it was made from, so the
     server applies only that change, never undoing someone else's edit to another subtask. */
  const findSub = (t, id) => {
    const s = (t.subtasks || []).find(s => s.id === id);
    if (!s) throw new ApiFail(404, 'No subtask with that id on this task.', 'not_found', 'id');
    return s;
  };
  const subWrite = (x, t, list, acts) =>
    x.V.task(
      write(x, [
        patchOp('tasks', t.id, { subtasks: list, updated: Date.now() }, { subtasks: t.subtasks || [] }),
        ...acts.map(([verb, extra]) => actOp(x, t, verb, extra)),
      ])[0],
    );
  const subChanges = (x, s, b) => {
    const next = { ...s };
    const acts = [];
    if (b.title !== undefined) next.title = b.title;
    if (b.done !== undefined && !!b.done !== !!s.done) {
      next.done = b.done;
      acts.push([b.done ? 'completed subtask on' : 'reopened subtask on', `“${next.title}”`]);
    }
    if (b.assignee !== undefined) {
      const m = b.assignee === null ? null : findMember(x, b.assignee, 'assignee');
      if ((s.assignee ?? null) !== (m?.id ?? null)) {
        next.assignee = m?.id ?? null;
        acts.push(['assigned a subtask on', m ? `to ${m.name}` : '(unassigned)']);
      }
    }
    if (b.due !== undefined && (s.due ?? null) !== b.due) {
      next.due = b.due;
      acts.push(['set a subtask due date on', whenFields(x, 'set a subtask due date on', b.due)]);
    }
    return { next, acts };
  };

  route('post', '/tasks/{ref}/subtasks', {
    id: 'addSubtask',
    tag: 'Tasks',
    summary: 'Add a subtask',
    params: S.RefParam,
    body: S.SubtaskCreate,
    ok: ok(S.Task, 201),
    run: (x, { params, body }) => {
      const t = findTask(x, params.ref);
      const blank = { id: newId('s'), title: body.title, done: false };
      const { next, acts } = subChanges(x, blank, { ...body, title: undefined });
      return subWrite(x, t, [...(t.subtasks || []), next], [['added subtask to', `“${body.title}”`], ...acts.filter(([v]) => v !== 'reopened subtask on')]);
    },
  });

  route('patch', '/tasks/{ref}/subtasks/{id}', {
    id: 'updateSubtask',
    tag: 'Tasks',
    summary: 'Change a subtask (title, done, assignee, due)',
    params: S.SubtaskParams,
    body: S.SubtaskUpdate,
    ok: ok(S.Task),
    run: (x, { params, body }) => {
      const t = findTask(x, params.ref);
      const s = findSub(t, params.id);
      const { next, acts } = subChanges(x, s, body);
      if (JSON.stringify(next) === JSON.stringify(s)) return x.V.task(t);
      return subWrite(
        x,
        t,
        t.subtasks.map(y => (y.id === s.id ? next : y)),
        acts,
      );
    },
  });

  route('delete', '/tasks/{ref}/subtasks/{id}', {
    id: 'deleteSubtask',
    tag: 'Tasks',
    summary: 'Remove a subtask',
    params: S.SubtaskParams,
    ok: ok(S.Task),
    run: (x, { params }) => {
      const t = findTask(x, params.ref);
      const s = findSub(t, params.id);
      return subWrite(
        x,
        t,
        t.subtasks.filter(y => y.id !== s.id),
        [],
      );
    },
  });

  route('post', '/tasks/{ref}/subtasks/{id}/promote', {
    id: 'promoteSubtask',
    tag: 'Tasks',
    summary: 'Turn a subtask into a task of its own in the same project',
    params: S.SubtaskParams,
    ok: ok(S.Task, 201),
    run: (x, { params }) => {
      const t = findTask(x, params.ref);
      const s = findSub(t, params.id);
      const p = x.repo.get('projects', t.project);
      const n = h.newTask(x, {
        project: t.project,
        title: s.title,
        status: s.done ? 'done' : 'todo',
        assignee: s.assignee || t.assignee || null,
        priority: t.priority,
        due: s.due || null,
        labels: [...(t.labels || [])],
        desc: s.note ? `<p>${s.note.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)}</p>` : '',
      });
      // The key the server will give it (the next number), so the parent's activity can name it.
      n.key = h.nextKey(x, p);
      write(x, [
        put('tasks', n),
        actOp(x, n, 'created'),
        patchOp('tasks', t.id, { subtasks: t.subtasks.filter(y => y.id !== s.id), updated: Date.now() }, { subtasks: t.subtasks }),
        actOp(x, t, 'converted a subtask of', `into ${n.key}`),
      ]);
      return x.V.task(x.repo.get('tasks', n.id));
    },
  });

  /* ---------- comments ---------- */
  const findComment = (x, id) => {
    const cm = x.repo.get('comments', id);
    if (!cm || !x.visible.some(p => p.id === cm.project)) throw new ApiFail(404, 'No comment with that id, or you can’t open it.', 'not_found', 'id');
    return cm;
  };
  route('patch', '/comments/{id}', {
    id: 'updateComment',
    tag: 'Comments',
    summary: 'Edit your own comment’s text',
    params: S.IdParam,
    body: S.CommentUpdate,
    ok: ok(S.Comment),
    run: (x, { params, body }) => {
      const cm = findComment(x, params.id);
      if (cm.text === body.text) return x.V.comment(cm);
      return x.V.comment(write(x, [patchOp('comments', cm.id, { text: body.text })])[0]);
    },
  });
  route('delete', '/comments/{id}', {
    id: 'deleteComment',
    tag: 'Comments',
    summary: 'Delete a comment (your own; Owners and Admins any)',
    description: 'POST /comments/{id}/undelete puts it back for 10 minutes.',
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const cm = findComment(x, params.id);
      write(x, [del('comments', cm.id)]);
      return { deleted: true, id: cm.id, restoreUntil: Date.now() + RESTORE_MS };
    },
  });
  route('post', '/comments/{id}/undelete', {
    id: 'undeleteComment',
    tag: 'Comments',
    summary: 'Undo deleting a comment (within 10 minutes, by whoever deleted it)',
    params: S.IdParam,
    ok: ok(S.Comment),
    run: (x, { params }) => {
      notDeleted(x, 'comments', params.id, 'comment');
      return x.V.comment(write(x, [put('comments', { id: params.id }, { restore: true })])[0]);
    },
  });
  const react =
    on =>
    (x, { params }) => {
      const cm = findComment(x, params.id);
      const re = cm.re || {};
      const who = re[params.emoji] || [];
      if (who.includes(x.me.id) === on) return x.V.comment(cm);
      const next = { ...re, [params.emoji]: on ? [...who, x.me.id] : who.filter(id => id !== x.me.id) };
      return x.V.comment(write(x, [patchOp('comments', cm.id, { re: next }, { re })])[0]);
    };
  route('put', '/comments/{id}/reactions/{emoji}', {
    id: 'addReaction',
    tag: 'Comments',
    summary: 'React to a comment (👍 🎉 ❤️ 👀 🚀 ✅)',
    params: S.ReactionParams,
    ok: ok(S.Comment),
    run: react(true),
  });
  route('delete', '/comments/{id}/reactions/{emoji}', {
    id: 'removeReaction',
    tag: 'Comments',
    summary: 'Take back your reaction',
    params: S.ReactionParams,
    ok: ok(S.Comment),
    run: react(false),
  });

  /* ---------- teams ---------- */
  const teamView = (x, t, members = x.repo.all('members')) => x.V.team(t, members);
  const findTeamById = (x, id) => {
    const t = x.repo.get('teams', id);
    if (!t) throw new ApiFail(404, 'No team with that id.', 'not_found', 'id');
    return t;
  };
  /* Member patches putting exactly `refs` on team `id` (people taken off get no team). */
  function teamMembers(x, id, refs) {
    if (!refs) return [];
    const want = new Set(refs.map(r => findMember(x, r, 'members').id));
    return x.repo
      .all('members')
      .filter(m => (m.team === id) !== want.has(m.id))
      .map(m => patchOp('members', m.id, { team: want.has(m.id) ? id : '' }));
  }
  route('get', '/teams', {
    id: 'listTeams',
    tag: 'Teams',
    summary: 'Every team, with its members',
    ok: ok(S.TeamList),
    run: x => {
      const members = x.repo.all('members');
      return { data: x.repo.all('teams', 'ORDER BY created_at, rowid').map(t => teamView(x, t, members)) };
    },
  });
  route('post', '/teams', {
    id: 'createTeam',
    tag: 'Teams',
    summary: 'Create a team (not Guests)',
    body: S.TeamCreate,
    ok: ok(S.Team, 201),
    run: (x, { body: b }) => {
      const t = { id: newId('tm'), name: b.name, desc: b.description ?? '', icon: b.icon || 'users', c: b.color || PCOLORS.teal };
      write(x, [put('teams', t), ...teamMembers(x, t.id, b.members)]);
      return teamView(x, x.repo.get('teams', t.id));
    },
  });
  route('patch', '/teams/{id}', {
    id: 'updateTeam',
    tag: 'Teams',
    summary: 'Change a team; `members` replaces who is on it',
    params: S.IdParam,
    body: S.TeamUpdate,
    ok: ok(S.Team),
    run: (x, { params, body: b }) => {
      const t = findTeamById(x, params.id);
      const v = {};
      if (b.name !== undefined) v.name = b.name;
      if (b.description !== undefined) v.desc = b.description;
      if (b.icon !== undefined) v.icon = b.icon;
      if (b.color !== undefined) v.c = b.color;
      const ops = [...(Object.keys(v).length ? [patchOp('teams', t.id, v)] : []), ...teamMembers(x, t.id, b.members)];
      if (ops.length) write(x, ops);
      return teamView(x, x.repo.get('teams', t.id));
    },
  });
  route('delete', '/teams/{id}', {
    id: 'deleteTeam',
    tag: 'Teams',
    summary: 'Delete a team; its people and projects are kept, with no team',
    description: 'Projects you can’t edit keep their team id, as in the app.',
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const t = findTeamById(x, params.id);
      const ops = [del('teams', t.id)];
      for (const m of x.repo.all('members')) if (m.team === t.id) ops.push(patchOp('members', m.id, { team: '' }));
      for (const p of x.projects) if (p.team === t.id && projectLevel(p, x.me) >= EDIT) ops.push(patchOp('projects', p.id, { team: '' }));
      write(x, ops);
      return { deleted: true, id: t.id };
    },
  });

  /* ---------- people ---------- */
  const findPerson = (x, ref, field = 'ref') => {
    const m = findMember(x, ref, field);
    if (m.kind === 'bot') throw new ApiFail(400, 'That’s a bot: manage it with /bots (Owners and Admins).', 'invalid_request', field);
    return m;
  };
  route('get', '/members/{ref}', {
    id: 'getMember',
    tag: 'Members',
    summary: 'A person or bot by id, email or name',
    params: S.RefParam,
    ok: ok(S.Member),
    run: (x, { params }) => x.V.member(findMember(x, params.ref, 'ref')),
  });
  /* The app's name for someone invited by email: the part before @, words capitalised. */
  const nameFromEmail = e =>
    e
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase())
      .trim()
      .slice(0, 80) || e;
  route('post', '/members', {
    id: 'inviteMember',
    tag: 'Members',
    summary: 'Invite someone by email (not Guests); they’re emailed a link to join',
    description: 'Only Owners and Admins invite Admins. Invites are limited to 50 an hour per person, shared with the app.',
    body: S.MemberInvite,
    ok: ok(S.Invited, 201),
    run: (x, { body: b }) => {
      const role = b.role || 'Member';
      if (role === 'Admin') needAdmin(x);
      const m = {
        id: newId('m'),
        name: b.name || nameFromEmail(b.email),
        email: b.email.toLowerCase(),
        role,
        team: b.team == null ? '' : findTeam(x, b.team).id,
        title: b.title ?? role,
        c: '#6B7280',
        status: 'invited',
        last: null,
        tz: '—',
      };
      const [saved] = write(x, [put('members', m)]);
      return { member: x.V.member(saved), ...(x.config.exposeEmailLinks && x.links?.length ? { link: x.links[0] } : {}) };
    },
  });
  route('post', '/members/{ref}/resend-invite', {
    id: 'resendInvite',
    tag: 'Members',
    summary: 'Send someone who hasn’t joined yet a fresh invite (the old link stops working)',
    params: S.RefParam,
    ok: ok(S.Ok),
    run: (x, { params }) => {
      const m = findMember(x, params.ref, 'ref');
      spend(`invite:${x.me.id}`, INVITES_PER_HOUR, 'You’ve sent a lot of invites. Try again in an hour.');
      const out = resendInvite(x.c.var, x.me, x.repo.get('members', m.id));
      if (out.error) throw new ApiFail(out.status, out.error, undefined);
      return { ok: true };
    },
  });
  route('patch', '/members/{ref}', {
    id: 'updateMember',
    tag: 'Members',
    summary: 'Change someone’s role, team, name or title',
    description:
      'Anyone but a Guest may change someone’s team. Role, name and title of other people are for Owners and Admins; only an Owner changes who owns the workspace, and nobody their own role.',
    params: S.RefParam,
    body: S.MemberUpdate,
    ok: ok(S.Member),
    run: (x, { params, body: b }) => {
      const m = findPerson(x, params.ref);
      const v = {};
      if (b.name !== undefined) v.name = b.name;
      if (b.title !== undefined) v.title = b.title;
      if (b.role !== undefined) v.role = b.role;
      if (b.team !== undefined) v.team = b.team === null ? '' : findTeam(x, b.team).id;
      for (const k of Object.keys(v)) if (v[k] === m[k]) delete v[k];
      if (!Object.keys(v).length) return x.V.member(m);
      if (v.role !== undefined || (m.id !== x.me.id && Object.keys(v).some(k => k !== 'team'))) needAdmin(x);
      return x.V.member(write(x, [patchOp('members', m.id, v)])[0]);
    },
  });
  route('delete', '/members/{ref}', {
    id: 'removeMember',
    tag: 'Members',
    summary: 'Remove someone from the workspace',
    description: 'Their tasks are unassigned and they’re taken off projects; they’re signed out everywhere. Not the Owner, not yourself.',
    admin: true,
    params: S.RefParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const m = findPerson(x, params.ref);
      write(x, [del('members', m.id)]);
      return { deleted: true, id: m.id };
    },
  });

  route('patch', '/me', {
    id: 'updateMe',
    tag: 'Me',
    summary: 'Change your own name, title, team or avatar colour',
    body: S.MeUpdate,
    ok: ok(S.Me),
    run: (x, { body: b }) => {
      if (x.me.kind === 'bot') throw new ApiFail(403, 'A bot’s name changes in Settings → API → Bots (or PATCH /bots/{id}).', 'forbidden');
      const v = {};
      if (b.name !== undefined) v.name = b.name;
      if (b.title !== undefined) v.title = b.title;
      if (b.color !== undefined) v.c = b.color;
      if (b.team !== undefined) v.team = b.team === null ? '' : findTeam(x, b.team).id;
      if (Object.keys(v).length) {
        const [m] = write(x, [patchOp('members', x.me.id, v)]);
        x.me = m;
        x.c.var.auth.member = m;
      }
      return h.meView(x);
    },
  });

  /* ---------- preferences, favourites, sidebar order ---------- */
  // `preferences.tz` is the zone the person saved (when it is one); timeZone the one in use for them
  // (their own, else the workspace's: never a Sudo-Time-Zone sent with this request).
  const prefsOf = x => {
    const st = x.repo.userState(x.me.id);
    return {
      preferences: Object.fromEntries(Object.entries(st.prefs).filter(([k, v]) => S.PREF_KEYS.includes(k) && (k !== 'tz' || validTz(v)))),
      notifications: { ...DEFAULT_NOTIF_PREFS, ...st.notifPrefs },
      ...zoneView(memberClock(x.repo, x.me.id)),
    };
  };
  route('get', '/me/preferences', {
    id: 'getPreferences',
    tag: 'Me',
    summary: 'Your display and notification preferences',
    ok: ok(S.Preferences),
    run: prefsOf,
  });
  route('patch', '/me/preferences', {
    id: 'updatePreferences',
    tag: 'Me',
    summary: 'Change display or notification preferences; only the ones sent change',
    body: S.PreferencesUpdate,
    ok: ok(S.Preferences),
    run: (x, { body: b }) => {
      if (b.notifications && Object.keys(b.notifications).length) write(x, [{ c: 'notifPrefs', k: 'patch', v: b.notifications }]);
      if (b.preferences && Object.keys(b.preferences).length) {
        // Only the ones sent change (saveState merges them into what's saved).
        saveState(x.c.var, x.me.id, { prefs: b.preferences });
        x.c.set('committed', true);
      }
      return prefsOf(x);
    },
  });
  const favoritesOf = x => {
    const f = x.favorites();
    const vis = new Set(x.visible.map(p => p.id));
    const tasks = f.tasks.size
      ? x.db
          .all('SELECT id, project_id FROM tasks WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify([...f.tasks]))
          .filter(r => vis.has(r.project_id))
          .map(r => r.id)
      : [];
    const order = sidebarOrder(x);
    return { projects: [...f.projects].filter(id => vis.has(id)), tasks, projectOrder: order };
  };
  route('get', '/me/favorites', {
    id: 'getFavorites',
    tag: 'Me',
    summary: 'The projects and tasks you starred, and your sidebar order',
    ok: ok(S.Favorites),
    run: favoritesOf,
  });
  route('put', '/me/project-order', {
    id: 'setProjectOrder',
    tag: 'Me',
    summary: 'Set the order of projects in your sidebar',
    body: S.ProjectOrder,
    ok: ok(S.Favorites),
    run: (x, { body }) => {
      // The ones named go first, in that order; the rest keep their places after them.
      const ids = [...new Set(body.projects.map(r => findManaged(x, r, 'projects').id))];
      write(x, [{ c: 'projOrder', k: 'put', v: [...ids, ...sidebarOrder(x).filter(id => !ids.includes(id))] }]);
      return favoritesOf(x);
    },
  });

  /* ---------- workspace ---------- */
  const wsView = x => {
    const ws = x.repo.workspace() || {};
    return { name: ws.name || '', color: ws.c || '#5A67D8', brand: !!ws.brand, timeZone: validTz(ws.tz) };
  };
  route('get', '/workspace', { id: 'getWorkspace', tag: 'Workspace', summary: 'Workspace settings', ok: ok(S.Workspace), run: wsView });
  route('patch', '/workspace', {
    id: 'updateWorkspace',
    tag: 'Workspace',
    summary: 'Rename the workspace, or change its colour or time zone',
    admin: true,
    body: S.WorkspaceUpdate,
    ok: ok(S.Workspace),
    run: (x, { body: b }) => {
      const v = {};
      if (b.name !== undefined) v.name = b.name;
      if (b.color !== undefined) v.c = b.color;
      if (b.brand !== undefined) v.brand = b.brand;
      if (b.timeZone !== undefined) v.tz = b.timeZone;
      if (Object.keys(v).length) write(x, [{ c: 'ws', k: 'patch', v }]);
      return wsView(x);
    },
  });
  route('post', '/workspace/invite-link', {
    id: 'createInviteLink',
    tag: 'Workspace',
    summary: 'Make the reusable link to join as a Member (the previous one stops working)',
    admin: true,
    ok: ok(S.InviteLink),
    run: x => {
      spend(`invite-link:${x.me.id}`, 10, 'You’ve made a lot of invite links. Try again in an hour.');
      x.c.set('committed', true);
      return { link: makeInviteLink(x.c.var, x.me) };
    },
  });

  route('get', '/activity', {
    id: 'listActivity',
    tag: 'Activity',
    summary: 'The workspace’s activity, newest first (projects you can open, plus workspace-wide entries)',
    query: S.ActivityQuery,
    ok: ok(S.ActivityPage),
    run: (x, { query: q }) => {
      const scoped = q.project
        ? ['SELECT id, data, created_at FROM activity WHERE project_id = ?', [findProject(x, q.project).id]]
        : ['SELECT id, data, created_at FROM activity WHERE (project_id IS NULL OR project_id IN (SELECT value FROM json_each(?)))', [visibleIds(x)]];
      const { rows, nextCursor } = newest(x, scoped[0], scoped[1], q);
      return { data: rows.map(x.V.activity), nextCursor };
    },
  });

  /* ---------- bots (Owners and Admins) ---------- */
  const findBot = (x, id) => {
    const m = x.repo.get('members', id);
    if (m?.kind !== 'bot') throw new ApiFail(404, 'No bot with that id.', 'not_found', 'id');
    return m;
  };
  const projectIds = (x, refs) =>
    refs?.map(r => {
      const up = String(r).toUpperCase();
      const p = x.projects.find(p => p.id === r || p.key === up);
      if (!p) throw new ApiFail(400, `No project “${r}”.`, 'invalid_request', 'projects');
      return p.id;
    });
  route('get', '/bots', {
    id: 'listBots',
    tag: 'Bots',
    summary: 'Every bot, with its projects and keys',
    admin: true,
    ok: ok(S.BotList),
    run: x => ({ data: listBots(x.db, x.repo) }),
  });
  route('post', '/bots', {
    id: 'createBot',
    tag: 'Bots',
    summary: 'Create a bot (a Member or Guest that acts only through its keys)',
    description: 'Its keys are made in Settings → API → Bots, never with an API key.',
    admin: true,
    body: S.BotCreate,
    ok: ok(S.Bot, 201),
    run: (x, { body: b }) => {
      if (x.db.get("SELECT COUNT(*) n FROM users WHERE kind = 'bot'").n >= MAX_BOTS)
        throw new ApiFail(400, `A workspace can have up to ${MAX_BOTS} bots. Remove one you no longer use first.`, 'invalid_request');
      const input = { name: b.name, role: b.role || 'Member', projects: projectIds(x, b.projects) || [] };
      const { member, changes } = x.db.tx(() => createBot(x.db, x.repo, input));
      x.c.set('committed', true);
      x.c.var.engine.publish(changes);
      return getBot(x.db, x.repo, member.id);
    },
  });
  route('patch', '/bots/{id}', {
    id: 'updateBot',
    tag: 'Bots',
    summary: 'Rename a bot, change its role, or set exactly which projects it’s on',
    admin: true,
    params: S.IdParam,
    body: S.BotUpdate,
    ok: ok(S.Bot),
    run: (x, { params, body: b }) => {
      const m = findBot(x, params.id);
      const input = { name: b.name, role: b.role, projects: projectIds(x, b.projects) };
      x.c.var.engine.publish(x.db.tx(() => updateBot(x.repo, m, input)));
      x.c.set('committed', true);
      return getBot(x.db, x.repo, m.id);
    },
  });
  route('delete', '/bots/{id}', {
    id: 'removeBot',
    tag: 'Bots',
    summary: 'Remove a bot; its keys stop working',
    admin: true,
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const m = findBot(x, params.id);
      x.c.var.engine.removeAccount({ member: m });
      x.c.set('committed', true);
      return { deleted: true, id: m.id };
    },
  });
  route('delete', '/bots/{id}/keys/{keyId}', {
    id: 'revokeBotKey',
    tag: 'Bots',
    summary: 'Revoke one of a bot’s keys',
    admin: true,
    params: S.BotKeyParams,
    ok: ok(S.Bot),
    run: (x, { params }) => {
      const m = findBot(x, params.id);
      if (!revokeKey(x.db, m.id, params.keyId)) throw new ApiFail(404, 'That key no longer exists.', 'not_found', 'keyId');
      x.c.set('committed', true);
      return getBot(x.db, x.repo, m.id);
    },
  });

  /* ---------- files ---------- */
  const findFile = (x, id) => {
    const f = x.repo.get('files', id);
    if (!f || !x.visible.some(p => p.id === f.project)) throw new ApiFail(404, 'No file with that id, or you can’t open it.', 'not_found', 'id');
    return f;
  };
  route('get', '/files', {
    id: 'listFiles',
    tag: 'Files',
    summary: 'Files in projects you can open, newest first',
    query: S.FileQuery,
    ok: ok(S.FilePage),
    run: (x, { query: q }) => {
      const t = q.task ? findTask(x, q.task, 'task') : null;
      const pid = t ? t.project : q.project ? findProject(x, q.project).id : null;
      const sql = pid
        ? [`SELECT id, data, created_at FROM files WHERE project_id = ?${t ? " AND json_extract(data, '$.task') = ?" : ''}`, t ? [pid, t.id] : [pid]]
        : ['SELECT id, data, created_at FROM files WHERE project_id IN (SELECT value FROM json_each(?))', [visibleIds(x)]];
      const { rows, nextCursor } = newest(x, sql[0], sql[1], q);
      return { data: rows.map(x.V.file), nextCursor };
    },
  });
  route('get', '/files/{id}', {
    id: 'getFile',
    tag: 'Files',
    summary: 'A file’s details',
    params: S.IdParam,
    ok: ok(S.File),
    run: (x, { params }) => x.V.file(findFile(x, params.id)),
  });
  route('get', '/files/{id}/content', {
    id: 'downloadFile',
    tag: 'Files',
    summary: 'Download a file’s bytes',
    params: S.IdParam,
    query: S.DownloadQuery,
    ok: { status: 200, binary: true },
    run: (x, { params, query }) => {
      findFile(x, params.id);
      return h.uploads.serve(x.c, params.id, { download: query.download === 'true' });
    },
  });
  route('post', '/files', {
    id: 'uploadFile',
    tag: 'Files',
    summary: 'Upload a file to a project, optionally attached to a task',
    description:
      'Send the bytes as the request body (any Content-Type) with `name` in the query, and `project` or `task`. Needs Can edit there. Not with an Idempotency-Key.',
    rawBody: 'The file’s bytes',
    query: S.FileUploadQuery,
    ok: ok(S.File, 201),
    run: async (x, { query: q }) => {
      const t = q.task ? findTask(x, q.task, 'task') : null;
      const p = t ? x.repo.get('projects', t.project) : q.project ? findProject(x, q.project) : null;
      if (!p) throw new ApiFail(400, 'Say where it goes: project=<key> or task=<key>.', 'invalid_request', 'project');
      const res = await h.uploads.upload(x.c, { project: p.id, task: t?.id, name: q.name, via: x.c.var.via });
      const body = await res.json();
      if (res.status !== 201) throw new ApiFail(res.status, body.error, body.code, res.status === 404 ? (t ? 'task' : 'project') : undefined);
      x.c.set('committed', true);
      return x.V.file(body.file);
    },
  });
  route('patch', '/files/{id}', {
    id: 'updateFile',
    tag: 'Files',
    summary: 'Rename a file, or attach it to a task in its project (`task: null` detaches it)',
    params: S.IdParam,
    body: S.FileUpdate,
    ok: ok(S.File),
    run: (x, { params, body: b }) => {
      const f = findFile(x, params.id);
      const ops = [];
      const v = {};
      if (b.name !== undefined && b.name !== f.name) v.name = b.name;
      if (b.task !== undefined) {
        const t = b.task === null ? null : findTask(x, b.task, 'task');
        if (t && t.project !== f.project) throw new ApiFail(400, 'task: attach a file to a task in its own project.', 'invalid_request', 'task');
        if ((t?.id ?? null) !== (f.task ?? null)) {
          v.task = t?.id ?? null;
          const old = f.task && x.repo.get('tasks', f.task);
          if (old && (old.attachments || []).some(a => a.id === f.id)) {
            ops.push(patchOp('tasks', old.id, { attachments: old.attachments.filter(a => a.id !== f.id), updated: Date.now() }));
            ops.push(actOp(x, old, 'removed a file from'));
          }
          if (t) {
            const entry = { id: f.id, name: v.name ?? f.name, type: f.type, size: f.size, by: f.by ?? null, at: f.at, url: f.url };
            ops.push(patchOp('tasks', t.id, { attachments: [...(t.attachments || []).filter(a => a.id !== f.id), entry], updated: Date.now() }));
            ops.push(actOp(x, t, 'added a file to', v.name ?? f.name));
          }
        }
      }
      if (!Object.keys(v).length) return x.V.file(f);
      write(x, [patchOp('files', f.id, v), ...ops]);
      return x.V.file(x.repo.get('files', f.id));
    },
  });
  route('post', '/files/{id}/duplicate', {
    id: 'duplicateFile',
    tag: 'Files',
    summary: 'Copy a file in its project (the copy shares the stored bytes)',
    params: S.IdParam,
    ok: ok(S.File, 201),
    run: (x, { params }) => {
      const f = findFile(x, params.id);
      const n = { ...f, id: newId('f'), name: f.name.replace(/(\.[^.]+)$/, ' copy$1').slice(0, 255), at: Date.now(), by: x.me.id };
      if (n.name === f.name) n.name = `${f.name} copy`.slice(0, 255);
      return x.V.file(write(x, [put('files', n)])[0]);
    },
  });
  route('delete', '/files/{id}', {
    id: 'deleteFile',
    tag: 'Files',
    summary: 'Delete a file (and take it off its task)',
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const f = findFile(x, params.id);
      const t = f.task && x.repo.get('tasks', f.task);
      const ops = [del('files', f.id)];
      if (t && (t.attachments || []).some(a => a.id === f.id)) ops.push(patchOp('tasks', t.id, { attachments: t.attachments.filter(a => a.id !== f.id) }));
      write(x, ops);
      return { deleted: true, id: f.id };
    },
  });

  /* ---------- calendar events ---------- */
  const findEvent = (x, id) => {
    const e = x.repo.get('events', id);
    if (!e || (e.project && !x.visible.some(p => p.id === e.project)))
      throw new ApiFail(404, 'No event with that id, or you can’t open it.', 'not_found', 'id');
    return e;
  };
  const eventProject = (x, ref) => (ref == null ? null : findProject(x, ref).id);
  /* An event's `when` from a day and an 'HH:MM' ('' for all day) on the caller's clock. */
  const eventWhen = (x, day, hm) => (hm ? fromWallClock(day, hm, clockOf(x).tz) : day);
  /* When an event (as x.V.event shows it) starts, to order by: an all-day one at the start of its day. */
  const eventMs = (v, tz) => instant(v.when || (v.time ? fromWallClock(v.date, v.time, tz) : v.date), tz);
  route('get', '/events', {
    id: 'listEvents',
    tag: 'Events',
    summary: 'Calendar events (in projects you can open, and workspace-wide), by date on your clock',
    query: S.EventQuery,
    ok: ok(S.EventPage),
    run: (x, { query: q }) => {
      const pid = q.project ? findProject(x, q.project).id : null;
      const { tz } = clockOf(x);
      // Days and order on the caller's clock (`date` in each view is that day).
      const all = x.repo
        .all('events', 'WHERE project_id IS NULL OR project_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', visibleIds(x))
        .filter(e => !pid || e.project === pid)
        .map(x.V.event)
        .filter(v => (!q.from || v.date >= q.from) && (!q.to || v.date <= q.to))
        .sort((a, b) => eventMs(a, tz) - eventMs(b, tz));
      return pageOf(all, q);
    },
  });
  route('post', '/events', {
    id: 'createEvent',
    tag: 'Events',
    summary: 'Add a calendar event (Can edit in its project; workspace-wide ones are for Owners and Admins)',
    body: S.EventCreate,
    ok: ok(S.Event, 201),
    run: (x, { body: b }) => {
      // The sync rules add `date` and `time` (on this person's clock) for older apps.
      const e = { id: newId('e'), title: b.title, when: eventWhen(x, b.date, b.time || ''), project: eventProject(x, b.project) };
      return x.V.event(write(x, [put('events', e)])[0]);
    },
  });
  route('patch', '/events/{id}', {
    id: 'updateEvent',
    tag: 'Events',
    summary: 'Change a calendar event',
    params: S.IdParam,
    body: S.EventUpdate,
    ok: ok(S.Event),
    run: (x, { params, body: b }) => {
      const e = findEvent(x, params.id);
      const v = {};
      if (b.title !== undefined) v.title = b.title;
      // A new day keeps the time, and a new time the day, as this person reads them now.
      if (b.date !== undefined || b.time !== undefined) {
        const now = x.V.event(e);
        const when = eventWhen(x, b.date ?? now.date, b.time ?? now.time);
        if (when !== e.when) v.when = when;
      }
      if (b.project !== undefined) v.project = eventProject(x, b.project);
      if (!Object.keys(v).length) return x.V.event(e);
      return x.V.event(write(x, [patchOp('events', e.id, v)])[0]);
    },
  });
  route('delete', '/events/{id}', {
    id: 'deleteEvent',
    tag: 'Events',
    summary: 'Delete a calendar event',
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const e = findEvent(x, params.id);
      write(x, [del('events', e.id)]);
      return { deleted: true, id: e.id };
    },
  });

  /* ---------- saved views ---------- */
  const findView = (x, id) => {
    const v = x.repo.get('savedViews', id);
    if (!v || !x.visible.some(p => p.id === v.project)) throw new ApiFail(404, 'No saved view with that id, or you can’t open it.', 'not_found', 'id');
    return v;
  };
  const filters = list => list.map(f => ({ f: f.field, op: f.op, v: f.values }));
  route('get', '/views', {
    id: 'listViews',
    tag: 'Views',
    summary: 'Saved views (a project’s extra tabs)',
    query: S.ViewQuery,
    ok: ok(S.SavedViewPage),
    run: (x, { query: q }) => {
      const ids = q.project ? JSON.stringify([findProject(x, q.project).id]) : visibleIds(x);
      return pageOf(x.repo.all('savedViews', 'WHERE project_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', ids).map(x.V.view), q);
    },
  });
  route('post', '/views', {
    id: 'createView',
    tag: 'Views',
    summary: 'Save a view: a named set of task filters, shown as a tab on the project',
    body: S.ViewCreate,
    ok: ok(S.SavedView, 201),
    run: (x, { body: b }) => {
      const v = { id: newId('v'), project: findProject(x, b.project).id, name: b.name, type: b.type || 'list', filters: filters(b.filters || []) };
      return x.V.view(write(x, [put('savedViews', v)])[0]);
    },
  });
  route('patch', '/views/{id}', {
    id: 'updateView',
    tag: 'Views',
    summary: 'Rename a saved view, or change its layout or filters',
    params: S.IdParam,
    body: S.ViewUpdate,
    ok: ok(S.SavedView),
    run: (x, { params, body: b }) => {
      const sv = findView(x, params.id);
      const v = {};
      if (b.name !== undefined) v.name = b.name;
      if (b.type !== undefined) v.type = b.type;
      if (b.filters !== undefined) v.filters = filters(b.filters);
      if (!Object.keys(v).length) return x.V.view(sv);
      return x.V.view(write(x, [patchOp('savedViews', sv.id, v)])[0]);
    },
  });
  route('delete', '/views/{id}', {
    id: 'deleteView',
    tag: 'Views',
    summary: 'Delete a saved view',
    params: S.IdParam,
    ok: ok(S.Deleted),
    run: (x, { params }) => {
      const sv = findView(x, params.id);
      write(x, [del('savedViews', sv.id)]);
      return { deleted: true, id: sv.id };
    },
  });

  /* ---------- notifications ---------- */
  route('get', '/notifications', {
    id: 'listNotifications',
    tag: 'Notifications',
    summary: 'Your inbox, newest first',
    query: S.NotificationQuery,
    ok: ok(S.NotificationPage),
    run: (x, { query: q }) => {
      const sql = `SELECT id, data, created_at FROM notifications WHERE user_id = ?${q.unread === 'true' ? " AND COALESCE(json_extract(data, '$.read'), 0) = 0" : ''}`;
      const { rows, nextCursor } = newest(x, sql, [x.me.id], q);
      return { data: rows.map(x.V.notification), nextCursor };
    },
  });
  route('patch', '/notifications/{id}', {
    id: 'markNotification',
    tag: 'Notifications',
    summary: 'Mark a notification read or unread',
    params: S.IdParam,
    body: S.NotificationUpdate,
    ok: ok(S.Notification),
    run: (x, { params, body }) => {
      const row = x.db.get('SELECT data FROM notifications WHERE id = ? AND user_id = ?', params.id, x.me.id);
      if (!row) throw new ApiFail(404, 'No notification with that id.', 'not_found', 'id');
      const n = JSON.parse(row.data);
      if (!!n.read === body.read) return x.V.notification(n);
      return x.V.notification(write(x, [patchOp('notifs', n.id, { read: body.read })])[0]);
    },
  });
  route('post', '/notifications/read-all', {
    id: 'markAllNotificationsRead',
    tag: 'Notifications',
    summary: 'Mark every notification read',
    ok: ok(S.MarkedRead),
    run: x => {
      const ids = x.db.all("SELECT id FROM notifications WHERE user_id = ? AND COALESCE(json_extract(data, '$.read'), 0) = 0", x.me.id).map(r => r.id);
      if (ids.length)
        write(
          x,
          ids.map(id => patchOp('notifs', id, { read: true })),
        );
      return { updated: ids.length };
    },
  });
}
