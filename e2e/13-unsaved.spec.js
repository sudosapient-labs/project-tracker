import { expect, test } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_AFTER_RESET, signIn, signOut, synced, toastWith } from './helpers.js';

/* Edits waiting to be saved are never lost: not when the session ends, not when the page goes away,
   and changes missed while the live stream was down always arrive. Runs after the other journeys
   (05-settings changes the owner's password to this) or on its own, on a fresh database. */
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const MAE = { name: 'Mae Jemison', email: 'mae@example.com', password: 'endeavour-orbit-92' };
const headers = { 'x-requested-with': 'sudo-sapient' };
test.describe.configure({ mode: 'serial' });

const project = (id, key) => ({
  c: 'projects',
  id,
  k: 'put',
  v: { id, key, name: `Unsaved ${key}`, icon: 'code', color: 'teal', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [] },
});
const task = (id, pid, key, title) => {
  const now = Date.now();
  return {
    c: 'tasks',
    id,
    k: 'put',
    v: {
      id,
      key,
      project: pid,
      title,
      status: 'todo',
      assignee: null,
      priority: 'none',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: now,
      updated: now,
      order: 1,
    },
  };
};
const sync = async (page, ops) => expect((await page.request.post('/api/sync', { headers, data: { ops } })).ok()).toBe(true);
const serverTask = async (page, id) => (await (await page.request.get('/api/bootstrap')).json()).data.tasks.find(t => t.id === id);
const openTask = async (page, title) => {
  await page.locator('[data-a="openTask"]', { hasText: title }).first().click();
  await expect(page.locator('#d-title')).toHaveValue(title);
};
const rename = async (page, title) => {
  await page.fill('#d-title', title);
  await page.locator('#d-title').blur();
};
/* The session ends on the server (it expired, or was revoked) without the tab being told. */
function expireSessions(email) {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  try {
    db.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(email);
  } finally {
    db.close();
  }
}
const tokenOf = link => link.split('#')[1].split('/')[1];

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const rq = ctx.request;
  const s = await (await rq.get('/api/auth/session')).json();
  if (!s.workspace) {
    // On its own: the first account makes the workspace.
    const r = await (await rq.post('/api/auth/signup', { headers, data: { name: OWNER.name, email: OWNER.email, password: OWNER.password } })).json();
    expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
    expect((await rq.post('/api/workspace/onboarded', { headers, data: {} })).ok()).toBe(true);
  } else expect((await rq.post('/api/auth/login', { headers, data: { email: OWNER.email, password: OWNER.password } })).ok()).toBe(true);
  await rq.post('/api/sync', { headers, data: { ops: [project('punsaved', 'UNS')] } });
  // Mae joins with the workspace's invite link, so a second person can sign in on this browser.
  const { link } = await (await rq.post('/api/workspace/invite-link', { headers, data: {} })).json();
  await rq.post('/api/auth/logout', { headers, data: {} });
  const r = await (
    await rq.post('/api/auth/signup', { headers, data: { name: MAE.name, email: MAE.email, password: MAE.password, join: tokenOf(link) } })
  ).json();
  expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
  await ctx.close();
});

test('an edit waiting when the session ends is saved once the same person signs in again', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tuns1', 'punsaved', 'UNS-1', 'Before the session ended')]);
  await page.goto('/#project/uns/list');
  await openTask(page, 'Before the session ended');

  // The session expires; the next save is refused (401) and the tab goes to the sign-in screen,
  // saying the edit is waiting rather than dropping it.
  expireSessions(OWNER.email);
  await rename(page, 'Saved after signing in again');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await toastWith(page, '1 change');
  expect((await (await page.request.get('/api/bootstrap')).status()) === 401).toBe(true);

  await page.fill('#l-email', OWNER.email);
  await page.fill('#l-pw', OWNER.password);
  await page.click('#login-btn');
  await expect(page.locator('.side')).toBeVisible();
  await expect.poll(async () => (await serverTask(page, 'tuns1'))?.title).toBe('Saved after signing in again');
  await synced(page);
  await signOut(page);
});

test('someone else signing in after the session ended doesn’t send its edits, and says so', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tuns2', 'punsaved', 'UNS-2', 'Not Mae’s to save')]);
  await page.goto('/#project/uns/list');
  await openTask(page, 'Not Mae’s to save');
  expireSessions(OWNER.email);
  await rename(page, 'Sent as Mae?');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();

  // Mae signs in on this browser: the owner's edit isn't sent as hers, and she's told one was dropped.
  await page.fill('#l-email', MAE.email);
  await page.fill('#l-pw', MAE.password);
  await page.click('#login-btn');
  await expect(page.locator('.side')).toBeVisible();
  await toastWith(page, '1 change');
  await page.waitForTimeout(1000);
  await signOut(page);

  // Nor when the owner signs in again later: it was discarded.
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.waitForTimeout(1000);
  expect((await serverTask(page, 'tuns2')).title).toBe('Not Mae’s to save');
  await synced(page);
  await signOut(page);
});

