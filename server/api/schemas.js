// @ts-check
/* Shapes of the public API (/api/v1). Inputs are validated with these schemas, and the OpenAPI
   document (openapi.js) is generated from the same objects, so the two can't drift. Records are
   the public view of the synced ones (sync/schemas.js), with stable, documented field names. */
import { z } from 'zod';
import { PCOLORS, PICONS, PRIOS, PSTAT, REACTIONS, RECUR, ROLES, STATUSES, validTz } from '../../src/core/constants.js';
import { PERMS } from '../../src/core/access.js';
import { FILE_TYPES } from '../../src/core/file-types.js';
import { DEFAULT_NOTIF_PREFS } from '../notify.js';
import { checkWhen } from '../../packages/client/dates.js';

const WHEN =
  'YYYY-MM-DD for all day, or an ISO 8601 date-time with a zone (Z or an offset like +05:30) for a time of day; times are stored and returned in UTC';
// How a stored start or due reads, on records.
const WHEN_OUT = 'YYYY-MM-DD (all day), or a UTC date-time like 2026-11-09T18:29:00.000Z (a time of day; show it in the reader’s time zone)';

export const registry = z.registry();
const named = (id, schema, description) => {
  registry.add(schema, { id, description });
  return schema;
};

const STATUS = z.enum(STATUSES.map(s => s.id));
const PRIORITY = z.enum(PRIOS.map(p => p.id));
// A start or due (packages/client/dates.js): 'YYYY-MM-DD' (all day), or an ISO date-time with a zone
// (timed), stored and returned as UTC ('2026-11-09T18:29:00.000Z'). A date-time without a zone is
// refused: it would be a different moment depending on whose clock read it. The day must exist:
// 2026-02-31 would read as "Invalid Date" in activity and break scheduling the next repeat.
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/, { message: 'Use YYYY-MM-DD or an ISO date-time', abort: true })
  .superRefine((v, ctx) => {
    const c = checkWhen(v);
    if ('error' in c) ctx.addIssue({ code: 'custom', message: c.error });
  })
  .overwrite(v => {
    const c = checkWhen(v);
    return c.ok ? c.value : v;
  })
  .describe(WHEN);
const ms = z.number().int().describe('Unix time in milliseconds');
const ref = z.string().min(1).max(254);
// Any IANA time zone. Whose clock is used is decided by server/lib/clock.js.
const tz = z
  .string()
  .max(64)
  .refine(v => !!validTz(v), 'Use an IANA time zone, like Asia/Dubai or UTC');
const zoneFields = {
  timeZone: z
    .string()
    .describe(
      'The IANA time zone this person’s starts, dues and reminders are read in: their own (Settings → Date and time), else the workspace’s, else UTC. Show their times in it.',
    ),
  timeZoneSource: z
    .enum(['person', 'workspace', 'default'])
    .describe('Where timeZone comes from: person (they set it), workspace (the workspace’s zone), default (UTC: neither is set)'),
};

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

const Kind = z
  .enum(['person', 'bot'])
  .describe('“bot”: a bot member an Owner or Admin made in Settings → API → Bots. It acts only through its keys and never signs in.');

export const Member = named(
  'Member',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().describe('Empty for bots, and for Guests looking at people they share no project with'),
    role: z.enum(ROLES),
    title: z.string(),
    team: z.string().describe('Team id, or empty'),
    status: z.enum(['active', 'invited']),
    kind: Kind,
    ...zoneFields,
  }),
  'A person or bot in the workspace.',
);

export const Me = named(
  'Me',
  z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().describe('Empty for a bot'),
    role: z.enum(ROLES),
    title: z.string(),
    team: z.string(),
    status: z.enum(['active', 'invited']),
    kind: Kind,
    ...zoneFields,
    workspace: z.string(),
    key: z.object({
      id: z.string(),
      name: z.string(),
      scope: z.enum(['read', 'write']).describe('write: everything the person’s role allows; read: only reading'),
      expiresAt: ms.nullable(),
    }),
  }),
  'The person or bot the API key belongs to.',
);

