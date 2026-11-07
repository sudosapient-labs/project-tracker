#!/usr/bin/env node
/* Sudo Tracker, the Slack agent. Configuration is environment variables only; see the README.

     sudo-tracker                                  run in Slack
     sudo-tracker chat --as <email> [options]      the same agent in this terminal, without Slack
       --project <KEY>   treat the conversation as in a channel linked to KEY
       --yes | --no      confirm or cancel held changes without asking
       [message…]        run one request and exit */
import { parseArgs } from 'node:util';
import { startApp } from '../src/app.js';
import { runChat } from '../src/chat.js';
import { assertReady, loadConfig } from '../src/config.js';

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'chat') {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { as: { type: 'string' }, project: { type: 'string' }, yes: { type: 'boolean' }, no: { type: 'boolean' } },
  });
  try {
    if (!values.as) throw new Error('Usage: sudo-tracker chat --as <tracker email> [--project KEY] [--yes|--no] [message…]');
    const config = loadConfig();
    assertReady(config, { surface: 'chat' });
    await runChat(config, { ...values, message: positionals.join(' ') || null });
    process.exit(0);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

if (cmd && cmd !== 'slack') {
  console.error(`Unknown command “${cmd}”. Use \`sudo-tracker\` (Slack) or \`sudo-tracker chat --as <email>\`.`);
  process.exit(1);
}

let running;
try {
  const config = loadConfig();
  assertReady(config);
  running = await startApp(config);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'])
  process.once(sig, async () => {
    await running?.stop().catch(() => {});
    process.exit(0);
  });
