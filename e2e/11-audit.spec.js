import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, watchErrors } from './helpers.js';

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

  // The ordinary save never gets an answer (the browser cancels it on unload); later requests (the
  // keepalive one sent on the way out) go through.
  let n = 0;
  await page.route('**/api/sync', route => (n++ === 0 ? undefined : route.continue()));
  await page.fill('#d-title', 'Saved on the way out');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'saving');

  const asked = [];
  page.on('dialog', d => {
    asked.push(d.type());
    d.accept();
  });
  await page.goto('about:blank');
  await expect.poll(async () => (await serverTask(page, 'tkeep1'))?.title, { timeout: 15_000 }).toBe('Saved on the way out');
  expect(asked).toContain('beforeunload');
});
