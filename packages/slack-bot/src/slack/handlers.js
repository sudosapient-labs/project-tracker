/* Slack → Sudo Tracker. Every surface the bot has:

   - @mention in a channel or thread, and DMs: the agent (agent.js) reads the thread and acts
   - Confirm / Cancel on changes the agent holds for confirmation
   - task cards under replies: Complete, Assign to me, Status
   - `/sudo …`: new (modal), my, search, project, link, guidance, help
   - the "Create task" message shortcut: a modal prefilled from the message
   - link previews (unfurls) for tracker task and project links

   Handlers take Bolt's listener arguments but only use plain fields and the Web API client, so tests
   drive them with a fake client. app.js wires them to Bolt and acks. */
import { createClient } from '@sudosapient/client';
import { EDIT, VIEW, isAdmin, level, unmatchedText } from '../people.js';
import { requestMessage } from '../prompt.js';
import { confirmBlocks, confirmedBlocks, createTaskModal, esc, modalValues, mrkdwn, statusName, taskCard } from './format.js';

const seg = ref => encodeURIComponent(String(ref).trim());
const WORKING = '_Working on it…_';
const MAX_CARDS = 5;

export function createHandlers({ config, store, agent, dir, people, slack, reader, fetch }) {
  /* A tracker client with the bot's key, labelled for Activity: "Sudo Tracker via Slack (Ada)". */
  const trackerAs = member => createClient({ url: config.tracker.url, key: config.tracker.key, client: `Slack (${member.name})`, ...(fetch ? { fetch } : {}) });

  /* One run at a time per conversation; later requests wait their turn. */
  const locks = new Map();
  function serial(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {});
    return next;
  }

  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());

  async function post(channel, threadTs, payload) {
    return slack.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, ...payload });
  }

  /* Cards for the tasks a run created or changed. */
  async function cards(api, keys) {
    const out = [];
    const who = new Map((await dir.members()).map(m => [m.id, m.name]));
    for (const key of keys.slice(0, MAX_CARDS)) {
      try {
        const t = await api.get(`/tasks/${seg(key)}`);
        const p = await dir.projectById(t.project);
        out.push(...taskCard(t, { assignee: who.get(t.assignee), project: p?.name }));
      } catch {
        /* deleted or no longer visible: no card */
      }
    }
    return out;
  }

  async function titlesFor(api, pending) {
    const titles = {};
    for (const p of pending)
      if (p.args?.key && !titles[p.args.key])
        titles[p.args.key] = await api
          .get(`/tasks/${seg(p.args.key)}`)
          .then(t => t.title)
          .catch(() => '');
    return titles;
  }

  /* Show what a run produced in the message at `ts`: the reply and task cards, or a confirmation. */
  async function render({ out, ctx, channel, ts, threadId, requesterSlack, prefix = [] }) {
    if (out.pending.length) {
      const titles = await titlesFor(ctx.api, out.pending);
      store.savePending({
        threadId,
        requester: requesterSlack,
        channel,
        threadTs: ctx.slack.threadTs,
        messageTs: ts,
        data: { pending: out.pending, permalink: ctx.slack.permalink, titles },
      });
      const blocks = [...prefix, ...confirmBlocks(threadId, out.pending, requesterSlack, titles)];
      return slack.chat.update({ channel, ts, text: 'Waiting for you to confirm', blocks });
    }
    const text = mrkdwn(out.text) || (out.touched.length ? 'Done.' : 'I don’t have anything to add.');
    const blocks = [...prefix, { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }, ...(await cards(ctx.api, out.touched))];
    return slack.chat.update({ channel, ts, text: text.slice(0, 3000), blocks });
  }

  const failure = e => `Sorry, something went wrong and I couldn’t finish that${e?.message ? `: ${esc(String(e.message).slice(0, 300))}` : '.'}`;

  /* A request to the agent from a mention or a DM. `replyThread`: the thread to answer in (none for
   a flat DM). `threadId`: the conversation's id for the agent's memory. */
  async function converse({ user, channel, ts, text, replyThread, threadId }) {
    const who = await people.resolve(user);
    if (!who.member) return post(channel, replyThread, { text: unmatchedText(who, config.name) });
    const member = who.member;

    const placeholder = await post(channel, replyThread, { text: WORKING });
    return serial(threadId, async () => {
      try {
        const [ch, permalink] = await Promise.all([reader.channel(channel), reader.permalink(channel, replyThread || ts)]);
        const thread = replyThread
          ? await reader.thread(channel, replyThread, { since: store.cursor(threadId), except: [ts, placeholder.ts] })
          : { transcript: '' };
        const project = store.channelProject(channel);
        const message = requestMessage({
          now: new Date(),
          timezone: config.timezone,
          requester: member,
          channel: { ...ch, project, tasks: replyThread ? store.tasksIn(channel, replyThread) : [] },
          transcript: thread.transcript,
          text: await reader.plain(text),
        });
        const ctx = {
          api: trackerAs(member),
          dir,
          store,
          requester: member,
          slack: { channel, channelName: ch.name, threadTs: replyThread || null, permalink },
          touched: [],
        };
        const out = await agent.run({ threadId, message, ctx });
        store.setCursor(threadId, placeholder.ts);
        await render({ out, ctx, channel, ts: placeholder.ts, threadId, requesterSlack: user });
      } catch (e) {
        console.error('agent run failed', e);
        await slack.chat.update({ channel, ts: placeholder.ts, text: failure(e) }).catch(() => {});
      }
    });
  }

  /* Confirm or Cancel on held changes. Only the person who asked can decide. */
  async function decidePending({ threadId, approve, user, channel, respond }) {
    const held = store.pending(threadId);
    if (!held) return respond?.({ response_type: 'ephemeral', replace_original: false, text: 'That was already handled.' });
    if (held.requester !== user) return respond?.({ response_type: 'ephemeral', replace_original: false, text: `Only <@${held.requester}> can confirm this.` });
    const who = await people.resolve(user);
    if (!who.member) return respond?.({ response_type: 'ephemeral', replace_original: false, text: unmatchedText(who, config.name) });
    const taken = store.takePending(threadId);
    if (!taken) return;
    const { pending, permalink, titles } = taken.data;
    const prefix = confirmedBlocks(pending, approve, user, titles);
    await slack.chat.update({
      channel,
      ts: taken.message_ts,
      text: approve ? 'Confirmed' : 'Cancelled',
      blocks: [...prefix, { type: 'context', elements: [{ type: 'mrkdwn', text: WORKING }] }],
    });
    return serial(threadId, async () => {
      const ctx = { api: trackerAs(who.member), dir, store, requester: who.member, slack: { channel, threadTs: taken.thread_ts, permalink }, touched: [] };
      try {
        const out = await agent.resume({ threadId, approve, ctx });
        if (!out) return slack.chat.update({ channel, ts: taken.message_ts, text: 'Expired', blocks: prefix });
        await render({ out, ctx, channel, ts: taken.message_ts, threadId, requesterSlack: user, prefix });
      } catch (e) {
        console.error('agent resume failed', e);
        await slack.chat
          .update({ channel, ts: taken.message_ts, text: failure(e), blocks: [...prefix, { type: 'section', text: { type: 'mrkdwn', text: failure(e) } }] })
          .catch(() => {});
      }
    });
  }

  /* Complete / Assign to me / Status on a task card, checked against the person who clicked. */
  async function taskAction({ name, value, user, channel, message, respond }) {
    const who = await people.resolve(user);
    const say = text => respond?.({ response_type: 'ephemeral', replace_original: false, text });
    if (!who.member) return say(unmatchedText(who, config.name));
    const [key, status] = name === 'task_status' ? value.split('|') : [value];
    const api = trackerAs(who.member);
    let t;
    try {
      t = await api.get(`/tasks/${seg(key)}`);
    } catch {
      return say(`I can’t find ${esc(key)} any more.`);
    }
    const p = await dir.projectById(t.project);
    if (level(p, who.member) < EDIT) return say(`You can’t change tasks in ${esc(p?.key || 'that project')}.`);
    try {
      if (name === 'task_complete') t = await api.post(`/tasks/${seg(key)}/complete`);
      else if (name === 'task_assign_me') t = await api.patch(`/tasks/${seg(key)}`, { assignee: who.member.id });
      else t = await api.patch(`/tasks/${seg(key)}`, { status });
    } catch (e) {
      return say(`Couldn’t update ${esc(key)}: ${esc(e.message)}`);
    }
    if (!message) return;
    const assignee = (await dir.member(t.assignee))?.name;
    const card = taskCard(t, { assignee, project: p?.name });
    const blocks = [...(message.blocks || [])];
    const at = blocks.findIndex(b => b.block_id === `task:${key}`);
    const done = name === 'task_complete' ? 'completed' : name === 'task_assign_me' ? 'took' : `moved to ${statusName(status)}:`;
    const note = { type: 'context', elements: [{ type: 'mrkdwn', text: `<@${user}> ${done} ${esc(key)}` }] };
    if (at > 0) blocks.splice(at - 1, 2, ...card, note);
    else blocks.push(...card, note);
    await slack.chat.update({ channel, ts: message.ts, text: message.text || key, blocks });
  }

  /* ---------- /sudo ---------- */
  const HELP = [
    `*${config.name}*: mention me in a thread or DM me to file and update tasks, e.g. “@${config.name} file this as a bug for me, due Friday”.`,
    '• `/sudo new <title>`: create a task',
    '• `/sudo my`: your open tasks',
    '• `/sudo search <words>`: find tasks',
    '• `/sudo project <KEY>`: link this channel to a project (`/sudo project none` unlinks)',
    '• `/sudo link`: how your Slack account maps to the tracker',
    '• `/sudo guidance`: instructions the agent follows here (admins can set them)',
    '• Message menu ⋯ → *Create task*: a task from any message',
  ].join('\n');

  async function openCreateModal({ triggerId, member, channel, title = '', description = '', meta }) {
    const [visible, members] = await Promise.all([dir.visible(member), dir.members()]);
    const projects = visible.filter(p => !p.archived && level(p, member) >= EDIT);
    if (!projects.length) return false;
    await slack.views.open({
      trigger_id: triggerId,
      view: createTaskModal({
        title,
        description,
        projects,
        members: members.filter(m => m.kind !== 'bot' && m.status === 'active'),
        defaultProject: store.channelProject(channel),
        meta,
      }),
    });
    return true;
  }

  async function onCommand({ command, respond }) {
    const say = text => respond({ response_type: 'ephemeral', text });
    const [sub = '', ...rest] = String(command.text || '')
      .trim()
      .split(/\s+/);
    const arg = rest.join(' ').trim();
    const op = sub.toLowerCase();
    if (!op || op === 'help') return say(HELP);

    const who = await people.resolve(command.user_id);
    if (!who.member) return say(unmatchedText(who, config.name));
    const me = who.member;
    const api = trackerAs(me);
    const names = new Map((await dir.members()).map(m => [m.id, m.name]));
    const line = t =>
      `• <${t.url}|${esc(t.key)}> ${esc(t.title)}  ·  ${statusName(t.status)}${t.due ? `  ·  📅 ${t.due.slice(0, 10)}` : ''}${t.assignee && t.assignee !== me.id ? `  ·  ${esc(names.get(t.assignee) || '')}` : ''}`;
    const visibleIds = async () => new Set((await dir.visible(me)).map(p => p.id));

    if (op === 'my') {
      const ids = await visibleIds();
      const tasks = (await api.all('/tasks', { assignee: me.id, status: 'open' }, 200))
        .filter(t => ids.has(t.project))
        .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
      return say(
        tasks.length
          ? `*Your open tasks (${tasks.length})*\n${tasks.slice(0, 20).map(line).join('\n')}${tasks.length > 20 ? `\n…and ${tasks.length - 20} more` : ''}`
          : 'You have no open tasks. 🎉',
      );
    }
    if (op === 'search') {
      if (!arg) return say('Usage: `/sudo search <words>`');
      const ids = await visibleIds();
      const r = await api.get('/search', { q: arg, limit: 20 });
      const tasks = r.tasks.filter(t => ids.has(t.project));
      return say(tasks.length ? `*Tasks matching “${esc(arg)}”*\n${tasks.slice(0, 15).map(line).join('\n')}` : `Nothing matches “${esc(arg)}”.`);
    }
    if (op === 'project') {
      const current = store.channelProject(command.channel_id);
      if (!arg)
        return say(
          current
            ? `This channel is linked to *${esc(current)}*. New tasks default to it.`
            : 'This channel isn’t linked to a project. `/sudo project <KEY>` links it.',
        );
      if (/^(none|off|clear)$/i.test(arg)) {
        store.setChannelProject(command.channel_id, null);
        return say('Unlinked this channel from its project.');
      }
      const p = await dir.project(arg);
      if (!p || level(p, me) < VIEW) return say(`There’s no project “${esc(arg)}” you can open.`);
      store.setChannelProject(command.channel_id, p.key, me.id);
      return say(`Linked this channel to *${esc(p.key)} ${esc(p.name)}*. Tasks filed here default to it.`);
    }
    if (op === 'link' || op === 'unlink') {
      const m = /^<@([A-Z0-9]+)(?:\|[^>]*)?>\s*(.*)$/.exec(arg);
      if (!m)
        return say(
          `You’re linked to *${esc(me.name)}* (${esc(me.email)}) in the tracker.${isAdmin(me) ? '\nAdmins: `/sudo link @person their-tracker-email` links someone whose Slack email differs; `/sudo unlink @person` undoes it.' : ''}`,
        );
      if (!isAdmin(me)) return say('Only tracker Owners and Admins can link other people.');
      if (op === 'unlink') {
        people.unlink(m[1]);
        return say(`Unlinked <@${m[1]}>. They’ll be matched by their Slack email again.`);
      }
      const linked = await people.link(m[1], m[2].trim(), me.id);
      return say(linked ? `Linked <@${m[1]}> to *${esc(linked.name)}*.` : `No active tracker member has the email “${esc(m[2].trim())}”.`);
    }
    if (op === 'guidance') {
      const [scopeWord, ...words] = arg.split(/\s+/);
      const scope = /^(channel|here)$/i.test(scopeWord) ? command.channel_id : 'workspace';
      const textArg = /^(channel|here|workspace)$/i.test(scopeWord) ? words.join(' ').trim() : arg;
      const label = scope === 'workspace' ? 'workspace' : 'this channel';
      if (!textArg) {
        const ws = store.guidance('workspace');
        const ch = store.guidance(command.channel_id);
        return say(
          `*Workspace guidance:* ${ws ? esc(ws) : '_none_'}\n*This channel:* ${ch ? esc(ch) : '_none_'}${isAdmin(me) ? '\nSet with `/sudo guidance [channel] <text>`, clear with `/sudo guidance [channel] clear`.' : ''}`,
        );
      }
      if (!isAdmin(me)) return say('Only tracker Owners and Admins can change the guidance.');
      const clear = /^clear$/i.test(textArg);
      store.setGuidance(scope, clear ? '' : textArg.slice(0, 4000), me.id);
      return say(clear ? `Cleared the guidance for ${label}.` : `Saved the guidance for ${label}.`);
    }
    // `/sudo new <title>`, or just `/sudo <title>`: the create-task modal.
    const title = op === 'new' ? arg : String(command.text).trim();
    const ok = await openCreateModal({ triggerId: command.trigger_id, member: me, channel: command.channel_id, title, meta: { channel: command.channel_id } });
    if (!ok) return say('There’s no project you can add tasks to.');
  }

  /* ---------- "Create task" message shortcut and its modal ---------- */
  async function onMessageShortcut({ shortcut }) {
    const user = shortcut.user.id;
    const channel = shortcut.channel.id;
    const msg = shortcut.message;
    const who = await people.resolve(user);
    if (!who.member) return slack.chat.postEphemeral({ channel, user, text: unmatchedText(who, config.name) });
    const text = await reader.plain(msg.text);
    const permalink = await reader.permalink(channel, msg.ts);
    const threadTs = msg.thread_ts || msg.ts;
    const ok = await openCreateModal({
      triggerId: shortcut.trigger_id,
      member: who.member,
      channel,
      title: (text.split('\n').find(Boolean) || '').slice(0, 120),
      description: text,
      meta: { channel, threadTs, permalink },
    });
    if (!ok) await slack.chat.postEphemeral({ channel, user, text: 'There’s no project you can add tasks to.' });
  }

  /* Returns what to ack the view_submission with (field errors), or nothing to close the modal. */
  async function onCreateSubmit({ view, user }) {
    const v = modalValues(view);
    const meta = JSON.parse(view.private_metadata || '{}');
    const who = await people.resolve(user);
    if (!who.member) return { response_action: 'errors', errors: { title: unmatchedText(who, config.name).slice(0, 150) } };
    const p = await dir.project(v.project);
    if (!p || level(p, who.member) < EDIT) return { response_action: 'errors', errors: { project: 'You can’t add tasks to that project.' } };
    const api = trackerAs(who.member);
    const description = [v.description, meta.permalink ? `From Slack: ${meta.permalink}` : '', `— created by ${who.member.name} in Slack`]
      .filter(Boolean)
      .join('\n\n');
    let t;
    try {
      t = await api.post(
        '/tasks',
        {
          project: p.key,
          title: v.title,
          description,
          ...(v.assignee ? { assignee: v.assignee } : {}),
          ...(v.priority ? { priority: v.priority } : {}),
          ...(v.due ? { due: v.due } : {}),
        },
        { idempotencyKey: `modal-${view.id}` },
      );
    } catch (e) {
      return { response_action: 'errors', errors: { title: String(e.message).slice(0, 150) } };
    }
    if (meta.threadTs) store.linkThread({ task: t.key, channel: meta.channel, threadTs: meta.threadTs, permalink: meta.permalink });
    const assignee = (await dir.member(t.assignee))?.name;
    const payload = {
      text: `<@${user}> created ${t.key}`,
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<@${user}> created a task` }] }, ...taskCard(t, { assignee, project: p.name })],
    };
    // Into the thread it came from; when the bot isn't in that channel, to the person instead.
    await post(meta.channel, meta.threadTs, payload).catch(() => slack.chat.postMessage({ channel: user, ...payload }).catch(() => {}));
  }

  /* ---------- link previews ---------- */
  const hosts = () => new Set([...(config.unfurlHosts || []), ...(config.tracker.url ? [new URL(config.tracker.url).host] : [])]);
  function parseLink(url) {
    try {
      const u = new URL(url);
      if (!hosts().has(u.host)) return null;
      const m = /^#(task|project)\/([A-Za-z0-9_-]+)/.exec(u.hash);
      return m ? { kind: m[1], ref: m[2] } : null;
    } catch {
      return null;
    }
  }

  async function onLinkShared({ event }) {
    const links = (event.links || []).map(l => ({ url: l.url, ...parseLink(l.url) })).filter(l => l.kind);
    if (!links.length) return;
    const who = await people.resolve(event.user);
    if (!who.member) return; // no preview for people the tracker doesn't know
    const api = trackerAs(who.member);
    const unfurls = {};
    for (const l of links.slice(0, 5)) {
      try {
        if (l.kind === 'task') {
          const t = await api.get(`/tasks/${seg(l.ref)}`);
          const p = await dir.projectById(t.project);
          if (level(p, who.member) < VIEW) continue;
          unfurls[l.url] = { blocks: taskCard(t, { assignee: (await dir.member(t.assignee))?.name, project: p.name, actions: false }) };
        } else {
          const p = await dir.project(l.ref);
          if (!p || level(p, who.member) < VIEW) continue;
          const lead = (await dir.member(p.lead))?.name;
          const facts = [
            p.status,
            lead ? `Lead: ${esc(lead)}` : null,
            `${p.openTasks} open · ${p.doneTasks} done`,
            p.due ? `📅 ${p.due.slice(0, 10)}` : null,
          ].filter(Boolean);
          unfurls[l.url] = {
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `*<${p.url}|${esc(p.key)} ${esc(p.name)}>*\n${facts.join('  ·  ')}${p.description ? `\n${esc(p.description.slice(0, 280))}` : ''}`,
                },
              },
            ],
          };
        }
      } catch {
        /* not found or not visible: no preview */
      }
    }
    if (!Object.keys(unfurls).length) return;
    await slack.chat.unfurl(
      event.unfurl_id ? { unfurl_id: event.unfurl_id, source: event.source, unfurls } : { channel: event.channel, ts: event.message_ts, unfurls },
    );
  }

  return {
    /* @mention in a channel: answer in the thread (starting one under a top-level message). */
    async onMention({ event }) {
      if (event.bot_id || !event.user || !store.firstTime(`${event.channel}:${event.ts}`)) return;
      const replyThread = event.thread_ts || event.ts;
      return converse({ user: event.user, channel: event.channel, ts: event.ts, text: event.text, replyThread, threadId: `${event.channel}:${replyThread}` });
    },
    /* A DM: threads keep their own conversation; flat messages share one per day. */
    async onDirectMessage({ event }) {
      if (event.channel_type !== 'im' || event.bot_id || event.subtype || !event.user || !store.firstTime(`${event.channel}:${event.ts}`)) return;
      const replyThread = event.thread_ts || null;
      return converse({
        user: event.user,
        channel: event.channel,
        ts: event.ts,
        text: event.text,
        replyThread,
        threadId: replyThread ? `${event.channel}:${replyThread}` : `${event.channel}:dm:${today()}`,
      });
    },
    onAction({ action, body, respond }) {
      const user = body.user.id;
      const channel = body.channel?.id || body.container?.channel_id;
      if (action.action_id === 'pending_confirm' || action.action_id === 'pending_cancel')
        return decidePending({ threadId: action.value, approve: action.action_id === 'pending_confirm', user, channel, respond });
      const value = action.selected_option?.value ?? action.value;
      return taskAction({ name: action.action_id, value, user, channel, message: body.message, respond });
    },
    onCommand,
    onMessageShortcut,
    onCreateSubmit,
    onLinkShared,
    /* For tests: wait until every queued run has finished. */
    idle: () => Promise.all([...locks.values()].map(p => p.catch(() => {}))),
  };
}
