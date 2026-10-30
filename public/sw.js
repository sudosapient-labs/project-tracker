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
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
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
      data: { url: m.url || '/' },
    }),
  );
});

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
