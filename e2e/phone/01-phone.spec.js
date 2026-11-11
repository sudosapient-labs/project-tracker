/* The app on a phone (Pixel 7: touch, no hover), as the Android app shows it: everything works by
   tap, the system Back button closes what's open before it leaves the page, nothing is wider than
   the screen. Runs after the desktop journeys, in the workspace they made. */
import { devices, expect, test } from '@playwright/test';
import { ownerNow, signIn, synced, toastWith, watchErrors } from '../helpers.js';

const NAME = 'Pocket Engine';
let OWNER; // whose password depends on how many journeys ran before (see ownerNow)
let key = ''; // the project's key, lower case, as in its URL (see projectKey)

test.beforeEach(async ({ request }) => {
  OWNER ??= await ownerNow(request);
});

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
/* The history the app writes, as Chrome on Android sees it. Chrome lets Back skip an entry the page
   added another one on top of with no tap since, and page.goBack() doesn't skip, so the tests read
   the structure itself: every pushState is recorded with whether the page had a user activation
   and whether it ran inside a popstate (Back), and history.length and the entry's state
   (`{ layer: n, id, below }`, see src/actions/back.js) are checked after each step. */
async function watchHistory(page) {
  await page.addInitScript(() => {
    const push = history.pushState.bind(history);
    /** @type {any} */ (window).__pushes = [];
    history.pushState = (...a) => {
      /** @type {any} */ (window).__pushes.push({ tap: navigator.userActivation.isActive, inBack: window.event?.type === 'popstate', layer: a[0]?.layer || 0 });
      return push(...a);
    };
  });
}
/* history.length, the entry's state, and the pushes since the last call (taken). */
const entries = page => page.evaluate(() => ({ length: history.length, state: history.state, pushes: /** @type {any} */ (window).__pushes.splice(0) }));
/* The entry shown is `n` layers over the page entry `base`, and history has `length` entries. Each
   push since the last check came with a tap and outside Back; `pushes` says how many there were. */
