/* The app on a phone (Pixel 7: touch, no hover), as the Android app shows it: everything works by
   tap, the system Back button closes what's open before it leaves the page, nothing is wider than
   the screen. Runs after the desktop journeys, in the workspace they made. */
import { expect, test } from '@playwright/test';
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
