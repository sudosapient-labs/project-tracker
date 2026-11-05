/* MCP over Streamable HTTP: POST a JSON-RPC message (or batch) and get the reply as JSON. There are
   no server-initiated messages, so GET has no stream (405) and DELETE has nothing to end.

   Stateless: the session id carries the client's label (base64url) plus random bytes, so any
   instance can serve any request and restarts lose nothing. Every request brings its own
   Authorization header, which `connect` turns into an API client. */
import crypto from 'node:crypto';
import { createMcp } from './protocol.js';

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const encode = label => `${Buffer.from(label).toString('base64url')}.${crypto.randomBytes(9).toString('base64url')}`;
const decode = id => (id ? Buffer.from(String(id).split('.')[0], 'base64url').toString().slice(0, 40) || null : null);

/* `connect({ authorization, label })` → { api, scope }. `origins`: allowed Origin values; requests
   from any other browser origin are refused (DNS-rebinding protection). */
export function createHttpHandler({ connect, readOnly = false, origins = [] }) {
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
    const out = (await Promise.all(msgs.map(m => mcp.handle(m, s)))).filter(Boolean);
    const init = msgs.find(m => m?.method === 'initialize');
    const headers = init ? { 'mcp-session-id': encode(s.label || 'MCP') } : {};
    if (!out.length) return new Response(null, { status: 202, headers });
    return json(Array.isArray(msg) ? out : out[0], 200, headers);
  };
}
