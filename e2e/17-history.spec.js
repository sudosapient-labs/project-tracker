/* Back and forward on a desktop browser follow the pages visited, as they always have: an open task
   drawer is not a history entry here (on a phone it is: see e2e/phone/). */
import { expect, test } from '@playwright/test';
import { ownerNow, signIn, toastWith, watchErrors } from './helpers.js';

const hash = page => page.evaluate(() => location.hash);
/* Every pushState, with whether the page had a user activation and whether it ran inside a
   popstate: Chrome lets Back skip an entry that had another pushed over it with no click since. */
const watchPushes = page =>
  page.addInitScript(() => {
    const push = history.pushState.bind(history);
    /** @type {any} */ (window).__pushes = [];
    history.pushState = (...a) => {
      /** @type {any} */ (window).__pushes.push({ click: navigator.userActivation.isActive, inBack: window.event?.type === 'popstate' });
      return push(...a);
    };
  });
const pushes = page => page.evaluate(() => /** @type {any} */ (window).__pushes.splice(0));

test('back and forward move between pages; the drawer and Escape leave history alone', async ({ page, request }) => {
  const errors = watchErrors(page);
  await watchPushes(page);
  await signIn(page, await ownerNow(request));
  await expect(page.locator('.side')).toBeVisible();
  await pushes(page);
  const start = await page.evaluate(() => history.length);
  await page.locator('.side [data-a="go"][data-r="mytasks"]').click();
  await expect.poll(() => hash(page)).toBe('#mytasks');
  await page.locator('.side [data-drag-proj]').filter({ hasText: 'Difference Engine' }).click();
  await page.locator('.tab[data-tab="list"]').click();
  const list = await hash(page);
  expect(list).toMatch(/^#project\/[a-z0-9]+\/list$/);

  await page.locator('[data-task-row] .ttl').first().click();
  await expect(page.locator('.drawer')).toBeVisible();
  const key = (await page.locator('.drawer-h .mono').textContent()).trim();
  // The URL names the open task after the page, in place.
  await expect.poll(() => hash(page)).toBe(`${list}?task=${key}`);
  // The drawer added no entry: Back goes to the page before, and the drawer stays open there.
  await page.goBack();
  await expect.poll(() => hash(page)).toMatch(new RegExp(`^#project/[a-z0-9]+/board\\?task=${key}$`));
  await expect(page.locator('.drawer')).toBeVisible();
  await page.goForward();
  await expect.poll(() => hash(page)).toBe(`${list}?task=${key}`);

  // Escape closes the drawer without moving in history.
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  expect(await hash(page)).toBe(list);
  await page.goBack();
  await expect.poll(() => hash(page)).toMatch(/^#project\/[a-z0-9]+\/board$/);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe('#mytasks');
  // One entry per page clicked to (My tasks, the project, its list), each in its click; Back,
  // Forward, the drawer and Escape added none.
  expect(await pushes(page)).toEqual(Array(3).fill({ click: true, inBack: false }));
  expect(await page.evaluate(() => history.length)).toBe(start + 3);

  // Reload keeps the page.
  await page.reload();
  await expect(page.locator('.side')).toBeVisible();
  expect(await hash(page)).toBe('#mytasks');
  expect(await errors()).toEqual([]);
});

test('a link opened in the open app opens its task where you are; the URL, a reload and a close', async ({ page, request }) => {
  const errors = watchErrors(page);
  const owner = await ownerNow(request);
  await signIn(page, owner);
  await expect(page.locator('.side')).toBeVisible();
  await page.locator('.side [data-drag-proj]').filter({ hasText: 'Difference Engine' }).click();
  await page.locator('.tab[data-tab="list"]').click();
  const list = await hash(page);
  await page.locator('[data-task-row] .ttl').first().click();
  const key = (await page.locator('.drawer-h .mono').textContent()).trim();
  const title = await page.locator('.drawer .ttl-edit').inputValue();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);

  // A copied #task/KEY link pasted into the open tab only changes the hash.
  await page.evaluate(k => (location.hash = `task/${k}`), key);
  await expect(page.locator('.drawer .ttl-edit')).toHaveValue(title);
  await expect.poll(() => hash(page)).toBe(`${list}?task=${key}`);
  await page.reload();
  await expect(page.locator('.drawer .ttl-edit')).toHaveValue(title);
  expect(await hash(page)).toBe(`${list}?task=${key}`);
  await page.locator('.drawer-h [data-a="closeDrawer"]').click();
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);

  // A page link opens the page; one to a task that isn't there says so and stays put.
  await page.evaluate(() => (location.hash = 'mytasks'));
  await expect(page.locator('.side [data-a="go"][data-r="mytasks"]')).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => (location.hash = 'task/NOPE-404'));
  await toastWith(page, "NOPE-404 can't be opened");
  await expect(page.locator('.drawer')).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe('#mytasks');

  // A link that comes while the app is still loading opens once it has.
  let release;
  const held = new Promise(r => (release = r));
  await page.route('**/api/bootstrap', async route => {
    await held;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator('.side')).toHaveCount(0);
  await page.evaluate(k => (location.hash = `task/${k}`), key);
  release();
  await expect(page.locator('.drawer .ttl-edit')).toHaveValue(title);
  await expect.poll(() => hash(page)).toMatch(new RegExp(`\\?task=${key}$`));
  await page.unroute('**/api/bootstrap');
  expect(await errors(["NOPE-404 can't be opened"])).toEqual([]);
});
