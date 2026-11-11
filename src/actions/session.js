/* =====================================================================
   ACTIONS · SESSION: boot, sign up, verify, sign in (+2FA), sign out,
   password reset, onboarding hand-off, and reloading the workspace.
   ===================================================================== */
import { $, esc } from '../core/utils.js';
import { setTimeZone } from '../core/utils.js';
import { tzCity, validTz } from '../core/constants.js';
import { browserTz, zoneOf } from '../core/clock.js';
import { D, DEFAULT_PREFS, PREFS_KEY, S, allTasks, canSee, emptyData, me, proj } from '../core/store.js';
import { ApiError, get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { go, hashFor, layers, pageEntry, render, routeFromHash } from '../shell/render.js';
import { keepAll } from './drafts.js';
import { parseHash } from '../core/links.js';
import {
  OFFLINE_MSG,
  changeCount,
  collect,
  commit,
  connectLive,
  dropKept,
  flush,
  keepNow,
  loadingFresh,
  onSync,
  pendingCount,
  prime,
  refresh,
  reloadWhenSaved,
  reloaded,
  sameUser,
  saveState,
  settled,
  stopSync,
  takeKept,
} from '../shell/sync.js';
import { A, EMAIL_RE, confirmDlg } from './actions.js';
import { disablePushHere, onPushChange, refreshPush } from './push.js';

const AUTH_SCREENS = ['login', 'signup', 'forgot'];
const changes = n => (n === 1 ? '1 change' : `${n} changes`);

/* ---------- loading the workspace ---------- */
/* `kept`: edits to send that this person left unsaved here earlier (see prime). */
function hydrate(b, kept) {
  S.data = b.data;
  S.prefs = { ...DEFAULT_PREFS, ...b.prefs, tz: validTz(b.prefs?.tz) };
  S.views = b.views || {};
  S.ui.collapsed = !!b.collapsed;
  prime(S.data, kept);
  if (!S.prefs.tz) adoptBrowserZone();
  setTimeZone(zoneOf(S.prefs, S.data.ws));
}
/* No time zone saved for this person yet: save their browser's, so reminders, digests and anything
   else the server writes for them is on the clock they see here (the server never guesses one from
   the browser). Only when none is saved: a zone they chose is never replaced. */
function adoptBrowserZone() {
  const tz = browserTz();
  if (!tz) return;
  S.prefs.tz = tz;
  saveState();
  toast(`Time zone set to ${tzCity(tz)} from your browser. Change it in Settings → Date and time.`, { kind: 'info', ms: 8000 });
}

let reloading = null;
let again = false;
/* Re-read everything from the server (after reconnecting, or when access changed). */
export function reload() {
  // Asked again while one is loading: its data may be from before what this one is for (a change
  // missed while the live stream was down), so another follows it.
  if (reloading) {
    again = true;
    return reloading;
  }
  reloading = (async () => {
    try {
      // A tab waking up (back from the back/forward cache, the stream reconnecting) may find
      // someone else signed in on this browser: then it sends nothing and signs out.
      if (!(await sameUser())) return void reloadWhenSaved();
      // Send what's queued first, even if the last attempt left us offline (the live stream that
      // asked for this reload just reconnected). If it still can't be saved, keep it and reload
      // once it is: a bootstrap mustn't replace local changes the server hasn't seen. Refused
      // changes are reported as usual (not taken from a commit() someone else is waiting on).
      await settled({ retry: true });
      if (pendingCount()) return reloadWhenSaved();
      // Edits keep flowing while the bootstrap loads: what the server confirms meanwhile, and what
      // is still waiting out the save delay when it arrives, are laid over it (see prime).
      loadingFresh();
      const b = await get('/api/bootstrap');
      collect(false);
      hydrate(b);
      if (pendingCount()) flush();
      if (S.ui.drawer && !allTasks().some(t => t.id === S.ui.drawer)) S.ui.drawer = null;
      if (S.ui.route === 'project' && !proj(S.ui.params.id)) {
        S.ui.route = 'projects';
        S.ui.params = {};
      }
      // Not under someone's caret: shown once they leave the field they're typing in.
      refresh();
      reloaded(true);
    } catch (e) {
      if (e.status === 401 || e.status === 403) sessionEnded();
      // Any other failure (a deploy's 502, the network) is tried again until a reload loads.
      else reloaded(false);
    } finally {
      loadingFresh(false);
      reloading = null;
      if (again) {
        again = false;
        reload();
      }
    }
  })();
  return reloading;
}

async function enter(hash, msg) {
  const b = await get('/api/bootstrap');
  // Edits left unsaved in this browser (the page went, or the session ended, while they waited):
  // this person's are sent on top of the fresh data; anyone else's are dropped, never sent as them.
  // Taken only once the data has loaded, so a failed load leaves them kept for next time.
  const kept = await takeKept(S.ui.me.id);
  hydrate(b, kept.mine);
  connectLive();
  const sending = changeCount();
  if (sending) flush();
  S.ui.errors = {};
  const told = () => {
    if (sending) toast(`Saving ${changes(sending)} you made here earlier that hadn't reached the server yet.`, { kind: 'info', ms: 6000 });
    const n = kept.others;
    if (n)
      toast(`${changes(n)} someone else made in this browser ${n === 1 ? "wasn't saved, and was" : "weren't saved, and were"} discarded.`, {
        kind: 'info',
        ms: 8000,
      });
  };
  if (!b.workspace.onboarded && me()?.role === 'Owner') {
    S.ui.auth = 'onboarding';
    S.ui.onb = 0;
    S.ui.onbData.ws = '';
    render();
    told();
    return;
  }
  S.ui.auth = null;
  openRoute(linked ?? (hash || S.ui.returnTo || ''));
  linked = null;
  S.ui.returnTo = null;
  refreshPush();
  if (msg) toast(msg);
  told();
}

/* Route from the URL hash: a page (see hashFor in shell/render.js), the task open over it, or a
   deep link written by A.copyLink (#task/KEY, #file/id); see core/links.js. At the start the page is
   the one the hash names, else Home. `here`: a link that came while the app was open (openLink),
   which closes what's open (the task too), goes to the page it names, else stays on this one. */
function openRoute(h = '', { here = false } = {}) {
  const { page, task: key, file: fid } = parseHash(h);
  const r = page ? routeFromHash(page) : null;
  const base = location.pathname + location.search + '#';
  // Give the entry a state (a link's has none), so nothing below takes it for a link. A reloaded
  // layer's entry (actions/back.js) stays one: the task opens on it again. A link that stays on the
  // page shown makes its entry a layer over that page, so Back closes what it opens and stays here.
  const same = !r || hashFor(r.route, r.params) === hashFor(S.ui.route, S.ui.params);
  const state = history.state || (here ? layers.linkEntry(same) : pageEntry());
  const mark = () => history.replaceState(state, '', base + hashFor(S.ui.route, S.ui.params));
  if (here) {
    mark();
    // What the link names is what's shown: a link to a page closes the task open over this one.
    // What was typed in a window or the composer it closes is kept (drafts.js).
    keepAll();
    Object.assign(S.ui, {
      pop: null,
      palette: null,
      modals: [],
      mention: null,
      editCell: null,
      composer: null,
      subOpen: null,
      mnav: false,
      drawer: null,
      drawerFull: false,
    });
    if (r) go(r.route, r.params, { fromUrl: true });
  } else {
    S.ui.route = r?.route || S.prefs.home || 'home';
    S.ui.params = r?.params || {};
    S.ui.history = [];
  }
  mark();
  const t = key && allTasks().find(x => x.key.toUpperCase() === key.toUpperCase());
  const f = fid && D().files.find(x => x.id === fid && canSee(proj(x.project)));
  // The task opens in the first render, so a touch screen's Back entry for it is made only once.
  if (t) A.openTask({ dataset: { id: t.id } });
  else render();
  if (key && !t) toast(`${key.slice(0, 40)} can't be opened: it was deleted or archived, or you don't have access to it.`, { kind: 'err', ms: 7000 });
  if (f) A.previewFile({ dataset: { id: f.id } });
  else if (fid) toast("That file can't be opened: it was deleted, or you don't have access to it.", { kind: 'err', ms: 7000 });
}

/* A link that came while this tab was open: a notification or URL Android hands the app (it only
   changes the hash), a hash typed or pasted. Signed in, it opens here at once; while the app is
   still loading, signing in or being set up, it opens when that's done. */
let linked = null;
function openLink(h) {
  if (S.ui.auth) linked = h;
  else openRoute(h, { here: true });
}

/* Who this browser's session belongs to, for the app's other tabs (see stillMe). */
const WHO_KEY = 'sudo-sapient.who';
const who = () => {
  try {
    return localStorage.getItem(WHO_KEY);
  } catch {
    return null;
  }
};
/* Whether this tab's person is still the one this browser is signed in as (as far as the other tabs
   have said: a sign-in in one of them replaces the session cookie all of them send). */
const stillMe = () => !S.ui.me || !who() || who() === S.ui.me.id;
/* Someone else signed in on this browser: their session mustn't send this person's changes, so the
   tab signs out at once, sending nothing. */
function otherUser() {
  const lost = changeCount();
  const were = lost === 1 ? 'was' : 'were';
  signedOut(
    `Someone else signed in on this browser, so you were signed out here.${lost ? ` ${changes(lost)} that hadn't been saved yet ${were} not sent.` : ''}`,
    {
      keepWho: true,
    },
  );
}
addEventListener('storage', e => {
  if (e.key === WHO_KEY && e.newValue && S.ui.me && e.newValue !== S.ui.me.id) otherUser();
});

/* Decide what to show for a session state from /api/auth/session. */
async function route(s, hash = '', msg) {
  S.ui.me = s.user;
  if (s.user)
    try {
      localStorage.setItem(WHO_KEY, s.user.id);
    } catch {
      /* storage blocked: the tabs still check with the server when they wake */
    }
  S.ui.wsName = s.workspace?.name || '';
  if (!s.user) {
    // Remember a deep link opened while signed out, and go there after signing in.
    if (hash && !AUTH_SCREENS.includes(hash)) S.ui.returnTo = hash;
    S.ui.auth = AUTH_SCREENS.includes(hash) ? hash : s.workspace ? 'login' : 'signup';
    render();
    return;
  }
  if (s.user.twoFactorPending) return show('tfa');
  if (!s.user.verified) {
    S.ui.af.email = s.user.email;
    S.ui.af.name = s.user.name;
    return show('verify');
  }
  await enter(hash, msg);
}

function show(screen) {
  S.ui.auth = screen;
  S.ui.errors = {};
  render();
  setTimeout(() => $('.auth input')?.focus(), 20);
}
const clearHash = () => history.replaceState(null, '', location.pathname + location.search);

export async function boot() {
  const flash = takeFlash();
  S.ui.af = { email: '', name: '' };
  S.ui.auth = 'boot';
  render();
  const hash = (location.hash || '').slice(1);
  const [kind, token] = hash.split('/');
  try {
    let s = await get('/api/auth/session');
    if (kind === 'verify' && token) {
      clearHash();
      try {
        s = await post('/api/auth/verify', { token });
        toast(s.user ? 'Email verified' : 'Email verified. Sign in to continue.');
      } catch (e) {
        toast(e.message, { kind: 'err', ms: 7000 });
      }
    } else if (kind === 'reset' && token) {
      clearHash();
      S.ui.resetToken = token;
      try {
        S.ui.af.email = (await get(`/api/auth/reset/${encodeURIComponent(token)}`)).email;
        return show('reset');
      } catch (e) {
        show('forgot');
        S.ui.errors.email = e.message;
        return render();
      }
    } else if (kind === 'setup' && token) {
      // The setup link printed by a fresh production server: create the owner account with it.
      clearHash();
      if (!s.workspace) {
        S.ui.setupToken = token;
        return route(s, 'signup');
      }
    } else if (kind === 'email' && token) {
      clearHash();
      try {
        s = await post('/api/auth/email/confirm', { token });
        S.ui.emailSent = null;
        toast(s.user ? `You now sign in with ${s.user.email}` : 'Email changed. Sign in with your new address.');
      } catch (e) {
        toast(e.message, { kind: 'err', ms: 7000 });
      }
    } else if (kind === 'join' && token) {
      clearHash();
      if (!s.user) {
        try {
          const j = await get(`/api/auth/join/${encodeURIComponent(token)}`);
          S.ui.joinToken = token;
          S.ui.invite = { workspace: j.workspace, email: '' };
          return show('signup');
        } catch (e) {
          toast(e.message, { kind: 'err', ms: 7000 });
        }
      } else toast("You're already a member of this workspace.", { kind: 'info' });
    } else if (kind === 'invite' && token) {
      clearHash();
      if (!s.user) {
        try {
          const inv = await get(`/api/auth/invite/${encodeURIComponent(token)}`);
          S.ui.inviteToken = token;
          S.ui.invite = inv;
          S.ui.af = { email: inv.email, name: inv.name };
          return show('signup');
        } catch (e) {
          toast(e.message, { kind: 'err', ms: 7000 });
        }
      }
    }
    await route(s, ['verify', 'reset', 'invite', 'join', 'setup', 'email'].includes(kind) ? '' : hash);
    if (flash) toast(flash, { kind: 'info', ms: 6000 });
  } catch (e) {
    S.ui.auth = 'boot-error';
    S.ui.bootError = e.message;
    render();
  }
}
A.retryBoot = () => boot();

/* ---------- busy buttons ---------- */
async function busy(id, fn) {
  const b = document.getElementById(id);
  b?.classList.add('is-loading');
  b?.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    const n = document.getElementById(id);
    n?.classList.remove('is-loading');
    n?.removeAttribute('aria-busy');
  }
}
/* Show an API error on the form: next to its field when the server names one, else as an alert. */
function formError(e, fieldMap, fallbackKey) {
  if (!(e instanceof ApiError)) throw e;
  const k = (e.field && fieldMap[e.field]) || fallbackKey;
  S.ui.errors = { [k]: e.message };
  render();
}

