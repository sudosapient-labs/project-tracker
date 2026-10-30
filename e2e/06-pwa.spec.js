import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, synced, watchErrors } from './helpers.js';

test.describe.configure({ mode: 'serial' });
// 05-settings changes the owner's password.
const OWNER = { ...OWNER_AFTER_RESET, password: 'jacquard-loom-42' };

test('installable: manifest, icons and the Sudo Sapient brand', async ({ page, request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.headers()['content-type']).toContain('application/manifest+json');
  const manifest = await m.json();
  expect(manifest).toMatchObject({ name: 'Sudo Sapient', display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  expect(manifest.icons.some(i => i.purpose === 'maskable')).toBe(true);

  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('.auth-top svg.logo')).toHaveAttribute('aria-label', 'Sudo Sapient');
  await expect(page).toHaveTitle('Sudo Sapient');
});

test('the service worker takes over, and the app still opens without a connection', async ({ page, context }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  // The cached shell loads and explains the problem instead of the browser's offline page.
  await expect(page.getByRole('heading', { name: "Can't reach Sudo Sapient" })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('turning on push subscribes this browser on the server; signing out removes it', async ({ page }) => {
  const errors = watchErrors(page);
  // Headless Chromium has no push service, so the browser's side is stood in for here: permission
  // is granted and PushManager returns a subscription. Everything after that (fetching the VAPID
  // key, registering with the server, removal on sign-out) is the app's real code.
  await page.addInitScript(() => {
    let sub = null;
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async opts => {
      window.__pushKeyBytes = opts.applicationServerKey.length;
      sub = {
        endpoint: 'https://push.example.test/e2e-subscription',
        toJSON: () => ({ endpoint: 'https://push.example.test/e2e-subscription', keys: { p256dh: 'BTestKey', auth: 'testauth' } }),
        unsubscribe: async () => !(sub = null),
      };
      return sub;
    };
  });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const count = () => {
    const db = new DatabaseSync('test-results/e2e-data/db.sqlite', { readOnly: true });
    try {
      return db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n;
    } finally {
      db.close();
    }
  };
  const toggle = page.locator('input[data-k="push_mention"]');
  await toggle.uncheck();
  await toggle.check();
  await synced(page);
  await expect.poll(count, { timeout: 15000 }).toBe(1);
  // The server's VAPID public key (an uncompressed P-256 point) was handed to the browser.
  expect(await page.evaluate(() => window.__pushKeyBytes)).toBe(65);

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.locator('.pop [data-a="signOut"]').click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect.poll(count).toBe(0);
  expect(await errors()).toEqual([]);
});
