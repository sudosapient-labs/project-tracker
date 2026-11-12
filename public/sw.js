/* Service worker: makes Sudo Sapient installable and able to open without a connection (the app
   shell is cached; data always comes from /api, which is never cached), and shows Web Push
   notifications. Registered as /sw.js?dev during development, where it leaves requests alone so
   Vite's hot reload keeps working. */
const SHELL = 'shell-v1';
const ASSETS = 'assets-v1';
const MAX_ASSETS = 80;
const DEV = new URL(self.location).searchParams.has('dev');

self.addEventListener('install', e => {
  if (!DEV) e.waitUntil(caches.open(SHELL).then(c => c.addAll(['/', '/favicon.svg', '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== ASSETS).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/* Hashed build assets never change, so old ones are only trimmed to bound the cache. */
async function keepAsset(req, res) {
  const c = await caches.open(ASSETS);
  await c.put(req, res);
  const keys = await c.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map(k => c.delete(k)));
}

self.addEventListener('fetch', e => {
  if (DEV) return;
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first so a deploy is picked up at once; the cached shell is the offline fallback.
    // Only the app page itself refreshes it: a tab opened on /sw.js or an icon is a navigation too.
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok && !res.redirected && url.pathname === '/' && /^text\/html\b/i.test(res.headers.get('content-type') || '')) {
            const copy = res.clone();
            e.waitUntil(caches.open(SHELL).then(c => c.put('/', copy)));
          }
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/'))
    e.respondWith(
      caches.match(req).then(
        hit =>
          hit ||
          fetch(req).then(res => {
            if (res.ok) e.waitUntil(keepAsset(req, res.clone()));
            return res;
          }),
      ),
    );
});

self.addEventListener('push', e => {
  let m;
  try {
    m = e.data.json();
  } catch {
    m = { title: 'Sudo Sapient', body: e.data ? e.data.text() : '' };
  }
  e.waitUntil(
    self.registration.showNotification(m.title || 'Sudo Sapient', {
      body: m.body || '',
      tag: m.tag,
      icon: '/icons/icon-192.png',
      // The small monochrome mark Android shows in the status bar (scripts/monochrome-icon.js).
      badge: '/icons/badge-96.png',
      data: { url: m.url || '/' },
    }),
  );
});

/* The push service replaced or expired this browser's subscription (Firefox does this; Chrome
   rarely). Subscribe again if the browser didn't already, and hand the new one to the server the
   way the app does: same origin, so the session cookie goes with it, plus the header the API
   requires on every change. A request the network or the server failed (5xx) is tried again a few
   times while the browser keeps the worker running; any other refusal is final, and signed out
   (401) there's nothing to do: the next sign-in subscribes. If every try fails, the next time the app
   opens signed in it hands the server this browser's subscription anyway (refreshPush in push.js). */
const RETRY_MS = [1000, 4000, 15000];
async function resubscribe(e) {
  const api = async (path, body) => {
    for (let i = 0; ; i++) {
      let res = null;
      try {
        res = await fetch(path, {
          method: body ? 'POST' : 'GET',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sudo-sapient' },
          body: body && JSON.stringify(body),
        });
      } catch {
        /* offline or the connection dropped: try again */
      }
      if (res && (res.ok || res.status < 500)) return res;
      if (i >= RETRY_MS.length) return res;
      await new Promise(r => setTimeout(r, RETRY_MS[i]));
    }
  };
  let sub = e.newSubscription;
  if (!sub) {
    const res = await api('/api/push/key');
    if (!res?.ok) return;
    const { publicKey } = await res.json();
    const s = atob((publicKey + '='.repeat((4 - (publicKey.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(s, c => c.charCodeAt(0)) });
  }
  if (e.oldSubscription && e.oldSubscription.endpoint !== sub.endpoint) {
    const res = await api('/api/push/unsubscribe', { endpoint: e.oldSubscription.endpoint });
    if (res?.status === 401) return;
  }
  await api('/api/push/subscriptions', sub.toJSON());
}
self.addEventListener('pushsubscriptionchange', e => e.waitUntil(resubscribe(e).catch(() => {})));

/* Clicking a notification focuses an open tab and takes it to the task, or opens a new one. */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const tab = list.find(c => new URL(c.url).origin === self.location.origin);
      if (tab) {
        tab.postMessage({ type: 'open', url });
        return tab.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
