import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, watchErrors } from './helpers.js';

const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };

test('a key from Settings → API drives the workspace, and the open app shows each step live', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();

  // A project of its own, so this journey doesn't depend on the earlier ones'.
  const ops = [
    {
      c: 'projects',
      id: 'papi',
      k: 'put',
      v: {
        id: 'papi',
        key: 'API',
        name: 'API journey',
        icon: 'code',
        color: 'teal',
        status: 'active',
        team: '',
        lead: null,
        members: [],
        desc: '',
        milestones: [],
      },
    },
  ];
  expect((await page.request.post('/api/sync', { headers: { 'x-requested-with': 'sudo-sapient' }, data: { ops } })).ok()).toBe(true);

  await page.goto('/#settings/api');
  await page.fill('#api-name', 'Release script');
  // Making a key takes the current password, like setting up two-factor.
  await page.click('#api-create');
  await expect(page.locator('.set-body .err')).toContainText('Enter your current password');
  await page.fill('#api-pw', OWNER.password);
  await page.click('#api-create');
  const token = await page.inputValue('#api-token');
  expect(token).toMatch(/^ssk_/);
  await expect(page.locator('#api-new')).toContainText('sudo-cli login --url');
  await expect(page.locator('.srow', { hasText: 'Release script' })).toContainText('Never used');

  const headers = { authorization: `Bearer ${token}`, 'x-sudo-client': 'Release script' };
  const api = (method, url, data) => request.fetch(`/api/v1${url}`, { method, headers, data });

  // Created by the script: appears in the open list without a reload.
  await page.goto('/#project/api/list');
  const made = await (await api('POST', '/tasks', { project: 'API', title: 'Cut the 1.0 release', assignee: 'me' })).json();
  expect(made.key).toBe('API-201');
  const row = page.locator('[data-a="openTask"]', { hasText: 'Cut the 1.0 release' });
  await expect(row).toBeVisible();

  // Commented on: shows in the open task, attributed "via" the script.
  await row.click();
  const drawer = page.locator('.drawer');
  await expect(drawer).toContainText('Cut the 1.0 release');
  expect((await api('POST', `/tasks/${made.key}/comments`, { text: 'Changelog is ready' })).status()).toBe(201);
  await drawer.locator('[data-k="drawerTab"][data-v="comments"]').click();
  await expect(drawer).toContainText('Changelog is ready');

  // Completed: the open app updates, and the activity log names the script.
  expect((await api('POST', `/tasks/${made.key}/complete`)).status()).toBe(200);
  await drawer.locator('[data-k="drawerTab"][data-v="activity"]').click();
  await expect(drawer).toContainText('via Release script');
  await expect(drawer.locator('.act-line', { hasText: 'completed' })).toBeVisible();

  // Revoked in Settings: the key stops working straight away.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await page.goto('/#settings/api');
  await page.locator('.srow', { hasText: 'Release script' }).locator('[data-a="revokeApiKey"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await expect(page.locator('.srow', { hasText: 'Release script' })).toHaveCount(0);
  expect((await api('GET', '/me')).status()).toBe(401);
  expect(await errors()).toEqual([]);
});