/* ---------- sign in ---------- */
A.doLogin = async () => {
  const e = (S.ui.errors = {});
  const em = $('#l-email').value.trim(),
    pw = $('#l-pw').value,
    remember = $('#l-rem')?.checked !== false;
  S.ui.af.email = em;
  if (!em) e.email = 'Enter your email address';
  else if (!EMAIL_RE.test(em)) e.email = 'Enter a valid email, like name@company.com';
  if (!pw) e.pw = 'Enter your password';
  if (Object.keys(e).length) {
    render();
    (e.email ? $('#l-email') : $('#l-pw'))?.focus();
    if (!e.email) $('#l-pw').value = pw;
    return;
  }
  try {
    const s = await busy('login-btn', () => post('/api/auth/login', { email: em, password: pw, remember }));
    if (s.twoFactor) return show('tfa');
    await route(s, '', `Signed in as ${s.user.email}`);
  } catch (err) {
    formError(err, { email: 'email' }, 'login');
    $('#l-pw')?.focus();
  }
};

A.doTfa = async () => {
  const code = ($('#t-code')?.value || '').trim();
  if (!code) {
    S.ui.errors = { code: 'Enter the code from your authenticator app' };
    render();
    return $('#t-code')?.focus();
  }
  try {
    const s = await busy('tfa-btn', () => post('/api/auth/2fa/verify', { code }));
    await route(s, '', `Signed in as ${s.user.email}`);
  } catch (err) {
    // Too many wrong codes end the sign-in; start again from the password.
    if (err.code === 'unauthenticated') {
      show('login');
      S.ui.errors = { login: err.message };
      return render();
    }
    formError(err, {}, 'code');
    $('#t-code')?.focus();
  }
};

