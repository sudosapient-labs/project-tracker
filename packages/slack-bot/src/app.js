/* Wires the handlers to Slack with Bolt. Socket Mode by default (the app dials out to Slack, so it
   needs no public URL); with SLACK_SOCKET_MODE=false it serves Slack's HTTP requests on HOST:PORT
   instead, behind a public HTTPS URL. Slack expects every request acked within 3 seconds, so acks
   come first and the agent's work happens after. */
import http from 'node:http';
import bolt from '@slack/bolt';
import { trackerClient } from './tracker.js';
import { createSudoAgent } from './agent.js';
import { mcpTools } from './mcp.js';
import { directory, people as peopleOf } from './people.js';
import { openStore } from './store.js';
import { slackContext } from './slack/context.js';
import { createHandlers } from './slack/handlers.js';

const { App, LogLevel } = bolt;
// On shutdown, how long runs already going get to finish before the process stops.
const STOP_WAIT = 10_000;

export async function startApp(config, { log = console } = {}) {
  const store = openStore(config.db);
  const api = trackerClient(config);
  const me = await api.get('/me');
  if (me.kind !== 'bot') log.warn(`SUDO_API_KEY belongs to ${me.name}, a person. Use a bot member's key (Settings → API → Bots) so the bot acts as itself.`);
  if (me.key?.scope !== 'write') log.warn('SUDO_API_KEY is read-only: the bot can answer questions but not change anything.');

  const app = new App({
    token: config.slack.botToken,
    ...(config.slack.socketMode ? { socketMode: true, appToken: config.slack.appToken } : { signingSecret: config.slack.signingSecret }),
    logLevel: LogLevel.INFO,
  });
  const auth = await app.client.auth.test();
  const dir = directory(api);
  const mcp = await mcpTools(config.mcpServers, { log });
  const agent = await createSudoAgent({ config, store, tools: mcp.tools });
  const handlers = createHandlers({
    config,
    store,
    agent,
    dir,
    people: peopleOf({ slack: app.client, store, dir }),
    slack: app.client,
    reader: slackContext(app.client, { botUserId: auth.user_id, botName: config.name }),
  });

  const later = (what, p) => Promise.resolve(p).catch(e => log.error(`${what} failed`, e));

  app.event('app_mention', async ({ event }) => later('mention', handlers.onMention({ event })));
  app.message(async ({ message }) => later('dm', handlers.onDirectMessage({ event: message })));
  app.event('link_shared', async ({ event }) => later('unfurl', handlers.onLinkShared({ event })));

  app.command(/^\/.+/, async ({ command, ack, respond }) => {
    await ack();
    await later('command', handlers.onCommand({ command, respond }));
  });
  app.shortcut('create_task', async ({ shortcut, ack }) => {
    await ack();
    await later('shortcut', handlers.onMessageShortcut({ shortcut }));
  });
  app.view('create_task', async ({ view, body, ack }) => {
    // The task is created before acking, so a failure can be shown in the modal; posting it to the
    // channel waits until after, so the answer reaches Slack within its 3 seconds.
    const r = await handlers.onCreateSubmit({ view, user: body.user.id }).catch(e => {
      log.error('create task failed', e);
      return { errors: { response_action: 'errors', errors: { title: 'Something went wrong. Try again.' } } };
    });
    await ack(r.errors || undefined);
    if (r.after) await later('post created task', r.after());
  });
  app.action(/^(task_complete|task_assign_me|task_status|pending_confirm|pending_cancel)$/, async ({ action, body, ack, respond }) => {
    await ack();
    await later('action', handlers.onAction({ action, body, respond }));
  });

  // Before any new event, so nothing started now is mistaken for something the last process left:
  // replies it left at "Working on it…" and Confirms it didn't finish are told to the people waiting.
  await later('recovering after a restart', handlers.recover());

  let health = null;
  if (config.slack.socketMode) {
    await app.start();
    // Socket Mode serves nothing over HTTP, so a host's health check (Railway's) gets its own
    // endpoint when PORT is set: GET /health answers 200 once the bot is connected to Slack.
    if (config.slack.healthPort) health = await healthServer(config.slack.healthPort, config.slack.healthHost);
  } else await app.start({ port: config.slack.port, host: config.slack.host });
  log.info(
    `${config.name} is running as @${auth.user} in ${auth.team}, acting in the tracker as ${me.name}${config.slack.socketMode ? ' (Socket Mode)' : ` on ${config.slack.host}:${config.slack.port}`}.`,
  );

  return {
    app,
    async stop() {
      health?.close();
      await app.stop();
      // No new events now; let runs already going finish, for a while. Whatever is still going
      // after that is told on the next start (handlers.recover()).
      await Promise.race([handlers.idle(), new Promise(resolve => setTimeout(resolve, STOP_WAIT).unref())]);
      await mcp.close();
      store.close();
    },
  };
}

function healthServer(port, host) {
  const server = http.createServer((req, res) => {
    // /api/health too, the tracker's path, in case a host applies the repository's root config.
    const ok = req.method === 'GET' && ['/health', '/api/health', '/'].includes(req.url);
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: 'not found' }));
  });
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve(server)));
}
