/* A minimal client for the Sudo Sapient public API (/api/v1), shared by the CLI and the MCP server.
   No dependencies: it runs on any fetch (Node 20+, or an in-process `app.request`). */

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || (status ? `Request failed (${status})` : 'Couldn’t reach Sudo Sapient. Check the URL and your connection.'));
    this.status = status;
    this.code = body?.code || (status ? 'http_' + status : 'offline');
    this.field = body?.field || null;
  }
}

/* `url`: the workspace's base URL (https://sudo.example.com). `client`: a label for activity, e.g.
   "CLI" or "Claude", shown as "Ada via Claude". */
export function createClient({ url, key, client = 'API', fetch: doFetch = globalThis.fetch }) {
  const base = String(url || '').replace(/\/+$/, '') + '/api/v1';
  async function request(method, path, { query, body, idempotencyKey } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    let res;
    try {
      res = await doFetch(base + path + (qs ? `?${qs}` : ''), {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          // URI-encoded: header values must be Latin-1, and client names needn't be.
          'x-sudo-client': encodeURIComponent(client),
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, null);
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body = {}, opts) => request('POST', path, { body, ...opts }),
    patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
    /* Every page of a list endpoint, up to `max` items. */
    async all(path, query = {}, max = 500) {
      const out = [];
      let cursor;
      do {
        const page = await request('GET', path, { query: { ...query, limit: 100, cursor } });
        out.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor && out.length < max);
      return out.slice(0, max);
    },
  };
}

/* Path segment for a task or project reference (an id or key). */
export const seg = ref => encodeURIComponent(String(ref).trim());

/* True when `url` would send the key in the clear to another machine: plain http to anything but
   this one (localhost, 127.x, ::1). */
export function plainHttpRemote(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return u.protocol === 'http:' && !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host));
}