export const Revoked = named(
  'Revoked',
  z.object({ revoked: z.literal(true), id: z.string().describe('The id of the key that was revoked') }),
  'The key that made the request is revoked and no longer works.',
);

export const Subtask = named(
  'Subtask',
  z.object({ id: z.string(), title: z.string(), done: z.boolean(), assignee: z.string().nullable(), due: z.string().nullable().describe(WHEN_OUT) }),
  'A checklist item of a task.',
);

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
    due: z.string().nullable().describe(WHEN_OUT),
    start: z.string().nullable().describe(WHEN_OUT),
    labels: z.array(z.string()),
    estimate: z.string().nullable(),
    subtasks: z.array(Subtask),
    dependsOn: z.array(z.string()).describe('Ids of the tasks this one waits on'),
    recurrence: z.enum(RECUR).nullable().describe('Repeats: completing it schedules the next one'),
    attachments: z.array(z.object({ id: z.string(), name: z.string(), size: z.string(), url: z.string().nullable() })).describe('Files attached (see /files)'),
    favorite: z.boolean().describe('Starred by the key’s person'),
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
    permissions: z
      .record(z.string(), z.enum(PERMS))
      .describe('Member id → permission set in the share dialog (listed people without one: Guests comment, others edit)'),
    private: z.boolean(),
    archived: z.boolean(),
    start: z.string().nullable().describe(WHEN_OUT),
    due: z.string().nullable().describe(WHEN_OUT),
    icon: z.string(),
    color: z.string(),
    team: z.string().describe('Team id, or empty'),
    milestones: z.array(z.object({ name: z.string(), date: z.string().nullable().describe(WHEN_OUT) })),
    favorite: z.boolean(),
    access: z
      .enum(['view', 'comment', 'edit', 'full', 'none'])
      .describe('What the key’s person may do here; "none": an Owner/Admin’s view of a project they’re not in (settings only)'),
    openTasks: z.number().int(),
    doneTasks: z.number().int(),
  }),
  'A project the key can open (or, for an Owner or Admin, one whose settings they manage).',
);

export const Comment = named(
  'Comment',
  z.object({
    id: z.string(),
    task: z.string().describe('Task id'),
    author: z.string().describe('Member id'),
    text: z.string(),
    reactions: z.record(z.string(), z.array(z.string())).describe('Emoji → member ids who reacted'),
    createdAt: ms,
  }),
  'A comment on a task.',
);

export const Activity = named(
  'Activity',
  z.object({
    id: z.string(),
    by: z.string().describe('Member id'),
    verb: z.string().describe('e.g. "created", "completed", "moved"'),
    extra: z.string().describe('The words after the verb and task, e.g. "to Nov 10, 6:30 PM"; a start or due in it is on your clock'),
    when: z
      .string()
      .nullable()
      .optional()
      .describe(
        `For an entry that set a start or due: the value it was set to, null when cleared. ${WHEN_OUT}. Absent on other entries, and on ones saved before it was kept.`,
      ),
    via: z.string().nullable().describe('What made the change when it was not the app, e.g. "Claude" or "CLI"'),
    task: z.string().nullable(),
    taskKey: z.string().nullable().describe('The task’s key (e.g. WEB-12), while it exists'),
    project: z.string().nullable().describe('Project id; null for workspace-wide entries'),
    at: ms,
  }),
  'An entry in the activity log.',
);