async function expectEntry(page, { length, base, n, pushes = 0 }) {
  await expect.poll(async () => await page.evaluate(() => history.state?.layer || 0)).toBe(n);
  const h = await entries(page);
  expect(h.length).toBe(length);
  expect(
    h.pushes.filter(p => !p.tap || p.inBack),
    'a push with no tap, or during Back',
  ).toEqual([]);
  expect(h.pushes.length).toBe(pushes);
  if (n) expect(h.state.below).toEqual([base, ...h.state.below.slice(1)]);
  if (n) expect(h.state.below).toHaveLength(n);
  else expect(h.state.id).toBe(base);
  return h.state.id;
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

test('Back closes the menu, then the edit window, then the drawer, then goes back a page; one entry per tap', async ({ page }) => {
  const errors = watchErrors(page);
  await watchHistory(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  const board = (await entries(page)).state.id;
  await page.locator('.tab[data-tab="list"]').tap();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/list`);
  const { length, state } = await entries(page);
  const list = state.id;

  // Each layer opened by a tap adds one entry, in that tap.
  await row(page, 'Gear one').locator('.ttl').tap();
  await expect(drawer(page)).toBeVisible();
  const l1 = await expectEntry(page, { length: length + 1, base: list, n: 1, pushes: 1 });
  await drawer(page).locator('.drawer-h [data-a="ctxBtn"]').tap();
  await expect(popup(page)).toBeVisible();
  const l2 = await expectEntry(page, { length: length + 2, base: list, n: 2, pushes: 1 });
  // The menu gives way to the edit window: still two layers, no new entry.
  await popup(page).locator('[data-a="editTask"]').tap();
  await expect(page.locator('.modal')).toBeVisible();
  await expectEntry(page, { length: length + 2, base: list, n: 2 });
  await page.locator('.modal [data-a="pop"][data-pop="status"]').tap();
  await expect(popup(page)).toBeVisible();
  await expectEntry(page, { length: length + 3, base: list, n: 3, pushes: 1 });

  // Back only steps back: no entry is added, so none under it is one Chrome would skip.
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator('.modal')).toBeVisible();
  expect(await expectEntry(page, { length: length + 3, base: list, n: 2 })).toBe(l2);
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(drawer(page)).toBeVisible();
  expect(await expectEntry(page, { length: length + 3, base: list, n: 1 })).toBe(l1);
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expectEntry(page, { length: length + 3, base: list, n: 0 });
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/board`);
  await expect(page.locator('.board')).toBeVisible();
  await expectEntry(page, { length: length + 3, base: board, n: 0 });

  // Forward returns to the list; the drawer that was closed doesn't come back.
  await page.goForward();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/list`);
  await page.goForward();
  await expect.poll(() => page.evaluate(() => history.state?.id)).toBe(list);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('.modal')).toHaveCount(0);
  await expect(row(page, 'Gear one')).toBeVisible();
  await expectEntry(page, { length: length + 3, base: list, n: 0 });

  // The sidebar is closed by Back too, and the page stays.
  await page.locator('.bottomnav [data-a="openMnav"]').tap();
  await expect(page.locator('.shell.mnav')).toBeVisible();
  // Its entry replaces the ones Forward had: history is the list and the sidebar's.
  await expectEntry(page, { length: length + 1, base: list, n: 1, pushes: 1 });
  await page.goBack();
  await expect(page.locator('.shell.mnav')).toHaveCount(0);
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await expectEntry(page, { length: length + 1, base: list, n: 0 });
  expect(await errors()).toEqual([]);
});

/* The case Chrome's history intervention broke: with the drawer and an edit window open, Back closed
   the window and added the entry back with no tap, so Chrome skipped the page under it and the next
   Back left the page with the drawer still drawn. */
test('Back from an edit window over the drawer, then Back again, closes the drawer on its page', async ({ page }) => {
  const errors = watchErrors(page);
  await watchHistory(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  await visit(page, `project/${key}/list`);
  const { length, state } = await entries(page);
  await row(page, 'Gear two').locator('.ttl').tap();
  await drawer(page).locator('.drawer-h [data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await expect(page.locator('.modal')).toBeVisible();
  await expectEntry(page, { length: length + 2, base: state.id, n: 2, pushes: 2 });
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  await expectEntry(page, { length: length + 2, base: state.id, n: 1 });
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expectEntry(page, { length: length + 2, base: state.id, n: 0 });
  // The screen and the URL agree: the list, nothing over it.
  expect(await hash(page)).toBe(`#project/${key}/list`);
  await expect(row(page, 'Gear two')).toBeVisible();
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

test('Back from an edit window closes it unsaved and keeps what was typed for next time; a picked date is saved', async ({ page }) => {
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
  // What Back closed comes back when the window opens again; its X discards it.
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await expect(page.locator('#f-title')).toHaveValue('Gear one, edited by Back');
  await page.locator('.modal [data-a="closeModal"]').first().tap();
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await popup(page).locator('[data-a="editTask"]').tap();
  await expect(page.locator('#f-title')).toHaveValue('Gear one');
  await page.locator('.modal [data-a="closeModal"]').first().tap();
  await expect(page.locator('.modal')).toHaveCount(0);

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

test('a new task and the inline composer keep what was typed through Back, and show it when reopened', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  const tasks = () => page.locator('.trow[data-task-row]').count();
  const before = await tasks();

  // The New task window.
  await page.locator('.toolbar [data-a="newTask"]').first().tap();
  await page.fill('#f-title', 'Half a gear');
  await page.fill('#f-desc', 'Teeth still to cut');
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  expect(await tasks()).toBe(before);
  await page.locator('.toolbar [data-a="newTask"]').first().tap();
  await expect(page.locator('#f-title')).toHaveValue('Half a gear');
  await expect(page.locator('#f-desc')).toHaveValue('Teeth still to cut');
  // Closed with its X on purpose, it's gone.
  await page.locator('.modal [data-a="closeModal"]').first().tap();
  await page.locator('.toolbar [data-a="newTask"]').first().tap();
  await expect(page.locator('#f-title')).toHaveValue('');
  await page.locator('.modal [data-a="closeModal"]').first().tap();
  await expect(page.locator('.modal')).toHaveCount(0);

  // The inline composer, in the same group.
  const add = page.locator('.addrow[data-a="startComposer"]').first();
  const group = await add.getAttribute('data-group');
  await add.tap();
  await page.locator('#composer-in').fill('Composer gear');
  await page.goBack();
  await expect(page.locator('#composer-in')).toHaveCount(0);
  expect(await tasks()).toBe(before);
  await page.locator(`.addrow[data-a="startComposer"][data-group="${group}"]`).tap();
  await expect(page.locator('#composer-in')).toHaveValue('Composer gear');
  await page.locator('#composer-in').press('Escape');
  await expect(page.locator('#composer-in')).toHaveCount(0);
  await page.locator(`.addrow[data-a="startComposer"][data-group="${group}"]`).tap();
  await expect(page.locator('#composer-in')).toHaveValue('');
  await page.goBack();
  await expect(page.locator('#composer-in')).toHaveCount(0);
  expect(await tasks()).toBe(before);
  expect(await errors()).toEqual([]);
});

test('a task opened from a link: after a tap, Back closes it and stays in the app', async ({ page, context }) => {
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  await row(page, 'Gear two').locator('.ttl').tap();
  const taskKey = (await drawer(page).locator('.drawer-h .mono').textContent()).trim();

  const tab = await context.newPage();
  const errors = watchErrors(tab);
  await watchHistory(tab);
  await tab.goto(`/#task/${taskKey}`);
  await expect(tab.locator('.drawer')).toBeVisible();
  await expect(tab.locator('.drawer .ttl-edit')).toHaveValue('Gear two');
  // The URL names the open task, after the page under it.
  await expect.poll(() => hash(tab)).toMatch(new RegExp(`^#[a-z]+\\?task=${taskKey}$`));
  // Opened with no tap, the drawer has no entry of its own yet: adding one now would let Chrome
  // skip the page's. The first tap adds it.
  const start = await entries(tab);
  expect(start.pushes).toEqual([]);
  expect(start.state.page).toBe(true);
  await tab.locator('.drawer .ttl-edit').tap();
  await expectEntry(tab, { length: start.length + 1, base: start.state.id, n: 1, pushes: 1 });
  await tab.goBack();
  await expect(tab.locator('.drawer')).toHaveCount(0);
  await expect(tab.locator('.bottomnav')).toBeVisible();
  await expect.poll(() => hash(tab)).not.toContain('task');
  await expectEntry(tab, { length: start.length + 1, base: start.state.id, n: 0 });
  // Reload keeps the page.
  const h = await hash(tab);
  await tab.reload();
  await expect(tab.locator('.bottomnav')).toBeVisible();
  expect(await hash(tab)).toBe(h);
  expect(await errors()).toEqual([]);
});

/* Android hands a notification or link for the app to the page already open: only the hash changes. */
test('a link handed to the open app opens its task in place; Back closes it and stays on the page', async ({ page }) => {
  const errors = watchErrors(page);
  await watchHistory(page);
  await signInPhone(page);
  await visit(page, `project/${key}/board`);
  await visit(page, `project/${key}/list`);
  const list = `#project/${key}/list`;
  await row(page, 'Gear three').locator('.ttl').tap();
  const taskKey = (await drawer(page).locator('.drawer-h .mono').textContent()).trim();
  await expect.poll(() => hash(page)).toBe(`${list}?task=${taskKey}`);
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);

  // With a menu open, as when a notification comes in mid-task. The link's own entry becomes the
  // task's layer over the page (no entry is added for it), and the menu's is left behind it.
  // (history.length counts the drawer's entry Back left, until a new entry replaces it.)
  const { length, state } = await entries(page);
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await expect(popup(page)).toBeVisible();
  await expectEntry(page, { length, base: state.id, n: 1, pushes: 1 });
  await page.evaluate(k => (location.hash = `task/${k}`), taskKey);
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('.ttl-edit')).toHaveValue('Gear three');
  await expect(popup(page)).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(`${list}?task=${taskKey}`);
  await expectEntry(page, { length: length + 1, base: state.id, n: 1 });
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect(page.locator('.bottomnav')).toBeVisible();
  await expect.poll(() => hash(page)).toBe(list);
  await expect(row(page, 'Gear one')).toBeVisible();
  // Back stepped over the menu's old entry too, onto the page's.
  await expectEntry(page, { length: length + 1, base: state.id, n: 0 });

  // A reload opens the task in the URL again, on the entry it had, and Back still closes it onto the
  // page, in one Back.
  await page.evaluate(k => (location.hash = `task/${k}`), taskKey);
  await expect(drawer(page)).toBeVisible();
  await expectEntry(page, { length, base: state.id, n: 1 });
  await page.reload();
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).locator('.ttl-edit')).toHaveValue('Gear three');
  expect(await hash(page)).toBe(`${list}?task=${taskKey}`);
  await expectEntry(page, { length, base: state.id, n: 1 });
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);
  await expectEntry(page, { length, base: state.id, n: 0 });

  // A reload with a menu open: nothing but the URL's task opens again, so the page steps back onto
  // its own entry; the next Back leaves the page at once (there's no second entry for it).
  await row(page, 'Gear one').locator('[data-a="ctxBtn"]').tap();
  await expectEntry(page, { length, base: state.id, n: 1, pushes: 1 });
  await page.reload();
  await expect(row(page, 'Gear one')).toBeVisible();
  await expectEntry(page, { length, base: state.id, n: 0 });
  await page.goBack();
  await expect.poll(() => hash(page)).toBe(`#project/${key}/board`);
  await page.goForward();
  await expect.poll(() => hash(page)).toBe(list);

  // Closed with X, the URL goes back to the page.
  await page.evaluate(k => (location.hash = `task/${k}`), taskKey);
  await expect(drawer(page)).toBeVisible();
  await drawer(page).locator('.drawer-h [data-a="closeDrawer"]').tap();
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);

  // A key that isn't there (deleted, or in a project this person can't see) says so; the page stays.
  await page.evaluate(() => (location.hash = 'task/NOPE-404'));
  await toastWith(page, "NOPE-404 can't be opened");
  await expect(drawer(page)).toHaveCount(0);
  await expect.poll(() => hash(page)).toBe(list);
  await expect(row(page, 'Gear one')).toBeVisible();
  expect(await errors(["NOPE-404 can't be opened"])).toEqual([]);
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