A.socialAuth = el => toast(`Sign-in with ${el.dataset.v} isn't set up for this workspace yet. Use your email and password.`, { kind: 'info', ms: 6000 });

/* ---------- sign up and verification ---------- */
A.doSignup = async () => {
  const e = (S.ui.errors = {});
  const nm = $('#s-name').value.trim(),
    em = $('#s-email').value.trim(),
    pw = $('#s-pw').value;
  S.ui.af.name = nm;
  S.ui.af.email = em;
  if (!nm) e.name = 'Enter your name';
  if (!EMAIL_RE.test(em)) e.email = 'Enter a valid work email';
  if (pw.length < 10 || !/[0-9\W]/.test(pw)) e.pw = 'Use at least 10 characters, including a number or symbol';
  if (Object.keys(e).length) {
    render();
    $('#s-email').value = em;
    return;
  }
  try {
    const r = await busy('signup-btn', () =>
      post('/api/auth/signup', {
        name: nm,
        email: em,
        password: pw,
        ...(S.ui.inviteToken ? { invite: S.ui.inviteToken } : {}),
        ...(S.ui.joinToken ? { join: S.ui.joinToken } : {}),
        ...(S.ui.setupToken ? { setup: S.ui.setupToken } : {}),
      }),
    );
    S.ui.inviteToken = S.ui.joinToken = S.ui.setupToken = S.ui.invite = null;
    S.ui.pwNew = '';
    S.ui.devLink = r.devLink || null;
    if (r.user.verified) return route(r, '', `Welcome, ${r.user.name.split(' ')[0]}`);
    startResend();
    show('verify');
  } catch (err) {
    formError(err, { email: 'email', name: 'name', password: 'pw' }, 'email');
    if ($('#s-email')) $('#s-email').value = em;
  }
};

