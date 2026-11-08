/* A minimal client for the Sudo Sapient public API (/api/v1), shared by the CLI and the MCP server.
   No dependencies: it runs on any fetch (Node 22+, or an in-process `app.request`). */

export class ApiError extends Error {
  constructor(status, body, retryAfter = null) {
    super(body?.error || (status ? `Request failed (${status})` : 'Couldn’t reach Sudo Sapient. Check the URL and your connection.'));
    this.status = status;
    this.code = body?.code || (status ? 'http_' + status : 'offline');
    this.field = body?.field || null;
    this.retryAfter = retryAfter;
  }
}

/* Rate limits (429). The API refuses a request over the limit before handling it (middleware.js
   `bearer`), so nothing of it was applied and retrying is safe for every method, writes included.
   The client waits as long as Retry-After says (at least a second), up to `retries` times, never
   longer than `maxDelay` at once nor `maxTotal` in all for one request: a wait past either is
   reported instead (an ApiError with `retryAfter`, in seconds). A 429 without Retry-After (e.g.
   "too many invites this hour") isn't retried. */
export const RETRY = { retries: 3, maxDelay: 60_000, maxTotal: 120_000 };
const MIN_WAIT = 1000;

/* Milliseconds to wait from a Retry-After header (seconds, or an HTTP date), or null. */
export function retryAfterMs(value, now = Date.now()) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/* `url`: the workspace's base URL (https://sudo.example.com). `client`: a label for activity, e.g.
   "CLI" or "Claude", shown as "Ada via Claude". `retry`: { retries, maxDelay, maxTotal } for rate limits (see
   RETRY; `{ retries: 0 }` turns retrying off). `onRetry({ attempt, delay, method, path })` is called
   before each wait, e.g. to tell someone at a terminal why it paused. */
export function createClient({ url, key, client = 'API', fetch: doFetch = globalThis.fetch, retry = {}, onRetry, sleep = wait }) {
  const base = String(url || '').replace(/\/+$/, '') + '/api/v1';
  const { retries, maxDelay, maxTotal } = { ...RETRY, ...retry };
  /* `raw`: { body, type } sent as is instead of JSON (a file upload). `binary`: answer with the bytes
     ({ bytes, type, name }) instead of parsed JSON (a file download). */
  async function request(method, path, { query, body, idempotencyKey, raw, binary = false } = {}) {
    const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
    const init = {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        // URI-encoded: header values must be Latin-1, and client names needn't be.
        'x-sudo-client': encodeURIComponent(client),
        accept: 'application/json',
        ...(raw ? { 'content-type': raw.type || 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: raw ? raw.body : body !== undefined ? JSON.stringify(body) : undefined,
    };
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await doFetch(base + path + (qs ? `?${qs}` : ''), init);
      } catch {
        throw new ApiError(0, null);
      }
      if (res.ok && binary) return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get('content-type') || '', name: fileName(res) };
      const data = (res.headers.get('content-type') || '').includes('json') ? await res.json().catch(() => null) : null;
      if (res.ok) return data;
      const header = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : null;
      // "Retry-After: 0" still waits a moment, so a client can't spin against the limit.
      const after = header == null ? null : Math.max(header, MIN_WAIT);
      if (after == null || after > maxDelay || waited + after > maxTotal || attempt > retries)
        throw new ApiError(res.status, data, header == null ? null : Math.ceil(header / 1000));
      // A little jitter, so clients that were refused together don't all come back in the same instant.
      const delay = after + Math.floor(Math.random() * 250);
      waited += delay;
      onRetry?.({ attempt, delay, method, path });
      await sleep(delay);
    }
  }
  /* The newest `n` (1–100) of a task's comments or activity, oldest first, and how many older ones
     were left out: { data, older }. A server from before `order` and `total` ignores them and sends
     its usual order, so then every page is read, keeping only the newest `n` by `at(item)` (ties in
     the order the server sent them, which way round it runs), for at most `maxPages` pages. */
  async function latest(path, n, at, maxPages = 1000) {
    n = Math.min(Math.max(Math.trunc(n) || 1, 1), 100);
    const page = await request('GET', path, { query: { order: 'newest', limit: n } });
    if (Number.isInteger(page.total)) {
      const data = page.data.slice(0, n).toReversed();
      return { data, older: Math.max(0, page.total - data.length) };
    }
    let kept = [];
    let seen = 0;
    // Which way the server runs: from the first item with a different time than the very first.
    let start, desc;
    const add = v => {
      if (start === undefined) start = at(v);
      else if (desc === undefined && at(v) !== start) desc = at(v) < start;
      kept.push({ v, i: seen++ });
    };
    const byTime = (a, b) => at(a.v) - at(b.v) || (desc ? b.i - a.i : a.i - b.i);
    page.data.forEach(add);
    const cursors = new Set();
    for (let cursor = page.nextCursor, pages = 1; cursor && !cursors.has(cursor) && pages < maxPages; pages++) {
      cursors.add(cursor);
      const next = await request('GET', path, { query: { limit: 100, cursor } });
      if (!next.data?.length) break;
      next.data.forEach(add);
      if (kept.length > 4 * n) kept = kept.sort(byTime).slice(-n);
      cursor = next.nextCursor;
    }
    kept.sort(byTime);
    return { data: kept.slice(-n).map(k => k.v), older: Math.max(0, seen - n) };
  }
  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body = {}, opts) => request('POST', path, { body, ...opts }),
    patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
    put: (path, body = {}, opts) => request('PUT', path, { body, ...opts }),
    del: (path, opts) => request('DELETE', path, opts),
    /* POST raw bytes, e.g. upload('/files', { project: 'WEB', name: 'spec.pdf' }, bytes, 'application/pdf'). */
    upload: (path, query, bytes, type, opts) => request('POST', path, { query, raw: { body: bytes, type }, ...opts }),
    /* GET bytes: { bytes, type, name }. */
    download: (path, query) => request('GET', path, { query, binary: true }),
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
    latest,
  };
}

/* The file name a download was sent with (Content-Disposition: filename*=UTF-8''…). */
function fileName(res) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(res.headers.get('content-disposition') || '');
  try {
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
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
