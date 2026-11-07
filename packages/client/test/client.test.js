/* @sudosapient/client: rate-limited requests are waited out (Retry-After), within limits, and only
   429s are retried. */
import { describe, expect, it } from 'vitest';
import { ApiError, RETRY, createClient, retryAfterMs } from '../index.js';

/* A fetch that answers from `replies` in turn and records every request. */
function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'content-type': 'application/json', ...(r.headers || {}) } });
  };
  return { fetch, calls };
}
const limited = (after = '2') => ({
  status: 429,
  headers: after == null ? {} : { 'retry-after': after },
  body: { error: 'Your API keys are limited to 120 requests a minute together. Try again in 2 s.', code: 'rate_limited' },
});
const ok = body => ({ status: 200, body });
function client(replies, opts = {}) {
  const { fetch, calls } = fakeFetch(replies);
  const waits = [];
  const retried = [];
  const api = createClient({
    url: 'https://sudo.test',
    key: 'ssk_x',
    fetch,
    sleep: async ms => void waits.push(ms),
    onRetry: e => retried.push(e),
    ...opts,
  });
  return { api, calls, waits, retried };
}

describe('Retry-After', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterMs('53')).toBe(53_000);
    expect(retryAfterMs(' 0 ')).toBe(0);
    const now = Date.parse('2026-11-07T10:00:00Z');
    expect(retryAfterMs('Sat, 07 Nov 2026 10:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Sat, 07 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('rate limits', () => {
  it('waits as long as Retry-After says and sends the same request again', async () => {
    const { api, calls, waits, retried } = client([limited('2'), limited('1'), ok({ id: 't1' })]);
    const body = { assignee: 'me' };
    expect(await api.patch('/tasks/WEB-1', body, { idempotencyKey: 'idem-1' })).toEqual({ id: 't1' });
    expect(calls).toHaveLength(3);
    // Same method, URL, headers (Idempotency-Key included) and body each time.
    for (const c of calls) expect(c).toMatchObject({ method: 'PATCH', url: 'https://sudo.test/api/v1/tasks/WEB-1', body: JSON.stringify(body) });
    expect(calls.every(c => c.headers['idempotency-key'] === 'idem-1')).toBe(true);
    // The wait is Retry-After plus under 250 ms of jitter.
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits[0]).toBeLessThan(2250);
    expect(waits[1]).toBeGreaterThanOrEqual(1000);
    expect(retried.map(r => [r.attempt, r.method, r.path])).toEqual([
      [1, 'PATCH', '/tasks/WEB-1'],
      [2, 'PATCH', '/tasks/WEB-1'],
    ]);
  });

  it('retries writes without an Idempotency-Key too: a 429 was never applied', async () => {
    const { api, calls } = client([limited('1'), { status: 201, body: { key: 'WEB-1' } }]);
    expect(await api.post('/tasks', { project: 'WEB', title: 'x' })).toEqual({ key: 'WEB-1' });
    expect(calls.map(c => c.method)).toEqual(['POST', 'POST']);
  });

  it(`gives up after ${RETRY.retries} retries with the server’s message and when to try again`, async () => {
    const { api, calls } = client([limited('3')]);
    const e = await api.get('/me').catch(e => e);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 3 });
    expect(e.message).toMatch(/Try again in/);
    expect(calls).toHaveLength(RETRY.retries + 1);
  });

  it('keeps all the waits for one request within maxTotal, and waits at least a second', async () => {
    const total = client([limited('8'), limited('8'), ok({})], { retry: { maxTotal: 15_000 } });
    expect(await total.api.get('/me').catch(e => e)).toMatchObject({ status: 429, retryAfter: 8 });
    expect(total.waits).toHaveLength(1);
    expect(total.calls).toHaveLength(2);
    const zero = client([limited('0'), ok({ ok: true })]);
    expect(await zero.api.get('/me')).toEqual({ ok: true });
    expect(zero.waits[0]).toBeGreaterThanOrEqual(1000);
  });

  it('doesn’t wait longer than maxDelay, or without a Retry-After', async () => {
    const long = client([limited('61'), ok({})]);
    expect(await long.api.get('/me').catch(e => e)).toMatchObject({ status: 429, retryAfter: 61 });
    expect(long.calls).toHaveLength(1);
    expect(long.waits).toEqual([]);

    const capped = client([limited('10'), ok({})], { retry: { maxDelay: 5000 } });
    expect(await capped.api.get('/me').catch(e => e)).toMatchObject({ status: 429 });
    expect(capped.calls).toHaveLength(1);

    // e.g. "You’ve sent a lot of invites. Try again in an hour."
    const bare = client([limited(null), ok({})]);
    expect(await bare.api.get('/me').catch(e => e)).toMatchObject({ status: 429, retryAfter: null });
    expect(bare.calls).toHaveLength(1);
  });

  it('can be turned off, and retries nothing but 429', async () => {
    const off = client([limited('1'), ok({})], { retry: { retries: 0 } });
    expect(await off.api.get('/me').catch(e => e)).toMatchObject({ status: 429 });
    expect(off.calls).toHaveLength(1);
    for (const status of [400, 403, 404, 500, 503]) {
      const c = client([{ status, headers: { 'retry-after': '1' }, body: { error: 'no', code: 'x' } }, ok({})]);
      expect(await c.api.get('/me').catch(e => e)).toMatchObject({ status });
      expect(c.calls).toHaveLength(1);
    }
    // A request that never reached the server isn't retried either: a write might have landed.
    const api = createClient({ url: 'https://sudo.test', key: 'k', fetch: async () => Promise.reject(new Error('ECONNRESET')) });
    expect(await api.post('/tasks', {}).catch(e => e)).toMatchObject({ status: 0, code: 'offline' });
  });

  it('pages through lists across a rate limit', async () => {
    const { api, calls } = client([ok({ data: [1, 2], nextCursor: 'c2' }), limited('1'), ok({ data: [3], nextCursor: null })]);
    expect(await api.all('/tasks')).toEqual([1, 2, 3]);
    expect(calls.map(c => new URL(c.url).searchParams.get('cursor'))).toEqual([null, 'c2', 'c2']);
  });
});

