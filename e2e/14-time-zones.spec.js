import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, toastWith, watchErrors } from './helpers.js';

/* The app saves the browser's time zone for someone who has none saved, once, and never replaces one
   they chose. The browser here is in Dubai. Runs after the other journeys (05-settings leaves the
   owner's password as below) or on its own, on a fresh database. */
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };
const KATHERINE = { name: 'Katherine Johnson', email: 'katherine@example.com', password: 'orbital-mechanics-62' };
const DOROTHY = { name: 'Dorothy Vaughan', email: 'dorothy@example.com', password: 'fortran-west-area-43' };
const headers = { 'x-requested-with': 'sudo-sapient' };
const tokenOf = link => link.split('#')[1].split('/')[1];
test.describe.configure({ mode: 'serial' });
test.use({ timezoneId: 'Asia/Dubai' });

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
  for (const p of [KATHERINE, DOROTHY]) {
    const r = await (await rq.post('/api/auth/signup', { headers, data: { ...p, join: tokenOf(link) } })).json();
    expect((await rq.post('/api/auth/verify', { headers, data: { token: tokenOf(r.devLink) } })).ok()).toBe(true);
    // Dorothy chose India in Settings (on another computer).
    if (p === DOROTHY) expect((await rq.put('/api/me/state', { headers, data: { prefs: { tz: 'Asia/Kolkata' } } })).ok()).toBe(true);
    await rq.post('/api/auth/logout', { headers, data: {} });
  }
  await ctx.close();
});

const savedTz = async page => (await (await page.request.get('/api/bootstrap')).json()).prefs.tz;

test('someone with no time zone saved gets their browser’s, and is told', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, KATHERINE);
  await expect(page.locator('.side')).toBeVisible();
  await toastWith(page, 'Time zone set to Dubai from your browser. Change it in Settings → Date and time.');
  await expect.poll(() => savedTz(page)).toBe('Asia/Dubai');
  await page.goto('/#settings/datetime');
  await expect(page.locator('select[data-k="tz"]')).toHaveValue('Asia/Dubai');
  // Any zone can be picked, not only the common ones.
  await page.locator('select[data-k="tz"]').selectOption('Australia/Sydney');
  await expect.poll(() => savedTz(page)).toBe('Australia/Sydney');
  await page.locator('select[data-k="tz"]').selectOption('Asia/Dubai');
  await expect.poll(() => savedTz(page)).toBe('Asia/Dubai');
  // The workspace's zone is for Owners and Admins to change.
  await page.goto('/#settings/workspace');
  await expect(page.locator('#ws-tz')).toBeDisabled();

  // Saved once: opening the app again says nothing more.
  await page.reload();
  await expect(page.locator('.side')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('#toasts .toast', { hasText: 'Time zone set to' })).toHaveCount(0);
  expect(await errors()).toEqual([]);
});

test('a time zone someone chose is never replaced by the browser’s', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, DOROTHY);
  await expect(page.locator('.side')).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.locator('#toasts .toast', { hasText: 'Time zone set to' })).toHaveCount(0);
  expect(await savedTz(page)).toBe('Asia/Kolkata');
  await page.goto('/#settings/datetime');
  await expect(page.locator('select[data-k="tz"]')).toHaveValue('Asia/Kolkata');
  expect(await errors()).toEqual([]);
});

test('an Owner sets the workspace’s time zone in Settings → Workspace', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/workspace');
  await page.locator('#ws-tz').selectOption('America/Sao_Paulo');
  await toastWith(page, 'Workspace time zone set to Sao Paulo');
  await expect.poll(async () => (await (await page.request.get('/api/bootstrap')).json()).data.ws.tz).toBe('America/Sao_Paulo');
  expect(await errors()).toEqual([]);
});
