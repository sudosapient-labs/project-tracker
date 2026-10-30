/* Test harness: the real app on an in-memory database, plus a tiny cookie-keeping client. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createApp } from '../../server/app.js';
import { totpAt } from '../../server/lib/crypto.js';

export function setup(env = {}, deps = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gr8r-up-'));
  const config = loadConfig({ NODE_ENV: 'test', DISABLE_RATE_LIMIT: 'true', UPLOAD_DIR: uploadDir, APP_URL: 'http://app.test', ...env });
  const db = openDb(':memory:');
  const quiet = { info() {}, error() {} };
  const ctx = createApp({ db, config, log: quiet, pushSend: deps.pushSend || (async () => {}) });
  return {
    ...ctx,
    db,
    config,
    client: (opts = {}) => client(ctx.app, opts),
    lastLink: to => db.get('SELECT link FROM outbox WHERE to_addr = ? ORDER BY id DESC', to)?.link,
  };
}

export function client(app, { ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0', clientId } = {}) {
  let cookie = '';
  async function req(method, url, body, headers = {}) {
    const isForm = body instanceof FormData;
    const res = await app.request(url, {
      method,
      headers: {
        ...(isForm ? {} : { 'content-type': 'application/json' }),
        'x-requested-with': 'gr8r',
        'user-agent': ua,
        ...(clientId ? { 'x-client-id': clientId } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body == null ? undefined : isForm ? body : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) {
      const [pair] = sc.split(';');
      const gone = /Max-Age=0/i.test(sc) || pair.endsWith('=');
      cookie = gone ? '' : pair;
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
      return cookie;
    },
    set cookie(v) {
      cookie = v;
    },
  };
}

export const PW = 'correct-horse-9';
export const code = secret => totpAt(secret);

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
