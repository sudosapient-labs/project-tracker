/* The app on a phone (Pixel 7: touch, no hover), as the Android app shows it: everything works by
   tap, the system Back button closes what's open before it leaves the page, nothing is wider than
   the screen. Runs after the desktop journeys, in the workspace they made. */
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET as OWNER, signIn, synced, toastWith, watchErrors } from '../helpers.js';

const NAME = 'Pocket Engine';
let key = ''; // the project's key, lower case, as in its URL (see projectKey)

const drawer = page => page.locator('.drawer');
const row = (page, title) => page.locator('.trow[data-task-row]', { hasText: title }).first();
const card = (page, title) => page.locator('.kcard', { hasText: title }).first();
const popup = page => page.locator('.pop.floating');
const hash = page => page.evaluate(() => location.hash);
/* Go to a page as a link would (a new history entry). */
async function visit(page, h) {
  await page.evaluate(h => (location.hash = h), h);
  await expect.poll(() => hash(page)).toBe('#' + h);
}
/* Signed in on the phone, with `key` known (each test finds it, so one failing doesn't stop the rest). */
async function signInPhone(page) {
  await signIn(page, OWNER);
  await expect(page.locator('.bottomnav')).toBeVisible();
  if (key) return;
  await page.locator('.side .sitem', { hasText: NAME }).evaluate(el => el.click());
  await expect.poll(() => hash(page)).toMatch(/^#project\//);
  key = (await hash(page)).split('/')[1];
}
async function newTask(page, title) {
  await page.locator('.toolbar [data-a="newTask"], .ph [data-a="newTask"]').first().tap();
  await page.fill('#f-title', title);
  await page.locator('#f-submit').tap();
  await toastWith(page, 'Created');
}

test('a project and its tasks are made by touch', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.bottomnav')).toBeVisible();
  await page.locator('.bottomnav button', { hasText: 'Projects' }).tap();
  await page.locator('.ph [data-a="newProject"]').tap();
  await page.fill('#p-name', NAME);
  await page.locator('[data-a="submitProject"]').tap();
  await toastWith(page, `Created ${NAME}`);
  await expect(page.locator('.proj-h')).toContainText(NAME);
  key = (await hash(page)).split('/')[1];
  await page.locator('.tab[data-tab="list"]').tap();
  for (const t of ['Gear one', 'Gear two', 'Gear three']) await newTask(page, t);
  await synced(page);
  // The toolbar keeps both of its rows on a phone: its buttons aren't drawn over the list (they were).
  const bottom = await page.locator('.pbody .toolbar').evaluate(el => Math.max(...[...el.children].map(c => c.getBoundingClientRect().bottom)));
  const first = await page.locator('.pbody .grp').first().boundingBox();
  expect(bottom).toBeLessThanOrEqual(first.y);
  expect(await errors()).toEqual([]);
});

test('Back closes the menu, then the edit window, then the drawer, then goes back a page', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  await page.locator('.tab[data-tab="list"]').tap();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/list`);

  await row(page, 'Gear one').locator('.ttl').tap();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).locator('.drawer-h [data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await expect(page.locator('.modal')).toBeVisible();
  await page.locator('.modal [data-a="pop"][data-pop="status"]').tap();
  await expect(popup(page)).toBeVisible();

  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator('.modal')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/board`);
  await expect(page.locator('.board')).toBeVisible();

  // Forward returns to the list; the drawer that was closed doesn't come back.
  await page.goForward();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/list`);
  await page.goForward();
  await page.waitForTimeout(300);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(row(page, 'Gear one')).toBeVisible();

  // The sidebar is closed by Back too, and the page stays.
  await page.locator('.bottomnav [data-a="openMnav"]').tap();
  await expect(page.locator('.shell.mnav')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.shell.mnav')).toHaveCount(0);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  expect(await errors()).toEqual([]);
});

test('closing with X leaves nothing behind for Back: it goes straight to the page before', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  await visit(page, `project/${key}/list`);
  await row(page, 'Gear two').locator('.ttl').tap();
  await expect(drawer(page)).toBeVisible();
  await drawer(page).locator('.drawer-h [data-a="closeDrawer"]').tap();
  await expect(drawer(page)).toHaveCount(0);
  // A menu opened and closed by picking from it leaves nothing either.
  await row(page, 'Gear two').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="ctxPrio"]').tap();
  await popup(page).locator('[data-a="popPick"][data-v="high"]').tap();
  await expect(popup(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/board`);
  expect(await errors()).toEqual([]);
});

