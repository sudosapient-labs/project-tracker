/* Slack text and Block Kit: the agent's reply as mrkdwn, task cards with actions, confirmation cards,
   and the create-task modal. Everything other people wrote (titles, names) is escaped, so it can't
   become a link, a mention or formatting. */
import { isTimed, label, parseWhen } from '@sudosapient/client/dates';

/* Slack's three control characters. */
export const esc = s =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/* Whether `url` is on one of `hosts` ("*.slack.com" covers subdomains). */
export function onHost(url, hosts) {
  try {
    const h = new URL(url).host;
    return hosts.some(x => (x.startsWith('*.') ? h.endsWith(x.slice(1)) : h === x));
  } catch {
    return false;
  }
}

/* The model's reply as Slack mrkdwn. Markdown it may still write is converted, and code is left
   alone. What it writes can echo planted text, so nothing in it can ping people (<!channel>,
   <@U…>) or hide where a link goes: Slack-style <…> sequences are escaped, except links to `hosts`
   (the tracker, Slack), and other links are spelled out as "text (url)". */
export function mrkdwn(md, { hosts = [] } = {}) {
  const link = (url, text) =>
    onHost(url, hosts) ? `<${url}|${esc(text).replace(/\|/g, '/')}>` : text && text !== url ? `${esc(text)} (${esc(url)})` : esc(url);
  return String(md || '')
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2) return part.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const links = [];
      const keep = s => `\uE000${links.push(s) - 1}\uE000`;
      return part
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => keep(link(url, text)))
        .replace(/<(https?:\/\/[^|>\s]+)(?:\|([^>]*))?>/g, (_, url, text) => keep(link(url, text || url)))
        .replace(/&(?!(amp|lt|gt);)/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '_$1_')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/^(\s*)[-*]\s+/gm, '$1• ')
        .replace(/\uE000(\d+)\uE000/g, (_, n) => links[n]);
    })
    .join('');
}

/* A start or due in Slack mrkdwn. Messages are read by everyone in a channel, each on their own
   clock, so a timed one is Slack's date token: each viewer sees the day and time in their own zone
   (and 12/24h setting). Where Slack can't render the token (notifications, older clients) the
   fallback after "|" is on `tz`'s clock (the person who asked), with its zone. An all-day one is
   a plain day: it's that day wherever it's read. Only for mrkdwn: plain_text, headers and modals
   show the token as is. */
export function when(v, tz) {
  if (!v) return '';
  if (!isTimed(v)) return label(v, tz);
  return `<!date^${Math.floor(Date.parse(v) / 1000)}^{date_short_pretty} {time}|${label(v, tz, { time: '12', zone: true })}>`;
}

