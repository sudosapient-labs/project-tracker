/* =====================================================================
   ACTIONS · PWA & PUSH: service worker registration and Web Push
   subscriptions for this browser (Settings → Notifications → Push).

   The Push preferences belong to the account (which kinds of notification
   are pushed); whether *this* browser receives them is its own state: the
   browser's permission and a subscription the server has accepted from
   this session. `pushHere` holds the latter so Settings never says push is
   on for a device that isn't subscribed.
   ===================================================================== */
import { D, S } from '../core/store.js';
import { get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';

export const PUSH_KEYS = ['push_mention', 'push_assign', 'push_comment', 'push_due'];
const NUDGE_KEY = 'ss-push-nudge-dismissed';

/* Why push can't work here, or 'ok'. Browsers only offer push on secure origins (HTTPS or
   localhost), and Safari on iPhone and iPad only to an app opened from the Home Screen. */
export function pushSupport() {
  if (!window.isSecureContext) return 'insecure';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return 'ok';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : 'unsupported';
}
const supported = () => pushSupport() === 'ok';

/* This browser: `subscribed` is true once the server accepted its subscription in this page load,
   false when it has none (or the server didn't take it), null until that's known. */
export const pushHere = { subscribed: null, busy: false };
export const pushPermission = () => (supported() ? Notification.permission : 'unsupported');
export const wantsPush = (np = D().notifPrefs || {}) => PUSH_KEYS.some(k => np[k] !== false);

let rerender = () => {};
/* The shell passes its render here (push.js stays free of shell imports). */
export function onPushChange(fn) {
  rerender = fn;
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // In development the worker skips caching so Vite's hot reload keeps working.
  navigator.serviceWorker.register(import.meta.env.DEV ? '/sw.js?dev' : '/sw.js').catch(() => {});
  // Allowing or blocking notifications in the browser's site settings updates Settings → Push.
  navigator.permissions
    ?.query({ name: 'notifications' })
    .then(st => st.addEventListener('change', () => !S.ui.auth && refreshPush()))
    .catch(() => {});
}

const bytes = b64 => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

/* Subscribe this browser and tell the server. `prompt` asks for permission if it hasn't been
   decided, so it must run from a tap (browsers refuse the prompt otherwise); without it this only
   uses an existing grant. Resolves with 'granted', 'default', 'denied', 'unsupported' or 'failed'. */
export async function enablePush({ prompt = false } = {}) {
  if (!supported()) return 'unsupported';
  let perm = Notification.permission;
  if (perm === 'default' && prompt) perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    pushHere.subscribed = false;
    return perm;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await get('/api/push/key');
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(publicKey) });
    }
    // Idempotent: the server keeps one row per endpoint, owned by this session.
    await post('/api/push/subscriptions', sub.toJSON());
    pushHere.subscribed = true;
    return 'granted';
  } catch {
    pushHere.subscribed = false;
    return 'failed';
  }
}

/* After signing in or finishing setup: if notifications are already allowed and the account wants
   push, subscribe this browser silently (no prompt is needed then). This is how a new sign-in, a
   cleared site or a subscription the server dropped gets push back. */
export async function refreshPush() {
  if (!supported()) pushHere.subscribed = false;
  else if (Notification.permission === 'granted' && wantsPush()) await enablePush();
  else pushHere.subscribed = false;
  rerender();
}

/* "Turn on push on this device": asks for permission from the tap and subscribes. */
export async function turnOnPushHere() {
  pushHere.busy = true;
  rerender();
  const state = await enablePush({ prompt: true });
  pushHere.busy = false;
  if (state === 'granted') toast('Push is on for this device.');
  else explainPush(state);
  rerender();
  return state;
}

/* What to tell someone when this browser couldn't be subscribed. */
export function explainPush(state) {
  if (state === 'denied') toast('Notifications are blocked for this site. Allow them in your browser settings.', { kind: 'err', ms: 6000 });
  else if (state === 'failed') toast("Couldn't turn on push notifications in this browser.", { kind: 'err' });
}

/* The Inbox offers push once per browser when the account wants it but this browser isn't
   subscribed (and wasn't blocked: Settings → Push explains that). Dismissing it is remembered here
   only, since it's about this device. */
export function showPushNudge() {
  if (!supported() || Notification.permission === 'denied' || !wantsPush() || pushHere.subscribed !== false) return false;
  try {
    return !localStorage.getItem(NUDGE_KEY);
  } catch {
    return false; // storage blocked: it couldn't stay dismissed
  }
}
export function dismissPushNudge() {
  try {
    localStorage.setItem(NUDGE_KEY, '1');
  } catch {
    /* storage blocked: hidden for this page load only */
  }
  rerender();
}

/* Before signing out: this browser should stop receiving the account's notifications. */
export async function disablePushHere() {
  pushHere.subscribed = false;
  if (!supported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
