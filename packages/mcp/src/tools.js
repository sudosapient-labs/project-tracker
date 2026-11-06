/* MCP tools and resources over the public API. Written for a small context budget: one-line
   descriptions, minimal schemas, and compact JSON results (task keys and people's names instead of
   ids, empty fields dropped). Every call goes through /api/v1 with the person's own key, so the
   server's permission rules apply; write tools are hidden for read-only keys.

   `api` is a client from @sudosapient/client (or anything with get/post/patch/all). */

const seg = ref => encodeURIComponent(String(ref).trim());
const str = (description, extra = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
// Keys, project keys and people are explained once, in the server's instructions (protocol.js),
// not on every property that takes one.
const KEY = str();
const STATUS = ['backlog', 'todo', 'progress', 'review', 'done'];
const PRIORITY = ['urgent', 'high', 'medium', 'low', 'none'];

/* Drop null, '', [] and false so results carry only what's set. */
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && v !== false && !(Array.isArray(v) && !v.length)));
const when = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : null);
const names = async api => new Map((await api.all('/members')).map(m => [m.id, m.name]));

const brief = (t, who) =>
  compact({
    key: t.key,
    title: t.title,
    status: t.status,
    priority: t.priority === 'none' ? null : t.priority,
    assignee: who.get(t.assignee),
    due: t.due,
    archived: t.archived,
  });
const byDue = (a, b) => (a.due || '9999').localeCompare(b.due || '9999');

async function taskDetail(api, ref) {
  const [t, comments, activity, who] = await Promise.all([
    api.get(`/tasks/${seg(ref)}`),
    api.get(`/tasks/${seg(ref)}/comments`, { limit: 20 }),
    api.get(`/tasks/${seg(ref)}/activity`, { limit: 10 }),
    names(api),
  ]);
  return compact({
    ...brief(t, who),
    start: t.start,
    labels: t.labels,
    estimate: t.estimate,
    description: t.description.length > 2000 ? t.description.slice(0, 2000) + '…' : t.description,
    subtasks: t.subtasks.map(s => `[${s.done ? 'x' : ' '}] ${s.title}`),
    comments: comments.data.map(c => `${when(c.createdAt)} ${who.get(c.author) || '?'}: ${c.text}`),
    activity: activity.data.map(a => `${when(a.at)} ${who.get(a.by) || '?'}${a.via ? ` via ${a.via}` : ''} ${a.verb}${a.extra ? ' ' + a.extra : ''}`),
    url: t.url,
  });
}

async function myWork(api, { status = 'open', limit = 30 } = {}) {
  const who = await names(api);
  const tasks = await api.all('/tasks', { assignee: 'me', status: status === 'all' ? undefined : status }, Math.min(Number(limit) || 30, 100));
  return tasks.sort(byDue).map(t => brief(t, who));
}

async function projectSummary(api, ref) {
  const [p, tasks, who] = await Promise.all([api.get(`/projects/${seg(ref)}`), api.all('/tasks', { project: ref }, 500), names(api)]);
  const today = new Date().toISOString().slice(0, 10);
  const open = tasks.filter(t => t.status !== 'done');
  const byStatus = Object.fromEntries(STATUS.map(s => [s, tasks.filter(t => t.status === s).length]).filter(([, n]) => n));
  return compact({
    key: p.key,
    name: p.name,
    status: p.status,
    lead: who.get(p.lead),
    due: p.due,
    private: p.private,
    tasks: byStatus,
    overdue: open
      .filter(t => t.due && t.due.slice(0, 10) < today)
      .sort(byDue)
      .slice(0, 10)
      .map(t => brief(t, who)),
    unassigned: open.filter(t => !t.assignee).length,
    next: open
      .filter(t => !(t.due && t.due.slice(0, 10) < today))
      .sort(byDue)
      .slice(0, 10)
      .map(t => brief(t, who)),
    url: p.url,
  });
}