test('Back from an edit window does what its X does; typed text and a picked date are kept', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);

  // The task edit window: X closes it without saving, and so does Back.
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await page.fill('#f-title', 'Gear one, edited by X');
  await page.locator('.modal [data-a="closeModal"]').first().tap();
  await expect(page.locator('.modal')).toHaveCount(0);
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await page.fill('#f-title', 'Gear one, edited by Back');
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(row(page, 'Gear one')).toBeVisible();
  await expect(page.locator('.trow', { hasText: 'edited by' })).toHaveCount(0);
  expect(await hash(page)).toBe(`#project/${key}/list`);

  // The drawer's title being typed is saved, as when it loses focus, and the drawer closes.
  await row(page, 'Gear one').locator('.ttl').tap();
  await page.locator('#d-title').tap();
  await page.fill('#d-title', 'Gear one, cast');
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(row(page, 'Gear one, cast')).toBeVisible();

  // A date picked in the date picker is saved, as a tap outside it does; the drawer stays open.
  await row(page, 'Gear two').locator('.ttl').tap();
  await drawer(page).locator('[data-a="pop"][data-pop="date"][data-field="due"]').first().tap();
  await popup(page).locator('.dp-chip', { hasText: 'Tomorrow' }).tap();
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('[data-pop="date"][data-field="due"]').first()).toContainText('Tomorrow');
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await synced(page);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  expect(await errors()).toEqual([]);
});

test('a task opened from a link: Back closes it and stays in the app', async ({ page, context }) => {
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  await row(page, 'Gear two').locator('.ttl').tap();
  const taskKey = (await drawer(page).locator('.drawer-h .mono').textContent()).trim();

  const tab = await context.newPage();
  const errors = watchErrors(tab);
  await tab.goto(`/#task/${taskKey}`);
  await expect(tab.locator('.drawer')).toBeVisible();
  await expect(tab.locator('.drawer .ttl-edit')).toHaveValue('Gear two');
  await tab.goBack();
  await expect(tab.locator('.drawer')).toHaveCount(0);
  await expect(tab.locator('.bottomnav')).toBeVisible();
  expect(new URL(tab.url()).hash).not.toContain('task/');
  // Reload keeps the page.
  const h = await hash(tab);
  await tab.reload();
  await expect(tab.locator('.bottomnav')).toBeVisible();
  expect(await hash(tab)).toBe(h);
  expect(await errors()).toEqual([]);
});

test('a list row moves up and down from its menu by touch', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  const order = () => page.locator('.trow[data-task-row] .tt').allTextContents();
  const before = await order();
  const [a, b] = [before.indexOf('Gear two'), before.indexOf('Gear three')];
  expect(b).toBe(a + 1);

  await row(page, 'Gear two').locator('[data-a="ctxBtn"]').tap();
  await expect(popup(page).locator('[data-a="rowDown"]')).toBeVisible();
  await popup(page).locator('[data-a="rowDown"]').tap();
  await expect.poll(async () => (await order()).indexOf('Gear two')).toBe(b);
  await synced(page);
  await page.reload();
  await expect.poll(async () => (await order()).indexOf('Gear two')).toBe(b);

  await row(page, 'Gear two').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="rowUp"]').tap();
  await expect.poll(async () => (await order()).indexOf('Gear two')).toBe(a);
  await synced(page);
  expect(await errors()).toEqual([]);
});

test('a board card moves to another column and is completed by touch', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  const c = card(page, 'Gear three');
  // The quick actions show without hovering.
  await expect(c.locator('.hacts [data-a="ctxBtn"]')).toBeVisible();
  await c.locator('.hacts [data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="ctxStatus"]').tap();
  await popup(page).locator('[data-a="popPick"][data-v="progress"]').tap();
  await expect(page.locator('.bcol[data-drop-col="progress"] .kcard', { hasText: 'Gear three' })).toBeVisible();

  await card(page, 'Gear three').locator('.hacts [data-a="toggleDone"]').tap();
  await expect(page.locator('.bcol[data-drop-col="done"] .kcard', { hasText: 'Gear three' })).toBeVisible();
  await synced(page);
  expect(await errors()).toEqual([]);
});