export function startResend() {
  S.ui.resendT = 30;
  clearInterval(startResend._i);
  startResend._i = setInterval(() => {
    S.ui.resendT--;
    const el = $('#resend-t');
    if (el) el.textContent = S.ui.resendT;
    if (S.ui.resendT <= 0) {
      clearInterval(startResend._i);
      if (S.ui.auth === 'verify') render();
    }
  }, 1000);
}

A.resend = async el => {
  try {
    if (el.dataset.v === 'verify') {
      const r = await post('/api/auth/verify/resend');
      S.ui.devLink = r.devLink || S.ui.devLink;
      startResend();
      render();
      toast(`Verification email sent to ${S.ui.af.email}`);
    } else {
      const r = await post('/api/auth/forgot', { email: S.ui.af.email });
      S.ui.devLink = r.devLink || null;
      render();
      toast(`Reset link sent to ${S.ui.af.email}`);
    }
  } catch (err) {
    toast(err.message, { kind: 'err' });
  }
};

A.verified = async () => {
  try {
    const s = await busy('verified-btn', () => get('/api/auth/session'));
    if (s.user?.verified) return route(s, '', 'Email verified');
    if (!s.user) return show('login');
    toast("We haven't seen the verification yet. Open the link in the email we sent you.", { kind: 'info', ms: 6000 });
  } catch (err) {
    toast(err.message, { kind: 'err' });
  }
};

