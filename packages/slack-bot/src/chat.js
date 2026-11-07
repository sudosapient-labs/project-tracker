/* The agent without Slack: `sudo-tracker chat --as <email>` in a terminal. Slack is only a surface;
   this one runs the same agent, tools, requester checks and confirmations, so the bot can be tried
   against any tracker (staging, production) before Slack is connected, and scripted in checks.

   The requester is named by email (they must be an active tracker member). Whoever runs this holds
   the bot's key, so they can already act as the bot; `--as` only narrows what it does to what that
   person could do. Changes that would wait for Confirm in Slack are asked about here (y/N), or
   decided up front with --yes / --no. Conversations live in memory and end with the process. */
import readline from 'node:readline/promises';
import { MemorySaver } from '@langchain/langgraph';
import { createClient } from '@sudosapient/client';
import { createSudoAgent } from './agent.js';
import { mcpTools } from './mcp.js';
import { directory } from './people.js';
import { requestMessage } from './prompt.js';
import { openStore } from './store.js';

const plainAction = ({ name, args }) => `${name.replace(/_/g, ' ')} ${JSON.stringify(args)}`;

/* One conversation: send(text) → { text, pending, touched } after any confirmations. */
export async function chatSession(config, { as, project = null, decide, log = console, fetch } = {}) {
  const api = createClient({ url: config.tracker.url, key: config.tracker.key, client: 'Slack', ...(fetch ? { fetch } : {}) });
  const dir = directory(api);
  const requester = await dir.byEmail(as);
  if (!requester) throw new Error(`No active tracker member has the email ${as}.`);
  const store = openStore(':memory:');
  if (project) store.setChannelProject('terminal', project, requester.id);
  const mcp = await mcpTools(config.mcpServers, { log });
  const agent = await createSudoAgent({ config, store, tools: mcp.tools, checkpointer: new MemorySaver() });
  const threadId = `terminal:${Date.now()}`;
  const labelled = createClient({ url: config.tracker.url, key: config.tracker.key, client: `Slack (${requester.name})`, ...(fetch ? { fetch } : {}) });
  const ctx = () => ({
    api: labelled,
    dir,
    store,
    requester,
    slack: { channel: 'terminal', channelName: 'terminal', threadTs: null, permalink: '' },
    touched: [],
  });

  async function send(text) {
    const message = requestMessage({
      now: new Date(),
      timezone: config.timezone,
      requester,
      channel: { id: 'terminal', name: 'terminal', project },
      transcript: '',
      text,
    });
    let c = ctx();
    let out = await agent.run({ threadId, message, ctx: c });
    const touched = [...out.touched];
    while (out.pending.length) {
      const approve = await decide(out.pending);
      c = ctx();
      out = await agent.resume({ threadId, approve, ctx: c });
      if (!out) break;
      touched.push(...out.touched);
    }
    return { text: out?.text || '', touched: [...new Set(touched)] };
  }
  return { requester, send, close: () => (store.close(), mcp.close()) };
}

/* The interactive terminal: one line per request, `exit` or Ctrl-D to quit. A message given on the
   command line runs once and exits. */
export async function runChat(config, { as, project, yes, no, message }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  const decide = async pending => {
    console.log(`\nWaiting for confirmation:\n${pending.map(p => `  • ${plainAction(p)}`).join('\n')}`);
    if (yes || no) {
      console.log(yes ? '  → confirmed (--yes)' : '  → cancelled (--no)');
      return !!yes;
    }
    return /^y(es)?$/i.test((await rl.question('Confirm? [y/N] ')).trim());
  };
  const session = await chatSession(config, { as, project, decide, log: { info() {}, warn: console.warn } });
  console.log(
    `${config.name} (terminal) as ${session.requester.name}, on ${config.tracker.url}${project ? `, project ${project}` : ''}. Type a request; "exit" quits.`,
  );
  const show = async text => {
    const r = await session.send(text);
    console.log(`\n${r.text}`);
    if (r.touched.length) console.log(`\n(tasks: ${r.touched.join(', ')})`);
  };
  try {
    if (message) await show(message);
    else
      for (;;) {
        let line;
        try {
          line = (await rl.question('\n> ')).trim();
        } catch {
          break; // Ctrl-D
        }
        if (!line) continue;
        if (/^(exit|quit)$/i.test(line)) break;
        await show(line).catch(e => console.error(`Error: ${e.message}`));
      }
  } finally {
    rl.close();
    await session.close();
  }
}
