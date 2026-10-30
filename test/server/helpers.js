/* Test harness: the real app on an in-memory database, plus a tiny cookie-keeping client. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { totpAt } from '../../server/lib/crypto.js';

export function setup(env = {}, deps = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-up-'));
  const config = loadConfig({ NODE_ENV: 'test', DISABLE_RATE_LIMIT: 'true', UPLOAD_DIR: uploadDir, APP_URL: 'http://app.test', ...env });
  const db = openDb(':memory:');
  const quiet = { info() {}, error() {} };
  const ctx = createApp({ db, config, log: deps.log || quiet, pushSend: deps.pushSend || (async () => {}) });
  return {
    ...ctx,
    db,
    config,
    client: (opts = {}) => client(ctx.app, opts),
    lastLink: to => db.get('SELECT link FROM outbox WHERE to_addr = ? ORDER BY id DESC', to)?.link,
  };
}

/* Keeps every cookie the server sets (session and device), like a browser would. */
export function client(app, { ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0', clientId } = {}) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, url, body, headers = {}) {
    const isForm = body instanceof FormData;
    const res = await app.request(url, {
      method,
      headers: {
        ...(isForm ? {} : { 'content-type': 'application/json' }),
        'x-requested-with': 'sudo-sapient',
        'user-agent': ua,
        ...(clientId ? { 'x-client-id': clientId } : {}),
        ...(jar.size ? { cookie: cookieHeader() } : {}),
        ...headers,
      },
      body: body == null ? undefined : isForm ? body : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, v = ''] = pair.split(/=(.*)/s);
      if (/Max-Age=0/i.test(sc) || !v) jar.delete(k);
      else jar.set(k, v);
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: data, headers: res.headers };
  }
  return {
    get: (u, h) => req('GET', u, null, h),
    post: (u, b = {}, h) => req('POST', u, b, h),
    put: (u, b = {}, h) => req('PUT', u, b, h),
    del: (u, h) => req('DELETE', u, null, h),
    sync: ops => req('POST', '/api/sync', { ops }),
    get cookie() {
      return cookieHeader();
    },
    set cookie(v) {
      jar.clear();
      for (const pair of v.split('; ').filter(Boolean)) {
        const [k, val = ''] = pair.split(/=(.*)/s);
        jar.set(k, val);
      }
    },
    /* Just the session cookie's value ('' when signed out). */
    get session() {
      return jar.get('ss_sid') || '';
    },
  };
}

export const PW = 'correct-horse-9';
/* An authenticator code `steps` time steps from now. Each step's code is accepted once, and the
   server tolerates one step of clock drift, so tests use 0 and then 1. */
export const code = (secret, steps = 0) => totpAt(secret, Date.now() + steps * 30_000);

/* Sign up and verify an account, returning its signed-in client. */
export async function account(t, { name = 'Ada Owner', email = 'ada@example.com', invite } = {}) {
  const c = t.client();
  const r = await c.post('/api/auth/signup', { name, email, password: PW, ...(invite ? { invite } : {}) });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${JSON.stringify(r.body)}`);
  if (!r.body.user.verified) {
    const token = r.body.devLink.split('#verify/')[1];
    const v = await c.post('/api/auth/verify', { token });
    if (v.status !== 200) throw new Error('verify failed');
  }
  return { c, user: r.body.user };
}
