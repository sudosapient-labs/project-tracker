import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, signOut, synced, watchErrors } from './helpers.js';

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
  // key, registering with the server, removal on sign-out) is the app's real code. The endpoint is on
  // a real push service's host because the server only accepts those.
  await page.addInitScript(() => {
    let sub = null;
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.getSubscription = async () => sub;
    PushManager.prototype.subscribe = async opts => {
      window.__pushKeyBytes = opts.applicationServerKey.length;
      sub = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-subscription',
        toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-subscription', keys: { p256dh: 'BTestKey', auth: 'testauth' } }),
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

/* The Push toggles are the account's; this device only gets push once its browser allows it and the
   server holds its subscription. As above, PushManager is stood in for (headless Chromium has no
   push service), and so is the permission: headless Chromium reports Notification.permission as
   'denied' even after context.grantPermissions(['notifications']). */
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device';
function fakePush(page, { permission = 'granted', failFirst = false } = {}) {
  return page.addInitScript(
    ({ permission, failFirst, endpoint }) => {
      // The browser keeps its subscription across reloads, as a real one does.
      const make = () => ({
        endpoint,
        toJSON: () => ({ endpoint, keys: { p256dh: 'BTestKey', auth: 'testauth' } }),
        unsubscribe: async () => !((sub = null), sessionStorage.removeItem('fakeSub')),
      });
      let sub = sessionStorage.getItem('fakeSub') ? make() : null;
      let fail = failFirst;
      window.__prompts = 0;
      let perm = permission;
      Object.defineProperty(Notification, 'permission', { get: () => perm });
      Notification.requestPermission = async () => {
        window.__prompts++;
        if (perm === 'default') perm = 'granted';
        return perm;
      };
      PushManager.prototype.getSubscription = async () => sub;
      PushManager.prototype.subscribe = async () => {
        if (fail) {
          fail = false;
          throw new DOMException('push service unavailable', 'AbortError');
        }
        window.__subscribes = (window.__subscribes || 0) + 1;
        sessionStorage.setItem('fakeSub', '1');
        return (sub = make());
      };
    },
    { permission, failFirst, endpoint: ENDPOINT },
  );
}
const subsHere = (sql = 'SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?') => {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  try {
    return db.prepare(sql).get(ENDPOINT)?.n ?? 0;
  } finally {
    db.close();
  }
};
const shot = name => ({ path: `${process.env.PUSH_SHOTS || 'test-results/push-shots'}/${name}.png` });

test('with notifications allowed but nothing subscribed, Push says so and one tap turns it on', async ({ page }) => {
  const errors = watchErrors(page);
  // Boot's silent subscribe fails (the push service didn't answer), so this device isn't subscribed.
  await fakePush(page, { failFirst: true });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'warn');
  await expect(state).toContainText('Push isn’t on for this device yet.');
  // The account's choices are unchanged.
  await expect(page.locator('input[data-k="push_mention"]')).toBeChecked();
  expect(subsHere()).toBe(0);
  await page.screenshot(shot('granted-not-subscribed'));
  // The same at phone width, from a fresh load (each load's silent subscribe fails again).
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(state).toHaveAttribute('data-push-here', 'warn');
  await page.screenshot(shot('phone-granted-not-subscribed'));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await expect(state).toHaveAttribute('data-push-here', 'warn');

  const posted = page.waitForResponse(r => r.url().endsWith('/api/push/subscriptions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Turn on push on this device' }).click();
  expect((await posted).status()).toBe(201);
  expect((await posted).request().postDataJSON()).toMatchObject({ endpoint: ENDPOINT });
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  await expect(state).toContainText('Push is on for this device.');
  await expect(page.getByRole('button', { name: 'Turn on push on this device' })).toHaveCount(0);
  expect(subsHere()).toBe(1);
  await page.screenshot(shot('subscribed'));
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('a browser that was never asked: Settings and the Inbox offer push, and the tap asks for permission', async ({ page }) => {
  const errors = watchErrors(page);
  await fakePush(page, { permission: 'default' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#inbox');
  const nudge = page.locator('[data-push-nudge]');
  await expect(nudge).toContainText('Get notifications on this device');
  await page.screenshot(shot('inbox-offer'));
  await page.goto('/#settings/notif-push');
  await expect(page.locator('[data-push-here]')).toContainText('Your browser will ask for permission.');
  await page.screenshot(shot('never-asked'));
  expect(await page.evaluate(() => window.__prompts)).toBe(0); // nothing is asked without a tap

  await page.goto('/#inbox');
  const posted = page.waitForResponse(r => r.url().endsWith('/api/push/subscriptions') && r.request().method() === 'POST');
  await nudge.getByRole('button', { name: 'Turn on' }).click();
  expect((await posted).status()).toBe(201);
  expect(await page.evaluate(() => window.__prompts)).toBe(1);
  await expect(nudge).toHaveCount(0);
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('the Inbox offer stays dismissed on this browser', async ({ page }) => {
  await fakePush(page, { permission: 'default' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#inbox');
  await page.locator('[data-push-nudge]').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('[data-push-nudge]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.inbox-list')).toBeVisible();
  await expect(page.locator('[data-push-nudge]')).toHaveCount(0);
  await signOut(page);
});

test('allowed and wanted: after the server drops this browser’s subscription, the next load subscribes again silently', async ({ page }) => {
  const errors = watchErrors(page);
  await fakePush(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await expect.poll(() => subsHere()).toBe(1);

  // Gone server-side, as when the push service reports it expired.
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(ENDPOINT);
  db.close();
  expect(subsHere()).toBe(0);

  const posted = page.waitForResponse(r => r.url().endsWith('/api/push/subscriptions') && r.request().method() === 'POST');
  await page.goto('/#settings/notif-push');
  await page.reload();
  expect((await posted).status()).toBe(201);
  await expect(page.locator('[data-push-here]')).toHaveAttribute('data-push-here', 'ok');
  expect(subsHere()).toBe(1);
  // The browser's existing subscription was handed to the server again: no prompt, no new subscribe().
  expect(await page.evaluate(() => [window.__prompts, window.__subscribes || 0])).toEqual([0, 0]);
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('notifications blocked: Push explains how to allow them instead of offering a button', async ({ page }) => {
  const errors = watchErrors(page);
  await fakePush(page, { permission: 'denied' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'danger');
  await expect(state).toContainText('Notifications are blocked on this device.');
  await expect(state).toContainText('set Notifications to Allow');
  await expect(page.getByRole('button', { name: 'Turn on push on this device' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await page.screenshot(shot('blocked'));
  await page.goto('/#inbox');
  await expect(page.locator('.inbox-list')).toBeVisible();
  await expect(page.locator('[data-push-nudge]')).toHaveCount(0);
  await signOut(page);
  expect(await errors()).toEqual([]);
});
