/* Slack → Sudo Tracker. Every surface the bot has:

   - @mention in a channel or thread, and DMs: the agent (agent.js) reads the thread and acts
   - Confirm / Cancel on changes the agent holds for confirmation
   - task cards under replies: Complete, Assign to me, Status
   - `/sudo …`: new (modal), my, search, project, link, guidance, help
   - the "Create task" message shortcut: a modal prefilled from the message
   - link previews (unfurls) for tracker task and project links

   Conversations are per person: in a channel thread each person who mentions the bot has their own
   (so nobody inherits what the bot looked up for someone else), in a DM one per day. Each
   confirmation card acts only on the changes it shows, only for the person who asked.

   Whose clock: every request is read on the clock of the person it's for (clock.js, people.clock):
   the asker's for a mention, DM, command or modal, the clicker's for a task card button, the
   poster's for a link preview, and for a Confirm the asker's as saved with the change. Timed dues in
   messages are Slack date tokens (format.js when()), so everyone in a channel sees their own time.

   Handlers take Bolt's listener arguments but only use plain fields and the Web API client, so tests
   drive them with a fake client. app.js wires them to Bolt and acks. */
import { compareDue, dayOf, fromWallClock } from '@sudosapient/client/dates';
import { trackerClient } from '../tracker.js';
import { zone } from '../clock.js';
import { EDIT, VIEW, isAdmin, level, shownHere, unmatchedText } from '../people.js';
import { requestMessage } from '../prompt.js';
import { renderCard } from './cards.js';
import { confirmBlocks, createTaskModal, esc, loadingModal, messageModal, modalValues, mrkdwn, resolvedBlocks, statusName, taskCard, when } from './format.js';

const seg = ref => encodeURIComponent(String(ref).trim());
const WORKING = '_Working on it…_';
const RESTARTED = 'Sorry, I restarted before I finished this, so it may be only partly done. Ask me again if you still need it.';
const MAX_CARDS = 5;
const CONFIRM_TTL = 24 * 3600_000;
const TRACKER_TIMEOUT = 20_000;
// `/sudo my` reads at most this many of the person's open tasks.
const MY_CAP = 200;

