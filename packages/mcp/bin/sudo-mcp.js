#!/usr/bin/env node
/* sudo-mcp: the Sudo Sapient MCP server.
     sudo-mcp                      stdio (Claude Desktop, Cursor, Claude Code, …)
     sudo-mcp --http [--port 3333] Streamable HTTP on 127.0.0.1; each request brings its own
                                   Authorization: Bearer <key>
   Options: --url, --key (else SUDO_URL / SUDO_API_KEY, else `sudo-cli login`'s config),
   --read-only (or SUDO_MCP_READ_ONLY=1: register only the read tools, so write tools are unknown),
   --insecure (allow a plain http:// URL to another machine). */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { createClient, plainHttpRemote } from '@sudosapient/client';
import { loadConfig } from '@sudosapient/client/config';
import { createMcp, VERSION } from '../src/protocol.js';
import { serveStdio } from '../src/stdio.js';
import { createHttpHandler } from '../src/http.js';

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
  },
});
if (o.version) {
  console.log(VERSION);
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
  const api = createClient({ url, key, client: label });
  const me = await api.get('/me');
  return { api, scope: me.key.scope };
}

if (o.http) {
  const port = Number(o.port);
  const handle = createHttpHandler({
    readOnly,
    origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`],
    connect: ({ authorization, label }) => connectWith(/^Bearer\s+(\S+)$/i.exec(authorization)?.[1] || '', label),
  });
  http
    .createServer(async (req, res) => {
      const chunks = [];
      for await (const ch of req) chunks.push(ch);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await handle(
        new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'POST' ? body : undefined }),
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    })
    .listen(port, o.host, () => console.error(`sudo-mcp: Streamable HTTP on http://${o.host}:${port}/ → ${url}`));
} else {
  const key = o.key || cfg.key;
  if (o.key) console.error('sudo-mcp: warning: --key leaves the key in your shell history and the process list. Prefer SUDO_API_KEY or `sudo-cli login`.');
  if (!key) {
    console.error('sudo-mcp: set an API key with --key, SUDO_API_KEY, or `sudo-cli login`.');
    process.exit(1);
  }
  await serveStdio(createMcp({ readOnly, connect: label => connectWith(key, label) }));
}