/* Each toolbar's buttons sit inside it without covering each other, and the next row starts below it. */
const toolbarsFit = page =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pbody .toolbar')].flatMap(bar => {
      const b = bar.getBoundingClientRect();
      const kids = [...bar.children].filter(c => c.getBoundingClientRect().width > 0).map(c => [c, c.getBoundingClientRect()]);
      const bad = [];
      for (const [c, r] of kids) if (r.bottom > b.bottom + 0.5 || r.right > innerWidth + 0.5) bad.push(`${c.className || c.tagName} leaves the toolbar`);
      kids.forEach(([c, r], i) =>
        kids.slice(i + 1).forEach(([d, q]) => {
          if (r.left < q.right - 0.5 && q.left < r.right - 0.5 && r.top < q.bottom - 0.5 && q.top < r.bottom - 0.5)
            bad.push(`${c.className || c.tagName} covers ${d.className || d.tagName}`);
        }),
      );
      const next = bar.nextElementSibling;
      if (next && next.getBoundingClientRect().top < b.bottom - 0.5) bad.push(`${next.className} starts under the toolbar`);
      return bad;
    }),
  );

test('the New task button keeps to its toolbar in List and Calendar at 360px and 412px', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 800 });
    for (const tab of ['list', 'calendar']) {
      await visit(page, `project/${key}/${tab}`);
      const btn = page.locator('.pbody .toolbar [data-a="newTask"]').first();
      await expect(btn).toBeVisible();
      expect(await toolbarsFit(page), `${tab} at ${width}px`).toEqual([]);
      const box = await btn.boundingBox();
      expect(box.x + box.width, `${tab} at ${width}px`).toBeLessThanOrEqual(width);
    }
  }
  // It still opens the new task window.
  await page.locator('.pbody .toolbar [data-a="newTask"]').first().tap();
  await expect(page.locator('.modal')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.modal')).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('every Settings tab can be reached on a 360px screen, and the open one is in view', async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await signInPhone(page);
  await visit(page, 'settings/appearance');
  const nav = page.locator('.set-nav');
  const secs = await nav.locator('.sitem').evaluateAll(els => els.map(el => el.dataset.sec));
  expect(secs.length).toBeGreaterThan(5);
  // More tabs than fit: the strip scrolls sideways.
  expect(await nav.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).overflowX === 'auto')).toBe(true);
  const inView = async () => {
    const n = await nav.boundingBox(),
      on = await nav.locator('.sitem.on').boundingBox();
    return on.x >= n.x - 0.5 && on.x + on.width <= n.x + n.width + 0.5 && on.x + on.width <= 360.5;
  };
  for (const sec of secs) {
    await nav.locator(`.sitem[data-sec="${sec}"]`).tap();
    await expect.poll(() => hash(page)).toBe(`#settings/${sec}`);
    await expect(nav.locator('.sitem.on')).toHaveAttribute('data-sec', sec);
    expect(await inView(), sec).toBe(true);
  }
  // Scrolled by hand, the strip stays where it was through a render (it jumped back to the open tab).
  await nav.locator('.sitem[data-sec="appearance"]').tap();
  await expect(nav.locator('.sitem.on')).toHaveAttribute('data-sec', 'appearance');
  const scrolled = await nav.evaluate(el => (el.scrollLeft = Math.min(200, el.scrollWidth - el.clientWidth)));
  expect(scrolled).toBeGreaterThan(0);
  const theme = await page.locator('[data-a="setTheme"][aria-checked="true"]').getAttribute('data-v');
  await page.locator(`[data-a="setTheme"][data-v="${theme}"]`).tap();
  await page.locator('[data-a="setTheme"]').first().focus();
  await page.waitForTimeout(100);
  expect(await nav.evaluate(el => el.scrollLeft)).toBeCloseTo(scrolled, 0);
  // Opened from a link, the last tab is shown too, not left past the edge.
  await visit(page, 'home');
  await visit(page, `settings/${secs.at(-1)}`);
  await expect(nav.locator('.sitem.on')).toHaveAttribute('data-sec', secs.at(-1));
  expect(await inView()).toBe(true);
  // So is a project's last view.
  await visit(page, `project/${key}/activity`);
  const tabs = page.locator('.tabs:has(.tab[data-tab="activity"])');
  const n = await tabs.boundingBox(),
    on = await tabs.locator('.tab.on').boundingBox();
  expect(on.x + on.width).toBeLessThanOrEqual(n.x + n.width + 0.5);
  expect(await errors()).toEqual([]);
});

