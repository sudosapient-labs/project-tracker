import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, emailLink, signIn, signOut, synced, toastWith, watchErrors } from './helpers.js';

// 05-settings changes the owner's password to this.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
// A teammate this journey invites (03-team's Grace was removed, 07-access's Charles left).
const LIN = { name: 'Lin Mei', email: 'lin@example.com', password: 'abacus-beads-1234' };
const headers = { 'x-requested-with': 'sudo-sapient' };
test.describe.configure({ mode: 'serial' });

const project = (id, key, extra = {}) => ({
  c: 'projects',
  id,
  k: 'put',
  v: { id, key, name: `Audit ${key}`, icon: 'code', color: 'teal', status: 'active', team: '', lead: null, members: [], desc: '', milestones: [], ...extra },
});
const task = (id, pid, key, title, extra = {}) => {
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
      ...extra,
    },
  };
};
const sync = async (page, ops) => expect((await page.request.post('/api/sync', { headers, data: { ops } })).ok()).toBe(true);
const serverData = async page => (await (await page.request.get('/api/bootstrap')).json()).data;
const serverTask = async (page, id) => (await serverData(page)).tasks.find(t => t.id === id);
const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/* What an /api/sync request carried, one `collection:fields` per op. */
const shape = route =>
  route
    .request()
    .postDataJSON()
    .ops.map(op => op.c + ':' + Object.keys(op.v || {}).join(','));
/* Account menu → Sign out (the task drawer, if open, covers the menu: closed first). */
const signOutFromMenu = async page => {
  if (await page.locator('.drawer').count()) await page.locator('.drawer [data-a="closeDrawer"]').first().click();
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('.pop [data-a="signOut"]').click();
};
const openTask = async (page, title) => {
  await page.locator('[data-a="openTask"]', { hasText: title }).first().click();
  await expect(page.locator('#d-title')).toHaveValue(title);
};
/* Replace the drawer's description as typing would (an input event on the editor). */
const setDesc = (page, html) =>
  page.evaluate(h => {
    const ed = document.querySelector('#d-desc');
    ed.innerHTML = h;
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  }, html);

test('completing a repeating task again after Undo or reopening schedules one next occurrence', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [project('plow', 'LOW'), task('trec1', 'plow', 'LOW-201', 'Water the plants', { recur: 'Weekly', due: day(1), start: day(1) })]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Water the plants');
  const statuses = async () =>
    (await serverData(page)).tasks
      .filter(t => t.title === 'Water the plants')
      .map(t => t.status)
      .sort();
  const toggle = page.locator('.drawer [data-a="toggleDone"]').first();

  await toggle.click();
  await expect.poll(statuses).toEqual(['done', 'todo']);
  // Undo, then complete again: still one next occurrence.
  await page.locator('#toasts .toast', { hasText: 'Completed' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(statuses).toEqual(['todo']);
  await toggle.click();
  await expect.poll(statuses).toEqual(['done', 'todo']);
  // Reopened: the untouched next occurrence goes with it; completed again, there's one.
  await toggle.click();
  await expect.poll(statuses).toEqual(['todo']);
  await toggle.click();
  await expect.poll(statuses).toEqual(['done', 'todo']);

  // A next occurrence someone has worked on stays, and completing again adds no other.
  const next = (await serverData(page)).tasks.find(t => t.title === 'Water the plants' && t.status === 'todo');
  await sync(page, [{ c: 'tasks', id: next.id, k: 'patch', v: { priority: 'high', updated: Date.now() } }]);
  await page.waitForTimeout(1500); // the change reaches the tab over the live stream
  await toggle.click();
  await expect.poll(statuses).toEqual(['todo', 'todo']);
  await toggle.click();
  await expect.poll(statuses).toEqual(['done', 'todo']);
  await synced(page);
  expect(await errors()).toEqual([]);
});

test('opening another file of the app in a tab leaves the offline shell alone', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // Navigations to the worker script and an icon go through the worker too.
  await page.goto('/sw.js');
  await page.goto('/icons/icon-192.png');
  await page.waitForTimeout(500);
  expect(await page.evaluate(async () => (await caches.match('/'))?.headers.get('content-type'))).toContain('text/html');
  await context.setOffline(true);
  await page.goto('/').catch(() => {});
  await expect(page.getByRole('heading', { name: "Can't reach Sudo Sapient" })).toBeVisible();
  await context.setOffline(false);
});

