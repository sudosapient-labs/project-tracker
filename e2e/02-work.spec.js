import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET as OWNER, openProject, signIn, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const drawer = page => page.locator('.drawer');
const row = (page, title) => page.locator('[data-task-row]', { hasText: title }).first();

test('create a project and tasks, and everything survives a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await page.locator('.side [data-a="newProject"]').click();
  await page.fill('#p-name', 'Analytical Engine');
  await page.fill('#p-desc', 'Mill, store and punched cards.');
  await page.locator('[data-a="submitProject"]').click();
  await toastWith(page, 'Created Analytical Engine');
  await expect(page.locator('.proj-h')).toContainText('Analytical Engine');

  // Task through the modal.
  await page.locator('.tab[data-tab="list"]').click();
  await page.locator('[data-a="newTask"]').first().click();
  await page.fill('#f-title', 'Design the mill');
  await page.fill('#f-desc', 'The arithmetic unit.');
  await page.click('#f-submit');
  await toastWith(page, 'Created AE-');

  // Task through the inline composer on the list.
  await page.locator('[data-a="startComposer"]').first().click();
  await page.fill('#composer-in', 'Punch the cards');
  await page.press('#composer-in', 'Enter');
  await page.press('#composer-in', 'Escape');
  await synced(page);

  await page.reload();
  await expect(row(page, 'Design the mill')).toBeVisible();
  await expect(row(page, 'Punch the cards')).toBeVisible();
  await expect(page.locator('.side')).toContainText('Analytical Engine');
  expect(await errors()).toEqual([]);
});

test('edit a task in the drawer: title, subtasks, comments, completion', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine');
  await row(page, 'Design the mill').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page)).toBeVisible();

  await page.fill('#d-title', 'Design the mill and store');
  await page.locator('#d-title').blur();
  await page.fill('#d-sub', 'Carry mechanism');
  await page.press('#d-sub', 'Enter');
  await page.fill('#d-sub', 'Anticipating carriage');
  await page.press('#d-sub', 'Enter');
  await drawer(page).locator('.subt', { hasText: 'Carry mechanism' }).locator('input[type="checkbox"]').check();
  await page.fill('#d-cmt', 'Babbage suggests base ten.');
  await drawer(page).locator('[data-a="postComment"]').click();
  await expect(drawer(page)).toContainText('Babbage suggests base ten.');
  await synced(page);

  await page.reload();
  await row(page, 'Design the mill and store').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page).locator('#d-title')).toHaveValue('Design the mill and store');
  await expect(drawer(page).locator('.subt.done', { hasText: 'Carry mechanism' })).toBeVisible();
  await expect(drawer(page).locator('.subt', { hasText: 'Anticipating carriage' })).toBeVisible();
  await expect(drawer(page)).toContainText('Babbage suggests base ten.');

  await drawer(page).locator('.drawer-h [data-a="toggleDone"]').click();
  await expect(drawer(page).locator('.drawer-h')).toContainText('Completed');
  await synced(page);
  await page.reload();
  await row(page, 'Design the mill and store').locator('[data-a="openTask"]').first().click();
  await expect(drawer(page).locator('.drawer-h')).toContainText('Completed');
  // The activity tab lists what happened, as recorded on the server.
  await drawer(page).locator('[data-k="drawerTab"][data-v="activity"]').click();
  await expect(drawer(page)).toContainText('completed');
  expect(await errors()).toEqual([]);
});

test('delete a task, undo it, then delete it for good', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openProject(page, 'Analytical Engine');

  await row(page, 'Punch the cards').click({ button: 'right' });
  await page.locator('.pop [data-a="delTask"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await page.locator('#toasts .toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Punch the cards')).toBeVisible();
  await synced(page);
  await page.reload();
  await expect(row(page, 'Punch the cards')).toBeVisible();

  await row(page, 'Punch the cards').click({ button: 'right' });
  await page.locator('.pop [data-a="delTask"]').click();
  await page.locator('[data-a="confirmOk"]').click();
  await expect(row(page, 'Punch the cards')).toHaveCount(0);
  await synced(page);
  await page.reload();
  await expect(row(page, 'Design the mill and store')).toBeVisible();
  await expect(row(page, 'Punch the cards')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});