test('timeline bars and calendar entries show their titles on a phone', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  // A task over two weeks from today, and one due today.
  await newTask(page, 'Long gear');
  await newTask(page, 'Short gear');
  const pick = async (title, field, chip) => {
    await row(page, title).locator('.ttl').tap();
    await drawer(page).locator(`[data-a="pop"][data-pop="date"][data-field="${field}"]`).first().tap();
    await popup(page).locator('.dp-chip', { hasText: chip }).tap();
    await page.goBack();
    await expect(popup(page)).toHaveCount(0);
    await page.goBack();
    await expect(drawer(page)).toHaveCount(0);
  };
  await pick('Long gear', 'due', '2 weeks');
  await pick('Long gear', 'start', 'Today');
  await pick('Short gear', 'due', 'Today');
  await synced(page);

  // Timeline: the task column is hidden on a phone, so the bars and groups carry the names.
  await visit(page, `project/${key}/timeline`);
  const right = page.locator('#tl-right');
  const bar = page.locator('.bar', { has: page.locator('.trunc', { hasText: 'Long gear' }) });
  await expect(page.locator('.tl-left')).toBeHidden();
  await expect(page.locator('.tl-glbl').first()).toBeVisible();
  await expect(bar.locator('.trunc')).toBeVisible();
  // Scrolled so the bar starts off the left edge: its title stays on screen, at the edge.
  await bar.evaluate((el, r) => (r.scrollLeft = el.offsetLeft + 120), await right.elementHandle());
  await page.waitForTimeout(100);
  const r = await right.boundingBox(),
    t = await bar.locator('.trunc').boundingBox(),
    b = await bar.boundingBox();
  expect(b.x).toBeLessThan(r.x);
  expect(t.x).toBeGreaterThanOrEqual(r.x);
  expect(t.width).toBeGreaterThan(30);

  // Calendar: each entry shows its title (they were bare colour strips).
  await visit(page, `project/${key}/calendar`);
  const entry = page.locator('.cev', { hasText: 'Short gear' }).first();
  await expect(entry.locator('.trunc')).toBeVisible();
  const shown = await page.locator('.cal-g .cev').evaluateAll(els =>
    els.map(el => {
      const s = el.querySelector('.trunc');
      return !!s && s.getBoundingClientRect().width > 20 && s.getBoundingClientRect().height >= 10 && el.title.startsWith(s.textContent);
    }),
  );
  expect(shown.length).toBeGreaterThan(0);
  expect(shown.every(Boolean)).toBe(true);
  expect(await errors()).toEqual([]);
});

