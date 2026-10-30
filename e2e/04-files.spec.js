import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET as OWNER, openProject, signIn, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

// A real 1×1 PNG, so the browser can render the thumbnail.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const card = (page, name) => page.locator('.fcard', { hasText: name });

test('upload a file to a project, preview it, download the same bytes, rename and delete it', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine', 'files');
  await page.locator('label.btn input[data-in="uploadFiles"]').setInputFiles({ name: 'mill-diagram.png', mimeType: 'image/png', buffer: PNG });
  await toastWith(page, 'Uploaded mill-diagram.png');
  await expect(card(page, 'mill-diagram.png').locator('img')).toHaveJSProperty('naturalWidth', 1);
  await synced(page);
  await page.reload();
  await expect(card(page, 'mill-diagram.png')).toContainText('70 B');

  await card(page, 'mill-diagram.png').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#file-download')]);
  expect(dl.suggestedFilename()).toBe('mill-diagram.png');
  expect(fs.readFileSync(await dl.path())).toEqual(PNG);
  await page.locator('.modal [data-a="closeModal"]').last().click();

  await card(page, 'mill-diagram.png').click({ button: 'right' });
  await page.locator('.pop [data-a="renameFile"]').click();
  await page.fill('#prompt-in', 'mill-v2.png');
  await page.press('#prompt-in', 'Enter');
  await synced(page);
  await page.reload();
  await expect(card(page, 'mill-v2.png')).toBeVisible();

  await card(page, 'mill-v2.png').click({ button: 'right' });
  await page.locator('.pop [data-a="delFile"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await synced(page);
  await page.reload();
  await expect(card(page, 'mill-v2.png')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('attach files to a task from the drawer and from the new-task form', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine');
  const row = page.locator('[data-task-row]', { hasText: 'Design the mill and store' }).first();
  await row.locator('[data-a="openTask"]').first().click();
  await page
    .locator('.drawer .dsec-h input[data-in="uploadFiles"]')
    .setInputFiles({ name: 'store-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('1000 numbers of 50 digits') });
  await toastWith(page, 'Uploaded store-notes.txt');
  await expect(page.locator('.drawer .attc', { hasText: 'store-notes.txt' })).toBeVisible();
  await synced(page);
  await page.reload();
  await row.locator('[data-a="openTask"]').first().click();
  await expect(page.locator('.drawer .attc', { hasText: 'store-notes.txt' })).toBeVisible();
  await page.locator('.drawer [data-k="drawerTab"][data-v="activity"]').click();
  await expect(page.locator('.drawer')).toContainText('added a file to store-notes.txt');
  await page.locator('.drawer [data-a="closeDrawer"]').click();

  await page.locator('[data-a="newTask"]').first().click();
  await page.fill('#f-title', 'Print the tables');
  await page
    .locator('.modal input[data-in="formFiles"]')
    .setInputFiles({ name: 'tables.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 tables') });
  await expect(page.locator('.modal')).toContainText('tables.pdf');
  await page.click('#f-submit');
  await toastWith(page, 'Uploaded tables.pdf');
  await synced(page);
  await page.reload();
  await page.locator('[data-task-row]', { hasText: 'Print the tables' }).locator('[data-a="openTask"]').first().click();
  await expect(page.locator('.drawer .attc', { hasText: 'tables.pdf' })).toBeVisible();
  await page.locator('.drawer [data-a="closeDrawer"]').click();
  await page.locator('.tab[data-tab="files"]').click();
  await expect(card(page, 'tables.pdf')).toBeVisible();
  await expect(card(page, 'store-notes.txt')).toBeVisible();
  expect(await errors()).toEqual([]);
});