test('a bot’s name is shown as text in the revoke-key confirmation', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/api');
  const bots = page.locator('#bots');
  await page.fill('#bot-name', '<img src=x onerror="window.__botXss=1">Bot');
  await page.click('#bot-create');
  await page.fill('#bot-key-name', 'Deploys');
  await page.fill('#bot-key-pw', OWNER.password);
  await page.click('#bot-key-create');
  await expect(page.locator('#bot-token')).toHaveValue(/^ssk_/);
  await bots.locator('.srow', { hasText: 'Deploys' }).locator('[data-a="revokeBotKey"]').click();
  const dlg = page.locator('.modal', { hasText: 'Revoke “Deploys”?' });
  await expect(dlg).toContainText('as <img src=x onerror="window.__botXss=1">Bot stops working');
  await expect(dlg.locator('img')).toHaveCount(0);
  await dlg.locator('[data-a="confirmOk"]').click();
  await toastWith(page, 'Key revoked');
  expect(await page.evaluate(() => window.__botXss)).toBeUndefined();
  expect(await errors()).toEqual([]);
});

test('a card dropped on a collapsed board column moves to that column', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [project('plow', 'LOW'), task('tcol1', 'plow', 'LOW-210', 'Ready for review')]);
  await page.goto('/#project/low/board');
  await page.locator('.bcol[aria-label="Review"] [data-a="ctxBtn"][data-ctx="column"]').click();
  await page.locator('.pop [data-a="colCollapse"]').click();
  const collapsed = page.locator('.bcol.collapsed[data-drop-col="review"]');
  await expect(collapsed).toBeVisible();
  // On the way it passes over the In Progress column, which mustn't be where it lands.
  await page.locator('[data-drag-card="tcol1"]').dragTo(collapsed);
  await expect.poll(async () => (await serverTask(page, 'tcol1'))?.status).toBe('review');
  expect(await errors()).toEqual([]);
});

test('the palette suggests the projects there are, not demo data', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#project/low/list');
  await expect(page.locator('[data-task-row]').first()).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Tab'); // search mode, where the suggestions are
  const pal = page.locator('.pi');
  await expect(pal.filter({ hasText: 'Overdue tasks' })).toBeVisible();
  await expect(pal.filter({ hasText: 'Website Redesign' })).toHaveCount(0);
  await pal.filter({ hasText: 'Files in Audit LOW' }).click();
  await expect(page).toHaveURL(/#project\/low\/files$/);
});

test('timeline bars don’t move in a project I can only view', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const me = (await serverData(page)).me;
  await sync(page, [project('pview', 'VIEW'), task('tview1', 'pview', 'VIEW-201', 'Look, don’t touch', { start: day(-1), due: day(2) })]);
  // Listed with Can view: exactly that, even for the Owner.
  await sync(page, [{ c: 'projects', id: 'pview', k: 'patch', v: { members: [me], perms: { [me]: 'Can view' }, lead: null } }]);
  await page.goto('/#project/view/timeline');
  const bar = page.locator('[data-bar="tview1"]');
  await expect(bar).toBeVisible();
  const box = await bar.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await serverTask(page, 'tview1')).due).toBe(day(2));
  expect(await errors()).toEqual([]);
});

test('typing in the description while offline keeps the caret where it is', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tcaret1', 'plow', 'LOW-220', 'Caret stays')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Caret stays');
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.locator('#d-desc').click();
  // Slowly, across several of the offline retries (1 s, 2 s, 4 s).
  await page.keyboard.type('One two three four five six seven', { delay: 150 });
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await page.keyboard.type(' eight nine ten', { delay: 300 });
  await expect(page.locator('#d-desc')).toHaveText('One two three four five six seven eight nine ten');
  await page.unroute('**/api/sync');
  await expect.poll(async () => (await serverTask(page, 'tcaret1'))?.desc, { timeout: 40_000 }).toContain('One two three four five six seven eight nine ten');
  expect(await errors(['offline'])).toEqual([]);
});

