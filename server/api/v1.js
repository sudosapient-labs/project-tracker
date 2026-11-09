/* The public REST API, /api/v1, for personal API keys (and the CLI and MCP server built on it).
   Reads apply the app's visibility rules (sync/rules.js); writes are expressed as the same sync
   operations the app sends, records plus their activity entries, and go through engine.apply, so
   they're validated, permission-checked, notify the same people and reach open apps live. One
   request is one transaction: if any part is refused, nothing is saved.

   Routes are declared once in ROUTES; registration and the OpenAPI document both read them. */
import { Hono } from 'hono';
import { PR, ST, validTz } from '../../src/core/constants.js';
import { clockOf as memberClock } from '../lib/clock.js';
import { dayOf, instant, isCanonical, label, timeOf } from '../../packages/client/dates.js';
import { actExtra, whenAct } from '../../src/core/activity.js';
import { textToHtml } from '../../src/core/rich-text.js';
import { newId } from '../lib/crypto.js';
import { PERMS, isAdminRole, projectLevel } from '../../src/core/access.js';
import { canSee, memberFor } from '../sync/rules.js';
import { bearer, fail, idempotent, scoped } from './middleware.js';
import { openapi } from './openapi.js';
import * as S from './schemas.js';
import { registerMore } from './v1-more.js';

export class ApiFail extends Error {
  constructor(status, message, code, field, retryAfter) {
    super(message);
    Object.assign(this, { status, code, field, retryAfter });
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
/* The caller's clock: what the API words or turns into a day for whoever is asking (activity "to
   Nov 9, 11:59 PM", `date` and `time` on events, `sort=due`, "today", an event's day and time sent
   in words). The key's person's clock, except that a client acting for someone else (the Slack bot,
   one key for a whole team) can name that person's zone in the Sudo-Time-Zone header, for that
   request only. The time format stays the key's person's. Nothing is saved, and what the server
   does for other people (notifications, reminders, repeats) keeps their own clocks. A value that
   isn't a zone is ignored. */
export const TIME_ZONE_HEADER = 'Sudo-Time-Zone';
const askedZone = c => validTz((c.req.header(TIME_ZONE_HEADER) || '').trim());
const onAsked = (own, asked) => (asked ? { ...own, tz: asked } : own);
const clockOf = x => onAsked(memberClock(x.repo, x.me.id), x.askedTz);
/* A member's effective time zone and where it comes from, as Member, Me and Preferences show it. */
const zoneView = ({ tz, source }) => ({ timeZone: tz, timeZoneSource: source });
const shortDate = (x, v) => {
  const { tz, time } = clockOf(x);
  return label(v, tz, { style: 'short', time });
};
/* An activity entry's fields for a start or due set to `v`, worded on the key's person's clock. */
const whenFields = (x, verb, v) => whenAct(verb, v, w => shortDate(x, w));

/* ---------- public views of synced records ---------- */
const LEVEL = ['none', 'view', 'comment', 'edit', 'full'];
/* `clock`: a member's clock (server/lib/clock.js), for the effective time zone on Member. `reader`:
   the caller's (clockOf above), for activity and events, which read on the reader's clock. */
const views = (config, me, favs, keyOf, clock, reader) => ({
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
    subtasks: (t.subtasks || []).map(s => ({ id: s.id, title: s.title, done: !!s.done, assignee: s.assignee ?? null, due: s.due ?? null })),
    dependsOn: t.deps || [],
    recurrence: t.recur ?? null,
    // Uploaded files by the address a key can fetch (as in /files), not the app's cookie-only one.
    attachments: (t.attachments || []).map(a => ({
      id: a.id,
      name: a.name,
      size: a.size || '',
      url: a.url?.startsWith('/api/files/') ? `${config.appUrl}/api/v1/files/${a.id}/content` : null,
    })),
    favorite: favs().tasks.has(t.id),
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
    status: p.status || '',
    lead: p.lead ?? null,
    members: p.members || [],
    permissions: Object.fromEntries(Object.entries(p.perms || {}).filter(([, v]) => PERMS.includes(v))),
    private: !!p.private,
    archived: !!p.archived,
    start: p.start ?? null,
    due: p.due ?? null,
    icon: p.icon || '',
    color: p.color || '',
    team: p.team || '',
    milestones: (p.milestones || []).map(m => ({ name: m.name, date: m.date ?? null })),
    favorite: favs().projects.has(p.id),
    access: LEVEL[projectLevel(p, me)],
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
    ...zoneView(clock(m.id)),
  }),
  comment: c => ({
    id: c.id,
    task: c.task,
    author: c.by,
    text: c.text,
    reactions: Object.fromEntries(Object.entries(c.re || {}).filter(([, who]) => who?.length)),
    createdAt: c.at,
  }),
  activity: a => ({
    id: a.id,
    by: a.by,
    verb: a.verb,
    extra: actExtra(a, v => {
      const { tz, time } = reader();
      return label(v, tz, { style: 'short', time });
    }),
    ...(a.when !== undefined ? { when: a.when } : {}),
    via: a.via ?? null,
    task: a.task ?? null,
    taskKey: keyOf(a.task),
    project: a.project ?? null,
    at: a.at,
  }),
  team: (t, members) => ({
    id: t.id,
    name: t.name,
    description: t.desc || '',
    icon: t.icon || '',
    color: t.c || '',
    members: members.filter(m => m.team === t.id).map(m => m.id),
  }),
  file: f => ({
    id: f.id,
    project: f.project,
    task: f.task ?? null,
    taskKey: keyOf(f.task),
    name: f.name,
    type: f.type,
    size: f.size || '',
    uploadedBy: f.by ?? null,
    uploadedAt: f.at,
    url: f.url ? `${config.appUrl}/api/v1/files/${f.id}/content` : null,
  }),
  // `date` and `time` on the reader's clock; `when` as stored. (An event the migration couldn't read
  // has only the day and time it was saved with.)
  event: e => {
    if (!isCanonical(e.when)) return { id: e.id, title: e.title, date: e.date, time: e.time || '', when: null, project: e.project ?? null };
    const { tz } = reader();
    return { id: e.id, title: e.title, date: dayOf(e.when, tz), time: timeOf(e.when, tz), when: e.when, project: e.project ?? null };
  },
  view: v => ({ id: v.id, project: v.project, name: v.name, type: v.type, filters: (v.filters || []).map(f => ({ field: f.f, op: f.op, values: f.v })) }),
  notification: n => ({
    id: n.id,
    type: n.type,
    by: n.by ?? null,
    task: n.task ?? null,
    taskKey: keyOf(n.task),
    project: n.project ?? null,
    text: n.text || '',
    snippet: n.snippet || '',
    read: !!n.read,
    at: n.at,
  }),
});