const page = (id, item, what, extra = {}) =>
  named(
    id,
    z.object({ data: z.array(item), nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page; null on the last'), ...extra }),
    `A page of ${what}.`,
  );
export const TaskPage = named(
  'TaskPage',
  z.object({
    data: z.array(Task),
    nextCursor: z.string().nullable().describe('Pass as `cursor` (with the same `sort`) to get the next page; null on the last'),
    sort: z.enum(['due']).optional().describe('Set when the request asked for `sort=due` and the list is in that order'),
  }),
  'A page of tasks.',
);
/* A task's comments and activity also say how many there are in all, so a client showing only the
   newest can say how many older ones it left out. */
const total = z.number().int().min(0).describe('How many there are in all, across every page');
export const ProjectPage = page('ProjectPage', Project, 'projects');
export const CommentPage = page('CommentPage', Comment, 'a task’s comments', { total });
export const MemberPage = page('MemberPage', Member, 'people');
export const ActivityPage = page('ActivityPage', Activity, 'activity');
export const TaskActivityPage = page('TaskActivityPage', Activity, 'a task’s activity', { total });
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
  sort: z
    .enum(['created', 'due'])
    .optional()
    .describe('created (default): newest first. due: soonest due first, tasks without a due date last, then newest first'),
  limit,
  cursor,
});
export const PageQuery = z.object({ limit, cursor });
const order = (dflt, what) =>
  z.enum(['oldest', 'newest']).optional().describe(`${what} oldest or newest first (default ${dflt}). Either way, nextCursor carries on in that order.`);
export const CommentQuery = PageQuery.extend({ order: order('oldest', 'Comments') });
export const TaskActivityQuery = PageQuery.extend({ order: order('newest', 'Entries') });
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
  recurrence: z.enum(RECUR).nullable().describe('Daily, Weekly, Every 2 weeks or Monthly; null for none'),
  dependsOn: z.array(ref).max(100).describe('Task ids or keys this one waits on; replaces the list'),
};
export const TaskCreate = z
  .strictObject({
    project: ref.describe('Project id or key'),
    ...fields,
    subtasks: z.array(z.object({ title: z.string().trim().min(1).max(500), done: z.boolean().optional(), assignee: ref.nullable().optional() })).max(200),
  })
  .partial()
  .required({ project: true, title: true });
export const TaskUpdate = z
  .strictObject({
    ...fields,
    project: ref.describe('Move to this project (id or key)'),
    order: z.number().finite().describe('Position in a manual sort (lower first), as dragging in a list or on a board sets'),
  })
  .partial();
export const CommentCreate = z.strictObject({
  text: z.string().trim().min(1, 'Write a comment').max(10_000).describe('Plain text; @Name mentions notify people'),
});

/* ---------- more records ---------- */
export const Team = named(
  'Team',
  z.object({ id: z.string(), name: z.string(), description: z.string(), icon: z.string(), color: z.string(), members: z.array(z.string()) }),
  'A team: a group of people (members carry their team id).',
);
export const TeamList = named('TeamList', z.object({ data: z.array(Team) }), 'Every team.');

export const Invited = named(
  'Invited',
  z.object({ member: Member, link: z.string().optional().describe('Only on servers that expose email links (development)') }),
  'The person invited; they’re emailed a link to join.',
);
export const Ok = named('Ok', z.object({ ok: z.literal(true) }), 'Done.');
export const Deleted = named(
  'Deleted',
  z.object({ deleted: z.literal(true), id: z.string(), restoreUntil: ms.optional().describe('Undo with …/undelete until then (tasks and comments)') }),
  'Deleted.',
);

export const File = named(
  'File',
  z.object({
    id: z.string(),
    project: z.string(),
    task: z.string().nullable().describe('Task id it’s attached to'),
    taskKey: z.string().nullable(),
    name: z.string(),
    type: z.enum(FILE_TYPES),
    size: z.string().describe('Readable size, e.g. "1.2 MB"'),
    uploadedBy: z.string().nullable(),
    uploadedAt: ms,
    url: z.string().nullable().describe('Download it with GET /files/{id}/content'),
  }),
  'A file in a project.',
);

export const Event = named(
  'Event',
  z.object({
    id: z.string(),
    title: z.string(),
    date: z.string().describe('YYYY-MM-DD: its day on your clock (timeZone on GET /me/preferences)'),
    time: z.string().describe('HH:MM (24h): when it starts on your clock, or empty for all day'),
    when: z
      .string()
      .nullable()
      .describe(
        'The event as stored: YYYY-MM-DD for all day, or the UTC moment it starts (2026-11-10T04:30:00.000Z), the same for everyone; null for an event saved before times had a zone that could not be read',
      ),
    project: z.string().nullable().describe('Project id; null for a workspace-wide event'),
  }),
  'A calendar event. A timed one is one moment: each reader gets its day and time on their own clock.',
);