test('closing the tab mid-save sends a large batch still on its way ahead of the queue', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tbig1', 'plow', 'LOW-230', 'Large notes')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Large notes');

  // A 40 KB description goes without keepalive (too large for its budget), and is held on its way.
  let held = null;
  const sent = [];
  await page.route('**/api/sync', route => {
    if (!held) return void (held = route);
    sent.push(shape(route));
    return route.continue();
  });
  await setDesc(page, `<p>${'n'.repeat(40_000)}</p>`);
  await expect.poll(() => !!held).toBe(true);
  await page.fill('#d-sub', 'Queued behind the notes');
  await page.press('#d-sub', 'Enter');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
  // One keepalive request: the batch that was on its way first, then the queue.
  await expect.poll(() => sent.length).toBe(1);
  const ops = sent[0];
  expect(ops.indexOf('tasks:desc,updated')).toBeGreaterThanOrEqual(0);
  expect(ops.indexOf('tasks:desc,updated')).toBeLessThan(ops.indexOf('tasks:subtasks,updated'));
  await expect.poll(async () => (await serverTask(page, 'tbig1'))?.subtasks?.map(x => x.title)).toEqual(['Queued behind the notes']);
  expect((await serverTask(page, 'tbig1')).desc).toContain('n'.repeat(40_000));
  await held.continue().catch(() => {});
  await page.unroute('**/api/sync');
});

test('closing the tab sends one keepalive request, however many changes are queued', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const many = Array.from({ length: 210 }, (_, i) => task(`tmany${i}`, 'pmany', `MANY-${300 + i}`, `Bulk ${i}`, { order: i }));
  await sync(page, [project('pmany', 'MANY'), ...many]);
  await page.goto('/#project/many/list');
  await expect(page.locator('[data-task-row]', { hasText: 'Bulk 209' })).toBeVisible();
  await page.locator('[data-a="selAll"]').first().click();
  await expect(page.locator('.bulkbar')).toContainText('210 selected');
  await page.locator('.bulkbar [data-pop="bulk-priority"]').click();

  let requests = 0;
  await page.route('**/api/sync', route => {
    requests++;
    return route.continue();
  });
  // The change and the tab going away in one go, before the save delay sends anything: 420 ops.
  await page.evaluate(() => {
    document.querySelector('.pop [data-a="bulkSet"][data-v="high"]').click();
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await page.waitForTimeout(1000);
  expect(requests).toBe(1);
  // Back: the rest is sent, in order.
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect
    .poll(async () => (await serverData(page)).tasks.filter(t => t.project === 'pmany' && t.priority === 'high').length, { timeout: 20_000 })
    .toBe(210);
  await page.unroute('**/api/sync');
});

test('what the server defers in the keepalive answer is sent again', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tdefer1', 'plow', 'LOW-240', 'Deferred on the way out')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Deferred on the way out');

  // The keepalive request reaches a server whose budget runs out after the first op: it saves that
  // one and defers the rest (`retry`), as it does for a request with too much formatted text.
  let deferred = null;
  const later = [];
  await page.route('**/api/sync', async route => {
    const ops = route.request().postDataJSON().ops;
    if (deferred) {
      later.push(...ops.map(op => JSON.stringify(op)));
      return route.continue();
    }
    deferred = ops.slice(1).map(op => JSON.stringify(op));
    const res = await route.fetch({ postData: JSON.stringify({ ops: ops.slice(0, 1) }) });
    const { results } = await res.json();
    for (let i = 1; i < ops.length; i++) results.push({ ok: false, retry: true, status: 413, error: 'desc: This batch has too much formatted text.', v: null });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  // A new description and title, and the tab going away before the save delay sent them.
  await page.evaluate(() => {
    const ed = document.querySelector('#d-desc');
    ed.innerHTML = '<p>Saved first</p>';
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    const ti = document.querySelector('#d-title');
    ti.focus();
    ti.value = 'Deferred, then sent again';
    ti.blur();
    dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await expect.poll(() => !!deferred).toBe(true);
  expect(deferred.length).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => deferred.every(op => later.includes(op)), { timeout: 20_000 }).toBe(true);
  await expect.poll(async () => (await serverTask(page, 'tdefer1'))?.title).toBe('Deferred, then sent again');
  expect((await serverTask(page, 'tdefer1')).desc).toContain('Saved first');
  await page.unroute('**/api/sync');
});

test('leaving again while the first keepalive send is unanswered sends what was typed since', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tagain1', 'plow', 'LOW-250', 'Left twice')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Left twice');

  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.locator('#d-desc').click();
  await page.keyboard.type('First words.', { delay: 20 });
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await page.waitForTimeout(400);

  // The first send on the way out is held unanswered; everything after it goes through.
  let first = null;
  await page.unroute('**/api/sync');
  await page.route('**/api/sync', route => (first ? route.continue() : void (first = route)));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => !!first).toBe(true);
  // Back in the tab for a moment, then away again.
  await page.keyboard.type(' More words.', { delay: 20 });
  await page.waitForTimeout(400);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(async () => (await serverTask(page, 'tagain1'))?.desc ?? '').toContain('First words. More words.');
  await first.continue().catch(() => {});
  await page.unroute('**/api/sync');
});

