/* =====================================================================
   ACTIONS · SESSION: boot, sign up, verify, sign in (+2FA), sign out,
   password reset, onboarding hand-off, and reloading the workspace.
   ===================================================================== */
import { $ } from '../core/utils.js';
import { setTimeZone } from '../core/utils.js';
import { validTz } from '../core/constants.js';
import { D, DEFAULT_PREFS, S, allTasks, canSee, emptyData, me, proj } from '../core/store.js';
import { ApiError, get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { hashFor, render, routeFromHash } from '../shell/render.js';
import { commit, connectLive, onSync, prime, stopSync } from '../shell/sync.js';
import { A, EMAIL_RE } from './actions.js';

const AUTH_SCREENS = ['login', 'signup', 'forgot'];

/* ---------- loading the workspace ---------- */
function hydrate(b) {
  S.data = b.data;
  S.prefs = { ...DEFAULT_PREFS, ...b.prefs, tz: validTz(b.prefs?.tz) };
  S.views = b.views || {};
  S.ui.collapsed = !!b.collapsed;
  setTimeZone(S.prefs.tz);
  prime(S.data);
}

let reloading = null;
/* Re-read everything from the server (after reconnecting, or when access changed). */
export function reload() {
  reloading ||= (async () => {
    try {
      await commit();
      hydrate(await get('/api/bootstrap'));
      if (S.ui.drawer && !allTasks().some(t => t.id === S.ui.drawer)) S.ui.drawer = null;
      if (S.ui.route === 'project' && !proj(S.ui.params.id)) {
        S.ui.route = 'projects';
        S.ui.params = {};
      }
      render();
    } catch (e) {
      if (e.status === 401 || e.status === 403) signedOut();
    } finally {
      reloading = null;
    }
  })();
  return reloading;
}

async function enter(hash, msg) {
  const b = await get('/api/bootstrap');
  hydrate(b);
  connectLive();
  S.ui.errors = {};
  if (!b.workspace.onboarded && me()?.role === 'Owner') {
    S.ui.auth = 'onboarding';
    S.ui.onb = 0;
    S.ui.onbData.ws = '';
    render();
    return;
  }
  S.ui.auth = null;
  openRoute(hash || S.ui.returnTo || '');
  S.ui.returnTo = null;
  if (msg) toast(msg);
}

/* Route from the URL hash: a page (see hashFor in shell/render.js), or a deep link written by
   A.copyLink (#task/KEY, #file/id). */
function openRoute(h = '') {
  const r = routeFromHash(h);
  S.ui.route = r?.route || S.prefs.home || 'home';
  S.ui.params = r?.params || {};
  S.ui.history = [];
  history.replaceState(null, '', location.pathname + location.search + '#' + hashFor(S.ui.route, S.ui.params));
  render();
  let kind, ref;
  try {
    [kind, ref] = h.split('/').map(decodeURIComponent);
  } catch {
    /* malformed escape in the hash: open normally */
  }
  const t = kind === 'task' && allTasks().find(x => x.key === ref);
  if (t) A.openTask({ dataset: { id: t.id } });
  const f = kind === 'file' && D().files.find(x => x.id === ref);
  if (f && canSee(proj(f.project))) A.previewFile({ dataset: { id: f.id } });
}

/* Decide what to show for a session state from /api/auth/session. */
async function route(s, hash = '', msg) {
  S.ui.me = s.user;
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
    await route(s, ['verify', 'reset', 'invite', 'join'].includes(kind) ? '' : hash);
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
      }),
    );
    S.ui.inviteToken = S.ui.joinToken = S.ui.invite = null;
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
export function signedOut(msg) {
  stopSync();
  S.data = emptyData();
  S.views = {};
  Object.assign(S.ui, { pop: null, palette: null, drawer: null, modals: [], route: 'home', params: {}, history: [], errors: {}, me: null, offline: false });
  S.ui.sel.clear();
  clearHash();
  S.ui.auth = 'login';
  render();
  if (msg) toast(msg, { kind: 'info', ms: 6000 });
}
A.signOut = async () => {
  S.ui.pop = null;
  await commit().catch(() => {});
  await post('/api/auth/logout').catch(() => {});
  signedOut();
};

onSync({ signedOut: () => signedOut('Your session ended. Sign in again to continue.'), resync: reload });

/* ---------- onboarding ---------- */
async function finishSetup() {
  const errs = await commit();
  if (errs.length) toast(errs[0], { kind: 'err' });
  await post('/api/workspace/onboarded').catch(err => toast(err.message, { kind: 'err' }));
}
const onbFinish = A.onbFinish;
A.onbFinish = async () => {
  onbFinish();
  await finishSetup();
};
A.onbExit = async () => {
  await finishSetup();
  S.ui.auth = null;
  openRoute('');
};

/* An emailed link pasted into a tab that already has the app open only changes the hash. */
addEventListener('hashchange', () => {
  if (/^#(verify|reset|invite|join)\//.test(location.hash)) boot();
});