/* name → { description, inputSchema, write?, run(api, args) }. */
export const TOOLS = {
  search: {
    description: 'Search tasks, projects and people.',
    inputSchema: obj({ q: str() }, ['q']),
    async run(api, { q }) {
      const [r, who] = await Promise.all([api.get('/search', { q, limit: 10 }), names(api)]);
      return compact({
        tasks: r.tasks.map(t => brief(t, who)),
        projects: r.projects.map(p => compact({ key: p.key, name: p.name })),
        people: r.members.map(m => compact({ name: m.name, email: m.email })),
      });
    },
  },
  get_task: {
    description: 'Task details with recent comments and activity.',
    inputSchema: obj({ key: KEY }, ['key']),
    run: (api, { key }) => taskDetail(api, key),
  },
  list_my_work: {
    description: 'Tasks assigned to me, soonest due first.',
    inputSchema: obj({ status: { enum: ['open', 'done', 'all'], default: 'open' }, limit: { type: 'integer', default: 30 } }),
    run: myWork,
  },
  list_projects: {
    description: 'Projects with open/done task counts.',
    inputSchema: obj({}),
    async run(api) {
      return (await api.all('/projects')).map(p =>
        compact({ key: p.key, name: p.name, status: p.status, open: p.openTasks, done: p.doneTasks, private: p.private }),
      );
    },
  },
  list_members: {
    description: 'People in the workspace.',
    inputSchema: obj({}),
    async run(api) {
      return (await api.all('/members')).map(m =>
        compact({ name: m.name, email: m.email, role: m.role, invited: m.status === 'invited', bot: m.kind === 'bot' }),
      );
    },
  },
  summarise_project: {
    description: 'Project health: counts, overdue, unassigned, next due.',
    inputSchema: obj({ project: str() }, ['project']),
    run: (api, { project }) => projectSummary(api, project),
  },
  create_task: {
    write: true,
    description: 'Create a task. Returns its key.',
    inputSchema: obj(
      {
        project: str(),
        title: str(),
        description: str(),
        assignee: str(),
        due: str('YYYY-MM-DD'),
        priority: { enum: PRIORITY },
      },
      ['project', 'title'],
    ),
    async run(api, a) {
      const t = await api.post('/tasks', a);
      return { key: t.key, url: t.url };
    },
  },
  update_task: {
    write: true,
    description: 'Change a task’s fields; omitted fields stay.',
    inputSchema: obj(
      {
        key: KEY,
        title: str(),
        status: { enum: STATUS },
        priority: { enum: PRIORITY },
        due: str('YYYY-MM-DD, or "" to clear'),
        description: str(),
        project: str('Move to'),
      },
      ['key'],
    ),
    async run(api, { key, due, ...rest }) {
      const t = await api.patch(`/tasks/${seg(key)}`, { ...rest, ...(due !== undefined ? { due: due || null } : {}) });
      return brief(t, await names(api));
    },
  },
  complete_task: {
    write: true,
    description: 'Mark a task done.',
    inputSchema: obj({ key: KEY }, ['key']),
    async run(api, { key }) {
      const t = await api.post(`/tasks/${seg(key)}/complete`);
      return { key: t.key, status: t.status };
    },
  },
  assign: {
    write: true,
    description: 'Assign a task; to="" unassigns.',
    inputSchema: obj({ key: KEY, to: str() }, ['key', 'to']),
    async run(api, { key, to }) {
      const t = await api.patch(`/tasks/${seg(key)}`, { assignee: to ? to : null });
      return brief(t, await names(api));
    },
  },
  comment: {
    write: true,
    description: 'Comment on a task. @Name mentions notify.',
    inputSchema: obj({ key: KEY, text: str() }, ['key', 'text']),
    async run(api, { key, text }) {
      const c = await api.post(`/tasks/${seg(key)}/comments`, { text });
      return { id: c.id };
    },
  },
};

// Reads never change anything, so clients needn't ask before running them; writes carry no hint
// and clients that confirm tool use will ask.
for (const t of Object.values(TOOLS)) if (!t.write) t.annotations = { readOnlyHint: true };

export const RESOURCES = [{ uri: 'sudo://my-work', name: 'my-work', description: 'My open tasks', mimeType: 'application/json' }];
export const RESOURCE_TEMPLATES = [{ uriTemplate: 'sudo://project/{key}', name: 'project', description: 'Project summary', mimeType: 'application/json' }];
export async function readResource(api, uri) {
  if (uri === 'sudo://my-work') return myWork(api);
  const m = /^sudo:\/\/project\/([A-Za-z0-9_-]+)$/.exec(uri);
  if (m) return projectSummary(api, m[1]);
  return null;
}

/* The tools a key may use: write tools only with a write key, unless forced read-only. */
export const toolsFor = ({ scope = 'write', readOnly = false } = {}) =>
  Object.entries(TOOLS)
    .filter(([, t]) => !t.write || (scope === 'write' && !readOnly))
    .map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) }));