test('a change too large to save is reported and rolled back, not retried', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('thuge1', 'plow', 'LOW-260', 'Too much')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Too much');
  let requests = 0;
  await page.route('**/api/sync', route => {
    requests++;
    return route.continue();
  });
  // Over the server's 256 KB per record (in words: one 300,000-letter word takes the browser long to lay out).
  await setDesc(page, `<p>${'heavy words '.repeat(10)}</p>`.repeat(2_500));
  await toastWith(page, 'This item is too large to save.');
  await synced(page);
  await page.waitForTimeout(1500);
  expect(requests).toBe(1);
  expect(((await page.locator('#d-desc').textContent()) || '').length).toBeLessThan(1000);
  expect((await serverTask(page, 'thuge1')).desc).toBe('');
  expect(await errors(['too large'])).toEqual([]);
  await page.unroute('**/api/sync');
});

test('a reload shows what others changed while its data loaded', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('trace1', 'plow', 'LOW-270', 'Renamed by both'), task('trace2', 'plow', 'LOW-271', 'Deleted meanwhile')]);
  await page.goto('/#project/low/list');
  await expect(page.locator('[data-task-row]', { hasText: 'Deleted meanwhile' })).toBeVisible();
  await openTask(page, 'Renamed by both');

  // A reload's data is read by the server now, and arrives only after the changes below.
  let snap = null;
  let held = null;
  await page.route('**/api/bootstrap', async route => {
    snap = await route.fetch();
    held = route;
  });
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => !!held).toBe(true);
  // Mine is saved first, then someone else renames it and deletes the other task (over the live
  // stream, as another tab of the same person here).
  await page.fill('#d-title', 'Mine, older');
  await page.locator('#d-title').blur();
  await expect.poll(async () => (await serverTask(page, 'trace1'))?.title).toBe('Mine, older');
  await sync(page, [
    { c: 'tasks', id: 'trace1', k: 'patch', v: { title: 'Theirs, newer', updated: Date.now() } },
    { c: 'tasks', id: 'trace2', k: 'del' },
  ]);
  await page.waitForTimeout(500);
  await held.fulfill({ response: snap });
  await page.unroute('**/api/bootstrap');
  await expect(page.locator('#d-title')).toHaveValue('Theirs, newer');
  await expect(page.locator('[data-task-row]', { hasText: 'Deleted meanwhile' })).toHaveCount(0);
});

