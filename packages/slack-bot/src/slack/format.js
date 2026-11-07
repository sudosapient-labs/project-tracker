/* Slack text and Block Kit: the agent's reply as mrkdwn, task cards with actions, confirmation cards,
   and the create-task modal. Everything other people wrote (titles, names) is escaped, so it can't
   become a link, a mention or formatting. */

/* Slack's three control characters. */
export const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/* Markdown a model may still write, turned into Slack mrkdwn. Code spans and blocks are left alone. */
export function mrkdwn(md) {
  return String(md || '')
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
            .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
            .replace(/__([^_\n]+)__/g, '_$1_')
            .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
            .replace(/^(\s*)[-*]\s+/gm, '$1• '),
    )
    .join('');
}

const STATUS = { backlog: 'Backlog', todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done' };
const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
export const statusName = s => STATUS[s] || s;

const button = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value, ...(style ? { style } : {}) });

/* One task as a Slack card: key, title (linked), status, assignee, due, and buttons. */
export function taskCard(t, { assignee, project, actions = true } = {}) {
  const facts = [
    statusName(t.status),
    PRIORITY[t.priority],
    assignee ? `👤 ${esc(assignee)}` : 'Unassigned',
    t.due ? `📅 ${t.due.slice(0, 10)}` : null,
    project ? esc(project) : null,
  ].filter(Boolean);
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*<${t.url}|${esc(t.key)} ${esc(t.title)}>*\n${facts.join('  ·  ')}` } }];
  if (actions && t.status !== 'done' && !t.archived)
    blocks.push({
      type: 'actions',
      block_id: `task:${t.key}`,
      elements: [
        button('Complete', 'task_complete', t.key, 'primary'),
        button('Assign to me', 'task_assign_me', t.key),
        {
          type: 'static_select',
          action_id: 'task_status',
          placeholder: { type: 'plain_text', text: 'Status' },
          options: Object.entries(STATUS).map(([value, text]) => ({ text: { type: 'plain_text', text }, value: `${t.key}|${value}` })),
        },
      ],
    });
  return blocks;
}

/* A change waiting for Confirm, in words. */
export function describeAction({ name, args }, titles = {}) {
  const k = args.key ? `${esc(args.key)}${titles[args.key] ? ` _${esc(titles[args.key])}_` : ''}` : '';
  switch (name) {
    case 'complete_task':
      return `Mark ${k} done`;
    case 'assign':
      return args.to ? `Assign ${k} to ${esc(args.to)}` : `Unassign ${k}`;
    case 'update_task': {
      const changes = Object.entries(args)
        .filter(([f]) => f !== 'key')
        .map(([f, v]) => (f === 'status' ? `status → ${statusName(v)}` : f === 'description' ? 'new description' : `${f} → ${v === '' ? 'none' : esc(v)}`));
      return `Change ${k}: ${changes.join(', ')}`;
    }
    case 'create_task':
      return `Create “${esc(args.title)}” in ${esc(args.project)}${args.assignee ? ` for ${esc(args.assignee)}` : ''}`;
    case 'comment':
      return `Comment on ${k}: “${esc(String(args.text).slice(0, 200))}”`;
    case 'link_thread':
      return `Link this thread to ${k}`;
    default:
      return `${name} ${esc(JSON.stringify(args))}`;
  }
}

export function confirmBlocks(threadId, pending, requesterSlack, titles) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${requesterSlack}>, confirm ${pending.length === 1 ? 'this change' : 'these changes'}:\n${pending.map(p => `• ${describeAction(p, titles)}`).join('\n')}`,
      },
    },
    {
      type: 'actions',
      block_id: 'pending',
      elements: [button('Confirm', 'pending_confirm', threadId, 'primary'), button('Cancel', 'pending_cancel', threadId)],
    },
  ];
}

export const confirmedBlocks = (pending, approve, by, titles) => [
  {
    type: 'section',
    text: { type: 'mrkdwn', text: `${pending.map(p => `• ${describeAction(p, titles)}`).join('\n')}\n_${approve ? 'Confirmed' : 'Cancelled'} by <@${by}>._` },
  },
];

const opt = (text, value) => ({ text: { type: 'plain_text', text: String(text).slice(0, 75) }, value });

/* "Create task" from a message: title, project, assignee, priority, due date, description. */
export function createTaskModal({ title, description, projects, members, defaultProject, meta }) {
  const projectOptions = projects.slice(0, 100).map(p => opt(`${p.key} · ${p.name}`, p.key));
  const initialProject = projectOptions.find(o => o.value === defaultProject);
  return {
    type: 'modal',
    callback_id: 'create_task',
    private_metadata: JSON.stringify(meta),
    title: { type: 'plain_text', text: 'Create task' },
    submit: { type: 'plain_text', text: 'Create' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'input',
        block_id: 'title',
        label: { type: 'plain_text', text: 'Title' },
        element: { type: 'plain_text_input', action_id: 'v', initial_value: String(title).slice(0, 200), max_length: 200 },
      },
      {
        type: 'input',
        block_id: 'project',
        label: { type: 'plain_text', text: 'Project' },
        element: { type: 'static_select', action_id: 'v', options: projectOptions, ...(initialProject ? { initial_option: initialProject } : {}) },
      },
      {
        type: 'input',
        block_id: 'assignee',
        optional: true,
        label: { type: 'plain_text', text: 'Assignee' },
        element: { type: 'static_select', action_id: 'v', options: members.slice(0, 100).map(m => opt(m.name, m.id)) },
      },
      {
        type: 'input',
        block_id: 'priority',
        optional: true,
        label: { type: 'plain_text', text: 'Priority' },
        element: { type: 'static_select', action_id: 'v', options: Object.entries(PRIORITY).map(([v, t]) => opt(t, v)) },
      },
      { type: 'input', block_id: 'due', optional: true, label: { type: 'plain_text', text: 'Due date' }, element: { type: 'datepicker', action_id: 'v' } },
      {
        type: 'input',
        block_id: 'description',
        optional: true,
        label: { type: 'plain_text', text: 'Description' },
        element: { type: 'plain_text_input', action_id: 'v', multiline: true, initial_value: String(description).slice(0, 2900) },
      },
    ],
  };
}

/* Values out of the modal's view_submission state. */
export function modalValues(view) {
  const v = id => {
    const el = view.state.values[id]?.v;
    return el?.value ?? el?.selected_option?.value ?? el?.selected_date ?? null;
  };
  return { title: v('title'), project: v('project'), assignee: v('assignee'), priority: v('priority'), due: v('due'), description: v('description') };
}
