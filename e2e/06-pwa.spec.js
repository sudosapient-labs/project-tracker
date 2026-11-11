import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import { OWNER_AFTER_RESET, signIn, signOut, synced, toastWith, watchErrors } from './helpers.js';

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
  // Android's status bar and notifications (and the Android app's notification icon) need it.
  expect(manifest.icons.find(i => i.purpose === 'monochrome')).toMatchObject({ type: 'image/png', sizes: '512x512' });
  expect((await request.get('/icons/badge-96.png')).headers()['content-type']).toBe('image/png');

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
const OLD_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device-old-key';
/* `worker`: 'ok', 'fails' (registering throws while window.__swFail is true, as when the script
   can't be fetched), 'failsOnce' (only the first time), 'hangsOnce' (the first registration never
   settles, as when fetching sw.js stalls) or 'blocked' (SecurityError, as in a private window). `readyHangsOnce`: the first wait for the worker never settles, as when it failed
   to install. `staleKey`: the browser already holds a subscription made with another server key. */
function fakePush(page, { permission = 'granted', failFirst = false, worker = 'ok', readyHangsOnce = false, staleKey = false } = {}) {
  return page.addInitScript(
    ({ permission, failFirst, worker, readyHangsOnce, staleKey, endpoint, oldEndpoint }) => {
      // The browser keeps its subscription across reloads, as a real one does.
      const make = (ep, key) => ({
        endpoint: ep,
        options: { applicationServerKey: key },
        toJSON: () => ({ endpoint: ep, keys: { p256dh: 'BTestKey', auth: 'testauth' } }),
        unsubscribe: async () => {
          window.__unsubscribed = [...(window.__unsubscribed || []), ep];
          sub = null;
          sessionStorage.removeItem('fakeSub');
          return true;
        },
      });
      const kept = sessionStorage.getItem('fakeSub');
      let sub = kept ? make(...JSON.parse(kept).map((v, i) => (i ? new Uint8Array(v).buffer : v))) : null;
      if (!kept && staleKey) sub = make(oldEndpoint, new Uint8Array(65).fill(7).buffer);
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
      PushManager.prototype.subscribe = async opts => {
        if (fail) {
          fail = false;
          throw new DOMException('push service unavailable', 'AbortError');
        }
        window.__subscribes = (window.__subscribes || 0) + 1;
        const key = new Uint8Array(opts.applicationServerKey);
        sessionStorage.setItem('fakeSub', JSON.stringify([endpoint, [...key]]));
        return (sub = make(endpoint, key.buffer));
      };
      const register = ServiceWorkerContainer.prototype.register;
      window.__swFail = worker === 'fails' || worker === 'failsOnce';
      window.__registers = 0;
      ServiceWorkerContainer.prototype.register = function (...args) {
        window.__registers++;
        if (worker === 'blocked') return Promise.reject(new DOMException('The operation is insecure.', 'SecurityError'));
        if (worker === 'hangsOnce' && window.__registers === 1) return new Promise(() => {});
        if (window.__swFail) {
          if (worker === 'failsOnce') window.__swFail = false;
          return Promise.reject(new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (503) was received.'));
        }
        return register.apply(this, args);
      };
      if (readyHangsOnce) {
        const ready = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, 'ready').get;
        let hung = false;
        Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', {
          get() {
            if (hung) return ready.call(this);
            hung = true;
            return new Promise(() => {});
          },
        });
      }
    },
    { permission, failFirst, worker, readyHangsOnce, staleKey, endpoint: ENDPOINT, oldEndpoint: OLD_ENDPOINT },
  );
}
/* Every push subscription the app hands the server, by endpoint. */
const postedSubs = page => {
  const seen = [];
  page.on('request', r => r.url().endsWith('/api/push/subscriptions') && r.method() === 'POST' && seen.push(r.postDataJSON().endpoint));
  return seen;
};
const subsHere = (endpoint = ENDPOINT) => {
  const db = new DatabaseSync('test-results/e2e-data/db.sqlite');
  try {
    return db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint = ?').get(endpoint)?.n ?? 0;
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
  await expect(page.locator('[data-push-here]')).toContainText('You’ll be asked to allow notifications.');
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

/* Push needs the service worker. When it can't be had, Settings must still end on a truthful state
   with a button that works, never on "Checking this device…" or a button that stays disabled. */
test('notifications allowed but the service worker won’t register: Push says not on yet, and the button tries again', async ({ page }) => {
  await fakePush(page, { worker: 'fails' });
  const posts = postedSubs(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'warn');
  await expect(state).toContainText('Push isn’t on for this device yet.');
  await page.goto('/#inbox');
  await expect(page.locator('[data-push-nudge]')).toBeVisible();

  await page.goto('/#settings/notif-push');
  const button = page.getByRole('button', { name: 'Turn on push on this device' });
  const tries = await page.evaluate(() => window.__registers);
  await button.click();
  await toastWith(page, "Couldn't turn on push notifications in this browser.");
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => window.__registers)).toBeGreaterThan(tries); // it did try again
  expect(posts).toEqual([]);

  // Whatever stopped it has cleared: the same button now turns push on.
  await page.evaluate(() => (window.__swFail = false));
  await button.click();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(posts).toEqual([ENDPOINT]);
  await signOut(page);
});

