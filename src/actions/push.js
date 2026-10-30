/* =====================================================================
   ACTIONS · PWA & PUSH: service worker registration and Web Push
   subscriptions for this browser (Settings → Notifications → Push).
   ===================================================================== */
import { D } from '../core/store.js';
import { get, post } from '../core/api.js';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // In development the worker skips caching so Vite's hot reload keeps working.
  navigator.serviceWorker.register(import.meta.env.DEV ? '/sw.js?dev' : '/sw.js').catch(() => {});
}

const bytes = b64 => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

/* Subscribe this browser and tell the server. `prompt` asks for permission if it hasn't been
   decided; otherwise this only refreshes an existing grant. Resolves with the permission state. */
export async function enablePush({ prompt = false } = {}) {
  if (!supported()) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default' && prompt) perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await get('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(publicKey) });
    }
    await post('/api/push/subscriptions', sub.toJSON());
    return 'granted';
  } catch {
    return 'failed';
  }
}

/* After signing in: keep this browser's subscription current if push is allowed and wanted. */
export function refreshPush() {
  const np = D().notifPrefs || {};
  if (supported() && Notification.permission === 'granted' && ['push_mention', 'push_assign', 'push_comment', 'push_due'].some(k => np[k] !== false))
    enablePush();
}

/* Before signing out: this browser should stop receiving the account's notifications. */
export async function disablePushHere() {
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
