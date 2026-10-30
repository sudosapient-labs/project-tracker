/* Shapes of synced records, matching what the client renders. Known fields are type-checked;
   unknown fields pass through (the UI keeps small flags like `prevStatus` on records), bounded by
   the per-record size limit in the engine. */
import { z } from 'zod';
import { FILTER_FIELDS, PCOLORS, PRIOS, PSTAT, REACTIONS, RECUR, ROLES, STATUSES } from '../../src/core/constants.js';
import { FILE_TYPES } from '../../src/core/file-types.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid id');
const ref = id.nullable().optional();
const text = (max = 500) => z.string().max(max);
const ts = z.number().finite().nonnegative();
// Dates are 'YYYY-MM-DD' (all day) or an ISO instant like '2026-11-02T09:30:00.000Z' (timed).
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, 'Invalid date')
  .nullable()
  .optional();
const color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid colour');
// A team reference: a team id, or '' for none.
const teamRef = z.string().regex(/^[A-Za-z0-9_-]{0,64}$/, 'Invalid team');
// Attachment and file URLs only ever point at this server's own files (routes/files.js).
const fileUrl = z
  .string()
  .max(300)
  .regex(/^\/api\/files\/[A-Za-z0-9_-]{1,64}\/\S*$/, 'Invalid file link');
const filter = z.object({ f: z.enum(FILTER_FIELDS), op: z.enum(['is', 'not']), v: z.array(z.string().max(64)).max(200) });

const subtask = z.looseObject({ id, title: text(500), done: z.boolean(), assignee: ref, due: date, note: text(10000).optional() });
const attachment = z.looseObject({ id, name: text(255), type: z.enum(FILE_TYPES), size: text(20), by: ref, at: ts, url: fileUrl.optional() });

export const SCHEMAS = {
  tasks: z.looseObject({
    id,
    key: z.string().regex(/^[A-Z]{1,8}-\d{1,7}$/, 'Invalid task key'),
    project: id,
    title: text(500).min(1, 'Give the task a name'),
    status: z.enum(STATUSES.map(s => s.id)),
    assignee: ref,
    priority: z.enum(PRIOS.map(p => p.id)),
    due: date,
    start: date,
    labels: z.array(text(40)).max(20),
    subtasks: z.array(subtask).max(200),
    attachments: z.array(attachment).max(200),
    deps: z.array(id).max(100),
    desc: text(100_000),
    estimate: text(20).nullable().optional(),
    created: ts,
    updated: ts,
    order: z.number().finite(),
    recur: z.enum(RECUR).nullable().optional(),
    archived: z.boolean().optional(),
    archivedAt: ts.nullable().optional(),
    completedAt: ts.nullable().optional(),
  }),
  projects: z.looseObject({
    id,
    key: z.string().regex(/^[A-Z]{1,8}$/, 'Invalid project key'),
    name: text(120).min(1, 'Give the project a name'),
    icon: text(40),
    color: z.enum(Object.keys(PCOLORS)),
    status: z.enum(Object.keys(PSTAT)),
    team: teamRef,
    lead: ref,
    due: date,
    start: date,
    members: z.array(id).max(1000),
    desc: text(5000),
    milestones: z.array(z.looseObject({ name: text(200), date })).max(100),
    private: z.boolean().optional(),
    access: z.enum(['private', 'workspace']).optional(),
    perms: z.record(z.string(), z.string().max(20)).optional(),
    seq: z.number().int().nonnegative().optional(),
    archived: z.boolean().optional(),
    archivedAt: ts.nullable().optional(),
  }),
  members: z.looseObject({
    id,
    name: text(80).min(1, 'Enter a name'),
    email: z
      .string()
      .max(254)
      .regex(/^\S+@\S+\.\S+$/, 'Enter a valid email address'),
    role: z.enum(ROLES),
    team: teamRef,
    title: text(80),
    c: color,
    status: z.enum(['active', 'invited']),
    tz: text(80),
  }),
  teams: z.looseObject({ id, name: text(60).min(1, 'Give the team a name'), icon: text(40), c: color, desc: text(500) }),
  comments: z.looseObject({
    id,
    task: id,
    by: id,
    at: ts,
    text: text(10_000).min(1),
    re: z.partialRecord(z.enum(REACTIONS), z.array(id).max(1000)).optional(),
  }),
  activity: z.looseObject({ id, by: id, verb: text(80), task: ref, project: ref, at: ts, extra: text(500).optional() }),
  notifs: z.looseObject({ id, read: z.boolean() }),
  files: z.looseObject({
    id,
    project: id,
    name: text(255).min(1),
    type: z.enum(FILE_TYPES),
    size: text(20),
    by: ref,
    at: ts,
    task: ref,
    url: fileUrl.optional(),
  }),
  // `time` is the event's start, 'HH:MM', or '' for all day.
  events: z.looseObject({
    id,
    title: text(200).min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    time: z.string().regex(/^(\d{2}:\d{2})?$/, 'Invalid time'),
    project: ref,
  }),
  savedViews: z.looseObject({ id, project: id, name: text(80).min(1), type: z.enum(['list', 'board', 'table']), filters: z.array(filter).max(50) }),
};

export const DOC_SCHEMAS = {
  ws: z.object({ name: text(80), c: color, brand: z.boolean().optional() }),
  projOrder: z.array(id).max(5000),
  recentSearches: z.array(text(200)).max(20),
  notifPrefs: z.record(z.string().max(40), z.boolean()),
};

export const MAX_RECORD_BYTES = 256 * 1024;