test('never asked, and the service worker failed to register at load: one tap asks, registers and subscribes', async ({ page }) => {
  const errors = watchErrors(page);
  await fakePush(page, { permission: 'default', worker: 'failsOnce' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  await expect.poll(() => page.evaluate(() => [window.__registers, window.__swFail])).toEqual([1, false]);
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'warn');
  await page.getByRole('button', { name: 'Turn on push on this device' }).click();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(subsHere()).toBe(1);
  expect(await page.evaluate(() => window.__prompts)).toBe(1);
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('a worker that never gets ready: Push stops checking and offers the button, which then works', async ({ page }) => {
  test.setTimeout(60_000);
  await fakePush(page, { readyHangsOnce: true });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  // The silent subscribe after sign-in waits for the worker for 10 seconds, then gives up.
  await expect(state).toHaveAttribute('data-push-here', 'warn', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Turn on push on this device' }).click();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(subsHere()).toBe(1);
  await signOut(page);
});

test('registering the worker stalls: Push stops checking after 10 seconds, and the button registers again', async ({ page }) => {
  test.setTimeout(60_000);
  await fakePush(page, { worker: 'hangsOnce' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'warn', { timeout: 20_000 });
  expect(await page.evaluate(() => window.__registers)).toBe(1);
  await page.getByRole('button', { name: 'Turn on push on this device' }).click();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(await page.evaluate(() => window.__registers)).toBe(2);
  expect(subsHere()).toBe(1);
  await signOut(page);
});

test('a browser that won’t run service workers here: Push says why, with no button and no Inbox offer', async ({ page }) => {
  const errors = watchErrors(page);
  await fakePush(page, { worker: 'blocked' });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toContainText('This browser isn’t letting Sudo Sapient run in the background.');
  await expect(page.getByRole('button', { name: 'Turn on push on this device' })).toHaveCount(0);
  await page.goto('/#inbox');
  await expect(page.locator('.inbox-list')).toBeVisible();
  await expect(page.locator('[data-push-nudge]')).toHaveCount(0);
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('the Inbox “Turn on” is disabled while it works, so a double tap posts once', async ({ page }) => {
  await fakePush(page, { permission: 'default' });
  const posts = postedSubs(page);
  let release;
  const held = new Promise(r => (release = r));
  await page.route('**/api/push/subscriptions', async route => {
    await held;
    await route.continue();
  });
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#inbox');
  const button = page.locator('[data-push-nudge]').getByRole('button', { name: 'Turn on' });
  await button.dblclick();
  await expect(button).toBeDisabled();
  await expect.poll(() => posts.length).toBe(1);
  release();
  await expect(page.locator('[data-push-nudge]')).toHaveCount(0);
  expect(posts).toEqual([ENDPOINT]);
  await page.unroute('**/api/push/subscriptions');
  await signOut(page);
});

test('a subscription made with an old server key is replaced, never handed to the server', async ({ page }) => {
  const errors = watchErrors(page);
  // The replacement fails the first time: Push must not say it's on.
  await fakePush(page, { staleKey: true, failFirst: true });
  const posts = postedSubs(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'warn');
  expect(await page.evaluate(() => window.__unsubscribed)).toEqual([OLD_ENDPOINT]);
  expect(posts).toEqual([]);

  await page.getByRole('button', { name: 'Turn on push on this device' }).click();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(posts).toEqual([ENDPOINT]);
  expect([subsHere(OLD_ENDPOINT), subsHere()]).toEqual([0, 1]);
  // Made with the server's key, so the next load keeps it.
  await page.reload();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  expect(await page.evaluate(() => [window.__unsubscribed, window.__subscribes])).toEqual([undefined, undefined]);
  await signOut(page);
  expect(await errors()).toEqual([]);
});

test('every kind of push off: Push says nothing is pushed, and turning one on brings it back', async ({ page }) => {
  await fakePush(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await page.goto('/#settings/notif-push');
  const state = page.locator('[data-push-here]');
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  await expect(state).toContainText('requests for access to projects you lead');
  const keys = ['push_mention', 'push_assign', 'push_comment', 'push_due'];
  for (const k of keys) await page.locator(`input[data-k="${k}"]`).uncheck();
  await synced(page);
  await expect(state).toContainText('Push is off.');
  await expect(state).toContainText('access requests included');
  // The server agrees (test/server/push.test.js checks that nothing is pushed then).
  await page.reload();
  await expect(state).toContainText('Push is off.');
  await page.locator('input[data-k="push_mention"]').check();
  await expect(state).toHaveAttribute('data-push-here', 'ok');
  for (const k of keys.slice(1)) await page.locator(`input[data-k="${k}"]`).check();
  await synced(page);
  await signOut(page);
});

/* The push service replaced this browser's subscription while the app was closed: the service worker
   hands the new one to the server itself, with the session cookie and the API's CSRF header. A real
   event can't be raised here (no push service), so the worker is sent one; its handler is the real one. */
/* Sends the worker a pushsubscriptionchange from `old` to `next`. `fail` lists what the worker's
   first POSTs to /api/push/subscriptions get instead of the server's answer: 'offline' (the request
   throws) or an HTTP status; window.__subPosts counts them all. */
async function subscriptionChanged(sw, old, next, fail = []) {
  await sw.evaluate(
    ([old, next, fail]) => {
      const real = self.__realFetch || (self.__realFetch = self.fetch);
      self.__subPosts = 0;
      self.fetch = (url, opts) => {
        if (String(url).endsWith('/api/push/subscriptions')) {
          const f = fail[self.__subPosts++];
          if (f === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
          if (f) return Promise.resolve(new Response('{}', { status: f }));
        }
        return real(url, opts);
      };
      const e = new self.ExtendableEvent('pushsubscriptionchange');
      const sub = { endpoint: next, toJSON: () => ({ endpoint: next, keys: { p256dh: 'BNewKey', auth: 'newauth' } }) };
      Object.defineProperties(e, { oldSubscription: { value: { endpoint: old } }, newSubscription: { value: sub } });
      // A made-up event can't be extended (waitUntil throws), but the handler's work still runs.
      try {
        self.dispatchEvent(e);
      } catch {
        /* see above */
      }
    },
    [old, next, fail],
  );
}

test('the service worker passes a replaced subscription to the server', async ({ page, context }) => {
  await fakePush(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await expect.poll(() => subsHere()).toBe(1);
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const NEW = 'https://fcm.googleapis.com/fcm/send/e2e-device-renewed';
  await subscriptionChanged(sw, ENDPOINT, NEW);
  await expect.poll(() => [subsHere(), subsHere(NEW)]).toEqual([0, 1]);
  await signOut(page);
  expect(subsHere(NEW)).toBe(0); // it belongs to this session, so signing out removes it
});

test('the service worker tries a replaced subscription again when the network or the server fails it', async ({ page, context }) => {
  await fakePush(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await expect.poll(() => subsHere()).toBe(1);
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const NEW = 'https://fcm.googleapis.com/fcm/send/e2e-device-retried';
  await subscriptionChanged(sw, ENDPOINT, NEW, ['offline', 503]);
  // Offline, then a 503, then the server takes it (retries after 1 and 4 seconds).
  await expect.poll(() => [subsHere(), subsHere(NEW)], { timeout: 15_000 }).toEqual([0, 1]);
  expect(await sw.evaluate(() => self.__subPosts)).toBe(3);
  await signOut(page);
  expect(subsHere(NEW)).toBe(0);
});

test('signed out (401), the service worker doesn’t try a replaced subscription again', async ({ page, context }) => {
  await fakePush(page);
  await signIn(page, OWNER);
  await expect(page.locator('.side')).toBeVisible();
  await expect.poll(() => subsHere()).toBe(1);
  const sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const NEW = 'https://fcm.googleapis.com/fcm/send/e2e-device-signed-out';
  await subscriptionChanged(sw, ENDPOINT, NEW, [401]);
  await expect.poll(() => sw.evaluate(() => self.__subPosts)).toBe(1);
  // Past the first retry's second: still the one request.
  await page.waitForTimeout(2000);
  expect(await sw.evaluate(() => self.__subPosts)).toBe(1);
  expect(subsHere(NEW)).toBe(0);
  await sw.evaluate(() => (self.fetch = self.__realFetch));
  await signOut(page);
});
