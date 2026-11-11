/* /.well-known/assetlinks.json for the Android app, and every other /.well-known path a 404 rather
   than the app's HTML, with and without static serving. */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { setup } from './helpers.js';

const A = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const B = Array.from({ length: 32 }, () => 'AB').join(':');
const ANDROID = { ANDROID_PACKAGE_NAME: 'dev.sudosapient.app', ANDROID_CERT_FINGERPRINTS: A };

/* A built client to serve: what `pnpm build` leaves in dist/, reduced to what the fallback needs. */
function staticDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Sudo Sapient</title>');
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { SERVE_STATIC: 'true', STATIC_DIR: dir };
}
const get = (t, url, method = 'GET') => t.app.request(url, { method });
const statement = (pkg, fps) => [
  {
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps },
  },
];

describe('assetlinks.json', () => {
  for (const [name, env] of [
    ['without static serving', {}],
    ['with static serving', staticDir()],
  ])
    describe(name, () => {
      it('is a 404, not the app, while the Android app is not configured', async () => {
        for (const partial of [{}, { ANDROID_PACKAGE_NAME: 'dev.sudosapient.app' }, { ANDROID_CERT_FINGERPRINTS: A }]) {
          const res = await get(setup({ ...env, ...partial }), '/.well-known/assetlinks.json');
          expect(res.status).toBe(404);
          expect(res.headers.get('content-type')).toMatch(/^application\/json/);
          expect(await res.json()).toEqual({ error: 'Not found.' });
        }
      });

      it('lists the package and its signing certificate, without a session, redirect or long cache', async () => {
        const res = await get(setup({ ...env, ...ANDROID }), '/.well-known/assetlinks.json');
        expect(res.status).toBe(200);
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(await res.json()).toEqual(statement('dev.sudosapient.app', [A]));
      });

      it('answers HEAD like GET', async () => {
        const t = setup({ ...env, ...ANDROID });
        const res = await get(t, '/.well-known/assetlinks.json', 'HEAD');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/^application\/json/);
        expect((await get(t, '/.well-known/other', 'HEAD')).status).toBe(404);
      });

      it('every other /.well-known path is a 404, never index.html', async () => {
        const t = setup({ ...env, ...ANDROID });
        for (const url of [
          '/.well-known',
          '/.well-known/',
          '/.well-known/x',
          '/.well-known/apple-app-site-association',
          '/.well-known/assetlinks.json/',
          '/.well-known/a/b.json',
        ])
          for (const method of ['GET', 'HEAD']) {
            const res = await get(t, url, method);
            expect(res.status, `${method} ${url}`).toBe(404);
            expect(res.headers.get('content-type'), `${method} ${url}`).not.toMatch(/html/);
          }
        expect((await t.app.request('/.well-known/assetlinks.json', { method: 'POST' })).status).toBe(404);
      });
    });

  it('serves several fingerprints, upper case, trimmed and without repeats', async () => {
    const t = setup({ ANDROID_PACKAGE_NAME: ' dev.sudosapient.app ', ANDROID_CERT_FINGERPRINTS: ` ${A.toLowerCase()} ,${B}, ${A} ,` });
    const res = await get(t, '/.well-known/assetlinks.json');
    expect(await res.json()).toEqual(statement('dev.sudosapient.app', [A, B]));
  });

  it('a malformed package name or fingerprint stops the server from starting', () => {
    const bad = [
      { ANDROID_PACKAGE_NAME: 'sudosapient' },
      { ANDROID_PACKAGE_NAME: 'dev.sudosapient.app/' },
      { ANDROID_PACKAGE_NAME: 'dev.1app' },
      { ANDROID_PACKAGE_NAME: 'dev sudosapient.app' },
      { ANDROID_CERT_FINGERPRINTS: A.slice(3) },
      { ANDROID_CERT_FINGERPRINTS: `${A}:00` },
      { ANDROID_CERT_FINGERPRINTS: A.replace(/:/g, '') },
      { ANDROID_CERT_FINGERPRINTS: A.replace('1', 'G') },
      { ANDROID_CERT_FINGERPRINTS: `${A},nope` },
      { ANDROID_CERT_FINGERPRINTS: ' , ' },
    ];
    for (const env of bad) expect(() => setup({ ...ANDROID, ...env }), JSON.stringify(env)).toThrow(/ANDROID_(PACKAGE_NAME|CERT_FINGERPRINTS) must be/);
    expect(loadConfig({ NODE_ENV: 'test' }).android).toEqual({ packageName: '', fingerprints: [] });
  });
});

describe('static serving around /.well-known', () => {
  it('real files and client-side routes still get the app', async () => {
    const t = setup({ ...staticDir(), ...ANDROID });
    const page = await get(t, '/');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Sudo Sapient</title>');
    const route = await get(t, '/projects/abc');
    expect(route.status).toBe(200);
    expect(route.headers.get('content-type')).toMatch(/^text\/html/);
    // A path that only starts like .well-known is an ordinary client-side route.
    expect((await get(t, '/.well-knownx')).headers.get('content-type')).toMatch(/^text\/html/);
    const file = await get(t, '/favicon.svg');
    expect(file.status).toBe(200);
    expect(await file.text()).toContain('<svg');
  });
});