const Filter = z.object({
  field: z.enum(['status', 'assignee', 'priority', 'due', 'project', 'labels', 'created', 'updated']),
  op: z.enum(['is', 'not']),
  values: z.array(z.string().max(64)).max(200),
});
export const SavedView = named(
  'SavedView',
  z.object({ id: z.string(), project: z.string(), name: z.string(), type: z.enum(['list', 'board', 'table']), filters: z.array(Filter) }),
  'A saved view: a named set of filters on a project’s tasks.',
);

export const Notification = named(
  'Notification',
  z.object({
    id: z.string(),
    type: z.string().describe('assign, mention, comment, update, due, …'),
    by: z.string().nullable(),
    task: z.string().nullable(),
    taskKey: z.string().nullable().describe('The task’s key (e.g. WEB-12), while it exists'),
    project: z.string().nullable(),
    text: z.string(),
    snippet: z.string(),
    read: z.boolean(),
    at: ms,
  }),
  'A notification in the inbox of the key’s person.',
);

export const Workspace = named(
  'Workspace',
  z.object({
    name: z.string(),
    color: z.string(),
    brand: z.boolean().describe('Show the workspace logo in the sidebar'),
    timeZone: z.string().nullable().describe('IANA time zone for people who haven’t set their own (bots too); null: not set, so they get UTC'),
  }),
  'Workspace settings.',
);

const PREF_SCHEMA = {
  theme: z.enum(['light', 'dark', 'system']),
  accent: z.enum(['indigo', 'blue', 'violet', 'teal', 'rose', 'graphite']),
  side: z.enum(['comfortable', 'compact']).describe('Sidebar density'),
  density: z.enum(['comfortable', 'compact']).describe('Task rows and cards'),
  motion: z.enum(['system', 'reduce']),
  lang: z.enum(['English (US)', 'English (UK)', 'Deutsch', 'Español', 'Français', '日本語']),
  spell: z.boolean().describe('Spellcheck in descriptions and comments'),
  tz: tz.describe('Your own time zone (any IANA zone) for starts, dues and reminders; without one, the workspace’s is used'),
  timeFmt: z.enum(['12', '24']),
  dateFmt: z.enum(['MMM d', 'd/M', 'M/d', 'yyyy-MM-dd']),
  weekStart: z.union([z.literal(0), z.literal(1), z.literal(6)]).describe('0 Sunday, 1 Monday, 6 Saturday'),
  home: z.string().max(40).describe('The page the app opens on'),
  openTasks: z.string().max(40).describe('How tasks open (drawer or page)'),
  defaultTab: z.string().max(40).describe('The tab a new project opens on'),
  showDoneBoard: z.boolean().describe('Show the Done column on boards'),
  confirmDel: z.boolean().describe('Ask before deleting a task'),
};
export const PREF_KEYS = Object.keys(PREF_SCHEMA);
const NOTIF_SCHEMA = Object.fromEntries(Object.keys(DEFAULT_NOTIF_PREFS).map(k => [k, z.boolean()]));
export const Preferences = named(
  'Preferences',
  z.object({
    preferences: z.object(PREF_SCHEMA).partial().describe('Display preferences (Settings → Appearance, Language, Date and time); tz only when you set one'),
    notifications: z.object(NOTIF_SCHEMA).describe('Notification preferences (Settings → Notifications)'),
    ...zoneFields,
  }),
  'The key’s person’s preferences.',
);
export const Favorites = named(
  'Favorites',
  z.object({ projects: z.array(z.string()), tasks: z.array(z.string()), projectOrder: z.array(z.string()).describe('Sidebar order of project ids') }),
  'What the key’s person starred, and their sidebar order.',
);