test('the page is sized to the visible screen (dvh), and the bottom bar covers nothing', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  const rule = await page.evaluate(() =>
    [...document.styleSheets].some(s => {
      try {
        return [...s.cssRules].some(r => r instanceof CSSStyleRule && r.selectorText === 'body' && r.style.height === '100dvh');
      } catch {
        return false;
      }
    }),
  );
  expect(rule).toBe(true);
  expect(await page.evaluate(() => document.body.getBoundingClientRect().height === innerHeight)).toBe(true);
  // Scrolled to the end, the last row of a page clears the bottom bar (it isn't hidden behind it).
  const clears = sel =>
    page.evaluate(sel => {
      const last = [...document.querySelectorAll(sel)].at(-1);
      for (let p = last.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight) p.scrollTop = p.scrollHeight;
      const nav = document.querySelector('.bottomnav').getBoundingClientRect();
      return nav.bottom <= innerHeight && last.getBoundingClientRect().bottom <= nav.top + 0.5;
    }, sel);
  expect(await clears('.trow[data-task-row]'), 'list').toBe(true);
  await visit(page, 'settings/appearance');
  expect(await clears('.set-in > *'), 'settings').toBe(true);
  await visit(page, 'projects');
  expect(await clears('.pcard'), 'projects').toBe(true);
  expect(await errors()).toEqual([]);
});

