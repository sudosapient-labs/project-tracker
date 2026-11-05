/* /api/mcp: the MCP server (packages/mcp) over Streamable HTTP, for assistants that connect to a URL
   (Claude, ChatGPT, Cursor). It authenticates the caller's personal API key, then each tool calls
   /api/v1 in-process with that same key, so tools get exactly the API's permissions, validation,
   rate limit and activity attribution ("Ada via Claude"). */
import { Hono } from 'hono';
import { createClient } from '../../packages/client/index.js';
import { createHttpHandler } from '../../packages/mcp/src/http.js';
import { fail } from '../api/middleware.js';
import { readKey } from '../api/keys.js';

const MIN = 60_000;

export function mcpRoutes({ request, limit }) {
  const r = new Hono();
  r.all('/', async c => {
    // Check the key up front so a bad one gets a plain 401, as MCP clients expect over HTTP.
    const raw = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '')?.[1];
    const a = raw ? readKey(c.var.db, raw) : { error: 'missing' };
    if (a.error) {
      c.header('WWW-Authenticate', 'Bearer realm="sudo-sapient"');
      return fail(
        c,
        401,
        'Send a personal API key: Authorization: Bearer <key>. Create one in Settings → API.',
        a.error === 'missing' ? 'unauthenticated' : a.error,
      );
    }
    // Protocol requests (initialize, tools/list, …) have their own per-key budget; the /api/v1 calls
    // tools make count against the API's, so a tool call isn't counted twice in one bucket.
    const r = limit.take(`mcp:${a.key.id}`, c.var.config.apiRateLimit, MIN);
    if (!r.ok) {
      c.header('Retry-After', String(r.reset));
      return fail(c, 429, `This key is limited to ${r.limit} MCP requests a minute. Try again in ${r.reset} s.`);
    }
    const handle = createHttpHandler({
      origins: [new URL(c.var.config.appUrl).origin],
      connect: ({ authorization, label }) => ({
        api: createClient({ url: '', key: authorization.replace(/^Bearer\s+/i, ''), client: label, fetch: request }),
        scope: a.key.scope,
      }),
    });
    return handle(c.req.raw);
  });
  return r;
}