export const Bot = named(
  'Bot',
  z.object({
    id: z.string(),
    name: z.string(),
    role: z.enum(['Member', 'Guest']),
    createdAt: ms,
    projects: z.array(z.string()),
    keys: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        prefix: z.string(),
        scope: z.enum(['read', 'write']),
        createdAt: ms,
        lastUsedAt: ms.nullable(),
        expiresAt: ms.nullable(),
        createdBy: z.string().nullable(),
      }),
    ),
  }),
  'A bot member and its keys (metadata only; key secrets are shown once, in Settings).',
);
export const BotList = named('BotList', z.object({ data: z.array(Bot) }), 'Every bot.');
export const MarkedRead = named('MarkedRead', z.object({ updated: z.number().int().describe('How many were unread') }), 'Notifications marked read.');
export const InviteLink = named('InviteLink', z.object({ link: z.string() }), 'A reusable link to join as a Member; making one turns the previous one off.');

export const FilePage = page('FilePage', File, 'files');
export const EventPage = page('EventPage', Event, 'events');
export const SavedViewPage = page('SavedViewPage', SavedView, 'saved views');
export const NotificationPage = page('NotificationPage', Notification, 'notifications');

/* ---------- more inputs ---------- */
export const IdParam = z.object({ id: ref.describe('Id') });
export const SubtaskParams = z.object({ ref: ref.describe('Task id or key'), id: ref.describe('Subtask id') });
export const ProjectMemberParams = z.object({ ref: ref.describe('Project id or key'), member: ref.describe('Member id, email, name or "me"') });
export const ReactionParams = z.object({ id: ref.describe('Comment id'), emoji: z.enum(REACTIONS) });
export const BotKeyParams = z.object({ id: ref.describe('Bot id'), keyId: ref.describe('Key id') });

const who = ref.describe('Member id, email, name or "me"');
const projectFields = {
  name: z.string().trim().min(1, 'Give the project a name').max(120),
  description: z.string().max(5000),
  icon: z.enum(PICONS),
  color: z.enum(Object.keys(PCOLORS)),
  status: z.enum(Object.keys(PSTAT)).describe('planning, active, risk, hold or complete'),
  lead: who.nullable(),
  team: ref.nullable().describe('Team id; null for none'),
  start: date.nullable(),
  due: date.nullable(),
  private: z.boolean().describe('Only listed people (and the lead) can open it'),
  milestones: z
    .array(z.object({ name: z.string().trim().min(1).max(200), date: date.nullable().optional() }))
    .max(100)
    .describe('Replaces the whole list'),
};
export const ProjectCreate = z
  .strictObject({
    ...projectFields,
    key: z
      .string()
      .regex(/^[A-Za-z]{1,8}$/, 'A key is 1–8 letters, e.g. WEB')
      .optional()
      .describe('Prefix of its task keys (1–8 letters); made from the name when left out'),
    members: z
      .array(z.object({ member: who, permission: z.enum(PERMS).optional() }))
      .max(1000)
      .describe('People to list on it, besides you'),
  })
  .partial()
  .required({ name: true });
export const ProjectUpdate = z.strictObject(projectFields).partial();
export const ProjectShare = z.strictObject({ permission: z.enum(PERMS).optional().describe('Default: Guests Can comment, others Can edit') });

export const TeamCreate = z.strictObject({
  name: z.string().trim().min(1, 'Give the team a name').max(60),
  description: z.string().max(500).optional(),
  icon: z.string().max(40).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, 'A colour is #RRGGBB')
    .optional(),
  members: z.array(ref).max(1000).optional().describe('Exactly who is on the team (ids, emails or names); replaces it'),
});
export const TeamUpdate = TeamCreate.partial();

export const MemberInvite = z.strictObject({
  email: z
    .string()
    .trim()
    .max(254)
    .regex(/^\S+@\S+\.\S+$/, 'Enter a valid email address'),
  name: z.string().trim().min(1).max(80).optional().describe('Defaults to the part of the email before @'),
  role: z.enum(['Admin', 'Member', 'Guest']).optional().describe('Default Member; only Owners and Admins invite Admins'),
  team: ref.nullable().optional(),
  title: z.string().max(80).optional(),
});
export const MemberUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    title: z.string().max(80),
    team: ref.nullable().describe('Team id; null for none'),
    role: z.enum(ROLES).describe('Owners and Admins only'),
  })
  .partial();