test('fields are 16px on a touch screen, and the status bar colour follows the theme chosen in Settings', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  expect(await page.locator('.toolbar input.search-sm').evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
  // On a phone on its side too; a tablet keeps compact fields at their own size.
  const size = () => page.locator('.toolbar input.search-sm').evaluate(el => getComputedStyle(el).fontSize);
  await page.setViewportSize({ width: 915, height: 412 });
  expect(await size()).toBe('16px');
  await page.setViewportSize({ width: 800, height: 1280 });
  expect(await size()).not.toBe('16px');
  await page.setViewportSize({ width: 412, height: 839 });

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
  // System: it follows the phone's setting, and changes when the phone's does.
  await page.locator('[data-a="setTheme"][data-v="system"]').tap();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
  expect(await color()).toEqual([light, light]);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(color).toEqual([dark, dark]);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(color).toEqual([light, light]);
  await page.locator(`[data-a="setTheme"][data-v="${was}"]`).tap();
  await synced(page);
  expect(await errors()).toEqual([]);
});

/* The same workspace in a desktop browser (a mouse, hover), to check a phone fix leaves it as it was. */
async function onDesktop(browser) {
  const context = await browser.newContext({ ...devices['Desktop Chrome'], baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  return { context, page };
}

test("a project card's menu button never covers its status, at 360px and 412px, light and dark", async ({ page, browser }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, 'projects');
  await page.locator('[data-k="projView"][data-v="grid"]').tap();
  const clear = () =>
    page.locator('.pcard').evaluateAll(cards =>
      cards.map(c => {
        const st = c.querySelector('.pstatus'),
          more = c.querySelector('.more').getBoundingClientRect(),
          card = c.getBoundingClientRect();
        if (!st) return { name: c.textContent, ok: more.right <= card.right };
        const s = st.getBoundingClientRect();
        // Beside the button, not under it, and not cut short ("Planni").
        return { name: st.textContent, ok: s.right <= more.left && st.scrollWidth <= st.clientWidth + 0.5 && more.right <= card.right };
      }),
    );
  for (const width of [360, 412])
    for (const colorScheme of /** @type {const} */ (['light', 'dark'])) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      const cards = await clear();
      expect(cards.length).toBeGreaterThan(0);
      expect(
        cards.filter(c => !c.ok),
        `${width}px, ${colorScheme}`,
      ).toEqual([]);
    }
  await page.emulateMedia({ colorScheme: 'light' });

  // On a desktop the button still shows only on hover, over the card's corner, and the title row
  // keeps its full width.
  const desk = await onDesktop(browser);
  await desk.page.evaluate(() => (location.hash = 'projects'));
  await desk.page.locator('[data-k="projView"][data-v="grid"]').click();
  const pc = desk.page.locator('.pcard').first();
  expect(await pc.locator('.more').evaluate(el => getComputedStyle(el).opacity)).toBe('0');
  expect(
    await pc
      .locator('> .row')
      .first()
      .evaluate(el => getComputedStyle(el).paddingRight),
  ).toBe('0px');
  await desk.context.close();
  expect(await errors()).toEqual([]);
});

test('no edge of the closed sidebar shows down the side of the screen', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  const side = page.locator('.side');
  const look = () => side.evaluate(el => ({ shadow: getComputedStyle(el).boxShadow, right: el.getBoundingClientRect().right }));
  expect(await look()).toEqual({ shadow: 'none', right: 0 });
  await page.locator('.bottomnav [data-a="openMnav"]').tap();
  await expect(page.locator('.shell.mnav')).toBeVisible();
  await expect.poll(async () => (await look()).shadow).not.toBe('none');
  await page.goBack();
  await expect(page.locator('.shell.mnav')).toHaveCount(0);
  await expect.poll(look).toEqual({ shadow: 'none', right: 0 });
  expect(await errors()).toEqual([]);
});

