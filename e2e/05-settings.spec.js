import { expect, test } from '@playwright/test';
import { totpAt } from '../server/lib/crypto.js';
import { OWNER_AFTER_RESET, signIn, signOut, synced, toastWith, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });

const OWNER = { ...OWNER_AFTER_RESET };
const section = (page, sec) => page.locator(`.set-nav [data-sec="${sec}"]`).click();
const openSettings = async (page, sec) => {
  await page.locator('.side [data-r="settings"]').first().click();
  await section(page, sec);
};

test('profile, workspace and preferences are saved to the account, not the browser', async ({ page, browser }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openSettings(page, 'profile');
  await page.fill('#pf-name', 'Ada King');
  await page.fill('#pf-title', 'Countess of Lovelace');
  await page.click('#pf-save');
  await toastWith(page, 'Profile updated');

  await section(page, 'workspace');
  await page.fill('#ws-name', 'Engines Ltd');
  await page.click('#ws-save');
  await toastWith(page, 'Workspace settings saved');

  await section(page, 'appearance');
  await page.locator('[data-a="setTheme"][data-v="dark"]').first().click();
  await section(page, 'notif-email');
  await page.locator('input[data-k="email_digest"]').check();
  await synced(page);

  // A different browser (no local cache) sees the same account settings.
  const other = await (await browser.newContext()).newPage();
  await signIn(other, OWNER);
  await expect(other.locator('.side')).toContainText('Ada King');
  await expect(other.locator('.side')).toContainText('Engines Ltd');
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await other.goto('/#settings/notif-email');
  await expect(other.locator('input[data-k="email_digest"]')).toBeChecked();
  await other.context().close();

  await section(page, 'appearance');
  await page.locator('[data-a="setTheme"][data-v="light"]').first().click();
  await synced(page);
  expect(await errors()).toEqual([]);
});

test('sessions: another device shows up and can be signed out remotely', async ({ page, browser }) => {
  const errors = watchErrors(page);
  const phone = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' })).newPage();
  await signIn(phone, OWNER);
  await expect(phone.locator('.side')).toBeVisible();

  await signIn(page, OWNER);
  await openSettings(page, 'sessions');
  const iphone = page.locator('.srow', { hasText: 'iPhone · Safari' });
  await expect(iphone).toBeVisible();
  await expect(page.locator('.srow', { hasText: 'This device' })).toBeVisible();
  await iphone.locator('[data-a="revokeSession"]').click();
  await toastWith(page, 'Session signed out');
  await expect(iphone).toHaveCount(0);
  await expect(phone.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15000 });
  await phone.context().close();
  expect(await errors()).toEqual([]);
});

test('change password, which signs out other devices, then sign in with the new one', async ({ page, browser }) => {
  const errors = watchErrors(page);
  const laptop = await (await browser.newContext()).newPage();
  await signIn(laptop, OWNER);
  await expect(laptop.locator('.side')).toBeVisible();
  await signIn(page, OWNER);
  await openSettings(page, 'password');
  await page.fill('#pw-cur', 'wrong-password-0');
  await page.fill('#pw-new', 'jacquard-loom-42');
  await page.fill('#pw-conf', 'jacquard-loom-42');
  await page.click('#pw-save');
  await expect(page.locator('.set-body .err')).toContainText('current password is incorrect');
  await page.fill('#pw-cur', OWNER.password);
  await page.fill('#pw-new', 'jacquard-loom-42');
  await page.fill('#pw-conf', 'jacquard-loom-42');
  await page.click('#pw-save');
  await toastWith(page, 'Password updated');
  await expect(page.locator('.set-body .alert.ok')).toContainText('other sessions were signed out');
  await expect(laptop.getByRole('heading', { name: 'Welcome back' })).toBeVisible({ timeout: 15000 });
  await laptop.context().close();
  OWNER.password = 'jacquard-loom-42';
  await signOut(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  expect(await errors(['current password is incorrect'])).toEqual([]);
});

test('two-factor authentication: set up with an authenticator code, required at sign-in, then turned off', async ({ page }) => {
  const errors = watchErrors(page);
  await signIn(page, OWNER);
  await openSettings(page, '2fa');
  // Setting it up starts with the current password.
  await page.click('#tfa-setup');
  await page.fill('#tfa-pw', 'not-my-password-1');
  await page.click('#tfa-setup');
  await expect(page.locator('.set-body .err')).toContainText('password is incorrect');
  await page.fill('#tfa-pw', OWNER.password);
  await page.click('#tfa-setup');
  await expect(page.locator('[aria-label="QR code for your authenticator app"] svg')).toBeVisible();
  const secret = (await page.locator('.set-body .hint .mono').textContent()).replace(/\s/g, '');
  await page.fill('#tfa-code', '000000');
  await page.click('#tfa-verify');
  await expect(page.locator('.set-body .err')).toBeVisible();
  await page.fill('#tfa-code', totpAt(secret));
  await page.click('#tfa-verify');
  await toastWith(page, 'Two-factor authentication enabled');
  const codes = (await page.locator('#tfa-codes span').allTextContents()).map(s => s.trim());
  expect(codes).toHaveLength(8);

  await signOut(page);
  await signIn(page, OWNER);
  await expect(page.getByRole('heading', { name: 'Two-factor authentication' })).toBeVisible();
  await page.fill('#t-code', '123456');
  await page.click('#tfa-btn');
  await expect(page.locator('#code-err')).toBeVisible();
  // Each code works once: the one that turned 2FA on is spent, so use the next time step's.
  await page.fill('#t-code', totpAt(secret, Date.now() + 30_000));
  await page.click('#tfa-btn');
  await expect(page.locator('.side')).toBeVisible();

  // A recovery code works once in place of the app.
  await signOut(page);
  await signIn(page, OWNER);
  await page.fill('#t-code', codes[0]);
  await page.click('#tfa-btn');
  await expect(page.locator('.side')).toBeVisible();

  // Turning it off needs the password (or a code), not just a signed-in browser.
  await openSettings(page, '2fa');
  await page.locator('[data-a="disable2fa"]').click();
  await page.fill('#tfa-off', 'not-my-password-1');
  await page.click('#tfa-off-btn');
  await expect(page.locator('.set-body .err')).toContainText('current password');
  await page.fill('#tfa-off', OWNER.password);
  await page.click('#tfa-off-btn');
  await toastWith(page, 'Two-factor authentication turned off');
  await signOut(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  expect(await errors(['didn’t match', "didn't work", 'current password', 'password is incorrect'])).toEqual([]);
});
