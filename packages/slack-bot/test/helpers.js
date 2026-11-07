/* A real tracker on an in-memory database with a "Sudo Tracker" bot member, a fake Slack Web API
   client that records every call, and the bot's handlers wired to an agent whose model is scripted
   (LangChain's FakeToolCallingModel: one list of tool calls per model turn). */
import { MemorySaver } from '@langchain/langgraph';
import { FakeToolCallingModel } from 'langchain';
import { createClient } from '@sudosapient/client';
import { account, bot, setup } from '../../../test/server/helpers.js';
import { createSudoAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { directory, people } from '../src/people.js';
import { openStore } from '../src/store.js';
import { slackContext } from '../src/slack/context.js';
import { createHandlers } from '../src/slack/handlers.js';

const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const project = (id, key, extra = {}) => ({
  id,
  key,
  name: 'Project ' + key,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const person = (id, name, email, role) => ({ id, name, email, role, team: '', title: '', c: '#6B7280', status: 'invited', tz: '' });

/* Ada (Owner), Bea (Member) and Gus (Guest). WEB is open to the workspace, SEC is private (Ada, who
   made it, and the bot are on it; Bea and Gus aren't), OPS lists Gus (comment). The bot is a Member. */
export async function tracker() {
  const t = setup();
  const ada = await account(t);
  await ada.c.sync([
    put('members', person('mbea', 'Bea Member', 'bea@example.com', 'Member')),
    put('members', person('mgus', 'Gus Guest', 'gus@example.com', 'Guest')),
  ]);
  await account(t, { name: 'Bea Member', email: 'bea@example.com', invite: t.lastLink('bea@example.com').split('#invite/')[1] });
  await account(t, { name: 'Gus Guest', email: 'gus@example.com', invite: t.lastLink('gus@example.com').split('#invite/')[1] });
  await ada.c.sync([
    put('projects', project('pweb', 'WEB')),
    put('projects', project('psec', 'SEC', { private: true })),
    put('projects', project('pops', 'OPS', { members: ['mgus'], perms: { mgus: 'Can comment' } })),
  ]);
  const b = await bot(ada.c, { name: 'Sudo Tracker', projects: ['psec'], key: 'Slack' });
  const fetch = (url, init) => t.app.request(String(url), init);
  const api = createClient({ url: 'http://app.test', key: b.token, client: 'Slack', fetch });
  return { t, ada: ada.c, adaId: ada.user.id, botId: b.id, token: b.token, fetch, api };
}

export const SLACK_USERS = {
  UADA: { real_name: 'Ada Owner', profile: { email: 'ada@example.com' } },
  UBEA: { real_name: 'Bea Member', profile: { email: 'bea@example.com' } },
  UGUS: { real_name: 'Gus Guest', profile: { email: 'gus@example.com' } },
  UOUT: { real_name: 'Out Sider', profile: { email: 'out@elsewhere.com' } },
  UBOT: { real_name: 'Sudo Tracker', is_bot: true, profile: {} },
};

/* The Web API methods the bot calls, recording each one. `thread` messages per "channel:ts". */
export function fakeSlack({ threads = {}, channels = {} } = {}) {
  const calls = [];
  let n = 1000;
  const rec = (method, fn) => async args => {
    calls.push({ method, args });
    return fn(args);
  };
  const messages = new Map();
  const slack = {
    calls,
    of: method => calls.filter(c => c.method === method).map(c => c.args),
    message: ts => messages.get(ts),
    users: {
      info: rec('users.info', ({ user }) => (SLACK_USERS[user] ? { user: { id: user, ...SLACK_USERS[user] } } : Promise.reject(new Error('user_not_found')))),
    },
    conversations: {
      info: rec('conversations.info', ({ channel }) => ({ channel: { id: channel, name: 'general', is_private: false, ...channels[channel] } })),
      replies: rec('conversations.replies', ({ channel, ts }) => ({ messages: threads[`${channel}:${ts}`] || [] })),
    },
    chat: {
      postMessage: rec('chat.postMessage', args => {
        const ts = `${++n}.000100`;
        messages.set(ts, { ...args, ts });
        return { ok: true, ts, channel: args.channel };
      }),
      update: rec('chat.update', args => {
        messages.set(args.ts, { ...messages.get(args.ts), ...args });
        return { ok: true, ts: args.ts };
      }),
      postEphemeral: rec('chat.postEphemeral', () => ({ ok: true })),
      getPermalink: rec('chat.getPermalink', ({ channel, message_ts }) => ({
        permalink: `https://slack.test/archives/${channel}/p${message_ts.replace('.', '')}`,
      })),
      unfurl: rec('chat.unfurl', () => ({ ok: true })),
    },
    views: { open: rec('views.open', () => ({ ok: true })) },
  };
  return slack;
}

/* The bot, wired to the tracker `w` and a fake Slack. `turns`: the scripted model's tool calls,
   one list per model turn (an empty list ends the run with a text reply). `model`: a real chat
   model instead (the live scenarios). */
export async function harness(w, { turns = [], confirm = 'edits', slack = fakeSlack(), env = {}, model: real = null } = {}) {
  const config = { ...loadConfig({ SLACK_BOT_CONFIRM: confirm, SLACK_BOT_TIMEZONE: 'UTC', ...env }), tracker: { url: 'http://app.test', key: w.token } };
  const store = openStore(':memory:');
  const model = real || new FakeToolCallingModel({ toolCalls: turns });
  const agent = await createSudoAgent({ config, store, model, checkpointer: new MemorySaver() });
  const dir = directory(w.api, { ttl: 0 });
  const handlers = createHandlers({
    config,
    store,
    agent,
    dir,
    people: people({ slack, store, dir }),
    slack,
    reader: slackContext(slack, { botUserId: 'UBOT', botName: config.name }),
    fetch: w.fetch,
  });
  return { config, store, agent, handlers, slack, model };
}

export const call = (name, args, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ name, args, id });