export function createHandlers({ config, store, agent, dir, people, slack, reader, fetch }) {
  /* A tracker client with the bot's key, labelled for Activity: "Sudo Tracker via Slack (Ada)", on
     `tz`, the clock of the person it acts for. Every call gives up after TRACKER_TIMEOUT, so a hung
     tracker can't hold a conversation. A new one per request: its clock is that request's only. */
  const base = fetch || globalThis.fetch;
  const timed = (url, init = {}) => base(url, { ...init, signal: init.signal || AbortSignal.timeout(TRACKER_TIMEOUT) });
  const trackerAs = (member, tz) => trackerClient(config, { client: `Slack (${member.name})`, fetch: timed, tz });
  /* The time zone `member` (Slack user `user`) reads and writes on. */
  const tzOf = async (user, member) => (await people.clock(user, member)).tz;

  /* Hosts the bot may link to in its own words: the tracker's and Slack's. */
  const trackerHosts = () => new Set([...(config.unfurlHosts || []), ...(config.tracker.url ? [new URL(config.tracker.url).host] : [])]);
  const linkHosts = () => [...trackerHosts(), 'slack.com', '*.slack.com'];

  /* One run at a time per conversation; later requests wait their turn. */
  const locks = new Map();
  function serial(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    locks.set(key, next);
    next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {});
    return next;
  }

  const isDm = channel => /^D/.test(String(channel));

  async function post(channel, threadTs, payload) {
    return slack.chat.postMessage({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, ...payload });
  }
  /* A note only `user` should see: ephemeral in a channel, a plain reply in their DM. */
  async function tell(channel, user, threadTs, text) {
    if (isDm(channel)) return post(channel, threadTs, { text });
    return slack.chat
      .postEphemeral({ channel, user, text, ...(threadTs ? { thread_ts: threadTs } : {}) })
      .catch(() => slack.chat.postMessage({ channel: user, text }));
  }

  /* Where a conversation is, for shownHere(): a DM, a private channel and the project it's linked to. */
  async function whereIs(channel) {
    const ch = await reader.channel(channel);
    return { channel, channelName: ch.name, dm: ch.dm, private: ch.private, project: store.channelProject(channel) };
  }

  /* Cards for the tasks a run created or changed; `tz` for their fallback text. */
  async function cards(api, keys, where, tz) {
    const out = [];
    const who = new Map((await dir.members()).map(m => [m.id, m.name]));
    for (const key of keys.slice(0, MAX_CARDS)) {
      try {
        const t = await api.get(`/tasks/${seg(key)}`);
        const p = await dir.projectById(t.project);
        if (p && !shownHere(p, where)) continue;
        out.push(...taskCard(t, { assignee: who.get(t.assignee), project: p?.name, tz }));
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
      const id = store.saveConfirmation({
        threadId,
        interrupts: out.pending.map(p => p.id),
        requester: requesterSlack,
        channel,
        threadTs: ctx.slack.threadTs,
        messageTs: ts,
        // A card the agent made before stopping for Confirm is shown with the reply after it. The
        // asker's clock goes with the changes: their dates are on it, whenever Confirm is pressed.
        data: { pending: out.pending, titles, slack: ctx.slack, card: ctx.card || null, tz: ctx.tz },
      });
      return slack.chat.update({
        channel,
        ts,
        text: 'Waiting for you to confirm',
        blocks: [...prefix, ...confirmBlocks(id, out.pending, requesterSlack, titles, ctx.tz)],
      });
    }
    const card = out.card ? cardBlocks(out.card) : null;
    const text = mrkdwn(out.text, { hosts: linkHosts() }) || (card ? '' : out.touched.length ? 'Done.' : 'I don’t have anything to add.');
    const head = [...prefix, ...(text ? [{ type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } }] : [])];
    const tasks = await cards(ctx.api, out.touched, ctx.slack, ctx.tz);
    const notify = (text || card.text).slice(0, 3000);
    if (card)
      try {
        return await slack.chat.update({ channel, ts, text: notify, blocks: [...head, ...card.blocks, ...tasks] });
      } catch (e) {
        // Slack refused the blocks (a block type this workspace doesn't have yet, say): the same
        // card as plain text, so the answer isn't lost.
        console.warn('Slack refused a card; posting it as text', e?.data?.error || e?.message);
        return slack.chat.update({ channel, ts, text: notify, blocks: [...head, ...card.plain, ...tasks] });
      }
    return slack.chat.update({ channel, ts, text: notify, blocks: [...head, ...tasks] });
  }

  /* The agent's card as Block Kit, or null (and the reply goes out as text) if it can't be shown. */
  function cardBlocks(spec) {
    try {
      return renderCard(spec, { hosts: linkHosts() });
    } catch (e) {
      console.warn('card not shown', e?.issues || e?.message);
      return null;
    }
  }

  const failure = e =>
    e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? 'Sorry, that took too long and I stopped. Try again, maybe with a smaller request.'
      : `Sorry, something went wrong and I couldn’t finish that${e?.message ? `: ${esc(String(e.message).slice(0, 300))}` : '.'}`;

  /* Cards still waiting in a conversation the person has moved on from: marked superseded. */
  async function supersede(threadId, why) {
    for (const c of store.takeConfirmationsIn(threadId))
      await slack.chat
        .update({ channel: c.channel, ts: c.message_ts, text: 'Cancelled', blocks: resolvedBlocks(c.data.pending, why, c.data.titles, c.data.tz) })
        .catch(() => {});
  }

  /* A request to the agent from a mention or a DM. `replyThread`: the thread to answer in (none for
     a flat DM). `convo`: the conversation (per person per thread, or per DM per day), or a function
     of the asker's time zone that gives it. */
  async function converse({ user, channel, ts, text, replyThread, convo: convoOf }) {
    const who = await people.resolve(user);
    if (!who.member) return tell(channel, user, replyThread, unmatchedText(who, config.name));
    const member = who.member;
    const tz = await tzOf(user, member);
    const convo = typeof convoOf === 'function' ? convoOf(tz) : convoOf;

    const placeholder = await post(channel, replyThread, { text: WORKING });
    // Kept until the reply replaces the placeholder, so if the bot stops first, recover() can say so.
    store.startRun({ channel, threadTs: replyThread, ts: placeholder.ts });
    return serial(convo, async () => {
      try {
        let { threadId, cursor } = store.conversation(convo);
        // Something waiting for Confirm, or a run that broke off: start a fresh round (the old
        // changes are cancelled, and the whole Slack thread is read again).
        if (!(await agent.ready(threadId))) {
          await supersede(threadId, 'Cancelled: a newer message replaced this request.');
          threadId = store.nextRound(convo);
          cursor = null;
        }
        const [where, permalink] = await Promise.all([whereIs(channel), reader.permalink(channel, replyThread || ts)]);
        const thread = replyThread ? await reader.thread(channel, replyThread, { since: cursor, except: [ts, placeholder.ts] }) : { transcript: '' };
        const message = requestMessage({
          now: new Date(),
          timezone: tz,
          requester: member,
          channel: {
            id: channel,
            name: where.channelName,
            dm: where.dm,
            private: where.private,
            project: where.project,
            tasks: replyThread ? store.tasksIn(channel, replyThread) : [],
          },
          transcript: thread.transcript,
          text: await reader.plain(text),
        });
        const ctx = {
          api: trackerAs(member, tz),
          tz,
          dir,
          store,
          requester: member,
          slack: { ...where, threadTs: replyThread || null, permalink },
          touched: [],
        };
        const out = await agent.run({ threadId, message, ctx });
        store.setCursor(convo, placeholder.ts);
        await render({ out, ctx, channel, ts: placeholder.ts, threadId, requesterSlack: user });
      } catch (e) {
        console.error('agent run failed', e);
        await slack.chat.update({ channel, ts: placeholder.ts, text: failure(e) }).catch(() => {});
      } finally {
        store.endRun(channel, placeholder.ts);
      }
    });
  }

  /* Confirm or Cancel on a confirmation card. Only the person who asked can decide; the card acts
     only on the changes it shows, in the channel it was posted in, and only while they're still
     the ones waiting. */
  async function decide({ id, approve, user, respond }) {
    const say = text => respond?.({ response_type: 'ephemeral', replace_original: false, text });
    const held = id ? store.confirmation(String(id)) : null;
    if (!held) return say('That was already handled.');
    if (held.requester !== user) return say(`Only <@${held.requester}> can confirm this.`);
    const who = await people.resolve(user);
    if (!who.member) return say(unmatchedText(who, config.name));
    // Taken, not deleted: two clicks still can't both act on it, and it stays until the card shows
    // what happened, so a restart in between is found by recover() instead of dropping the change.
    const taken = store.takeConfirmation(id, { by: user, approve });
    if (!taken) return say('That was already handled.');
    const { channel, message_ts: ts } = taken;
    const { pending, titles, slack: where } = taken.data;
    // The clock the changes were asked on, saved with them (only a card from before it was saved
    // reads on the asker's clock now).
    const tz = zone(taken.data.tz) || (await tzOf(user, who.member));
    const finish = () => store.finishConfirmation(id);
    if (Date.now() - taken.created_at > CONFIRM_TTL)
      try {
        return await slack.chat.update({
          channel,
          ts,
          text: 'Expired',
          blocks: resolvedBlocks(pending, 'Expired: ask again if you still want this.', titles, tz),
        });
      } finally {
        finish();
      }
    const prefix = resolvedBlocks(pending, `${approve ? 'Confirmed' : 'Cancelled'} by <@${user}>.`, titles, tz);
    try {
      await slack.chat.update({
        channel,
        ts,
        text: approve ? 'Confirmed' : 'Cancelled',
        blocks: [...prefix, { type: 'context', elements: [{ type: 'mrkdwn', text: WORKING }] }],
      });
    } catch (e) {
      // The card still shows its buttons, so they should still work.
      store.untakeConfirmation(id);
      throw e;
    }
    return serial(taken.thread_id.replace(/#\d+$/, ''), async () => {
      const ctx = { api: trackerAs(who.member, tz), tz, dir, store, requester: who.member, slack: where, touched: [], card: taken.data.card || null };
      try {
        // From here the change may be made. A restart after this can't tell whether it was, so
        // recover() says so rather than making it again (only create_task has an idempotency key).
        store.markResuming(id);
        const out = await agent.resume({ threadId: taken.thread_id, ids: taken.interrupts, approve, ctx });
        if (out.stale)
          return await slack.chat.update({
            channel,
            ts,
            text: 'Out of date',
            blocks: resolvedBlocks(pending, 'Out of date: nothing was changed. Ask again if you still want this.', titles, tz),
          });
        await render({ out, ctx, channel, ts, threadId: taken.thread_id, requesterSlack: user, prefix });
      } catch (e) {
        console.error('agent resume failed', e);
        await slack.chat
          .update({ channel, ts, text: failure(e), blocks: [...prefix, { type: 'section', text: { type: 'mrkdwn', text: failure(e) } }] })
          .catch(() => {});
      } finally {
        finish();
      }
    });
  }

  /* On start, before taking events: what the last process left unfinished, told to the people
     waiting on it. Nothing is run again, since a write may already have happened (a task created
     by a run cut off, a change half made); a run's requests aren't replayed either.
     - a reply still "Working on it…" says the bot restarted, and to ask again;
     - a Cancel says it was cancelled (a cancelled change is never made);
     - a Confirm the agent hadn't started on yet gets its buttons back: nothing was changed, and the
       saved conversation is still paused on exactly those changes;
     - a Confirm the agent had started on says it may or may not have gone through, to check first. */
  async function recover() {
    const show = (where, what) =>
      slack.chat.update({ ...where, ...what }).catch(e => console.warn('couldn’t update a message after a restart', e?.data?.error || e?.message));
    for (const r of store.runs()) {
      await show({ channel: r.channel, ts: r.ts }, { text: RESTARTED });
      store.endRun(r.channel, r.ts);
    }
    for (const c of store.takenConfirmations()) {
      const { pending, titles, tz } = c.data;
      const it = pending.length === 1 ? 'this change' : 'these changes';
      const where = { channel: c.channel, ts: c.message_ts };
      if (c.approve && !c.resumed_at) {
        store.untakeConfirmation(c.id);
        const note = {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_I restarted before making ${it}, so nothing was changed. Confirm again if you still want it._` }],
        };
        await show(where, { text: 'Waiting for you to confirm', blocks: [note, ...confirmBlocks(c.id, pending, c.requester, titles, tz)] });
        continue;
      }
      const note = c.approve
        ? `Confirmed by <@${c.taken_by}>, but I restarted while making ${it}, so I can’t tell whether ${pending.length === 1 ? 'it' : 'they'} went through. Check before you ask me again.`
        : `Cancelled by <@${c.taken_by}>.`;
      await show(where, { text: c.approve ? 'Interrupted' : 'Cancelled', blocks: resolvedBlocks(pending, note, titles, tz) });
      store.finishConfirmation(c.id);
    }
  }

  /* Complete / Assign to me / Status on a task card, checked against the person who clicked. */
  async function taskAction({ name, value, user, channel, message, respond }) {
    const who = await people.resolve(user);
    const say = text => respond?.({ response_type: 'ephemeral', replace_original: false, text });
    if (!who.member) return say(unmatchedText(who, config.name));
    const [key, status] = name === 'task_status' ? String(value).split('|') : [value];
    const tz = await tzOf(user, who.member);
    const api = trackerAs(who.member, tz);
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
    const card = taskCard(t, { assignee, project: p?.name, tz });
    const blocks = [...(message.blocks || [])];
    const at = blocks.findIndex(b => b.block_id === `task:${key}`);
    const done = name === 'task_complete' ? 'completed' : name === 'task_assign_me' ? 'took' : `moved to ${statusName(status)}:`;
    const note = { type: 'context', elements: [{ type: 'mrkdwn', text: `<@${user}> ${done} ${esc(key)}` }] };
    if (at > 0) blocks.splice(at - 1, 2, ...card, note);
    else blocks.push(...card, note);
    await slack.chat.update({ channel, ts: message.ts, text: message.text || key, blocks: blocks.slice(-50) });
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
    'Private projects are only discussed in a DM with me, or in a private channel linked to that project.',
  ].join('\n');

  /* The create-task modal. Slack allows only 3 seconds between the click and opening a modal, so a
     loading view opens first and the form replaces it once people and projects are looked up. */
  async function createTaskFlow({ triggerId, user, channel, title = '', description = '', meta }) {
    const opened = await slack.views.open({ trigger_id: triggerId, view: loadingModal() });
    const show = view => slack.views.update({ view_id: opened.view?.id, view });
    const who = await people.resolve(user);
    if (!who.member) return show(messageModal('Create task', unmatchedText(who, config.name)));
    const [visible, members, tz] = await Promise.all([dir.visible(who.member), dir.members(), tzOf(user, who.member)]);
    const projects = visible.filter(p => !p.archived && level(p, who.member) >= EDIT);
    if (!projects.length) return show(messageModal('Create task', 'There’s no project you can add tasks to.'));
    return show(
      createTaskModal({
        title,
        description,
        projects,
        members: members.filter(m => m.kind !== 'bot' && m.status === 'active'),
        defaultProject: store.channelProject(channel),
        // The due time is read on the clock the form showed (the person's, now).
        meta: { ...meta, tz },
        tz,
      }),
    );
  }

  const NAMED = ['my', 'search', 'project', 'link', 'unlink', 'guidance'];

  async function onCommand({ command, respond }) {
    const say = text => respond({ response_type: 'ephemeral', text });
    const [sub = '', ...rest] = String(command.text || '')
      .trim()
      .split(/\s+/);
    const arg = rest.join(' ').trim();
    const op = sub.toLowerCase();
    if (!op || op === 'help') return say(HELP);
    // `/sudo new <title>`, or just `/sudo <title>`: the create-task modal, opened before anything slow.
    if (!NAMED.includes(op)) {
      const title = op === 'new' ? arg : String(command.text).trim();
      return createTaskFlow({
        triggerId: command.trigger_id,
        user: command.user_id,
        channel: command.channel_id,
        title,
        meta: { channel: command.channel_id },
      });
    }

    const who = await people.resolve(command.user_id);
    if (!who.member) return say(unmatchedText(who, config.name));
    const me = who.member;
    const tz = await tzOf(command.user_id, me);
    const api = trackerAs(me, tz);
    const names = new Map((await dir.members()).map(m => [m.id, m.name]));
    const line = t =>
      `• <${t.url}|${esc(t.key)}> ${esc(t.title)}  ·  ${statusName(t.status)}${t.due ? `  ·  📅 ${when(t.due, tz)}` : ''}${t.assignee && t.assignee !== me.id ? `  ·  ${esc(names.get(t.assignee) || '')}` : ''}`;
    // Only the person sees these answers, so everything they can open is included.
    const visibleIds = async () => new Set((await dir.visible(me)).map(p => p.id));

    if (op === 'my') {
      const ids = await visibleIds();
      // sort=due so the cap drops the latest due, not the oldest; sorted again here for older servers.
      // One past the cap, to tell "exactly MY_CAP" from "more".
      const read = await api.all('/tasks', { assignee: me.id, status: 'open', sort: 'due' }, MY_CAP + 1);
      const tasks = read
        .slice(0, MY_CAP)
        .filter(t => ids.has(t.project))
        .sort((a, b) => compareDue(a.due, b.due, tz));
      const plus = read.length > MY_CAP ? '+' : '';
      return say(
        tasks.length
          ? `*Your open tasks (${tasks.length}${plus})*\n${tasks.slice(0, 20).map(line).join('\n')}${tasks.length > 20 ? `\n…and ${tasks.length - 20}${plus} more` : ''}`
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
      const key = store.channelProject(command.channel_id);
      const current = key && (await dir.project(key));
      const canOpen = current && level(current, me) >= VIEW;
      if (!arg)
        return say(
          canOpen
            ? `This channel is linked to *${esc(current.key)}*. New tasks default to it.`
            : key
              ? 'This channel is linked to a project you can’t open.'
              : 'This channel isn’t linked to a project. `/sudo project <KEY>` links it.',
        );
      // This sets the default for everyone in the channel: Members and up who can edit the project.
      if (me.role === 'Guest') return say('Guests can’t change which project a channel is linked to.');
      if (/^(none|off|clear)$/i.test(arg)) {
        if (current && level(current, me) < EDIT) return say('Only people who can edit the linked project can unlink it.');
        store.setChannelProject(command.channel_id, null);
        return say('Unlinked this channel from its project.');
      }
      const p = await dir.project(arg);
      if (!p || level(p, me) < VIEW) return say(`There’s no project “${esc(arg)}” you can open.`);
      if (level(p, me) < EDIT) return say(`You need to be able to edit ${esc(p.key)} to link a channel to it.`);
      store.setChannelProject(command.channel_id, p.key, me.id);
      const where = await whereIs(command.channel_id);
      const note = p.private && !where.private ? `\n${esc(p.key)} is private and this channel isn’t, so I won’t discuss its work here.` : '';
      return say(`Linked this channel to *${esc(p.key)} ${esc(p.name)}*. Tasks filed here default to it.${note}`);
    }
    if (op === 'link' || op === 'unlink') {
      const m = /^<@([A-Z0-9]+)(?:\|[^>]*)?>\s*(.*)$/.exec(arg);
      if (!m)
        return say(
          `You’re linked to *${esc(me.name)}* (${esc(me.email)}) in the tracker.${isAdmin(me) ? '\nAdmins: `/sudo link @person their-tracker-email` links someone whose Slack email differs; `/sudo unlink @person` undoes it.' : ''}`,
        );
      if (!isAdmin(me)) return say('Only tracker Owners and Admins can link other people.');
      if (m[1] === command.user_id) return say('You can’t link your own Slack account by hand.');
      if (op === 'unlink') {
        people.unlink(m[1]);
        return say(`Unlinked <@${m[1]}>. They’ll be matched by their Slack email again.`);
      }
      const r = await people.link(m[1], m[2].trim(), me);
      const why = {
        no_member: `No active tracker member has the email “${esc(m[2].trim())}”.`,
        privileged: 'Owners and Admins are only matched by their own Slack email, never linked by hand.',
        self: 'You can’t link someone to yourself.',
        taken: 'That member is already matched to another Slack account. Unlink it first.',
      };
      if (r.error) return say(why[r.error]);
      await slack.chat
        .postMessage({
          channel: m[1],
          text: `${esc(me.name)} linked your Slack account to *${esc(r.member.name)}* in the tracker. If that isn’t you, tell an admin.`,
        })
        .catch(() => {});
      return say(`Linked <@${m[1]}> to *${esc(r.member.name)}*. They’ve been told.`);
    }
    // guidance
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

  /* ---------- "Create task" message shortcut and its modal ---------- */
  async function onMessageShortcut({ shortcut }) {
    const channel = shortcut.channel.id;
    const msg = shortcut.message;
    const [text, permalink] = await Promise.all([reader.plain(msg.text), reader.permalink(channel, msg.ts)]).catch(() => [msg.text || '', '']);
    return createTaskFlow({
      triggerId: shortcut.trigger_id,
      user: shortcut.user.id,
      channel,
      title: (text.split('\n').find(Boolean) || '').slice(0, 120),
      description: text,
      meta: { channel, threadTs: msg.thread_ts || msg.ts, permalink },
    });
  }

  /* The modal's submission. Returns { errors } (ack with them; the modal stays open) or { task,
     after }: the task is created, and `after()` posts it once Slack has its answer. */
  async function onCreateSubmit({ view, user }) {
    const errors = e => ({ errors: { response_action: 'errors', errors: e } });
    const v = modalValues(view);
    const meta = JSON.parse(view.private_metadata || '{}');
    const who = await people.resolve(user);
    if (!who.member) return errors({ title: unmatchedText(who, config.name).slice(0, 150) });
    const p = await dir.project(v.project);
    if (!p || level(p, who.member) < EDIT) return errors({ project: 'You can’t add tasks to that project.' });
    if (!String(v.title || '').trim()) return errors({ title: 'Give the task a title.' });
    // The clock the time was picked on: the zone Slack says the picker showed, else the one the form
    // was opened with, else the person's now.
    const tz = zone(v.dueTimeZone) || zone(meta.tz) || (await tzOf(user, who.member));
    const api = trackerAs(who.member, tz);
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
          // A time needs a day: on its own it's today's, on the person's clock.
          ...(v.due || v.dueTime ? { due: v.dueTime ? fromWallClock(v.due || dayOf(Date.now(), tz), v.dueTime, tz) : v.due } : {}),
        },
        { idempotencyKey: `modal-${view.id}` },
      );
    } catch (e) {
      return errors({ title: String(e.message).slice(0, 150) });
    }
    return {
      task: t,
      after: async () => {
        if (meta.threadTs) store.linkThread({ task: t.key, channel: meta.channel, threadTs: meta.threadTs, permalink: meta.permalink });
        const assignee = (await dir.member(t.assignee))?.name;
        const payload = {
          text: `<@${user}> created ${t.key}`,
          blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `<@${user}> created a task` }] }, ...taskCard(t, { assignee, project: p.name, tz })],
        };
        // Into the thread it came from, unless the channel may not see a private project's task, or
        // the bot isn't in that channel: then to the person.
        const where = meta.channel ? await whereIs(meta.channel) : null;
        if (where && shownHere(p, where)) await post(meta.channel, meta.threadTs, payload).catch(() => slack.chat.postMessage({ channel: user, ...payload }));
        else await slack.chat.postMessage({ channel: user, ...payload });
      },
    };
  }

  /* ---------- link previews ---------- */
  function parseLink(url) {
    try {
      const u = new URL(url);
      if (!trackerHosts().has(u.host)) return null;
      const m = /^#(task|project)\/([A-Za-z0-9_-]+)/.exec(u.hash);
      return m ? { kind: m[1], ref: m[2] } : null;
    } catch {
      return null;
    }
  }

  /* A preview is seen by everyone in the channel, so it shows only what the person who pasted the
     link can open and what may be shown in that channel (shownHere). */
  async function onLinkShared({ event }) {
    const links = (event.links || []).map(l => ({ url: l.url, ...parseLink(l.url) })).filter(l => l.kind);
    if (!links.length) return;
    const who = await people.resolve(event.user);
    if (!who.member) return; // no preview for people the tracker doesn't know
    const where = event.channel ? await whereIs(event.channel) : { dm: false };
    // The preview is everyone's: dues in it show each viewer's clock, the poster's in the fallback.
    const tz = await tzOf(event.user, who.member);
    const api = trackerAs(who.member, tz);
    const unfurls = {};
    for (const l of links.slice(0, 5)) {
      try {
        if (l.kind === 'task') {
          const t = await api.get(`/tasks/${seg(l.ref)}`);
          const p = await dir.projectById(t.project);
          if (level(p, who.member) < VIEW || !shownHere(p, where)) continue;
          unfurls[l.url] = { blocks: taskCard(t, { assignee: (await dir.member(t.assignee))?.name, project: p.name, actions: false, tz }) };
        } else {
          const p = await dir.project(l.ref);
          if (!p || level(p, who.member) < VIEW || !shownHere(p, where)) continue;
          const lead = (await dir.member(p.lead))?.name;
          const facts = [
            p.status,
            lead ? `Lead: ${esc(lead)}` : null,
            `${p.openTasks} open · ${p.doneTasks} done`,
            p.due ? `📅 ${when(p.due, tz)}` : null,
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
      return converse({
        user: event.user,
        channel: event.channel,
        ts: event.ts,
        text: event.text,
        replyThread,
        convo: `${event.channel}:${replyThread}:${event.user}`,
      });
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
        // Flat DMs: one conversation per day, on the person's clock.
        convo: replyThread ? `${event.channel}:${replyThread}:${event.user}` : tz => `${event.channel}:dm:${dayOf(Date.now(), tz)}`,
      });
    },
    onAction({ action, body, respond }) {
      const user = body.user.id;
      const channel = body.channel?.id || body.container?.channel_id;
      if (action.action_id === 'pending_confirm' || action.action_id === 'pending_cancel')
        return decide({ id: action.value, approve: action.action_id === 'pending_confirm', user, respond });
      const value = action.selected_option?.value ?? action.value;
      return taskAction({ name: action.action_id, value, user, channel, message: body.message, respond });
    },
    onCommand,
    onMessageShortcut,
    onCreateSubmit,
    onLinkShared,
    recover,
    /* For tests: wait until every queued run has finished. */
    idle: () => Promise.all([...locks.values()].map(p => p.catch(() => {}))),
  };
}