/* "Wrong email? Change it": the unverified account is signed out so a new one can be created. */
A.changeEmail = async () => {
  await post('/api/auth/logout').catch(() => {});
  S.ui.devLink = null;
  show('signup');
};

/* ---------- password reset ---------- */
A.doForgot = async () => {
  const em = $('#f-email').value.trim();
  S.ui.af.email = em;
  S.ui.errors = {};
  if (!EMAIL_RE.test(em)) {
    S.ui.errors.email = 'Enter the email you use to sign in';
    render();
    return;
  }
  try {
    const r = await busy('forgot-btn', () => post('/api/auth/forgot', { email: em }));
    S.ui.devLink = r.devLink || null;
    show('forgot-sent');
  } catch (err) {
    formError(err, {}, 'email');
  }
};

A.openDevLink = () => {
  const url = S.ui.devLink;
  if (!url) return;
  S.ui.devLink = null;
  // The hashchange listener below boots with the token.
  location.hash = url.split('#')[1];
};

A.doReset = async () => {
  const a = $('#r-pw').value,
    b = $('#r-pw2').value;
  const e = (S.ui.errors = {});
  if (a.length < 10 || !/[0-9\W]/.test(a)) e.pw = 'Use at least 10 characters, including a number or symbol';
  if (a !== b) e.pw2 = "Passwords don't match";
  if (Object.keys(e).length) {
    render();
    return;
  }
  try {
    await busy('reset-btn', () => post('/api/auth/reset', { token: S.ui.resetToken, password: a }));
    S.ui.resetToken = null;
    S.ui.pwNew = '';
    show('reset-done');
  } catch (err) {
    formError(err, { password: 'pw' }, 'pw');
  }
};

/* ---------- sign out ---------- */
/* A message for the next page load to show (signing out reloads the page). */
const FLASH_KEY = 'sudo-sapient.flash';
/* Display preferences the browser may keep for whoever signs in next (so the theme applies before
   the first request); everything else in them is the person's. */
const DEVICE_PREFS = ['theme', 'accent', 'side', 'density', 'motion'];

/* Signed out (or the session ended): nothing of this person may stay in the tab for whoever uses it
   next. Personal preferences leave the browser and the page reloads, so no state survives: a new
   API key or bot key, recovery codes, two-factor setup, drafts, half-filled forms, searches. */
let leaving = false;
/* `keepEdits`: edits still waiting stay kept in the browser (the session only ended; see sessionEnded).
   Otherwise they go: signed out on purpose (after being asked), or someone else signed in. */
