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

describe('latest', () => {
  const item = i => ({ id: `c${i}`, text: `Comment ${i}`, createdAt: 1000 + i });
  const range = (from, to) => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => (from <= to ? from + i : from - i));
  const texts = r => r.data.map(c => c.text);
  const search = calls => calls.map(c => new URL(c.url).search);
  const at = c => c.createdAt;

  it('asks for the newest first and gives them back oldest first, with how many older were left out', async () => {
    const { api, calls } = client([ok({ data: range(25, 6).map(item), nextCursor: 'n5', total: 25 })]);
    const got = await api.latest('/tasks/WEB-1/comments', 20, at);
    expect(texts(got)).toEqual(range(6, 25).map(i => `Comment ${i}`));
    expect(got.older).toBe(5);
    expect(search(calls)).toEqual(['?order=newest&limit=20']);
  });

  it('keeps to n even if a server sends more, and asks for 1 to 100', async () => {
    const { api, calls } = client([ok({ data: range(9, 1).map(item), nextCursor: null, total: 9 })]);
    const got = await api.latest('/x', 3, at);
    expect(texts(got)).toEqual(['Comment 7', 'Comment 8', 'Comment 9']);
    expect(got.older).toBe(6);
    await api.latest('/x', 500, at);
    await api.latest('/x', 0, at);
    expect(search(calls).slice(1)).toEqual(['?order=newest&limit=100', '?order=newest&limit=1']);
  });

  it('with a server from before order=newest (oldest first, no total), reads on from its first page and keeps the newest', async () => {
    const { api, calls } = client([
      ok({ data: range(1, 20).map(item), nextCursor: 'o20' }),
      ok({ data: range(21, 120).map(item), nextCursor: 'o120' }),
      ok({ data: range(121, 130).map(item), nextCursor: null }),
    ]);
    const got = await api.latest('/tasks/WEB-1/comments', 20, at);
    expect(texts(got)).toEqual(range(111, 130).map(i => `Comment ${i}`));
    expect(got.older).toBe(110);
    expect(search(calls)).toEqual(['?order=newest&limit=20', '?limit=100&cursor=o20', '?limit=100&cursor=o120']);
  });

  it('with an older server sending newest first, over several pages and with ties, comes out oldest first', async () => {
    // Activity from an older server: newest first. 3 and 3b happened in the same millisecond, 3b later.
    const tie = { id: 'c3b', text: 'Comment 3b', createdAt: 1003 };
    const { api } = client([ok({ data: [item(5), item(4)], nextCursor: 'o2' }), ok({ data: [tie, item(3), item(2), item(1)], nextCursor: null })]);
    const got = await api.latest('/tasks/WEB-1/activity', 4, at);
    expect(texts(got)).toEqual(['Comment 3', 'Comment 3b', 'Comment 4', 'Comment 5']);
    expect(got.older).toBe(2);
  });

  it('tells which way an older server runs even when its whole first page shares one time', async () => {
    // Newest first; a, b, c logged in the same millisecond (c last), then older entries.
    const same = id => ({ id, text: id, createdAt: 2000 });
    const { api } = client([ok({ data: [same('c'), same('b')], nextCursor: 'o2' }), ok({ data: [same('a'), item(1)], nextCursor: null })]);
    expect(texts(await api.latest('/tasks/WEB-1/activity', 3, at))).toEqual(['a', 'b', 'c']);
  });

  it('stops on an empty page or a cursor it has seen, so a broken server can’t keep it looping', async () => {
    const empty = client([ok({ data: [item(1)], nextCursor: 'o1' }), ok({ data: [], nextCursor: 'o1' })]);
    expect(await empty.api.latest('/x', 5, at)).toEqual({ data: [item(1)], older: 0 });
    expect(empty.calls).toHaveLength(2);
    const loop = client([ok({ data: [item(1)], nextCursor: 'same' }), ok({ data: [item(2)], nextCursor: 'same' })]);
    expect(await loop.api.latest('/x', 5, at)).toEqual({ data: [item(1), item(2)], older: 0 });
    expect(loop.calls).toHaveLength(2);
  });
});

describe('Sudo-Time-Zone', () => {
  const sent = calls => calls.map(c => c.headers['sudo-time-zone'] ?? null);
  it('is sent when the client is given a zone, and changes with setTimeZone', async () => {
    const { api, calls } = client([ok({})], { timeZone: 'Asia/Dubai' });
    expect(api.timeZone).toBe('Asia/Dubai');
    await api.get('/me');
    api.setTimeZone('Asia/Kolkata');
    await api.post('/tasks', { title: 'x' });
    api.setTimeZone(null);
    await api.get('/me');
    expect(sent(calls)).toEqual(['Asia/Dubai', 'Asia/Kolkata', null]);
  });
  it('isn’t sent without one, or for a value that isn’t a zone', async () => {
    const { api, calls } = client([ok({})]);
    await api.get('/me');
    api.setTimeZone('+04:00');
    await api.get('/me');
    const bad = client([ok({})], { timeZone: 'Mars/Base' });
    await bad.api.get('/me');
    expect([...sent(calls), ...sent(bad.calls)]).toEqual([null, null, null]);
  });
});
