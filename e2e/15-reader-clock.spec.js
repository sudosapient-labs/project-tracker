import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, synced, watchErrors } from './helpers.js';

/* History and calendar events on the reader's clock: Ravi, in India, moves a due to 6:30 PM and
   adds a 10:00 standup; Layla, in Dubai, sees the standup at 8:30 and the history line at 5:00 PM.
   Each has their zone saved and a browser in it. Runs after the other journeys (05-settings leaves
   the owner's password as below) or on its own, on a fresh database. */
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const RAVI = { name: 'Ravi Menon', email: 'ravi@example.com', password: 'monsoon-ledger-58', tz: 'Asia/Kolkata' };
const LAYLA = { name: 'Layla Haddad', email: 'layla@example.com', password: 'dune-compass-31', tz: 'Asia/Dubai' };
const headers = { 'x-requested-with': 'sudo-sapient' };
const tokenOf = link => link.split('#')[1].split('/')[1];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The 15th of this month (in Dubai, where the calendar is read): in view on the month calendar.
const [Y, M] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(Date.now()).split('-');
const DAY = `${Y}-${M}-15`;
const DAY_WORDS = `${MON[Number(M) - 1]} 15`;
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const rq = ctx.request;
  const s = await (await rq.get('/api/auth/session')).json();
  if (!s.workspace) {
    const r = await (await rq.post('/api/auth/signup', { headers, data: { name: OWNER.name, email: OWNER.email, password: OWNER.password } })).json();
    expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
    expect((await rq.post('/api/workspace/onboarded', { headers, data: {} })).ok()).toBe(true);
  } else expect((await rq.post('/api/auth/login', { headers, data: { email: OWNER.email, password: OWNER.password } })).ok()).toBe(true);
  const { link } = await (await rq.post('/api/workspace/invite-link', { headers, data: {} })).json();
  await rq.post('/api/auth/logout', { headers, data: {} });
  for (const p of [RAVI, LAYLA]) {
    const r = await (await rq.post('/api/auth/signup', { headers, data: { name: p.name, email: p.email, password: p.password, join: tokenOf(link) } })).json();
    expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
    expect((await rq.put('/api/me/state', { headers, data: { prefs: { tz: p.tz } } })).ok()).toBe(true);
    if (p === RAVI) {
      // Ravi's project and task, and the standup he adds at 10:00 his time (the app shows events;
      // they're added through the API, the CLI, MCP or the Slack bot).
      const { token } = await (
        await rq.post('/api/keys', { headers, data: { name: 'e2e', scope: 'write', expiresInDays: null, password: p.password } })
      ).json();
      const api = (url, data) => rq.post('/api/v1' + url, { headers: { authorization: `Bearer ${token}` }, data });
      expect((await api('/projects', { name: 'Release train', key: 'RTR', members: [] })).status()).toBe(201);
      expect((await api('/tasks', { project: 'RTR', title: 'Cut the release' })).status()).toBe(201);
      const ev = await (await api('/events', { title: 'Standup', date: DAY, time: '10:00', project: 'RTR' })).json();
      expect(ev).toMatchObject({ date: DAY, time: '10:00' });
    }
    await rq.post('/api/auth/logout', { headers, data: {} });
  }
  await ctx.close();
});

test.describe('in India', () => {
  test.use({ timezoneId: 'Asia/Kolkata' });
  test('Ravi moves a due to 6:30 PM and sees it in the history at 6:30 PM', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, RAVI);
    await expect(page.locator('.side')).toBeVisible();
    await page.goto('/#project/rtr/list');
    await page.locator('[data-a="openTask"]', { hasText: 'Cut the release' }).first().click();
    await page.locator('.drawer [data-pop="date"][data-field="due"]').click();
    await page.locator(`.pop [data-a="popPick"][data-v="${DAY}"]`).click();
    await page.locator('.pop [data-a="popTimeOn"]').click();
    await page.locator('#pop-time').fill('6:30 pm');
    await page.locator('.pop [data-a="popDateSave"]').click();
    await synced(page);
    await page.locator('.drawer [data-k="drawerTab"][data-v="activity"]').click();
    await expect(page.locator('.drawer .act-line', { hasText: 'changed due date' })).toContainText(`changed due date to ${DAY_WORDS}, 6:30 PM`);
    // His standup, on his calendar at 10:00.
    await page.goto('/#project/rtr/calendar');
    await expect(page.locator(`[data-drop-day="${DAY}"] .cev.event`)).toContainText('10:00 AM');
    // The date picker's day buttons carry inline hover handlers, which the CSP blocks (and reports).
    expect(await errors(['Executing inline event handler'])).toEqual([]);
  });
});

test.describe('in Dubai', () => {
  test.use({ timezoneId: 'Asia/Dubai' });
  test('Layla sees the standup at 8:30 AM and the new due at 5:00 PM', async ({ page }) => {
    const errors = watchErrors(page);
    await signIn(page, LAYLA);
    await expect(page.locator('.side')).toBeVisible();
    await page.goto('/#project/rtr/calendar');
    const standup = page.locator(`[data-drop-day="${DAY}"] .cev.event`);
    await expect(standup).toContainText('8:30 AM');
    await expect(standup).toContainText('Standup');
    await standup.click();
    await expect(page.locator('.pop')).toContainText('8:30 AM');
    await page.keyboard.press('Escape');
    // The due is on her calendar at 5:00 PM, and so is the history line.
    await page.goto('/#project/rtr/list');
    await page.locator('[data-a="openTask"]', { hasText: 'Cut the release' }).first().click();
    await page.locator('.drawer [data-k="drawerTab"][data-v="activity"]').click();
    await expect(page.locator('.drawer .act-line', { hasText: 'changed due date' })).toContainText(`changed due date to ${DAY_WORDS}, 5:00 PM`);
    expect(await errors()).toEqual([]);
  });
});
