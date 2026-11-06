import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, signOut, synced, toastWith, watchErrors } from './helpers.js';

// 05-settings changes the owner's password to this.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const headers = { 'x-requested-with': 'sudo-sapient' };
test.describe.configure({ mode: 'serial' });

const project = (id, key, extra = {}) => ({
  c: 'projects',
  id,
  k: 'put',
  v: { id, key, name: `Audit ${key}`, icon: 'code', color: 'teal', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [], ...extra },
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
const serverTask = async (page, id) => (await (await page.request.get('/api/bootstrap')).json()).data.tasks.find(t => t.id === id);

test('edits queued while saving fails survive a reload the live stream asks for', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const r = await page.request.post('/api/sync', { headers, data: { ops: [project('paud', 'AUD'), task('taud1', 'paud', 'AUD-201', 'Offline draft')] } });
  expect(r.ok()).toBe(true);
  await page.goto('/#project/aud/list');
  await page.locator('[data-a="openTask"]', { hasText: 'Offline draft' }).first().click();
  await expect(page.locator('#d-title')).toHaveValue('Offline draft');

  // Saving fails (the server is restarting), so the edit waits in the queue.
  await page.route('**/api/sync', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Restarting"}' }));
  await page.fill('#d-title', 'Written while saving failed');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');

  // Meanwhile the live stream tells this tab to reload (here: a project it could see went private).
  const other = await page.request.post('/api/sync', { headers, data: { ops: [project('paud2', 'AUDX', { members: [] })] } });
  expect(other.ok()).toBe(true);
  await page.request.post('/api/sync', {
    headers,
    data: { ops: [{ c: 'projects', id: 'paud2', k: 'patch', v: { private: true, members: [], perms: {}, lead: null } }] },
  });
  await page.waitForTimeout(1500);
  await expect(page.locator('#d-title')).toHaveValue('Written while saving failed');

  // Once the server is back, the queued edit is saved, not dropped by the reload.
  await page.unroute('**/api/sync');
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'saved', { timeout: 40_000 });
  await expect.poll(async () => (await serverTask(page, 'taud1'))?.title, { timeout: 15_000 }).toBe('Written while saving failed');
  expect(await errors(['Restarting', 'offline'])).toEqual([]);
});

test('closing the tab mid-save sends the change with keepalive, after asking', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const r = await page.request.post('/api/sync', {
    headers,
    data: { ops: [project('pkeep', 'KEEP'), task('tkeep1', 'pkeep', 'KEEP-201', 'Keepalive draft')] },
  });
  expect(r.ok()).toBe(true);
  await page.goto('/#project/keep/list');
  await page.locator('[data-a="openTask"]', { hasText: 'Keepalive draft' }).first().click();
  await expect(page.locator('#d-title')).toHaveValue('Keepalive draft');

  // The first save is held up on its way; the change made behind it is still queued when the tab
  // goes. pagehide sends only the queue (the batch on its way went with keepalive itself, and
  // re-sending it could land after the queue). The event is dispatched here, because Playwright
  // can't reliably route requests from a page that has really unloaded.
  let held = null;
  const sent = [];
  await page.route('**/api/sync', route => {
    if (!held) return void (held = route);
    sent.push(
      route
        .request()
        .postDataJSON()
        .ops.map(op => op.c + ':' + Object.keys(op.v || {}).join(',')),
    );
    return route.continue();
  });
  await page.fill('#d-title', 'Saved on the way out');
  await page.locator('#d-title').blur();
  await expect.poll(() => !!held).toBe(true);
  await page.fill('#d-sub', 'Queued behind it');
  await page.press('#d-sub', 'Enter');
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'saving');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  await expect.poll(async () => (await serverTask(page, 'tkeep1'))?.subtasks?.map(x => x.title)).toEqual(['Queued behind it']);
  // One keepalive request, with the queued change and not the batch still on its way.
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('tasks:subtasks,updated');
  expect(sent[0]).not.toContain('tasks:title,updated');

  // Really leaving while the first save is still unanswered asks first.
  const asked = [];
  page.on('dialog', d => {
    asked.push(d.type());
    d.accept();
  });
  await page.goto('about:blank');
  expect(asked).toContain('beforeunload');
  await held.continue().catch(() => {});
});

test('changes queued offline survive the page going into the back/forward cache', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const r = await page.request.post('/api/sync', { headers, data: { ops: [project('pbf', 'BF'), task('tbf1', 'pbf', 'BF-201', 'Before the trip')] } });
  expect(r.ok()).toBe(true);
  await page.goto('/#project/bf/list');
  await page.locator('[data-a="openTask"]', { hasText: 'Before the trip' }).first().click();

  // Offline: the edit waits in the queue.
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.fill('#d-title', 'Made offline, kept through Back');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');

  // The tab goes into the back/forward cache (Playwright's Chromium has the cache turned off, so
  // the browser's own events are dispatched): the keepalive send fails, offline, so the edit stays.
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.waitForTimeout(300);
  // Back, and online again: the queued edit is saved, not overwritten by the reload.
  await page.unroute('**/api/sync');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(async () => (await serverTask(page, 'tbf1'))?.title, { timeout: 20_000 }).toBe('Made offline, kept through Back');
  await expect(page.locator('#d-title')).toHaveValue('Made offline, kept through Back');
});

test('signing out leaves nothing of the person in the tab', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/api');
  await page.fill('#api-name', 'Left behind?');
  await page.fill('#api-pw', OWNER.password);
  await page.click('#api-create');
  await expect(page.locator('#api-token')).toHaveValue(/^ssk_/);
  await page.evaluate(() => (window.__sameTab = true));

  await signOut(page);
  // The page was reloaded, so no in-memory state (like the key just shown) survives...
  expect(await page.evaluate(() => window.__sameTab)).toBeUndefined();
  // ...and the browser keeps only display preferences.
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('sudo-sapient.prefs') || '{}'));
  expect(cached).not.toHaveProperty('name');
  expect(cached).not.toHaveProperty('title');

  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/api');
  await expect(page.locator('.srow', { hasText: 'Left behind?' })).toBeVisible();
  await expect(page.locator('#api-token')).toHaveCount(0);

  // A session that ends elsewhere closes the live stream; the tab signs out, reloads and says why.
  await page.request.post('/api/auth/logout', { headers });
  await toastWith(page, 'Your session ended');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test.afterAll(async ({ browser }) => {
  // Leave no key behind for later runs against this database.
  const page = await browser.newPage();
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const keys = await (await page.request.get('/api/keys')).json();
  for (const k of keys.filter(k => k.name === 'Left behind?')) await page.request.delete(`/api/keys/${k.id}`, { headers });
  await synced(page);
  await page.close();
});
