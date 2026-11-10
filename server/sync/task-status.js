// @ts-check
/* A task's status lifecycle. The server owns it for every surface: the app (sync), the REST API and
   so the CLI, MCP server and Slack bot all save tasks through rules.js, which calls this.

   - Finishing a task stamps `completedAt` (the server's clock) and `prevStatus` (where it was, for
     Reopen and Undo). Reopening clears both, so they're only ever on a done task and never left
     from an earlier round.
   - A repeating task finished with a due date gets exactly one next occurrence, made here in the
     batch's own transaction: two people finishing it at once still make one.
   - The occurrence points back at the task it came from (`repeatOf`), with a fingerprint of how the
     server made it. Reopening the original removes it only when it is still exactly that (nobody
     has worked on it since, whatever its timestamps say) and nobody has commented on it.
   Clients can't set any of these fields (`serverOwned` in rules.js). */
import crypto from 'node:crypto';
import { RECUR_DAYS } from '../../src/core/constants.js';
import { EDIT, canSeeProject, projectLevel } from '../../src/core/access.js';
import { shiftDays } from '../../packages/client/dates.js';
import { clockOf } from '../lib/clock.js';
import { newId } from '../lib/crypto.js';
import { Reject } from '../lib/http.js';
import { SCHEMAS } from './schemas.js';

export const LIFECYCLE = ['completedAt', 'prevStatus', 'nextId', 'repeatOf'];

/* What an occurrence is, for telling whether someone has worked on it: everything but `updated`
   (clients stamp it, or don't), its place in a list and the lifecycle itself. Keys are sorted, so a
   value rebuilt in another order still matches. */
const NOT_WORK = new Set(['updated', 'order', 'fav', ...LIFECYCLE]);
const sorted = v =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map(k => [k, sorted(v[k])]),
        )
      : v;
/** @param {Record<string, any>} t */
export function fingerprint(t) {
  const work = Object.fromEntries(Object.entries(t).filter(([k]) => !NOT_WORK.has(k)));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted(work)))
    .digest('base64url')
    .slice(0, 22);
}

/* A new task (from the app, the API, a duplicate or a copy): none of the lifecycle comes from the
   client; one created done was finished now. */
export function createdStatus(ctx, t) {
  for (const f of LIFECYCLE) delete t[f];
  if (t.status === 'done') t.completedAt = ctx.now;
}

/* The next occurrence `t` scheduled, if it still exists and came from `t`. */
function nextOf(ctx, t) {
  const n = t.nextId ? ctx.repo.get('tasks', t.nextId) : null;
  return n?.repeatOf?.id === t.id ? n : null;
}

/* `t` is about to be saved over `before` with another status (its lifecycle fields still as in
   `before`). `create` is the tasks rule for a new task (keys, checks, notifications); `cascade`
   removes what goes with a deleted task. */
export function settleStatus(ctx, before, t, { create, cascade }) {
  const done = t.status === 'done';
  if (done === (before.status === 'done')) return;
  if (done) {
    t.completedAt = ctx.now;
    t.prevStatus = before.status;
    if (t.recur && t.due && !nextOf(ctx, t)) t.nextId = scheduleNext(ctx, t, create).id;
    return;
  }
  delete t.completedAt;
  delete t.prevStatus;
  if (!t.nextId) return;
  const n = nextOf(ctx, t);
  // Gone, or not one this task made: forget it, so finishing again schedules a new one.
  if (!n) return void delete t.nextId;
  const untouched = n.repeatOf.sum === fingerprint(n) && !ctx.db.get("SELECT 1 FROM comments WHERE json_extract(data, '$.task') = ? LIMIT 1", n.id);
  // Kept (worked on, or in a project this person can't change) stays linked, so finishing again adds no other.
  if (!untouched || projectLevel(ctx.repo.get('projects', n.project), ctx.me) < EDIT) return;
  cascade(ctx, n);
  ctx.keepDeleted('tasks', n);
  ctx.repo.del('tasks', n.id);
  ctx.emitDel('tasks', n.id, n.project);
  delete t.nextId;
}

/* The next occurrence of `t`: its due (and start) moved on by the repeat in the finisher's time
   zone, open again, subtasks unticked, no attachments; created as the app creates a task, and
   logged. */
function scheduleNext(ctx, t, create) {
  const p = ctx.repo.get('projects', t.project);
  // Someone who can no longer open the project isn't given the new one (it would be refused).
  const keep = m => (m != null && canSeeProject(p, ctx.repo.get('members', m)) ? m : null);
  const due = shiftDays(t.due, RECUR_DAYS[t.recur] || 7, clockOf(ctx.repo, ctx.uid).tz);
  const order = (ctx.db.get("SELECT MAX(json_extract(data, '$.order')) n FROM tasks")?.n || 0) + 1;
  const n = create(ctx, {
    id: newId('t'),
    project: t.project,
    title: t.title,
    status: 'todo',
    assignee: keep(t.assignee),
    priority: t.priority,
    due,
    start: due,
    labels: [...(t.labels || [])],
    subtasks: (t.subtasks || []).map(s => ({ ...s, done: false, assignee: keep(s.assignee) })),
    attachments: [],
    deps: [...(t.deps || [])],
    desc: t.desc || '',
    estimate: t.estimate ?? null,
    created: ctx.now,
    updated: ctx.now,
    order,
    recur: t.recur,
  });
  n.repeatOf = { id: t.id, sum: fingerprint(n) };
  const r = SCHEMAS.tasks.safeParse(n);
  if (!r.success) throw new Reject(`The next “${t.title}” couldn’t be scheduled: ${r.error.issues[0].message}`, 400);
  ctx.repo.put('tasks', n, n.project);
  ctx.emit('tasks', n);
  const a = { id: newId('a'), by: ctx.uid, verb: 'created', task: n.id, project: n.project, at: ctx.now, extra: '', ...(ctx.via ? { via: ctx.via } : {}) };
  ctx.repo.put('activity', a, n.project);
  ctx.emit('activity', a);
  return n;
}