test('an edit made offline survives the tab crashing, and is saved the next time the app opens', async ({ page, context }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tuns3', 'punsaved', 'UNS-3', 'Written on the train')]);
  await page.goto('/#project/uns/list');
  await openTask(page, 'Written on the train');

  // Offline, the edit waits; then the tab crashes (or the browser discards it, or a phone kills
  // it): no pagehide, no beforeunload, nothing sent on the way out.
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await rename(page, 'Saved the next morning');
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await page.waitForTimeout(1000);
  const crashed = page.waitForEvent('crash');
  (await context.newCDPSession(page)).send('Page.crash').catch(() => {});
  await crashed;
  const next = await context.newPage();
  expect((await serverTask(next, 'tuns3')).title).toBe('Written on the train');

  // Opened again, it's sent once the data has loaded, and shown.
  await next.goto('/#project/uns/list');
  await expect(next.locator('.side')).toBeVisible();
  await toastWith(next, 'Saving 1 change');
  await expect.poll(async () => (await serverTask(next, 'tuns3'))?.title).toBe('Saved the next morning');
  await expect(next.locator('[data-task-row]', { hasText: 'Saved the next morning' })).toBeVisible();
  await synced(next);
  await next.close();
});

test('an edit is sent as soon as the page is hidden, not after the save delay', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tuns4', 'punsaved', 'UNS-4', 'Typed then switched away')]);
  await page.goto('/#project/uns/list');
  await openTask(page, 'Typed then switched away');

  // Phones often skip pagehide when an app is switched away from and then killed: hiding the page
  // is the last sure moment to send what's waiting.
  const sentAtOnce = await page.evaluate(() => {
    const sent = [];
    const fetch0 = window.fetch;
    window.fetch = (url, opts) => (sent.push(String(url)), fetch0(url, opts));
    const el = document.querySelector('#d-desc');
    el.innerHTML = '<p>Sent when hidden</p>';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    window.fetch = fetch0;
    return sent.filter(u => u.includes('/api/sync')).length;
  });
  expect(sentAtOnce).toBe(1);
  await expect.poll(async () => (await serverTask(page, 'tuns4'))?.desc).toContain('Sent when hidden');
});

test('changes missed while the live stream was down arrive, even when the first reload fails', async ({ page }) => {
  // Keep hold of the live stream, so the test can drop it as the network would.
  await page.addInitScript(() => {
    const ES = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends ES {
      constructor(...a) {
        super(...a);
        window.__streams.push(this);
      }
    };
  });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tuns5', 'punsaved', 'UNS-5', 'Before the deploy')]);
  await page.goto('/#project/uns/list');
  await expect(page.locator('[data-task-row]', { hasText: 'Before the deploy' })).toBeVisible();

  // The stream drops (a deploy), and someone renames the task meanwhile: this tab misses it.
  await page.route('**/api/events*', route => route.abort('connectionrefused'));
  await page.evaluate(() => window.__streams.at(-1).dispatchEvent(new Event('error')));
  await sync(page, [{ c: 'tasks', id: 'tuns5', k: 'patch', v: { title: 'Renamed during the deploy', updated: Date.now() } }]);
  // The stream is back, but the server isn't ready yet: the reload it asks for fails.
  let failed = 0;
  await page.route('**/api/bootstrap', route => (failed++, route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"Bad gateway"}' })));
  await page.unroute('**/api/events*');
  await expect.poll(() => failed, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');

  // Once the server is ready, the reload is tried again and the rename arrives.
  await page.unroute('**/api/bootstrap');
  await expect(page.locator('[data-task-row]', { hasText: 'Renamed during the deploy' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'saved');
});

test.afterAll(async ({ browser }) => {
  // Leave the workspace as the journeys found it: no Mae.
  const ctx = await browser.newContext();
  const rq = ctx.request;
  await rq.post('/api/auth/login', { headers, data: { email: OWNER.email, password: OWNER.password } });
  const d = (await (await rq.get('/api/bootstrap')).json()).data;
  const mae = d.members.find(m => m.email === MAE.email);
  if (mae) await rq.post('/api/sync', { headers, data: { ops: [{ c: 'members', id: mae.id, k: 'del' }] } });
  await rq.post('/api/auth/logout', { headers, data: {} });
  await ctx.close();
});