/* ---------- pagination ---------- */
/* Small, append-only lists (comments, people, projects) page by position; tasks page by key below. */
function pageOf(items, { limit = 50, cursor }) {
  const from = cursor ? Number(/^o(\d+)$/.exec(cursor)?.[1]) : 0;
  if (!Number.isInteger(from)) throw new ApiFail(400, 'That cursor isn’t valid.', 'invalid_request', 'cursor');
  const data = items.slice(from, from + limit);
  return { data, nextCursor: from + limit < items.length ? `o${from + limit}` : null };
}
/* A task's comments or activity, given oldest first: in the order asked for, with how many in all.
   Newest first pages back from the newest: its cursor `n<i>` means "the ones before position i",
   counted from the oldest, so ones added between pages don't push a page's last item onto the
   next. `o<i>` (skip the newest i), as earlier servers sent for newest-first activity, still works. */
function orderedPage(items, query, dflt) {
  const total = items.length;
  if ((query.order || dflt) !== 'newest') return { ...pageOf(items, query), total };
  const { limit = 50, cursor } = query;
  const m = cursor ? /^([no])(\d+)$/.exec(cursor) : null;
  if (cursor && !m) throw new ApiFail(400, 'That cursor isn’t valid.', 'invalid_request', 'cursor');
  const end = !m ? total : m[1] === 'n' ? Math.min(Number(m[2]), total) : Math.max(total - Number(m[2]), 0);
  const from = Math.max(end - limit, 0);
  return { data: items.slice(from, end).toReversed(), nextCursor: from > 0 ? `n${from}` : null, total };
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
/* sort=due pages resume after [created_at, id, due moment]: the moment (Unix ms) its due stands for,
   null for tasks without one, which come last. Cursors from before held the due value itself. */
const encodeDueCursor = (at, id, key) => Buffer.from(JSON.stringify([at, id, key])).toString('base64url');
function decodeDueCursor(s, tz) {
  try {
    const k = JSON.parse(Buffer.from(s, 'base64url').toString());
    if (Array.isArray(k) && k.length === 3 && Number.isFinite(k[0]) && typeof k[1] === 'string') {
      if (k[2] === null || Number.isFinite(k[2])) return { at: k[0], id: k[1], key: k[2] };
      if (typeof k[2] === 'string' && Number.isFinite(dueKey(k[2], tz))) return { at: k[0], id: k[1], key: dueKey(k[2], tz) };
    }
  } catch {
    /* fall through */
  }
  throw new ApiFail(400, 'That cursor isn’t valid.', 'invalid_request', 'cursor');
}
/* Where a task sorts by due: the moment it's due, an all-day due counting as the end of its day in
   the reader's time zone, as the app's lists do; null (last) for none. */
const dueKey = (due, tz) => (due ? instant(due, tz, true) : null);
const byDueOrder = (a, b) =>
  a.key === b.key ? b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.key === null ? 1 : b.key === null ? -1 : a.key - b.key;
export function v1Routes({ limit, uploads }) {
  /* ---------- lookups, all within what the key's person can see ---------- */
  const ctxOf = c => {
    const { db, repo, config } = c.var;
    const me = c.var.auth.member;
    const projects = repo.all('projects', 'ORDER BY created_at, rowid');
    const visible = projects.filter(p => canSee(p, me));
    let favs;
    const favorites = () => (favs ||= repo.favorites(me.id));
    const resetFavorites = () => (favs = null);
    // A task's key from its id, for records that name a task (activity, notifications, files), so
    // clients needn't look each one up. Only tasks this person can see; null otherwise.
    const keys = new Map();
    const visibleIds = new Set(visible.map(p => p.id));
    const keyOf = id => {
      if (!id) return null;
      if (!keys.has(id)) {
        const r = db.get("SELECT project_id, json_extract(data, '$.key') k FROM tasks WHERE id = ?", id);
        keys.set(id, r && visibleIds.has(r.project_id) ? r.k : null);
      }
      return keys.get(id);
    };
    // A key acts as its person: an Owner's or Admin's key has their admin powers, as in the app.
    const admin = isAdminRole(me);
    const clocks = new Map();
    const clock = id => clocks.get(id) || clocks.set(id, memberClock(repo, id)).get(id);
    const askedTz = askedZone(c);
    return {
      c,
      db,
      repo,
      config,
      me,
      admin,
      projects,
      visible,
      favorites,
      resetFavorites,
      askedTz,
      // Each member's clock once per request (activity and events read the caller's on every row).
      V: views(config, me, favorites, keyOf, clock, () => onAsked(clock(me.id), askedTz)),
    };
  };
  const findProject = (x, ref, field = 'project') => {
    const up = ref.toUpperCase();
    const p = x.visible.find(p => p.id === ref || p.key === up);
    if (!p) throw notFound('project', field);
    return p;
  };
  const findTask = (x, ref, field) => {
    const t = x.repo.get('tasks', ref) || x.repo.all('tasks', "WHERE json_extract(data, '$.key') = ?", ref.toUpperCase())[0];
    if (!t || !x.visible.some(p => p.id === t.project)) throw notFound('task', field);
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

  /* Workspace administration (roles, removing people, workspace settings, bots, the invite link)
     is for Owners and Admins: the key's person, with their role as it is now (read on every
     request), so someone demoted loses it on their keys at once. */
  const needAdmin = x => {
    if (!isAdminRole(x.me)) throw new ApiFail(403, 'Only owners and admins can do this.', 'forbidden');
  };

  /* ---------- writes ---------- */
  /* `fields`: the API's name for a record field an error names, e.g. which of description and
     descriptionHtml the request sent. */
  function write(x, ops, fields = { desc: 'description' }) {
    const { results, failed, links } = x.c.var.engine.apply(x.c.var.auth, ops, null, { via: x.c.var.via, atomic: true });
    // Invite links, for servers that expose them (development).
    x.links = links;
    if (!failed) x.c.set('committed', true);
    if (failed) {
      const m = /^(\w+): (.*)$/.exec(failed.error);
      const field = m && (fields[m[1]] || m[1]);
      throw new ApiFail(failed.status || 400, field ? `${field}: ${m[2]}` : failed.error, undefined, field || undefined);
    }
    return results.map(r => r.v);
  }
  /* The activity line the app logs with each change (store.js logAct). `extra`: its words, or for a
     start or due, `whenFields` (the words and the value). */
  const actOp = (x, t, verb, extra = '') => {
    const id = newId('a');
    const more = typeof extra === 'string' ? { extra } : extra;
    return { c: 'activity', id, k: 'put', v: { id, by: x.me.id, verb, task: t.id, project: t.project, at: Date.now(), ...more } };
  };
  /* The key the next task in project `p` gets (the app's nextKey; the server keeps it, see
     rules.js settleKey). */
  const nextKey = (x, p) => {
    const prefix = p.key + '-';
    const top =
      x.db.get(
        "SELECT MAX(CAST(substr(json_extract(data, '$.key'), ?) AS INTEGER)) n FROM tasks WHERE json_extract(data, '$.key') LIKE ?",
        prefix.length + 1,
        prefix + '%',
      )?.n || 0;
    return prefix + (Math.max(p.seq || 200, top) + 1);
  };
  const nextOrder = x => (x.db.get("SELECT MAX(json_extract(data, '$.order')) n FROM tasks")?.n || 0) + 1;
  /* The description as sent. The sync rules check and sanitise it, once (rules.js richDesc), like
     any description from the app. */
  const descOf = b => (b.descriptionHtml != null ? b.descriptionHtml : b.description != null ? textToHtml(b.description) : undefined);
  const descField = b => ({ desc: b.descriptionHtml != null ? 'descriptionHtml' : 'description' });

  /* `order` when the caller already knows it (a copy of many tasks finds the next one once). */
  function newTask(x, f, order) {
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
      order: order ?? nextOrder(x),
      recur: f.recur ?? null,
    };
  }

  /* Task references for `dependsOn`: tasks this person can see, in the same project (the app's
     "Blocked by" picker offers only those), never the task itself. */
  function depsOf(x, t, refs) {
    const ids = [];
    for (const r of refs) {
      const d = findTask(x, r, 'dependsOn');
      if (d.id === t.id) throw new ApiFail(400, 'dependsOn: a task can’t wait on itself.', 'invalid_request', 'dependsOn');
      if (d.project !== t.project) throw new ApiFail(400, `dependsOn: ${d.key} is in another project.`, 'invalid_request', 'dependsOn');
      if (!ids.includes(d.id)) ids.push(d.id);
    }
    return ids;
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
    // When it was finished and the next occurrence of a repeating task are the server's
    // (sync/task-status.js), as for the app.
    if (b.status !== undefined && set('status', b.status))
      acts.push(b.status === 'done' ? ['completed', ''] : ['moved', `from ${ST[t.status]?.name} to ${ST[b.status].name}`]);
    if (b.priority !== undefined && set('priority', b.priority)) acts.push(['changed priority of', `to ${PR[b.priority].name}`]);
    if (b.assignee !== undefined) {
      const m = b.assignee === null ? null : findMember(x, b.assignee, 'assignee');
      if (set('assignee', m?.id ?? null)) acts.push(['assigned', m ? `to ${m.name}` : '(unassigned)']);
    }
    if (b.due !== undefined && set('due', b.due)) acts.push(['changed due date of', whenFields(x, 'changed due date of', b.due)]);
    if (b.start !== undefined && set('start', b.start)) acts.push(['changed start date of', whenFields(x, 'changed start date of', b.start)]);
    if (b.labels !== undefined && set('labels', b.labels)) acts.push(['updated labels on', '']);
    if (b.estimate !== undefined && set('estimate', b.estimate)) acts.push(['estimated', b.estimate || 'none']);
    if (b.recurrence !== undefined && set('recur', b.recurrence)) acts.push(['set repeat on', b.recurrence ? b.recurrence.toLowerCase() : 'off']);
    // After a move, so they're checked against the project the task ends up in.
    if (b.dependsOn !== undefined && set('deps', depsOf(x, after, b.dependsOn))) acts.push(['updated dependencies of', '']);
    // Its place in a manual order (dragging in a list or on a board): no activity, as in the app.
    if (b.order !== undefined) set('order', b.order);
    if (!Object.keys(patch).length) return t;
    patch.updated = Date.now();
    const ops = [{ c: 'tasks', id: t.id, k: 'patch', v: patch }, ...acts.map(([verb, extra]) => actOp(x, after, verb, extra))];
    return write(x, ops, descField(b))[0];
  }

  const meView = x => {
    const { key, user } = x.c.var.auth;
    return {
      ...x.V.member(x.me),
      email: user.kind === 'bot' ? '' : user.email,
      workspace: x.repo.workspace()?.name || '',
      key: { id: key.id, name: key.name, scope: key.scope, expiresAt: key.expires_at },
    };
  };

  /* ---------- routes ---------- */
  const R = [];
  const route = (method, path, o) => R.push({ method, path, ...o });
  const ok = (schema, status = 200) => ({ schema, status });

  route('get', '/me', {
    id: 'getMe',
    tag: 'Me',
    summary: 'The person or bot this key acts as',
    ok: ok(S.Me),
    run: x => meView(x),
  });

  route('delete', '/me/key', {
    id: 'revokeMyKey',
    tag: 'Me',
    summary: 'Revoke the key making this request (read-only keys too); it stops working at once',
    ok: ok(S.Revoked),
    run: x => {
      // Only ever the key presented: there is no id to name another one.
      const { key } = x.c.var.auth;
      x.db.run('DELETE FROM api_keys WHERE id = ?', key.id);
      x.c.set('committed', true);
      return { revoked: true, id: key.id };
    },
  });

  route('get', '/tasks', {
    id: 'listTasks',
    tag: 'Tasks',
    summary: 'List tasks, newest first (or soonest due first with sort=due)',
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
      const byDue = q.sort === 'due';
      const n = q.limit || 50;
      if (byDue) {
        // Ordered here rather than in SQL: the two shapes of a due ('YYYY-MM-DD' and a UTC instant)
        // don't sort as text, and where an all-day due falls depends on the reader's time zone.
        const { tz } = clockOf(x);
        const after = q.cursor ? decodeDueCursor(q.cursor, tz) : null;
        const all = x.db
          .all(`SELECT id, created_at AS at, json_extract(data, '$.due') AS due FROM tasks WHERE ${where.join(' AND ')}`, ...args)
          .map(r => ({ id: r.id, at: r.at, key: dueKey(r.due, tz) }))
          .sort(byDueOrder);
        const from = after ? all.findIndex(r => byDueOrder(r, after) > 0) : 0;
        const picked = from < 0 ? [] : all.slice(from, from + n + 1);
        const more = picked.length > n;
        const page = picked.slice(0, n);
        const data = new Map(
          x.db.all('SELECT id, data FROM tasks WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(page.map(r => r.id))).map(r => [r.id, r.data]),
        );
        const last = page.at(-1);
        return {
          data: page.map(r => x.V.task(JSON.parse(data.get(r.id)))),
          nextCursor: more ? encodeDueCursor(last.at, last.id, last.key) : null,
          // Echoed so a client can tell this server sorted by due (an older one ignores sort).
          sort: 'due',
        };
      }
      if (q.cursor) {
        const k = decodeCursor(q.cursor);
        where.push('(created_at < ? OR (created_at = ? AND id < ?))');
        args.push(k.at, k.at, k.id);
      }
      const rows = x.db.all(`SELECT id, data, created_at FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`, ...args, n + 1);
      const more = rows.length > n;
      const page = rows.slice(0, n);
      const last = page.at(-1);
      const nextCursor = more ? encodeCursor(last.created_at, last.id) : null;
      // Echoed so a client can tell this server sorted by due (an older one ignores sort).
      return { data: page.map(r => x.V.task(JSON.parse(r.data))), nextCursor };
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
      const subtasks = (b.subtasks || []).map(s => ({
        id: newId('s'),
        title: s.title,
        done: !!s.done,
        ...(s.assignee != null ? { assignee: findMember(x, s.assignee, 'subtasks').id } : {}),
      }));
      const t = newTask(x, { ...b, project: p.id, assignee, desc: descOf(b), subtasks, recur: b.recurrence ?? null });
      t.deps = b.dependsOn ? depsOf(x, t, b.dependsOn) : [];
      const [saved] = write(x, [{ c: 'tasks', id: t.id, k: 'put', v: t }, actOp(x, t, 'created')], descField(b));
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
    summary: 'Comments on a task, oldest first (or newest first with order=newest)',
    params: S.RefParam,
    query: S.CommentQuery,
    ok: ok(S.CommentPage),
    run: (x, { params, query }) => {
      const t = findTask(x, params.ref);
      const all = x.repo.all('comments', "WHERE json_extract(data, '$.task') = ? ORDER BY created_at, rowid", t.id).map(x.V.comment);
      return orderedPage(all, query, 'oldest');
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
    summary: 'A task’s activity, newest first (or oldest first with order=oldest)',
    params: S.RefParam,
    query: S.TaskActivityQuery,
    ok: ok(S.TaskActivityPage),
    run: (x, { params, query }) => {
      const t = findTask(x, params.ref);
      const all = x.repo.all('activity', "WHERE json_extract(data, '$.task') = ? ORDER BY created_at, rowid", t.id).map(x.V.activity);
      return orderedPage(all, query, 'newest');
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

  registerMore({
    route,
    ok,
    ApiFail,
    notFound,
    findProject,
    findTask,
    findMember,
    people,
    counts,
    write,
    actOp,
    needAdmin,
    pageOf,
    newTask,
    nextKey,
    meView,
    encodeCursor,
    decodeCursor,
    limit,
    uploads,
    shortDate,
    whenFields,
    clockOf,
    memberClock,
    zoneView,
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
    // A field that wasn't sent at all: zod says "expected nonoptional, received undefined".
    const absent = i.code === 'invalid_type' && i.path.length === 1 && (v == null || typeof v !== 'object' || v[field] === undefined);
    const msg =
      i.code === 'unrecognized_keys' ? `Unknown field: ${i.keys.join(', ')}.` : absent ? `${field} is required.` : field ? `${field}: ${i.message}` : i.message;
    throw new ApiFail(400, where === 'body' || !field ? msg : `${msg} (in the ${where})`, 'invalid_request', field || undefined);
  };
  for (const rt of R)
    r.on(rt.method.toUpperCase(), rt.path.replace(/\{(\w+)\}/g, ':$1'), async c => {
      try {
        const input = {};
        if (rt.params) input.params = parse(rt.params, c.req.param(), 'path');
        if (rt.query) input.query = parse(rt.query, c.req.query(), 'query');
        if (rt.body && !rt.rawBody) {
          let raw;
          try {
            const text = await c.req.text();
            // No body at all is an empty one, for routes whose fields are all optional.
            raw = text.trim() ? JSON.parse(text) : {};
          } catch {
            throw new ApiFail(400, 'Request body must be JSON.', 'invalid_request');
          }
          input.body = parse(rt.body, raw, 'body');
        }
        const x = ctxOf(c);
        if (rt.admin) needAdmin(x);
        const out = await rt.run(x, input);
        // File downloads (and anything else that isn't JSON) answer with their own Response.
        return out instanceof Response ? out : c.json(out, rt.ok.status);
      } catch (e) {
        if (e instanceof ApiFail) {
          if (e.retryAfter) c.header('Retry-After', String(e.retryAfter));
          return fail(c, e.status, e.message, e.code, e.field);
        }
        c.var.log.error?.('[api]', c.req.method, c.req.path, e);
        return fail(c, 500, 'Something went wrong on our side. Try again in a moment.', 'server_error');
      }
    });
  r.all('*', c => fail(c, 404, 'There’s no such endpoint. See /api/v1/openapi.json.'));
  return { routes: r, R };
}