test('a change someone makes while mine is on its way isn’t hidden by the answer to mine', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tcross1', 'plow', 'LOW-280', 'Crossed')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Crossed');

  // My rename is saved, but its answer is held; someone renames it again after mine, and their
  // change reaches this tab first.
  let held = null;
  await page.route('**/api/sync', async route => {
    if (held) return route.continue();
    held = { route, res: await route.fetch() };
  });
  await page.fill('#d-title', 'Mine first');
  await page.locator('#d-title').blur();
  await expect.poll(() => !!held).toBe(true);
  await sync(page, [{ c: 'tasks', id: 'tcross1', k: 'patch', v: { title: 'Theirs after', updated: Date.now() } }]);
  await page.waitForTimeout(500);
  await held.route.fulfill({ response: held.res });
  await expect(page.locator('#d-title')).toHaveValue('Theirs after');
  await synced(page);
  expect((await serverTask(page, 'tcross1')).title).toBe('Theirs after');
  await page.unroute('**/api/sync');
});

test('a refused description doesn’t take a new title with it', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tfold1', 'plow', 'LOW-290', 'Old title')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Old title');

  // A first edit is held on its way, so what follows queues up behind it: a description longer
  // than the server takes (100,000 characters), then a new title.
  let held = null;
  await page.route('**/api/sync', route => (held ? route.continue() : void (held = route)));
  await page.locator('#d-desc').click();
  await page.keyboard.type('x');
  await expect.poll(() => !!held).toBe(true);
  await setDesc(page, `<p>${'d'.repeat(120_000)}</p>`);
  await page.waitForTimeout(300);
  await page.fill('#d-title', 'New title');
  await page.locator('#d-title').blur();
  await page.waitForTimeout(300);
  await held.continue();
  await toastWith(page, 'desc');
  await synced(page);
  const t = await serverTask(page, 'tfold1');
  expect(t.title).toBe('New title');
  expect(t.desc.length).toBeLessThan(1000);
  await expect(page.locator('#d-title')).toHaveValue('New title');
  expect(await errors(['desc'])).toEqual([]);
  await page.unroute('**/api/sync');
});

test('an edit made just before a delete survives its Undo', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tundo1', 'plow', 'LOW-300', 'Before the slip')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Before the slip');
  // Renamed, and deleted a moment later: within the save delay, so the rename was never sent.
  await page.evaluate(() => {
    const ti = document.querySelector('#d-title');
    ti.focus();
    ti.value = 'Renamed, then deleted';
    ti.dispatchEvent(new Event('input', { bubbles: true }));
    ti.blur();
    const b = document.createElement('button');
    b.dataset.a = 'delTask';
    b.dataset.id = 'tundo1';
    document.body.append(b);
    b.click();
    b.remove();
    document.querySelector('[data-a="confirmOk"]').click();
  });
  await expect.poll(async () => !!(await serverTask(page, 'tundo1'))).toBe(false);
  await page.locator('#toasts .toast', { hasText: 'Deleted' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await serverTask(page, 'tundo1'))?.title).toBe('Renamed, then deleted');
  await synced(page);
  expect((await serverTask(page, 'tundo1')).title).toBe('Renamed, then deleted');
});

test('a save waiting during a reload reports its own error', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/workspace');
  const name = await page.inputValue('#ws-name');
  // The save is held on its way while a reload starts and waits for it too.
  let held = null;
  await page.route('**/api/sync', route => (held ? route.continue() : void (held = route)));
  await page.fill('#ws-name', 'W'.repeat(100));
  await page.click('#ws-save');
  await expect.poll(() => !!held).toBe(true);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await page.waitForTimeout(300);
  await held.continue();
  // The server refuses a name that long: the save says so (and not that it worked).
  await expect(page.locator('#toasts .toast', { has: page.locator('.bad') }).first()).toBeVisible();
  await expect(page.locator('#toasts .toast', { hasText: 'Workspace settings saved' })).toHaveCount(0);
  await page.unroute('**/api/sync');
  expect((await (await page.request.get('/api/bootstrap')).json()).data.ws.name).toBe(name);
});

