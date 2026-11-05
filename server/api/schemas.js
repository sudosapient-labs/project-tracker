// @ts-check
/* Shapes of the public API (/api/v1). Inputs are validated with these schemas, and the OpenAPI
   document (openapi.js) is generated from the same objects, so the two can't drift. Records are
   the public view of the synced ones (sync/schemas.js), with stable, documented field names. */
import { z } from 'zod';
import { PRIOS, ROLES, STATUSES } from '../../src/core/constants.js';

export const registry = z.registry();
const named = (id, schema, description) => {
  registry.add(schema, { id, description });
  return schema;
};

const STATUS = z.enum(STATUSES.map(s => s.id));
const PRIORITY = z.enum(PRIOS.map(p => p.id));
// 'YYYY-MM-DD' (all day) or an ISO instant (timed), as in the app.
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, 'Use YYYY-MM-DD or an ISO date-time')
  .describe('YYYY-MM-DD, or an ISO 8601 date-time for a timed due date');
const ms = z.number().int().describe('Unix time in milliseconds');
const ref = z.string().min(1).max(254);

/* ---------- records ---------- */
export const ErrorBody = named(
  'Error',
  z.object({
    error: z.string().describe('What went wrong, readable by people'),
    code: z.string().describe('Stable machine-readable code, e.g. not_found, forbidden, invalid_request, rate_limited'),
    field: z.string().optional().describe('The input field the error is about'),
  }),
  'Every error response has this shape.',
);

export const Member = named(
  'Member',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().describe('Empty for Guests looking at people they share no project with'),
    role: z.enum(ROLES),
    title: z.string(),
    team: z.string().describe('Team id, or empty'),
    status: z.enum(['active', 'invited']),
  }),
  'A person in the workspace.',
);

export const Me = named(
  'Me',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: z.enum(ROLES),
    title: z.string(),
    team: z.string(),
    status: z.enum(['active', 'invited']),
    workspace: z.string(),
    key: z.object({ id: z.string(), name: z.string(), scope: z.enum(['read', 'write']), expiresAt: ms.nullable() }),
  }),
  'The person the API key belongs to.',
);

export const Subtask = z.object({ id: z.string(), title: z.string(), done: z.boolean(), assignee: z.string().nullable() });

export const Task = named(
  'Task',
  z.object({
    id: z.string(),
    key: z.string().describe('Human key, e.g. WEB-212'),
    url: z.string().describe('Opens the task in the app'),
    project: z.string().describe('Project id'),
    title: z.string(),
    description: z.string().describe('The description as plain text'),
    descriptionHtml: z.string().describe('The description as the app stores it (sanitised HTML)'),
    status: STATUS,
    priority: PRIORITY,
    assignee: z.string().nullable().describe('Member id'),
    due: z.string().nullable(),
    start: z.string().nullable(),
    labels: z.array(z.string()),
    estimate: z.string().nullable(),
    subtasks: z.array(Subtask),
    archived: z.boolean(),
    completedAt: ms.nullable(),
    createdAt: ms,
    updatedAt: ms,
  }),
  'A task.',
);

export const Project = named(
  'Project',
  z.object({
    id: z.string(),
    key: z.string().describe('Prefix of its task keys, e.g. WEB'),
    url: z.string(),
    name: z.string(),
    description: z.string(),
    status: z.string().describe('planning, active, risk, hold or complete'),
    lead: z.string().nullable().describe('Member id'),
    members: z.array(z.string()).describe('Member ids listed on the project'),
    private: z.boolean(),
    archived: z.boolean(),
    start: z.string().nullable(),
    due: z.string().nullable(),
    openTasks: z.number().int(),
    doneTasks: z.number().int(),
  }),
  'A project the key can open.',
);

export const Comment = named(
  'Comment',
  z.object({ id: z.string(), task: z.string().describe('Task id'), author: z.string().describe('Member id'), text: z.string(), createdAt: ms }),
  'A comment on a task.',
);

export const Activity = named(
  'Activity',
  z.object({
    id: z.string(),
    by: z.string().describe('Member id'),
    verb: z.string().describe('e.g. "created", "completed", "moved"'),
    extra: z.string(),
    via: z.string().nullable().describe('What made the change when it was not the app, e.g. "Claude" or "CLI"'),
    task: z.string().nullable(),
    at: ms,
  }),
  'An entry in the activity log.',
);

const page = (id, item, what) =>
  named(
    id,
    z.object({ data: z.array(item), nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page; null on the last') }),
    `A page of ${what}.`,
  );
export const TaskPage = page('TaskPage', Task, 'tasks');
export const ProjectPage = page('ProjectPage', Project, 'projects');
export const CommentPage = page('CommentPage', Comment, 'comments');
export const MemberPage = page('MemberPage', Member, 'people');
export const ActivityPage = page('ActivityPage', Activity, 'activity');
export const SearchResult = named(
  'SearchResult',
  z.object({ tasks: z.array(Task), projects: z.array(Project), members: z.array(Member) }),
  'Matches in tasks (key, title, description), projects and people.',
);

/* ---------- inputs ---------- */
const limit = z.coerce.number().int().min(1).max(100).optional().describe('Page size, 1–100 (default 50)');
const cursor = z.string().max(200).optional().describe('From the previous page’s nextCursor');
const bool = z.enum(['true', 'false']).optional();

export const RefParam = z.object({ ref: ref.describe('Id or key (e.g. WEB-212 or WEB)') });

export const TaskQuery = z.object({
  project: ref.optional().describe('Project id or key'),
  status: z
    .string()
    .regex(/^[a-z,]+$/)
    .optional()
    .describe('Comma-separated statuses, or "open" for everything not done'),
  assignee: ref.optional().describe('Member id, email, or "me"'),
  q: z.string().max(200).optional().describe('Text in the title, or an exact key'),
  updatedSince: z.string().max(40).optional().describe('Only tasks changed since this ISO date-time or Unix ms'),
  includeArchived: bool,
  limit,
  cursor,
});
export const PageQuery = z.object({ limit, cursor });
export const ProjectQuery = z.object({ includeArchived: bool, limit, cursor });
export const SearchQuery = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(200),
  limit: limit.describe('Results per kind, 1–100 (default 10)'),
});

const fields = {
  title: z.string().trim().min(1, 'Give the task a name').max(500),
  description: z.string().max(20_000).describe('Plain text; replaces the description'),
  descriptionHtml: z.string().max(100_000).describe('HTML (sanitised like the app); used instead of description'),
  status: STATUS,
  priority: PRIORITY,
  assignee: ref.nullable().describe('Member id, email, name or "me"; null to unassign'),
  due: date.nullable(),
  start: date.nullable(),
  labels: z.array(z.string().max(40)).max(20),
  estimate: z.string().max(20).nullable(),
};
export const TaskCreate = z
  .strictObject({ project: ref.describe('Project id or key'), ...fields })
  .partial()
  .required({ project: true, title: true });
export const TaskUpdate = z.strictObject({ ...fields, project: ref.describe('Move to this project (id or key)') }).partial();
export const CommentCreate = z.strictObject({
  text: z.string().trim().min(1, 'Write a comment').max(10_000).describe('Plain text; @Name mentions notify people'),
});