test('settings switches and lists are named by their labels, and a board card has each button reachable', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, 'settings/notif-push');
  for (const name of ['Mentions', 'Assignments', 'Comments', 'Due date reminders'])
    await expect(page.locator('.set-body').getByRole('checkbox', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^push_/ })).toHaveCount(0);
  await visit(page, 'settings/language');
  await expect(page.locator('.set-body').getByRole('button', { name: 'Language', exact: true })).toBeVisible();

  // Board card: the card isn't one big button; its title opens it, and its other buttons are there
  // with their names.
  await visit(page, `project/${key}/board`);
  const c = card(page, 'Gear one');
  await expect(c).not.toHaveAttribute('role', 'button');
  // (An earlier test renames it "Gear one, cast".)
  const title = c.getByRole('button', { name: /^Gear one/ });
  await expect(title).toBeVisible();
  for (const name of ['Mark complete', 'Quick edit', 'More', 'Assignee']) await expect(c.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(c.getByRole('button', { name: /^Priority: / })).toBeVisible();
  // A tap anywhere on the card still opens the task, and so do the keyboard's Enter and Space.
  await c.locator('.key').tap();
  await expect(drawer(page)).toBeVisible();
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  for (const key of ['Enter', ' ']) {
    await title.focus();
    await page.keyboard.press(key);
    await expect(drawer(page)).toContainText('Gear one');
    await page.goBack();
    await expect(drawer(page)).toHaveCount(0);
  }
  expect(await errors()).toEqual([]);
});

test("a project card's name opens it and its menu button is reachable, by touch, keyboard and on a desktop", async ({ page, browser }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, 'projects');
  await page.locator('[data-k="projView"][data-v="grid"]').tap();
  const pc = page.locator('.pcard', { hasText: NAME }).first();
  const opened = new RegExp(`#project/${key}(/|$)`);
  // The card isn't one big link; its name is the link that opens it, and the menu button is there
  // with its name.
  await expect(pc).not.toHaveAttribute('role', 'link');
  await expect(pc).not.toHaveAttribute('tabindex');
  const name = pc.getByRole('link', { name: NAME, exact: true });
  await expect(name).toBeVisible();
  const more = pc.getByRole('button', { name: 'Project options', exact: true });
  await expect(more).toBeVisible();
  // A tap anywhere on the card still opens the project; the menu button opens the menu instead.
  await pc.locator('.desc').tap();
  await expect(page).toHaveURL(opened);
  await page.goBack();
  await expect(page).toHaveURL(/#projects$/);
  await more.tap();
  await expect(popup(page).locator('[data-a="openProject"]')).toBeVisible();
  await expect(page).toHaveURL(/#projects$/);
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  // The keyboard's Enter on the name opens it.
  await name.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(opened);
  await page.goBack();
  await expect(page).toHaveURL(/#projects$/);

  // On a desktop: a click on the card opens it, Tab goes from the name to the menu button, which
  // shows while focus is in the card, and Enter opens the menu.
  const desk = await onDesktop(browser);
  await desk.page.evaluate(() => (location.hash = 'projects'));
  await desk.page.locator('[data-k="projView"][data-v="grid"]').click();
  const dc = desk.page.locator('.pcard', { hasText: NAME }).first();
  const dmore = dc.getByRole('button', { name: 'Project options', exact: true });
  const opacity = () => dmore.evaluate(el => getComputedStyle(el).opacity);
  expect(await opacity()).toBe('0');
  await dc.getByRole('link', { name: NAME, exact: true }).focus();
  await expect.poll(opacity).toBe('1');
  await desk.page.keyboard.press('Tab');
  await expect(dmore).toBeFocused();
  expect(await opacity()).toBe('1');
  await desk.page.keyboard.press('Enter');
  await expect(desk.page.locator('.pop.floating [data-a="openProject"]')).toBeVisible();
  await desk.page.keyboard.press('Escape');
  await dc.locator('.desc').click();
  await expect(desk.page).toHaveURL(opened);
  await desk.context.close();
  expect(await errors()).toEqual([]);
});

test('keyboard hints are left out on a touch screen, and kept on a desktop', async ({ page, browser }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  // The board's inline composer, and a task's menu (Edit "E", Delete "Del").
  await visit(page, `project/${key}/board`);
  await page.locator('.bcol[data-drop-col="todo"] .addcard').tap();
  await expect(page.locator('.composer')).toBeVisible();
  await expect(page.locator('.composer')).not.toContainText('Enter to add', { useInnerText: true });
  await page.goBack();
  await expect(page.locator('.composer')).toHaveCount(0);
  await card(page, 'Gear one').locator('.hacts [data-a="ctxBtn"]').tap();
  // What is shown (innerText): the shortcut letters are in the markup, hidden here.
  await expect(popup(page).locator('[data-a="editTask"]')).toHaveText('Edit', { useInnerText: true });
  await expect(popup(page).locator('[data-a="delTask"]')).toHaveText('Delete', { useInnerText: true });
  await page.goBack();
  await expect(popup(page)).toHaveCount(0);
  // The list's inline composer.
  await visit(page, `project/${key}/list`);
  await page.locator('.addrow[data-a="startComposer"]').first().tap();
  await expect(page.locator('#composer-in')).toHaveAttribute('placeholder', 'Task name');
  await page.goBack();

  const desk = await onDesktop(browser);
  await desk.page.evaluate(k => (location.hash = `project/${k}/board`), key);
  await desk.page.locator('.bcol[data-drop-col="todo"] .addcard').click();
  await expect(desk.page.locator('.composer')).toContainText('Enter to add · Esc to cancel', { useInnerText: true });
  await desk.page.keyboard.press('Escape');
  await desk.page.locator('.kcard', { hasText: 'Gear one' }).first().click({ button: 'right' });
  await expect(desk.page.locator('.pop.floating [data-a="editTask"]')).toHaveText(/^Edit\s*E$/, { useInnerText: true });
  await expect(desk.page.locator('.pop.floating [data-a="delTask"]')).toHaveText(/^Delete\s*Del$/, { useInnerText: true });
  await desk.page.keyboard.press('Escape');
  await desk.page.evaluate(k => (location.hash = `project/${k}/list`), key);
  await desk.page.locator('.addrow[data-a="startComposer"]').first().click();
  await expect(desk.page.locator('#composer-in')).toHaveAttribute('placeholder', /Enter to add/);
  await desk.context.close();
  expect(await errors()).toEqual([]);
});

test("the push settings say you'll be asked, which is true in a browser and in the Android app", async ({ page }) => {
  const errors = watchErrors(page);
  // Not asked yet (a fresh install).
  await page.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }));
  await signInPhone(page);
  await visit(page, 'settings/notif-push');
  // The banner on whether this device gets push (data-push-here) is where permission is mentioned.
  await expect(page.locator('[data-push-here]')).toContainText('You’ll be asked to allow notifications.');
  await expect(page.locator('.set-in')).not.toContainText('browser will ask');
  expect(await errors()).toEqual([]);
});

