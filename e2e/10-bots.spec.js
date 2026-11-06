import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, watchErrors } from './helpers.js';

const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };

test('a bot made in Settings → API → Bots works through its own key and shows as the bot in Activity', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();

  const ops = [
    {
      c: 'projects',
      id: 'prel',
      k: 'put',
      v: {
        id: 'prel',
        key: 'REL',
        name: 'Releases',
        icon: 'rocket',
        color: 'teal',
        status: 'active',
        team: '',
        lead: null,
        members: [],
        desc: '',
        milestones: [],
        private: true,
      },
    },
  ];
  expect((await page.request.post('/api/sync', { headers: { 'x-requested-with': 'sudo-sapient' }, data: { ops } })).ok()).toBe(true);

  // Create the bot, on the private Releases project only.
  await page.goto('/#settings/api');
  const bots = page.locator('#bots');
  await expect(bots).toContainText('No bots yet.');
  await page.fill('#bot-name', 'Release Bot');
  await page.selectOption('#bot-role', 'Member');
  await bots.locator('input[name="bot-proj"][value="prel"]').check();
  await page.click('#bot-create');
  await expect(bots.locator('.srow', { hasText: 'Release Bot' })).toContainText('1 project · 0 keys');

  // Its key needs the admin's password, and is shown once.
  await page.fill('#bot-key-name', 'GitHub Actions');
  await page.click('#bot-key-create');
  await expect(bots.locator('.err')).toContainText('Enter your current password');
  await page.fill('#bot-key-pw', OWNER.password);
  await page.click('#bot-key-create');
  const token = await page.inputValue('#bot-token');
  expect(token).toMatch(/^ssk_/);
  // Records the admin who made it (renamed to hostile markup by the XSS journey, shown as text).
  const keyRow = bots.locator('.srow', { hasText: 'GitHub Actions' });
  await expect(keyRow).toContainText('Created by <img src=x');
  await expect(keyRow).not.toContainText('Former member');
  // It isn't one of the admin's personal keys.
  await expect(page.locator('.sblock', { hasText: 'Your keys' }).first()).not.toContainText('GitHub Actions');

  const api = (method, url, data) => request.fetch(`/api/v1${url}`, { method, headers: { authorization: `Bearer ${token}` }, data });
  expect(await (await api('GET', '/me')).json()).toMatchObject({ name: 'Release Bot', kind: 'bot', role: 'Member' });

  // The bot works in the open app's project, live.
  await page.goto('/#project/rel/list');
  const made = await (await api('POST', '/tasks', { project: 'REL', title: 'Publish 1.4.0' })).json();
  const row = page.locator('[data-a="openTask"]', { hasText: 'Publish 1.4.0' });
  await expect(row).toBeVisible();
  expect((await api('POST', `/tasks/${made.key}/comments`, { text: 'Tagged v1.4.0' })).status()).toBe(201);

  // Bots aren't offered as assignees.
  await page.locator('.trow', { hasText: 'Publish 1.4.0' }).locator('[data-pop="assignee"]').first().click();
  await expect(page.locator('.pop')).toContainText('Unassigned');
  await expect(page.locator('.pop')).not.toContainText('Release Bot');
  await page.keyboard.press('Escape');

  await row.click();
  const drawer = page.locator('.drawer');
  await drawer.locator('[data-k="drawerTab"][data-v="comments"]').click();
  await expect(drawer.locator('.cmt', { hasText: 'Tagged v1.4.0' })).toContainText('Release Bot');
  await expect(drawer.locator('.cmt', { hasText: 'Tagged v1.4.0' }).locator('.bot-badge')).toHaveText('Bot');
  await drawer.locator('[data-k="drawerTab"][data-v="activity"]').click();
  const created = drawer.locator('.act-line', { hasText: 'created' }).first();
  await expect(created).toContainText('Release Bot');
  await expect(created).toContainText('via GitHub Actions');
  await expect(created.locator('.bot-badge')).toHaveText('Bot');

  // Listed with the badge among the members.
  await page.keyboard.press('Escape');
  await page.goto('/#members');
  await expect(page.locator('tr', { hasText: 'Release Bot' }).locator('.bot-badge')).toBeVisible();

  // Removing the bot revokes its key.
  await page.goto('/#settings/api');
  await bots.locator('[data-a="dismissBotKey"]').click();
  await expect(page.locator('#bot-token')).toHaveCount(0);
  // The bot stays open where it was left.
  await expect(bots.locator('#bot-panel')).toBeVisible();
  await bots.locator('[data-a="removeBot"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await expect(bots).toContainText('No bots yet.');
  expect((await api('GET', '/me')).status()).toBe(401);
  expect(await errors()).toEqual([]);
});
