/* Back and forward on a desktop browser follow the pages visited, as they always have: an open task
   drawer is not a history entry here (on a phone it is: see e2e/phone/). */
import { expect, test } from '@playwright/test';
import { ownerNow, signIn, watchErrors } from './helpers.js';

const hash = page => page.evaluate(() => location.hash);

test('back and forward move between pages; the drawer and Escape leave history alone', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, await ownerNow(request));
  await expect(page.locator('.side')).toBeVisible();
  await page.locator('.side [data-a="go"][data-r="mytasks"]').click();
  await expect.poll(() => hash(page)).toBe('#mytasks');
  await page.locator('.side [data-drag-proj]').filter({ hasText: 'Difference Engine' }).click();
  await page.locator('.tab[data-tab="list"]').click();
  const list = await hash(page);
  expect(list).toMatch(/^#project\/[a-z0-9]+\/list$/);

  await page.locator('[data-task-row] .ttl').first().click();
  await expect(page.locator('.drawer')).toBeVisible();
  // The drawer added no entry: Back goes to the page before, and the drawer stays open there.
  await page.goBack();
  await expect.poll(() => hash(page)).toMatch(/^#project\/[a-z0-9]+\/board$/);
  await expect(page.locator('.drawer')).toBeVisible();
  await page.goForward();
  await expect.poll(() => hash(page)).toBe(list);

  // Escape closes the drawer without moving in history.
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  expect(await hash(page)).toBe(list);
  await page.goBack();
  await expect.poll(() => hash(page)).toMatch(/^#project\/[a-z0-9]+\/board$/);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe('#mytasks');

  // Reload keeps the page.
  await page.reload();
  await expect(page.locator('.side')).toBeVisible();
  expect(await hash(page)).toBe('#mytasks');
  expect(await errors()).toEqual([]);
});
