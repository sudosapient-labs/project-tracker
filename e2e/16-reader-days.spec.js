import { expect, test } from '@playwright/test';
import { addDaysToDay, dayOf, fromWallClock } from '../packages/client/dates.js';
import { OWNER_AFTER_RESET, signIn, synced, watchErrors } from './helpers.js';

/* Days and dues the app shows on the reader's clock, and a time zone set elsewhere kept by an open
   tab. Mary has India's zone saved and a browser in it. Runs after the other journeys (05-settings
   leaves the owner's password as below) or on its own, on a fresh database. */
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const MARY = { name: 'Mary Jackson', email: 'mary@example.com', password: 'wind-tunnel-58' };
const IST = 'Asia/Kolkata';
const headers = { 'x-requested-with': 'sudo-sapient' };
const tokenOf = link => link.split('#')[1].split('/')[1];
// Ten days from today in India: in view on the project timeline.
const SOON = addDaysToDay(dayOf(Date.now(), IST), 10);
let token = '';
test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: IST });

/* Mary's REST API, with her key. */
const rest = (rq, method, url, data) => rq.fetch('/api/v1' + url, { method, headers: { authorization: `Bearer ${token}` }, ...(data ? { data } : {}) });

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
  const r = await (await rq.post('/api/auth/signup', { headers, data: { ...MARY, join: tokenOf(link) } })).json();
  expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
  expect((await rq.put('/api/me/state', { headers, data: { prefs: { tz: IST } } })).ok()).toBe(true);
  ({ token } = await (await rq.post('/api/keys', { headers, data: { name: 'e2e', scope: 'write', expiresInDays: null, password: MARY.password } })).json());
  // Two dues on Nov 30 in India: all day, and 15:30 (10:00 UTC), which comes first.
  expect((await rest(rq, 'POST', '/projects', { name: 'Mid Atlantic', key: 'MAT', due: '2026-11-30' })).status()).toBe(201);
  expect((await rest(rq, 'POST', '/projects', { name: 'Kitty Hawk', key: 'KHK', due: '2026-11-30T10:00:00Z' })).status()).toBe(201);
  // A target at 01:30 on Dec 1 in India (Nov 30 in UTC), and two milestones on one day in India,
  // one of them at 01:00 (the day before in UTC).
  const glide = {
    name: 'Glide Test',
    key: 'GLD',
    due: '2026-11-30T20:00:00Z',
    milestones: [
      { name: 'Wind tunnel', date: SOON },
      { name: 'First flight', date: fromWallClock(SOON, '01:00', IST) },
    ],
  };
  expect((await rest(rq, 'POST', '/projects', glide)).status()).toBe(201);
  await rq.post('/api/auth/logout', { headers, data: {} });
  await ctx.close();
});

test('API keys show the day they were made and expire on the reader’s clock', async ({ page }) => {
  const errors = watchErrors(page);
  // Made at 01:30 on Oct 5 and expiring at 01:30 on Feb 8 in India: Oct 4 and Feb 7 in UTC.
  const dated = k => (k.name === 'e2e' ? { ...k, createdAt: Date.parse('2026-10-04T20:00:00Z'), expiresAt: Date.parse('2027-02-07T20:00:00Z') } : k);
  await page.route('**/api/keys', async route => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: (await res.json()).map(dated) });
  });
  await page.route('**/api/bootstrap', async route => {
    const res = await route.fetch();
    const b = await res.json();
    if (b.data?.apiKeys) b.data.apiKeys = b.data.apiKeys.map(dated);
    await route.fulfill({ response: res, json: b });
  });
  await signIn(page, MARY);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/api');
  const row = page.locator('.srow', { hasText: 'e2e' });
  await expect(row).toContainText(/Created Oct 5(, 2026)? ·/);
  await expect(row).toContainText('Expires Feb 8, 2027');
  expect(await errors()).toEqual([]);
});

test('projects sort by due as moments on the reader’s clock', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, MARY);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#projects');
  await page.locator('[data-in="projSort"]').selectOption('due');
  const names = await page.locator('.page [data-r="project"][data-id]').allInnerTexts();
  const order = ['Kitty Hawk', 'Mid Atlantic'].map(n => names.findIndex(t => t.includes(n)));
  expect(order.every(i => i >= 0)).toBe(true);
  expect(order[0]).toBeLessThan(order[1]);
  expect(await errors()).toEqual([]);
});