test('controls that showed only on hover can be seen and tapped', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  const shown = loc => loc.evaluate(el => getComputedStyle(el).opacity === '1' && getComputedStyle(el).display !== 'none');

  // A project card's menu.
  await visit(page, 'projects');
  const more = page.locator('.pcard', { hasText: NAME }).locator('.more');
  expect(await shown(more)).toBe(true);
  await more.tap();
  await expect(popup(page).locator('[data-a="openProject"]')).toBeVisible();
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);

  // A calendar day's add button.
  await visit(page, `project/${key}/calendar`);
  const add = page.locator('.cday:not(.out) .add').nth(14);
  expect(await shown(add)).toBe(true);
  await add.tap();
  await expect(page.locator('.modal')).toBeVisible();
  await expect(page.locator('.modal [data-pop="date"]').first()).not.toContainText('Due date');
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);

  // The sidebar's section and project buttons.
  await page.locator('.bottomnav [data-a="openMnav"]').tap();
  expect(await shown(page.locator('.sgroup-h [data-a="newProject"]'))).toBe(true);
  const item = page.locator('.side .sitem', { hasText: NAME });
  expect(await shown(item.locator('.hov [data-a="ctxBtn"]'))).toBe(true);
  await item.locator('.hov [data-a="ctxBtn"]').tap();
  await expect(popup(page).locator('[data-a="share"]')).toBeVisible();
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator('.shell.mnav')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.shell.mnav')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('the timeline is view-only by touch: a drag scrolls, a bar stays, a tap opens the task', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/timeline`);
  const bar = page.locator('.bar', { hasText: 'Gear two' }).or(page.locator('.bar[title^="Gear two"]')).first();
  await bar.scrollIntoViewIfNeeded();
  const left = await bar.evaluate(el => el.style.left);
  const due = await bar.getAttribute('title');
  const box = await bar.boundingBox();
  const x = box.x + Math.min(20, box.width / 2),
    y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, px) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: px == null ? [] : [{ x: px, y }] });
  await touch('touchStart', x);
  for (let i = 1; i <= 8; i++) await touch('touchMove', x - i * 15);
  await touch('touchEnd');
  await page.waitForTimeout(300);
  expect(await bar.evaluate(el => el.style.left)).toBe(left);
  await expect(bar).not.toHaveClass(/dragging/);
  expect(await bar.getAttribute('title')).toBe(due);

  await bar.tap();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('.ttl-edit')).toHaveValue('Gear two');
  expect(await errors()).toEqual([]);
});

test('nothing is wider than a 360px screen, and the drawer header fits', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await signInPhone(page);
  const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  const pages = ['home', 'inbox', 'mytasks', 'notifications', 'projects', 'tasks', 'calendar', 'timeline', 'members', 'activity', 'search'];
  for (const tab of ['overview', 'board', 'list', 'table', 'calendar', 'timeline', 'files', 'activity']) pages.push(`project/${key}/${tab}`);
  for (const sec of ['appearance', 'workspace', 'members', 'profile', 'preferences', 'api', 'sessions', 'account']) pages.push(`settings/${sec}`);
  for (const h of pages) {
    await visit(page, h);
    await page.waitForTimeout(100);
    expect(await fits(), h).toBe(true);
  }
  await visit(page, `project/${key}/list`);
  await row(page, 'Gear two').locator('.ttl').tap();
  await expect(drawer(page)).toBeVisible();
  expect(await fits()).toBe(true);
  // Measured once it has slid in.
  await drawer(page).evaluate(el => Promise.all(el.getAnimations().map(a => a.finished)));
  const close = await drawer(page).locator('.drawer-h [data-a="closeDrawer"]').boundingBox();
  expect(close.x + close.width).toBeLessThanOrEqual(360);
  expect(close.height).toBeGreaterThanOrEqual(36);
  expect(await errors()).toEqual([]);
});

test('fields are 16px on a touch screen, and the status bar colour follows the theme chosen in Settings', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  expect(await page.locator('.toolbar input.search-sm').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');

  const color = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map(m => m.content));
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  // The phone is in light mode; the app is switched to dark and to light in Settings → Appearance.
  await visit(page, 'settings/appearance');
  const was = await page.locator('[data-a="setTheme"][aria-checked="true"]').getAttribute('data-v');
  await page.locator('[data-a="setTheme"][data-v="dark"]').tap();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await bg();
  expect(await color()).toEqual([dark, dark]);
  await page.locator('[data-a="setTheme"][data-v="light"]').tap();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const light = await bg();
  expect(light).not.toBe(dark);
  expect(await color()).toEqual([light, light]);
  await page.locator(`[data-a="setTheme"][data-v="${was}"]`).tap();
  await synced(page);
  expect(await errors()).toEqual([]);
});