describe('methods', () => {
  it('put and del send JSON and no body', async () => {
    const { api, calls } = client([ok({ favorite: true }), ok({ deleted: true })]);
    await api.put('/tasks/WEB-1/favorite');
    await api.del('/comments/c1');
    expect(calls.map(c => [c.method, c.body, c.headers['content-type']])).toEqual([
      ['PUT', '{}', 'application/json'],
      ['DELETE', undefined, undefined],
    ]);
  });

  it('uploads raw bytes with their type, and retries them on a rate limit', async () => {
    const { api, calls } = client([limited('1'), { status: 201, body: { id: 'f1' } }]);
    const bytes = new TextEncoder().encode('hello');
    expect(await api.upload('/files', { project: 'WEB', name: 'a b.txt' }, bytes, 'text/plain')).toEqual({ id: 'f1' });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe('https://sudo.test/api/v1/files?project=WEB&name=a+b.txt');
      expect(c.headers['content-type']).toBe('text/plain');
      expect(c.body).toBe(bytes);
    }
  });

  it('downloads bytes with their type and file name', async () => {
    const fetch = async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" },
      });
    const api = createClient({ url: 'https://sudo.test', key: 'k', fetch });
    const got = await api.download('/files/f1/content');
    expect(got).toEqual({ bytes: new Uint8Array([1, 2, 3]), type: 'application/pdf', name: 'résumé.pdf' });
    // A failed download is an ApiError like any other.
    const missing = createClient({
      url: 'https://sudo.test',
      key: 'k',
      fetch: fakeFetch([{ status: 404, body: { error: 'No file', code: 'not_found' } }]).fetch,
    });
    expect(await missing.download('/files/x/content').catch(e => e)).toMatchObject({ status: 404, code: 'not_found' });
  });
});