export const MeUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    title: z.string().max(80),
    team: ref.nullable(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'A colour is #RRGGBB'),
  })
  .partial();
export const PreferencesUpdate = z.strictObject({
  preferences: z.strictObject(PREF_SCHEMA).partial().optional(),
  notifications: z.strictObject(NOTIF_SCHEMA).partial().optional(),
});
export const ProjectOrder = z.strictObject({ projects: z.array(ref).max(5000).describe('Project ids or keys, top first') });

export const BotCreate = z.strictObject({
  name: z.string().trim().min(1, 'Name the bot, e.g. “Release Bot”').max(80),
  role: z.enum(['Member', 'Guest']).optional(),
  projects: z.array(ref).max(1000).optional().describe('Project ids or keys it is listed on'),
});
export const BotUpdate = BotCreate.partial();

export const WorkspaceUpdate = z
  .strictObject({
    name: z.string().trim().min(1).max(80),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'A colour is #RRGGBB'),
    brand: z.boolean(),
    timeZone: tz.nullable().describe('IANA time zone for people who haven’t set their own; null unsets it'),
  })
  .partial();

export const SubtaskCreate = z.strictObject({
  title: z.string().trim().min(1, 'Give the subtask a name').max(500),
  done: z.boolean().optional(),
  assignee: who.nullable().optional(),
  due: date.nullable().optional(),
});
export const SubtaskUpdate = SubtaskCreate.partial();

export const CommentUpdate = CommentCreate;

export const FileQuery = z.object({ project: ref.optional().describe('Project id or key'), task: ref.optional().describe('Task id or key'), limit, cursor });
export const FileUploadQuery = z.object({
  project: ref.optional().describe('Project id or key (or give task)'),
  task: ref.optional().describe('Task id or key to attach it to'),
  name: z.string().trim().min(1, 'Name the file, e.g. name=spec.pdf').max(255),
});
export const FileUpdate = z
  .strictObject({ name: z.string().trim().min(1).max(255), task: ref.nullable().describe('Attach to this task (id or key); null detaches') })
  .partial();
export const DownloadQuery = z.object({ download: bool.describe('true: always as an attachment') });

const time = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d)?$/, 'Use HH:MM, or empty for all day')
  .describe('HH:MM (24h) on your clock, or empty for all day');
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => checkWhen(v).ok, 'That date doesn’t exist');
export const EventQuery = z.object({
  project: ref.optional().describe('Project id or key'),
  from: day.optional().describe('From this day (YYYY-MM-DD) on your clock'),
  to: day.optional().describe('To this day, on your clock'),
  limit,
  cursor,
});
// The day and time are read on the key's person's clock (timeZone on GET /me/preferences); a timed
// event is stored as the moment it starts.
export const EventCreate = z.strictObject({
  title: z.string().trim().min(1, 'Give the event a title').max(200),
  date: day.describe('YYYY-MM-DD, on your clock'),
  time: time.optional(),
  project: ref.nullable().optional().describe('Project id or key; null or left out for a workspace-wide event (admins only)'),
});
export const EventUpdate = EventCreate.partial();

export const ViewQuery = z.object({ project: ref.optional(), limit, cursor });
export const ViewCreate = z.strictObject({
  project: ref.describe('Project id or key'),
  name: z.string().trim().min(1, 'Name the view').max(80),
  type: z.enum(['list', 'board', 'table']).optional(),
  filters: z.array(Filter).max(50).optional(),
});
export const ViewUpdate = ViewCreate.omit({ project: true }).partial();

export const NotificationQuery = z.object({ unread: bool.describe('true: only unread'), limit, cursor });
export const NotificationUpdate = z.strictObject({ read: z.boolean() });

export const ActivityQuery = z.object({
  project: ref.optional().describe('Project id or key'),
  limit,
  cursor,
});