test('signing out with unsaved changes asks first, and needs the server to end the session', async ({ page }) => {
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await sync(page, [task('tout1', 'plow', 'LOW-310', 'Unsaved at sign-out')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Unsaved at sign-out');

  // Offline with an edit waiting: signing out asks, and Cancel keeps everything.
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.fill('#d-title', 'Saved after all');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await signOutFromMenu(page);
  const dlg = page.locator('.modal', { hasText: 'Sign out without saving?' });
  await expect(dlg).toContainText("You're offline, and some of your changes haven't reached the server yet.");
  await dlg.locator('[data-a="closeModal"]').first().click();
  await expect(page.locator('.side')).toBeVisible();
  await page.unroute('**/api/sync');
  await page.locator('[data-a="retryOnline"]').click();
  await expect.poll(async () => (await serverTask(page, 'tout1'))?.title, { timeout: 20_000 }).toBe('Saved after all');

  // The server can't end the session: the tab stays signed in and says so.
  await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Restarting"}' }));
  await signOutFromMenu(page);
  await toastWith(page, "Couldn't sign out");
  await expect(page.locator('.side')).toBeVisible();
  await page.unroute('**/api/auth/logout');

  // Offline again, and the person insists: the waiting edit is dropped and they're signed out.
  await openTask(page, 'Saved after all');
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.fill('#d-title', 'Dropped on purpose');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await signOutFromMenu(page);
  await page.locator('.modal [data-a="confirmOk"]', { hasText: 'Sign out anyway' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.unroute('**/api/sync');
  expect((await page.request.get('/api/bootstrap')).status()).toBe(401);
});

test('a tab notices someone else signed in on this browser, and sends nothing as them', async ({ page, browser }) => {
  // Invite a teammate, who joins from another browser.
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.locator('.side [data-r="members"]').click();
  await page.locator('[data-a="invite"]').first().click();
  await page.fill('#inv-emails', LIN.email);
  await page.click('#inv-submit');
  await toastWith(page, '1 invitation sent');
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto(emailLink(LIN.email));
  await elsewhere.fill('#s-name', LIN.name);
  await elsewhere.fill('#s-pw', LIN.password);
  await elsewhere.click('#signup-btn');
  await toastWith(elsewhere, 'Welcome, Lin');
  await elsewhere.context().close();

  // This tab has an edit waiting (offline) when Lin signs in in another tab of this browser.
  await sync(page, [task('twho1', 'plow', 'LOW-320', 'Whose edit?')]);
  await page.goto('/#project/low/list');
  await openTask(page, 'Whose edit?');
  await page.route('**/api/sync', route => route.abort('internetdisconnected'));
  await page.fill('#d-title', 'Not to be sent as Lin');
  await page.locator('#d-title').blur();
  await expect(page.locator('html')).toHaveAttribute('data-sync', 'offline');
  await page.unroute('**/api/sync');
  const other = await page.context().newPage();
  await other.request.post('/api/auth/login', { headers, data: { email: LIN.email, password: LIN.password } });
  await other.goto('/');
  await expect(other.locator('.side')).toBeVisible();

  // The first tab signs out without sending the edit (it would have been saved as Lin).
  await toastWith(page, 'Someone else signed in on this browser');
  const owner = await (await browser.newContext()).newPage();
  await signIn(owner, OWNER);
  await expect(owner.locator('.side')).toBeVisible();
  await page.waitForTimeout(500);
  expect((await serverTask(owner, 'twho1')).title).toBe('Whose edit?');
  await owner.context().close();
  await other.close();
});

test.afterAll(async ({ browser }) => {
  // Leave the workspace as the journeys found it: no Lin, no audit bot.
  const page = await browser.newPage();
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  const d = await serverData(page);
  const lin = d.members.find(m => m.email === LIN.email);
  if (lin) await page.request.post('/api/sync', { headers, data: { ops: [{ c: 'members', id: lin.id, k: 'del' }] } });
  for (const b of (d.bots || []).filter(b => b.name.endsWith('>Bot'))) await page.request.delete(`/api/bots/${b.id}`, { headers }).catch(() => {});
  await signOut(page).catch(() => {});
  await page.close();
});
