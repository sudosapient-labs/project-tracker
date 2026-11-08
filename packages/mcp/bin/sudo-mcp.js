#!/usr/bin/env node
/* sudo-mcp: the Sudo Sapient MCP server. Usage in HELP below. */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { createClient, plainHttpRemote } from '@sudosapient/client';
import { loadConfig } from '@sudosapient/client/config';
import { createMcp, VERSION } from '../src/protocol.js';
import { serveStdio } from '../src/stdio.js';
import { createHttpHandler, nodeListener } from '../src/http.js';

const HELP = `sudo-mcp: the Sudo Sapient MCP server

Usage
  sudo-mcp                                   stdio (Claude Desktop, Cursor, Claude Code, …)
  sudo-mcp --http [--port 3333] [--host 127.0.0.1]
                                             Streamable HTTP; each request brings its own
                                             Authorization: Bearer <key>

Options
  --url <workspace url>   else SUDO_URL, else \`sudo-cli login\`'s config
  --key <api key>         else SUDO_API_KEY, else the login config (prefer those: a key on the
                          command line lands in shell history and the process list)
  --read-only             register only the read tools (or SUDO_MCP_READ_ONLY=1)
  --insecure              allow a plain http:// workspace URL on another machine
  --host <address>        with --http: the address to listen on (default 127.0.0.1, this machine
                          only; anything else lets other machines reach it)
  --port <n>              with --http (default 3333)
  --version, --help`;

const { values: o } = parseArgs({
  options: {
    url: { type: 'string' },
    key: { type: 'string' },
    'read-only': { type: 'boolean', default: ['1', 'true'].includes(String(process.env.SUDO_MCP_READ_ONLY).toLowerCase()) },
    insecure: { type: 'boolean', default: false },
    http: { type: 'boolean', default: false },
    port: { type: 'string', default: '3333' },
    host: { type: 'string', default: '127.0.0.1' },
    version: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (o.version || o.help) {
  console.log(o.version ? VERSION : HELP);
  process.exit(0);
}
const cfg = loadConfig();
const url = o.url || cfg.url;
if (!url) {
  console.error('sudo-mcp: set the workspace URL with --url, SUDO_URL, or `sudo-cli login`.');
  process.exit(1);
}
// Every request carries the key: never in the clear to another machine unless asked (or allowed at
// `sudo-cli login --insecure` for that same URL).
if (plainHttpRemote(url) && !o.insecure && !(!o.url && cfg.insecure)) {
  console.error(`sudo-mcp: ${url} is plain http, so your API key would cross the network unencrypted. Use https, or add --insecure.`);
  process.exit(1);
}
const readOnly = o['read-only'];

async function connectWith(key, label) {
  // Rate limits are waited out (Retry-After) by the client; stderr is the log, stdout the protocol.
  const onRetry = ({ delay, method, path }) => console.error(`sudo-mcp: rate limited on ${method} ${path}; retrying in ${Math.ceil(delay / 1000)} s`);
  const api = createClient({ url, key, client: label, onRetry });
  const me = await api.get('/me');
  return { api, scope: me.key.scope, admin: me.role === 'Owner' || me.role === 'Admin' };
}

if (o.http) {
  const port = Number(o.port);
  const handle = createHttpHandler({
    readOnly,
    origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    connect: ({ authorization, label }) => connectWith(/^Bearer\s+(\S+)$/i.exec(authorization)?.[1] || '', label),
  });
  // Loopback only by default: anyone who can reach the port can use it with their own key, and it
  // speaks plain http.
  const loopback = /^(localhost|(::ffff:)?127(\.\d+){3}|::1|\[::1\])$/i.test(o.host);
  if (!loopback)
    console.error(
      `sudo-mcp: warning: listening on ${o.host}, not just this machine. Other machines can reach it, over plain http, so keys sent to it cross the network unencrypted.`,
    );
  const server = http.createServer(nodeListener(handle));
  server.on('error', e => {
    console.error(`sudo-mcp: can't listen on ${o.host}:${port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(port, o.host, () => console.error(`sudo-mcp: Streamable HTTP on http://${o.host}:${server.address().port}/ → ${url}`));
} else {
  const key = o.key || cfg.key;
  if (o.key) console.error('sudo-mcp: warning: --key leaves the key in your shell history and the process list. Prefer SUDO_API_KEY or `sudo-cli login`.');
  if (!key) {
    console.error('sudo-mcp: set an API key with --key, SUDO_API_KEY, or `sudo-cli login`.');
    process.exit(1);
  }
  await serveStdio(createMcp({ readOnly, connect: label => connectWith(key, label) }));
}