export async function signedOut(msg, { keepWho = false, keepEdits = false } = {}) {
  // Once: the live stream closing can report the same sign-out again before the reload.
  if (leaving) return;
  leaving = true;
  const mine = S.ui.me && who() === S.ui.me.id;
  stopSync();
  if (!keepEdits) await dropKept();
  S.data = emptyData();
  S.views = {};
  Object.assign(S.ui, { pop: null, palette: null, drawer: null, modals: [], route: 'home', params: {}, history: [], errors: {}, me: null, offline: false });
  S.ui.sel.clear();
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') || {};
    localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(DEVICE_PREFS.filter(k => k in p).map(k => [k, p[k]]))));
    if (msg) sessionStorage.setItem(FLASH_KEY, msg);
    else sessionStorage.removeItem(FLASH_KEY);
    if (mine && !keepWho) localStorage.removeItem(WHO_KEY);
  } catch {
    /* storage blocked: nothing was kept there either */
  }
  clearHash();
  location.reload();
}
/* The message signedOut left for this page load, once. */
function takeFlash() {
  try {
    const m = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
    return m;
  } catch {
    return null;
  }
}
/* Signing out first saves what's queued. If some of it can't be saved (offline, or refused), it
   asks before dropping it; and it only signs out here once the server has ended the session, so
   the reloaded tab isn't still signed in behind the sign-in screen. */
A.signOut = async () => {
  S.ui.pop = null;
  render();
  const errs = await commit();
  const refused = errs.filter(e => e !== OFFLINE_MSG);
  const waiting = pendingCount();
  if (waiting || refused.length) {
    const why = waiting
      ? `${S.ui.offline ? "You're offline, and some" : 'Some'} of your changes haven't reached the server yet. If you sign out now, they're lost.`
      : `Some of your changes couldn't be saved: ${refused[0]}`;
    return confirmDlg({ title: 'Sign out without saving?', body: esc(why), ok: 'Sign out anyway', danger: true, icon: 'log-out', run: leave });
  }
  await leave();
};
async function leave() {
  await disablePushHere();
  try {
    await post('/api/auth/logout');
  } catch (e) {
    // Already signed out (401) is fine; otherwise stay, with everything still queued.
    if (e.status !== 401) {
      refreshPush();
      toast(e.offline ? "You're offline, so you can't sign out yet. Try again once you're connected." : `Couldn't sign out. ${e.message}`, {
        kind: 'err',
        ms: 7000,
      });
      return;
    }
  }
  signedOut();
}

/* The session ended (expired, revoked, signed out in another tab). Edits still waiting aren't
   dropped: they're kept in this browser and sent when this person signs in again (see enter), and
   the sign-in screen says how many. The page reloads only once they're safely kept; if they can't
   be (storage blocked), it doesn't reload unasked over them. */
let ending = false;
async function sessionEnded() {
  if (ending || leaving) return;
  // Someone else has signed in on this browser since: these edits are never theirs to send.
  if (!stillMe()) return otherUser();
  ending = true;
  const n = changeCount();
  const msg = 'Your session ended. Sign in again to continue.';
  if (!n) return signedOut(msg);
  if (await keepNow()) return signedOut(`${msg} ${changes(n)} waiting to be saved will be sent when you do.`, { keepEdits: true });
  confirmDlg({
    title: 'Your session ended',
    body: esc(
      `${changes(n)} haven't been saved, and this browser can't keep them until you sign in again. Copy anything you need first: signing in again loses them.`,
    ),
    ok: 'Sign in again',
    icon: 'log-out',
    run: () => signedOut(msg),
  });
}

onSync({ signedOut: sessionEnded, otherUser, stillMe, resync: reload });
onPushChange(render);

/* ---------- onboarding ---------- */
async function finishSetup() {
  const errs = await commit();
  if (errs.length) toast(errs[0], { kind: 'err' });
  await post('/api/workspace/onboarded').catch(err => toast(err.message, { kind: 'err' }));
  // Sign-in skipped this while setup was showing.
  refreshPush();
}
const onbFinish = A.onbFinish;
A.onbFinish = async () => {
  onbFinish();
  await finishSetup();
};
A.onbExit = async () => {
  await finishSetup();
  S.ui.auth = null;
  openRoute(linked ?? '');
  linked = null;
};

/* A link opened in a tab that already has the app open only changes the hash. An emailed link
   (#reset/…) boots with its token; any other opens in place. Back and forward between the app's
   own entries also change it: those have a state, and the popstate handler routed them. */
addEventListener('hashchange', () => {
  if (/^#(verify|reset|invite|join|setup|email)\//.test(location.hash)) boot();
  else if (!history.state) openLink(location.hash.slice(1));
});

/* A push notification was clicked while the app was open: go to what it's about, as a link does
   (a history entry of its own, so Back returns to where you were). */
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type !== 'open') return;
  const h = (e.data.url || '').split('#')[1] || '';
  if (h && '#' + h !== location.hash) location.hash = h;
});
