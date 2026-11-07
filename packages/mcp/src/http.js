/* MCP over Streamable HTTP: POST a JSON-RPC message (or batch) and get the reply as JSON. There are
   no server-initiated messages, so GET has no stream (405) and DELETE has nothing to end.

   Stateless: the session id carries the client's label (base64url) plus random bytes, so any
   instance can serve any request and restarts lose nothing. Every request brings its own
   Authorization header, which `connect` turns into an API client. */
import crypto from 'node:crypto';
import { createMcp } from './protocol.js';

/* The largest request body `nodeListener` accepts (the app's /api/mcp has the same 1 MB cap). */
export const MAX_BODY = 1024 * 1024;

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const encode = label => `${Buffer.from(label).toString('base64url')}.${crypto.randomBytes(9).toString('base64url')}`;
const decode = id => (id ? Buffer.from(String(id).split('.')[0], 'base64url').toString().slice(0, 40) || null : null);

/* `connect({ authorization, label })` → { api, scope }. `origins`: allowed Origin values; requests
   from any other browser origin are refused (DNS-rebinding protection). `admit(count)`: called with
   the number of messages in the request before any is handled; a Response it returns (e.g. a 429)
   is sent instead, so a batch can't do more than its messages' worth of a rate limit. */
export function createHttpHandler({ connect, readOnly = false, origins = [], admit = null }) {
  return async function handle(req) {
    const origin = req.headers.get('origin');
    if (origin && !origins.includes(origin)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } }, 403);
    if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });
    if (req.method === 'DELETE') return new Response(null, { status: 204 });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } });

    let msg;
    try {
      msg = await req.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const authorization = req.headers.get('authorization') || '';
    const s = { label: decode(req.headers.get('mcp-session-id')) };
    const mcp = createMcp({ connect: label => connect({ authorization, label }), readOnly });
    const msgs = Array.isArray(msg) ? msg : [msg];
    const refused = admit && (await admit(msgs.length));
    if (refused) return refused;
    const out = (await Promise.all(msgs.map(m => mcp.handle(m, s)))).filter(Boolean);
    const init = msgs.find(m => m?.method === 'initialize');
    const headers = init ? { 'mcp-session-id': encode(s.label || 'MCP') } : {};
    if (!out.length) return new Response(null, { status: 202, headers });
    return json(Array.isArray(msg) ? out : out[0], 200, headers);
  };
}

/* The body of a Node request, or a 413 error once it passes `max` bytes (checked against
   Content-Length first, then as it streams in). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => Object.assign(new Error('Request too large'), { status: 413 });
    if (Number(req.headers['content-length']) > max) return reject(tooLarge());
    const chunks = [];
    let size = 0;
    req.on('data', ch => {
      size += ch.length;
      if (size > max) {
        req.pause();
        reject(tooLarge());
      } else chunks.push(ch);
    });
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on('error', reject);
  });
}

/* `handle` (createHttpHandler) as a node:http request listener, for `sudo-mcp --http`: bodies are
   capped at `maxBody`, and anything that goes wrong answers 500 instead of an unhandled rejection
   that would stop the server. */
export function nodeListener(handle, { maxBody = MAX_BODY, log = console } = {}) {
  const fail = (res, status, message) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'content-type': 'application/json', ...(status === 413 ? { connection: 'close' } : {}) });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: status === 413 ? -32600 : -32603, message } }));
  };
  return async (req, res) => {
    try {
      const body = await readBody(req, maxBody);
      const r = await handle(
        new Request(`http://${req.headers.host || 'localhost'}${req.url}`, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'POST' ? body : undefined,
        }),
      );
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (e?.status === 413) return fail(res, 413, 'Request too large');
      log.error?.('sudo-mcp: request failed', e);
      fail(res, 500, 'Internal error');
    }
  };
}