test('Settings scrolls in one place on a phone', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  for (const sec of ['appearance', 'preferences', 'language', 'account']) {
    await visit(page, `settings/${sec}`);
    await expect(page.locator('.set-in h1')).toBeVisible();
    // Only the settings pane scrolls: nothing makes the page around it scroll too.
    const scrollers = await page.evaluate(() =>
      [...document.querySelectorAll('.main *')]
        .filter(el => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
        .map(el => el.className),
    );
    expect(
      scrollers.filter(c => c !== 'set-body'),
      sec,
    ).toEqual([]);
  }
  expect(await errors()).toEqual([]);
});

test('calendar titles break between words, and inside one only when it is wider than the entry', async ({ page }) => {
  const errors = watchErrors(page);
  await signInPhone(page);
  await visit(page, `project/${key}/list`);
  await newTask(page, 'Map the new site');
  await row(page, 'Map the new site').locator('.ttl').tap();
  await drawer(page).locator('[data-a="pop"][data-pop="date"][data-field="due"]').first().tap();
  await popup(page).locator('.dp-chip', { hasText: 'Today' }).tap();
  await page.goBack();
  await page.goBack();
  await expect(drawer(page)).toHaveCount(0);
  await synced(page);
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 800 });
    await visit(page, `project/${key}/calendar`);
    await expect(page.locator('.cev', { hasText: 'Map the new site' }).first()).toBeVisible();
    const split = await page.locator('.cal-g .cev .trunc').evaluateAll(els =>
      els.flatMap(el => {
        const cs = getComputedStyle(el);
        if (cs.overflowWrap !== 'break-word' || cs.hyphens !== 'auto') return [`${el.textContent}: ${cs.overflowWrap} ${cs.hyphens}`];
        const text = el.firstChild;
        if (!text || text.nodeType !== 3) return [];
        const line = el.getBoundingClientRect().width;
        const out = [];
        for (const m of text.textContent.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(text, m.index);
          r.setEnd(text, m.index + m[0].length);
          const lines = new Set([...r.getClientRects()].map(x => Math.round(x.top))).size;
          // A word split over lines must be too wide for one.
          const probe = Object.assign(document.createElement('span'), { textContent: m[0] });
          probe.style.cssText = 'position:absolute;white-space:nowrap;visibility:hidden';
          el.appendChild(probe);
          const own = probe.getBoundingClientRect().width;
          probe.remove();
          if (lines > 1 && own <= line) out.push(`${el.textContent}: "${m[0]}"`);
        }
        return out;
      }),
    );
    expect(split, `${width}px`).toEqual([]);
  }
  expect(await errors()).toEqual([]);
});
