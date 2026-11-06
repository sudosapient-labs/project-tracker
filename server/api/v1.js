/* The public REST API, /api/v1, for personal API keys (and the CLI and MCP server built on it).
   Reads apply the app's visibility rules (sync/rules.js); writes are expressed as the same sync
   operations the app sends, records plus their activity entries, and go through engine.apply, so
   they're validated, permission-checked, notify the same people and reach open apps live. One
   request is one transaction: if any part is refused, nothing is saved.

   Routes are declared once in ROUTES; registration and the OpenAPI document both read them. */
import { Hono } from 'hono';
import { PR, RECUR_DAYS, ST } from '../../src/core/constants.js';
import { newId } from '../lib/crypto.js';
import { cleanRich, richTextProblem } from '../lib/rich-text.js';
import { canSee, memberFor } from '../sync/rules.js';
import { bearer, fail, idempotent, scoped } from './middleware.js';
import { openapi } from './openapi.js';
import * as S from './schemas.js';

class ApiFail extends Error {
  constructor(status, message, code, field) {
    super(message);
    Object.assign(this, { status, code, field });
  }
}
const notFound = (what, field) => new ApiFail(404, `No ${what} with that id or key, or you can’t open it.`, 'not_found', field);

/* ---------- text ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
export const htmlToText = html =>
  String(html || '')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|h\d)>/gi, '\n\n')
    .replace(/<\/li>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e])
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const esc = s => s.replace(/[&<>"']/g, ch => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[ch]};`);
/* Plain text becomes paragraphs, the way the app's own quick-add stores a description. */
const textToHtml = s =>
  s
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
const shortDate = v => new Date(v.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const shiftDate = (v, days) => new Date(Date.parse(v.slice(0, 10) + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10) + v.slice(10);

/* ---------- public views of synced records ---------- */
const views = config => ({
  task: t => ({
    id: t.id,
    key: t.key,
    url: `${config.appUrl}/#task/${t.key}`,
    project: t.project,
    title: t.title,
    description: htmlToText(t.desc),
    descriptionHtml: t.desc || '',
    status: t.status,
    priority: t.priority,
    assignee: t.assignee ?? null,
    due: t.due ?? null,
    start: t.start ?? null,
    labels: t.labels || [],
    estimate: t.estimate ?? null,
    subtasks: (t.subtasks || []).map(s => ({ id: s.id, title: s.title, done: !!s.done, assignee: s.assignee ?? null })),
    archived: !!t.archived,
    completedAt: t.completedAt ?? null,
    createdAt: t.created,
    updatedAt: t.updated,
  }),
  project: (p, counts) => ({
    id: p.id,
    key: p.key,
    url: `${config.appUrl}/#project/${p.key.toLowerCase()}`,
    name: p.name,
    description: p.desc || '',
    status: p.status,
    lead: p.lead ?? null,
    members: p.members || [],
    private: !!p.private,
    archived: !!p.archived,
    start: p.start ?? null,
    due: p.due ?? null,
    openTasks: counts?.get(p.id)?.open || 0,
    doneTasks: counts?.get(p.id)?.done || 0,
  }),
  // A bot's address is a placeholder nobody can mail (api/bots.js), so it isn't shown.
  member: m => ({
    id: m.id,
    name: m.name,
    email: m.kind === 'bot' ? '' : m.email || '',
    role: m.role,
    title: m.title || '',
    team: m.team || '',
    status: m.status,
    kind: m.kind === 'bot' ? 'bot' : 'person',
  }),
  comment: c => ({ id: c.id, task: c.task, author: c.by, text: c.text, createdAt: c.at }),
  activity: a => ({ id: a.id, by: a.by, verb: a.verb, extra: a.extra || '', via: a.via ?? null, task: a.task ?? null, at: a.at }),
});

/* ---------- pagination ---------- */
/* Small, append-only lists (comments, people, projects) page by position; tasks page by key below. */
function pageOf(items, { limit = 50, cursor }) {
  const from = cursor ? Number(/^o(\d+)$/.exec(cursor)?.[1]) : 0;
  if (!Number.isInteger(from)) throw new ApiFail(400, 'That cursor isn’t valid.', 'invalid_request', 'cursor');
  const data = items.slice(from, from + limit);
  return { data, nextCursor: from + limit < items.length ? `o${from + limit}` : null };
}
const encodeCursor = (at, id) => Buffer.from(JSON.stringify([at, id])).toString('base64url');
function decodeCursor(s) {
  try {
    const [at, id] = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (Number.isFinite(at) && typeof id === 'string') return { at, id };
  } catch {
    /* fall through */
  }
  throw new ApiFail(400, 'That cursor isn’t valid.', 'invalid_request', 'cursor');
}

export function v1Routes({ limit }) {
  /* ---------- lookups, all within what the key's person can see ---------- */
  const ctxOf = c => {
    const { db, repo, config } = c.var;
    const me = c.var.auth.member;
    const projects = repo.all('projects', 'ORDER BY created_at, rowid');
    const visible = projects.filter(p => canSee(p, me));
    return { c, db, repo, config, me, projects, visible, V: views(config) };
  };
  const findProject = (x, ref, field = 'project') => {
    const up = ref.toUpperCase();
    const p = x.visible.find(p => p.id === ref || p.key === up);
    if (!p) throw notFound('project', field);
    return p;
  };
  const findTask = (x, ref) => {
    const t = x.repo.get('tasks', ref) || x.repo.all('tasks', "WHERE json_extract(data, '$.key') = ?", ref.toUpperCase())[0];
    if (!t || !x.visible.some(p => p.id === t.project)) throw notFound('task');
    return t;
  };
  /* People as this person may see them (Guests don't see everyone's email). */
  const people = x => x.repo.all('members', 'ORDER BY created_at, rowid').map(m => memberFor(m, x.me, x.projects));
  /* 'me', an id, an email, a full name, or a first name when only one person has it. */
  const findMember = (x, ref, field) => {
    if (ref === 'me') return x.me;
    const lc = ref.trim().toLowerCase();
    const all = people(x);
    const hit = all.find(m => m.id === ref) || all.find(m => m.email && m.email.toLowerCase() === lc);
    if (hit) return hit;
    const named = all.filter(m => m.name.toLowerCase() === lc);
    const first = named.length ? named : all.filter(m => m.name.toLowerCase().split(/\s+/)[0] === lc);
    if (first.length === 1) return first[0];
    if (first.length > 1) throw new ApiFail(400, `More than one person matches “${ref}”: use their email.`, 'ambiguous', field);
    throw new ApiFail(400, `Nobody in the workspace matches “${ref}”.`, 'invalid_request', field);
  };
  const counts = x =>
    new Map(
      x.db
        .all(
          "SELECT project_id id, SUM(json_extract(data, '$.status') = 'done') done, SUM(json_extract(data, '$.status') != 'done') open FROM tasks WHERE COALESCE(json_extract(data, '$.archived'), 0) = 0 GROUP BY project_id",
        )
        .map(r => [r.id, r]),
    );

  /* ---------- writes ---------- */
  const FIELD = { desc: 'description' };
  function write(x, ops) {
    const { results, failed } = x.c.var.engine.apply(x.c.var.auth, ops, null, { via: x.c.var.via, atomic: true });
    if (!failed) x.c.set('committed', true);
    if (failed) {
      const m = /^(\w+): (.*)$/.exec(failed.error);
      throw new ApiFail(failed.status || 400, failed.error, undefined, m ? FIELD[m[1]] || m[1] : undefined);
    }
    return results.map(r => r.v);
  }
  /* The activity line the app logs with each change (store.js logAct). */
  const actOp = (x, t, verb, extra = '') => {
    const id = newId('a');
    return { c: 'activity', id, k: 'put', v: { id, by: x.me.id, verb, task: t.id, project: t.project, at: Date.now(), extra } };
  };
  const nextOrder = x => (x.db.get("SELECT MAX(json_extract(data, '$.order')) n FROM tasks")?.n || 0) + 1;
  const descOf = b => {
    if (b.descriptionHtml == null) return b.description != null ? textToHtml(b.description) : undefined;
    const problem = richTextProblem(b.descriptionHtml);
    if (problem) throw new ApiFail(400, `descriptionHtml: ${problem}`, 'invalid_request', 'descriptionHtml');
    return cleanRich(b.descriptionHtml);
  };

  function newTask(x, f) {
    const now = Date.now();
    return {
      id: newId('t'),
      project: f.project,
      title: f.title,
      status: f.status || 'todo',
      assignee: f.assignee ?? null,
      priority: f.priority || 'none',
      due: f.due ?? null,
      start: f.start ?? null,
      labels: f.labels || [],
      subtasks: f.subtasks || [],
      attachments: [],
      deps: f.deps || [],
      desc: f.desc || '',
      estimate: f.estimate ?? null,
      created: now,
      updated: now,
      order: nextOrder(x),
      recur: f.recur ?? null,
      ...(f.status === 'done' ? { completedAt: now } : {}),
    };
  }

  /* The same field-by-field changes and activity lines the app's applyPatch makes (actions.js). */
  function updateTask(x, t, b) {
    const patch = {};
    const acts = [];
    const after = { ...t };
    const set = (k, v) => {
      if (JSON.stringify(t[k] ?? null) === JSON.stringify(v ?? null)) return false;
      patch[k] = after[k] = v;
      return true;
    };
    if (b.project !== undefined) {
      const p = findProject(x, b.project);
      if (set('project', p.id)) acts.push(['moved', `to ${p.name}`]);
    }
    if (b.title !== undefined && set('title', b.title)) acts.push(['renamed', `to “${b.title}”`]);
    const desc = descOf(b);
    if (desc !== undefined) set('desc', desc);
    if (b.status !== undefined && set('status', b.status)) {
      if (b.status === 'done') {
        patch.completedAt = Date.now();
        patch.prevStatus = t.status;
        acts.push(['completed', '']);
      } else acts.push(['moved', `from ${ST[t.status]?.name} to ${ST[b.status].name}`]);
    }
    if (b.priority !== undefined && set('priority', b.priority)) acts.push(['changed priority of', `to ${PR[b.priority].name}`]);
    if (b.assignee !== undefined) {
      const m = b.assignee === null ? null : findMember(x, b.assignee, 'assignee');
      if (set('assignee', m?.id ?? null)) acts.push(['assigned', m ? `to ${m.name}` : '(unassigned)']);
    }
    if (b.due !== undefined && set('due', b.due)) acts.push(['changed due date of', b.due ? `to ${shortDate(b.due)}` : '(cleared)']);
    if (b.start !== undefined && set('start', b.start)) acts.push(['changed start date of', b.start ? `to ${shortDate(b.start)}` : '(cleared)']);
    if (b.labels !== undefined && set('labels', b.labels)) acts.push(['updated labels on', '']);
    if (b.estimate !== undefined && set('estimate', b.estimate)) acts.push(['estimated', b.estimate || 'none']);
    if (!Object.keys(patch).length) return t;
    patch.updated = Date.now();
    const ops = [{ c: 'tasks', id: t.id, k: 'patch', v: patch }, ...acts.map(([verb, extra]) => actOp(x, after, verb, extra))];
    // Completing a repeating task schedules the next one, as in the app.
    if (patch.status === 'done' && after.recur && after.due) {
      const due = shiftDate(after.due, RECUR_DAYS[after.recur] || 7);
      const n = newTask(x, { ...after, due, start: due, status: 'todo', subtasks: (after.subtasks || []).map(s => ({ ...s, done: false })) });
      ops.push({ c: 'tasks', id: n.id, k: 'put', v: n }, actOp(x, n, 'created'));
    }
    return write(x, ops)[0];
  }

  /* ---------- routes ---------- */
  const R = [];
  const route = (method, path, o) => R.push({ method, path, ...o });
  const ok = (schema, status = 200) => ({ schema, status });

  route('get', '/me', {
    id: 'getMe',
    tag: 'Me',
    summary: 'The person or bot this key acts as',
    ok: ok(S.Me),
    run: x => {
      const { key, user } = x.c.var.auth;
      return {
        ...x.V.member(x.me),
        email: user.kind === 'bot' ? '' : user.email,
        workspace: x.repo.workspace()?.name || '',
        key: { id: key.id, name: key.name, scope: key.scope, expiresAt: key.expires_at },
      };
    },
  });

  route('get', '/tasks', {
    id: 'listTasks',
    tag: 'Tasks',
    summary: 'List tasks, newest first',
    query: S.TaskQuery,
    ok: ok(S.TaskPage),
    run: (x, { query: q }) => {
      const pids = q.project ? [findProject(x, q.project).id] : x.visible.map(p => p.id);
      const where = ['project_id IN (SELECT value FROM json_each(?))'];
      const args = [JSON.stringify(pids)];
      if (q.status === 'open') where.push("json_extract(data, '$.status') != 'done'");
      else if (q.status) {
        const list = q.status.split(',').filter(Boolean);
        if (list.some(s => !ST[s])) throw new ApiFail(400, `Status is one of open, ${Object.keys(ST).join(', ')}.`, 'invalid_request', 'status');
        where.push("json_extract(data, '$.status') IN (SELECT value FROM json_each(?))");
        args.push(JSON.stringify(list));
      }
      if (q.assignee) {
        where.push("json_extract(data, '$.assignee') = ?");
        args.push(findMember(x, q.assignee, 'assignee').id);
      }
      if (q.q) {
        where.push("(instr(lower(json_extract(data, '$.title')), ?) > 0 OR json_extract(data, '$.key') = ?)");
        args.push(q.q.toLowerCase(), q.q.toUpperCase());
      }
      if (q.updatedSince) {
        const since = /^\d+$/.test(q.updatedSince) ? Number(q.updatedSince) : Date.parse(q.updatedSince);
        if (!Number.isFinite(since)) throw new ApiFail(400, 'updatedSince must be an ISO date-time or Unix milliseconds.', 'invalid_request', 'updatedSince');
        where.push('updated_at >= ?');
        args.push(since);
      }
      if (q.includeArchived !== 'true') where.push("COALESCE(json_extract(data, '$.archived'), 0) = 0");
      if (q.cursor) {
        const k = decodeCursor(q.cursor);
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        args.push(k.at, k.at, k.id);
      }
      const n = q.limit || 50;
      const rows = x.db.all(`SELECT id, data, created_at FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, n + 1);
      const more = rows.length > n;
      const page = rows.slice(0, n);
      return { data: page.map(r => x.V.task(JSON.parse(r.data))), nextCursor: more ? encodeCursor(page.at(-1).created_at, page.at(-1).id) : null };
    },
  });

  route('post', '/tasks', {
    id: 'createTask',
    tag: 'Tasks',
    summary: 'Create a task',
    body: S.TaskCreate,
    ok: ok(S.Task, 201),
    run: (x, { body: b }) => {
      const p = findProject(x, b.project);
      const assignee = b.assignee == null ? null : findMember(x, b.assignee, 'assignee').id;
      const t = newTask(x, { ...b, project: p.id, assignee, desc: descOf(b) });
      const [saved] = write(x, [{ c: 'tasks', id: t.id, k: 'put', v: t }, actOp(x, t, 'created')]);
      return x.V.task(saved);
    },
  });

  route('get', '/tasks/{ref}', {
    id: 'getTask',
    tag: 'Tasks',
    summary: 'Get a task by id or key',
    params: S.RefParam,
    ok: ok(S.Task),
    run: (x, { params }) => x.V.task(findTask(x, params.ref)),
  });

  route('patch', '/tasks/{ref}', {
    id: 'updateTask',
    tag: 'Tasks',
    summary: 'Change a task; only the fields sent change',
    params: S.RefParam,
    body: S.TaskUpdate,
    ok: ok(S.Task),
    run: (x, { params, body }) => x.V.task(updateTask(x, findTask(x, params.ref), body)),
  });

  route('post', '/tasks/{ref}/complete', {
    id: 'completeTask',
    tag: 'Tasks',
    summary: 'Mark a task done',
    params: S.RefParam,
    ok: ok(S.Task),
    run: (x, { params }) => x.V.task(updateTask(x, findTask(x, params.ref), { status: 'done' })),
  });

  const archive =
    on =>
    (x, { params }) => {
      const t = findTask(x, params.ref);
      if (!!t.archived === on) return x.V.task(t);
      const v = { archived: on, archivedAt: on ? Date.now() : null, updated: Date.now() };
      return x.V.task(write(x, [{ c: 'tasks', id: t.id, k: 'patch', v }, actOp(x, t, on ? 'archived' : 'restored')])[0]);
    };
  route('post', '/tasks/{ref}/archive', { id: 'archiveTask', tag: 'Tasks', summary: 'Archive a task', params: S.RefParam, ok: ok(S.Task), run: archive(true) });
  route('post', '/tasks/{ref}/restore', {
    id: 'restoreTask',
    tag: 'Tasks',
    summary: 'Restore an archived task',
    params: S.RefParam,
    ok: ok(S.Task),
    run: archive(false),
  });

  route('get', '/tasks/{ref}/comments', {
    id: 'listComments',
    tag: 'Comments',
    summary: 'Comments on a task, oldest first',
    params: S.RefParam,
    query: S.PageQuery,
    ok: ok(S.CommentPage),
    run: (x, { params, query }) => {
      const t = findTask(x, params.ref);
      const all = x.repo.all('comments', "WHERE json_extract(data, '$.task') = ? ORDER BY created_at, rowid", t.id).map(x.V.comment);
      return pageOf(all, query);
    },
  });

  route('post', '/tasks/{ref}/comments', {
    id: 'createComment',
    tag: 'Comments',
    summary: 'Comment on a task',
    params: S.RefParam,
    body: S.CommentCreate,
    ok: ok(S.Comment, 201),
    run: (x, { params, body }) => {
      const t = findTask(x, params.ref);
      const cm = { id: newId('c'), task: t.id, by: x.me.id, at: Date.now(), text: body.text, re: {} };
      const [saved] = write(x, [{ c: 'comments', id: cm.id, k: 'put', v: cm }, actOp(x, t, 'commented on')]);
      return x.V.comment(saved);
    },
  });

  route('get', '/tasks/{ref}/activity', {
    id: 'listTaskActivity',
    tag: 'Tasks',
    summary: 'A task’s activity, newest first',
    params: S.RefParam,
    query: S.PageQuery,
    ok: ok(S.ActivityPage),
    run: (x, { params, query }) => {
      const t = findTask(x, params.ref);
      const all = x.repo.all('activity', "WHERE json_extract(data, '$.task') = ? ORDER BY created_at DESC, rowid DESC", t.id).map(x.V.activity);
      return pageOf(all, query);
    },
  });

  route('get', '/projects', {
    id: 'listProjects',
    tag: 'Projects',
    summary: 'Projects this key can open',
    query: S.ProjectQuery,
    ok: ok(S.ProjectPage),
    run: (x, { query }) => {
      const n = counts(x);
      return pageOf(
        x.visible.filter(p => query.includeArchived === 'true' || !p.archived).map(p => x.V.project(p, n)),
        query,
      );
    },
  });

  route('get', '/projects/{ref}', {
    id: 'getProject',
    tag: 'Projects',
    summary: 'Get a project by id or key',
    params: S.RefParam,
    ok: ok(S.Project),
    run: (x, { params }) => x.V.project(findProject(x, params.ref, 'ref'), counts(x)),
  });

  route('get', '/members', {
    id: 'listMembers',
    tag: 'Members',
    summary: 'People in the workspace',
    query: S.PageQuery,
    ok: ok(S.MemberPage),
    run: (x, { query }) => pageOf(people(x).map(x.V.member), query),
  });

  route('get', '/search', {
    id: 'search',
    tag: 'Search',
    summary: 'Search tasks, projects and people',
    query: S.SearchQuery,
    ok: ok(S.SearchResult),
    run: (x, { query }) => {
      const n = query.limit || 10;
      const q = query.q.toLowerCase();
      const has = s =>
        String(s || '')
          .toLowerCase()
          .includes(q);
      const tasks = x.db
        .all(
          `SELECT data FROM tasks WHERE project_id IN (SELECT value FROM json_each(?)) AND COALESCE(json_extract(data, '$.archived'), 0) = 0
             AND (json_extract(data, '$.key') = ? OR instr(lower(json_extract(data, '$.title')), ?) > 0 OR instr(lower(json_extract(data, '$.desc')), ?) > 0)
           ORDER BY json_extract(data, '$.key') = ? DESC, instr(lower(json_extract(data, '$.title')), ?) > 0 DESC, updated_at DESC LIMIT ?`,
          JSON.stringify(x.visible.map(p => p.id)),
          q.toUpperCase(),
          q,
          q,
          q.toUpperCase(),
          q,
          n,
        )
        .map(r => x.V.task(JSON.parse(r.data)));
      const c = counts(x);
      const projects = x.visible
        .filter(p => !p.archived && (has(p.name) || p.key === q.toUpperCase()))
        .slice(0, n)
        .map(p => x.V.project(p, c));
      const members = people(x)
        .filter(m => has(m.name) || (m.email && has(m.email)))
        .slice(0, n)
        .map(x.V.member);
      return { tasks, projects, members };
    },
  });

  /* ---------- wiring ---------- */
  const r = new Hono();
  // The spec is public, so tools can read it without a key.
  r.get('/openapi.json', c => c.json(openapi(R, { appUrl: c.var.config.appUrl })));
  r.use('*', bearer({ limit }), scoped, idempotent);

  const parse = (schema, v, where) => {
    const res = schema.safeParse(v);
    if (res.success) return res.data;
    const i = res.error.issues[0];
    const field = String(i.path[0] ?? (i.code === 'unrecognized_keys' ? i.keys?.[0] : '') ?? '');
    const msg = i.code === 'unrecognized_keys' ? `Unknown field: ${i.keys.join(', ')}.` : field ? `${field}: ${i.message}` : i.message;
    throw new ApiFail(400, where === 'body' || !field ? msg : `${msg} (in the ${where})`, 'invalid_request', field || undefined);
  };
  for (const rt of R)
    r.on(rt.method.toUpperCase(), rt.path.replace(/\{(\w+)\}/g, ':$1'), async c => {
      try {
        const input = {};
        if (rt.params) input.params = parse(rt.params, c.req.param(), 'path');
        if (rt.query) input.query = parse(rt.query, c.req.query(), 'query');
        if (rt.body) {
          let raw;
          try {
            raw = await c.req.json();
          } catch {
            throw new ApiFail(400, 'Request body must be JSON.', 'invalid_request');
          }
          input.body = parse(rt.body, raw, 'body');
        }
        return c.json(rt.run(ctxOf(c), input), rt.ok.status);
      } catch (e) {
        if (e instanceof ApiFail) return fail(c, e.status, e.message, e.code, e.field);
        c.var.log.error?.('[api]', c.req.method, c.req.path, e);
        return fail(c, 500, 'Something went wrong on our side. Try again in a moment.', 'server_error');
      }
    });
  r.all('*', c => fail(c, 404, 'There’s no such endpoint. See /api/v1/openapi.json.'));
  return { routes: r, R };
}