const STATUS = { backlog: 'Backlog', todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done' };
const PRIORITY = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
export const statusName = s => STATUS[s] || s;

const button = (text, action_id, value, style) => ({ type: 'button', text: { type: 'plain_text', text }, action_id, value, ...(style ? { style } : {}) });

/* One task as a Slack card: key, title (linked), status, assignee, due, and buttons. `tz`: the clock
   of the person it's shown for, for the due's fallback text (when()). */
export function taskCard(t, { assignee, project, actions = true, tz } = {}) {
  const facts = [
    statusName(t.status),
    PRIORITY[t.priority],
    assignee ? `👤 ${esc(assignee)}` : 'Unassigned',
    t.due ? `📅 ${when(t.due, tz)}` : null,
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

const short = (v, n) => {
  const s = String(v ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

/* A start or due of a change waiting for Confirm, as when() shows it: a stored value (agent.js pins
   them), or on a card saved before that, the model's words on `tz`, the asker's clock; as given when
   it can't be read (or `tz` isn't known: a card saved before it was kept). */
const givenWhen = (v, tz) => {
  const value = tz && v ? parseWhen(v, tz) : null;
  return value ? when(value, tz) : esc(short(v, 120));
};

/* A change waiting for Confirm, in words. `tz`: the clock of the person who asked. */
export function describeAction({ name, args }, titles = {}, tz) {
  const k = args.key ? `${esc(short(args.key, 30))}${titles[args.key] ? ` _${esc(short(titles[args.key], 80))}_` : ''}` : '';
  switch (name) {
    case 'complete_task':
      return `Mark ${k} done`;
    case 'assign':
      return args.to ? `Assign ${k} to ${esc(args.to)}` : `Unassign ${k}`;
    case 'update_task': {
      const changes = Object.entries(args)
        .filter(([f]) => f !== 'key')
        .map(([f, v]) =>
          f === 'status'
            ? `status → ${statusName(v)}`
            : f === 'description'
              ? `description → “${esc(short(v, 400))}”`
              : `${f} → ${v === '' ? 'none' : f === 'due' ? givenWhen(v, tz) : esc(short(v, 120))}`,
        );
      return `Change ${k}: ${changes.join(', ')}`;
    }
    case 'create_task':
      return `Create “${esc(short(args.title, 120))}” in ${esc(args.project)}${args.assignee ? ` for ${esc(args.assignee)}` : ''}${args.due ? `, due ${givenWhen(args.due, tz)}` : ''}`;
    case 'comment':
      return `Comment on ${k}: “${esc(short(args.text, 400))}”`;
    case 'link_thread':
      return `Link this thread to ${k}`;
    default:
      return `${name} ${esc(JSON.stringify(args))}`;
  }
}

/* The changes as a list that fits a section (3000 characters): the first ones in full, then a count. */
function changeList(pending, titles, tz) {
  const lines = [];
  let used = 0;
  for (const [i, p] of pending.entries()) {
    const line = `• ${describeAction(p, titles, tz)}`;
    if (used + line.length > 2500) {
      lines.push(`…and ${pending.length - i} more`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/* A confirmation card. `id` is the card's own (store.saveConfirmation), so a press acts on exactly
   these changes. `tz`: the asker's clock, which the changes' dates are on. */
export function confirmBlocks(id, pending, requesterSlack, titles, tz) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<@${requesterSlack}>, confirm ${pending.length === 1 ? 'this change' : 'these changes'}:\n${changeList(pending, titles, tz)}`,
      },
    },
    {
      type: 'actions',
      block_id: 'pending',
      elements: [button('Confirm', 'pending_confirm', id, 'primary'), button('Cancel', 'pending_cancel', id)],
    },
  ];
}

/* A card once decided, superseded or expired: the changes, then what happened. */
export const resolvedBlocks = (pending, note, titles, tz) => [
  { type: 'section', text: { type: 'mrkdwn', text: `${changeList(pending, titles, tz)}\n_${note}_` } },
];

export const loadingModal = () => ({
  type: 'modal',
  title: { type: 'plain_text', text: 'Create task' },
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '_Loading…_' } }],
});
export const messageModal = (title, text) => ({
  type: 'modal',
  title: { type: 'plain_text', text: title },
  close: { type: 'plain_text', text: 'Close' },
  blocks: [{ type: 'section', text: { type: 'mrkdwn', text: esc(text).slice(0, 2900) } }],
});

const opt = (text, value) => ({ text: { type: 'plain_text', text: String(text).slice(0, 75) }, value });

/* "Create task" from a message: title, project, assignee, priority, due date, description. The due
   time is on `tz`, the clock of the person filling it in: the timepicker shows that zone under it,
   and `meta.tz` keeps it for the submission (handlers.js onCreateSubmit). */
export function createTaskModal({ title, description, projects, members, defaultProject, meta, tz }) {
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
        block_id: 'due_time',
        optional: true,
        label: { type: 'plain_text', text: 'Due time' },
        element: { type: 'timepicker', action_id: 'v', ...(tz ? { timezone: tz } : {}) },
      },
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
    return el?.value ?? el?.selected_option?.value ?? el?.selected_date ?? el?.selected_time ?? null;
  };
  return {
    title: v('title'),
    project: v('project'),
    assignee: v('assignee'),
    priority: v('priority'),
    due: v('due'),
    dueTime: v('due_time'),
    // The zone the timepicker showed, if Slack sends it back.
    dueTimeZone: view.state.values.due_time?.v?.timezone ?? null,
    description: v('description'),
  };
}
