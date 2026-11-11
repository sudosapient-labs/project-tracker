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
import { PUSH_KEYS, wantsPush as wants } from '../core/push-prefs.js';
import { toast } from '../ui/toast.js';

export { PUSH_KEYS };
const NUDGE_KEY = 'ss-push-nudge-dismissed';
/* How long to wait for the service worker to be ready before saying push isn't on (a worker that
   failed to install never becomes ready, and `navigator.serviceWorker.ready` never settles then). */
const READY_MS = 10_000;

/* The service worker's registration: a promise of it, or of null when registering failed. */
let worker = null;
/* The browser refused to run a service worker here at all (SecurityError: some privacy settings and
   private windows do this), so push can't work until that changes. */
let workerBlocked = false;

/* Why push can't work here, or 'ok'. Browsers only offer push on secure origins (HTTPS or
   localhost), and Safari on iPhone and iPad only to an app opened from the Home Screen. */
export function pushSupport() {
  if (!window.isSecureContext) return 'insecure';
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) return workerBlocked ? 'noworker' : 'ok';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : 'unsupported';
}
const supported = () => pushSupport() === 'ok';

/* This browser: `subscribed` is true once the server accepted its subscription in this page load,
   false when it has none (or the server didn't take it, or the worker never got ready), null until
   that's known; every check ends within READY_MS plus the requests, so it never stays null. */
export const pushHere = { subscribed: null, busy: false };
export const pushPermission = () => (supported() ? Notification.permission : 'unsupported');
export const wantsPush = (np = D().notifPrefs || {}) => wants(np);

let rerender = () => {};
/* The shell passes its render here (push.js stays free of shell imports). */
export function onPushChange(fn) {
  rerender = fn;
}

/* Register the service worker (again, if the last attempt failed). */
function register() {
  // In development the worker skips caching so Vite's hot reload keeps working.
  worker = navigator.serviceWorker.register(import.meta.env.DEV ? '/sw.js?dev' : '/sw.js').catch(err => {
    if (err?.name === 'SecurityError') workerBlocked = true;
    return null;
  });
  return worker;
}

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (!worker) register();
  // Allowing or blocking notifications in the browser's site settings updates Settings → Push.
  navigator.permissions
    ?.query({ name: 'notifications' })
    .then(st => st.addEventListener('change', () => !S.ui.auth && refreshPush()))
    .catch(() => {});
}

/* The active worker's registration, or null if it can't be had: registering failed (each call tries
   again), or it isn't ready within READY_MS. */
async function readyWorker() {
  if (!worker) register();
  let reg = await worker;
  if (!reg && !workerBlocked) reg = await register();
  if (!reg) return null;
  let timer;
  const late = new Promise(resolve => (timer = setTimeout(() => resolve(null), READY_MS)));
  try {
    return await Promise.race([navigator.serviceWorker.ready, late]);
  } finally {
    clearTimeout(timer);
  }
}

const bytes = b64 => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};
/* Whether a subscription was made with this server key. A browser that doesn't say (no
   `options.applicationServerKey`) is taken at its word. */
function madeWith(sub, key) {
  const was = sub.options?.applicationServerKey;
  if (!was) return true;
  const a = new Uint8Array(was);
  return a.length === key.length && a.every((b, i) => b === key[i]);
}

/* Subscribe this browser and tell the server. `prompt` asks for permission if it hasn't been
   decided, so it must run from a tap (browsers refuse the prompt otherwise); without it this only
   uses an existing grant. Resolves with 'granted', 'default', 'denied', 'unsupported' or 'failed'
   (after which `pushHere.subscribed` is false); it always settles. */
export async function enablePush({ prompt = false } = {}) {
  if (!supported()) {
    pushHere.subscribed = false;
    return 'unsupported';
  }
  try {
    let perm = Notification.permission;
    if (perm === 'default' && prompt) perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      pushHere.subscribed = false;
      return perm;
    }
    const reg = await readyWorker();
    if (!reg) {
      pushHere.subscribed = false;
      return supported() ? 'failed' : 'unsupported';
    }
    const key = bytes((await get('/api/push/key')).publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Made with a server key that has since changed: the push service would refuse what the server
    // signs now, so replace it rather than handing the server a dead one.
    if (sub && !madeWith(sub, key)) {
      const old = sub.endpoint;
      await sub.unsubscribe();
      sub = null;
      await post('/api/push/unsubscribe', { endpoint: old }).catch(() => {});
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
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
  if (supported() && Notification.permission === 'granted' && wantsPush()) await enablePush();
  else pushHere.subscribed = false;
  rerender();
}

/* "Turn on push on this device": asks for permission from the tap and subscribes. */
export async function turnOnPushHere() {
  if (pushHere.busy) return null; // a second tap while the first is still working
  pushHere.busy = true;
  rerender();
  let state = 'failed';
  try {
    state = await enablePush({ prompt: true });
  } finally {
    pushHere.busy = false;
  }
  if (state === 'granted') toast('Push is on for this device.');
  else explainPush(state);
  rerender();
  return state;
}

/* What to tell someone when this browser couldn't be subscribed ('unsupported' needs no toast:
   Settings → Push says why in its place). */
export function explainPush(state) {
  if (state === 'denied') toast('Notifications are blocked for this site. Allow them in your browser settings.', { kind: 'err', ms: 6000 });
  else if (state === 'failed') toast("Couldn't turn on push notifications in this browser. Try again in a moment.", { kind: 'err' });
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
