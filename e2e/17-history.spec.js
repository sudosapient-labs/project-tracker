/* Back and forward on a desktop browser follow the pages visited, as they always have: an open task
   drawer is not a history entry here (on a phone it is: see e2e/phone/). */
import { expect, test } from '@playwright/test';
import { openProject, ownerNow, signIn, synced, toastWith, watchErrors } from './helpers.js';

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

test('Escape in the drawer’s title cancels the rename; Enter saves it', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, await ownerNow(request));
  await expect(page.locator('.side')).toBeVisible();
  await openProject(page, 'Difference Engine');
  await page.locator('[data-task-row] .ttl').first().click();
  const title = page.locator('.drawer .ttl-edit');
  const was = await title.inputValue();
  const id = await title.getAttribute('data-id');
  const saved = async () => (await (await request.get('/api/bootstrap')).json()).data.tasks.find(t => t.id === id).title;

  await title.fill(`${was} (not this)`);
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  await synced(page);
  expect(await saved()).toBe(was);
  await expect(page.locator('[data-task-row] .ttl', { hasText: '(not this)' })).toHaveCount(0);

  await page.locator('[data-task-row] .ttl', { hasText: was }).first().click();
  await expect(title).toHaveValue(was);
  await title.fill(`${was} (renamed)`);
  await page.keyboard.press('Enter');
  await synced(page);
  expect(await saved()).toBe(`${was} (renamed)`);
  await title.fill(was);
  await page.keyboard.press('Enter');
  await synced(page);
  expect(await saved()).toBe(was);
  expect(await errors()).toEqual([]);
});

test('a link closing a new task opened over an edit keeps what was typed in each, each for its own window', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, await ownerNow(request));
  await expect(page.locator('.side')).toBeVisible();
  await openProject(page, 'Difference Engine');
  const first = page.locator('[data-task-row]').first();
  await first.locator('.ttl').click();
  const key = (await page.locator('.drawer-h .mono').textContent()).trim();
  const was = await page.locator('.drawer .ttl-edit').inputValue();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  const edit = async () => {
    await first.hover();
    await first.locator('[data-a="ctxBtn"]').click();
    await page.locator('.pop.floating [data-a="editTask"]').click();
    await expect(page.locator('.modal')).toHaveCount(1);
  };

  // Edit a task, then (from the palette) start a new one over it; both have a #f-title.
  await edit();
  await page.locator('.modal #f-title').fill(`${was} (edited)`);
  await page.keyboard.press('Control+k');
  await page.locator('.pi', { hasText: 'Create task' }).click();
  await expect(page.locator('.modal')).toHaveCount(2);
  await page.locator('.modal').last().locator('#f-title').fill('A gear of its own');
  // A link opening closes them both, keeping what was typed.
  await page.evaluate(k => (location.hash = `task/${k}`), key);
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(page.locator('.drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);

  await edit();
  await expect(page.locator('.modal #f-title')).toHaveValue(`${was} (edited)`);
  await page.locator('.modal [data-a="closeModal"]').first().click();
  await page.keyboard.press('Control+k');
  await page.locator('.pi', { hasText: 'Create task' }).click();
  await expect(page.locator('.modal #f-title')).toHaveValue('A gear of its own');
  await page.locator('.modal [data-a="closeModal"]').first().click();
  await expect(page.locator('.modal')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('a link opening saves a date picked and a table cell being typed in, as Back does', async ({ page, request }) => {
  const errors = watchErrors(page);
  await signIn(page, await ownerNow(request));
  await expect(page.locator('.side')).toBeVisible();
  await openProject(page, 'Difference Engine');
  const rows = page.locator('[data-task-row]');
  const keyOf = async i => {
    await rows.nth(i).locator('.ttl').click();
    const k = (await page.locator('.drawer-h .mono').textContent()).trim();
    const id = await page.locator('.drawer .ttl-edit').getAttribute('data-id');
    return [k, id];
  };
  const [, a] = await keyOf(0);
  await page.keyboard.press('Escape');
  const [kb] = await keyOf(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.drawer')).toHaveCount(0);
  const saved = async id => (await (await request.get('/api/bootstrap')).json()).data.tasks.find(t => t.id === id);
  const link = k => page.evaluate(k => (location.hash = `task/${k}`), k);

  // A due date picked in the drawer's date picker, not yet saved, when a link to another task comes.
  const due = (await saved(a)).due;
  await rows.nth(0).locator('.ttl').click();
  await page.locator('.drawer [data-a="pop"][data-pop="date"][data-field="due"]').first().click();
  const chip = page.locator('.pop.floating .dp-chip:not(.on)', { hasText: /^(Tomorrow|Today|Next week)$/ }).first();
  await chip.click();
  await link(kb);
  await expect(page.locator('.pop.floating')).toHaveCount(0);
  await expect(page.locator('.drawer .drawer-h .mono')).toHaveText(kb);
  await synced(page);
  expect((await saved(a)).due).not.toEqual(due);
  await page.keyboard.press('Escape');

  // A table cell being typed in.
  await page.locator('.tab[data-tab="table"]').click();
  const cell = page.locator(`td[data-f="estimate"][data-id="${a}"]`);
  await cell.click();
  await page.locator('#edit-cell').fill('3d');
  await link(kb);
  await expect(page.locator('.drawer .drawer-h .mono')).toHaveText(kb);
  await synced(page);
  expect((await saved(a)).estimate).toBe('3d');
  await page.keyboard.press('Escape');
  expect(await errors()).toEqual([]);
});
