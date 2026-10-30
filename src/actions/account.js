/* =====================================================================
   ACTIONS · ACCOUNT SECURITY: password, signed-in sessions, two-factor,
   changing the sign-in email and deleting the account
   ===================================================================== */
import { $, esc } from '../core/utils.js';
import { D, S } from '../core/store.js';
import { del, get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { render } from '../shell/render.js';
import { A, EMAIL_RE, busy, confirmDlg } from './actions.js';
import { signedOut } from './session.js';

A.savePassword = async () => {
  const e = (S.ui.errors = {});
  const cur = $('#pw-cur').value,
    nw = $('#pw-new').value,
    cf = $('#pw-conf').value;
  S.ui.pwDone = false;
  if (!cur) e.pwCur = 'Enter your current password';
  if (nw.length < 10 || !/[0-9\W]/.test(nw)) e.pwNew = 'Use at least 10 characters, including a number or symbol';
  if (nw !== cf) e.pwConf = "Passwords don't match";
  if (Object.keys(e).length) return render();
  try {
    const r = await busy('pw-save', () => post('/api/auth/password', { current: cur, password: nw }));
    D().sessions = r.sessions || D().sessions;
    S.ui.pwDone = true;
    S.ui.pwNew = '';
    render();
    toast('Password updated');
  } catch (err) {
    S.ui.errors = { [err.field === 'current' ? 'pwCur' : 'pwNew']: err.message };
    render();
  }
};

/* Settings → Sessions shows live data: refresh the list whenever the section opens. */
export async function refreshSessions() {
  try {
    D().sessions = await get('/api/auth/sessions');
    if (S.ui.route === 'settings') render();
  } catch {
    /* keep the list from bootstrap */
  }
}
const go = A.go;
A.go = el => {
  go(el);
  if (el.dataset.r === 'settings' && el.dataset.sec === 'sessions') refreshSessions();
};

A.revokeSession = async el => {
  try {
    D().sessions = await del(`/api/auth/sessions/${encodeURIComponent(el.dataset.id)}`);
    render();
    toast('Session signed out');
  } catch (err) {
    toast(err.message, { kind: 'err' });
  }
};
A.revokeAll = () =>
  confirmDlg({
    title: 'Sign out of all other sessions?',
    body: "You'll stay signed in on this device. Other devices will need to sign in again.",
    ok: 'Sign out others',
    danger: true,
    icon: 'log-out',
    run: async () => {
      try {
        D().sessions = await post('/api/auth/sessions/revoke-others');
        render();
        toast('Signed out of other sessions');
      } catch (err) {
        toast(err.message, { kind: 'err' });
      }
    },
  });

/* ---------- two-factor ---------- */
/* Setting it up starts with the current password. */
A.ask2fa = () => {
  S.ui.errors = {};
  S.ui.tfaAsk = true;
  render();
  setTimeout(() => $('#tfa-pw')?.focus(), 0);
};
A.setup2fa = async () => {
  const password = $('#tfa-pw')?.value || '';
  S.ui.errors = {};
  S.ui.recoveryCodes = null;
  if (!password) {
    S.ui.errors.tfaPw = 'Enter your current password';
    return render();
  }
  try {
    S.ui.tfaSetup = await busy('tfa-setup', () => post('/api/auth/2fa/setup', { password }));
    S.ui.tfaAsk = false;
    render();
    setTimeout(() => $('#tfa-code')?.focus(), 0);
  } catch (err) {
    S.ui.errors.tfaPw = err.message;
    render();
  }
};
A.cancel2fa = () => {
  S.ui.tfaSetup = null;
  S.ui.tfaAsk = false;
  S.ui.errors = {};
  render();
};
A.verify2fa = async () => {
  const v = $('#tfa-code').value.trim();
  if (!/^\d{6}$/.test(v)) {
    S.ui.errors.tfa = 'Enter the 6-digit code from your app';
    render();
    return;
  }
  try {
    const r = await busy('tfa-verify', () => post('/api/auth/2fa/enable', { code: v }));
    S.ui.errors = {};
    S.ui.tfaSetup = null;
    S.ui.recoveryCodes = r.recoveryCodes;
    D().tfa = true;
    render();
    toast('Two-factor authentication enabled');
  } catch (err) {
    S.ui.errors.tfa = err.message;
    render();
    $('#tfa-code')?.select();
  }
};
/* Turning it off asks for the password or a current code first. */
A.disable2fa = () => {
  S.ui.tfaOff = true;
  S.ui.errors = {};
  render();
  setTimeout(() => $('#tfa-off')?.focus(), 0);
};
A.cancelDisable2fa = () => {
  S.ui.tfaOff = false;
  S.ui.errors = {};
  render();
};
A.confirmDisable2fa = async () => {
  const v = ($('#tfa-off')?.value || '').trim();
  if (!v) {
    S.ui.errors = { tfaOff: 'Enter your password or a code from your authenticator app' };
    return render();
  }
  // Six digits or a recovery code (XXXX-XXXX) is a code; anything else is the password.
  const body = /^(\d{6}|[A-Z0-9]{4}-[A-Z0-9]{4})$/i.test(v.replace(/\s/g, '')) ? { code: v } : { password: v };
  try {
    await busy('tfa-off-btn', () => post('/api/auth/2fa/disable', body));
    Object.assign(S.ui, { tfaOff: false, recoveryCodes: null, errors: {} });
    D().tfa = false;
    render();
    toast('Two-factor authentication turned off');
  } catch (err) {
    S.ui.errors = { tfaOff: err.message };
    render();
  }
};

/* ---------- email and account ---------- */
A.requestEmailChange = async () => {
  const em = ($('#em-new')?.value || '').trim(),
    pw = $('#em-pw')?.value || '';
  const e = (S.ui.errors = {});
  if (!EMAIL_RE.test(em)) e.emNew = 'Enter a valid email, like name@company.com';
  if (!pw) e.emPw = 'Enter your current password';
  if (Object.keys(e).length) {
    render();
    if ($('#em-new')) $('#em-new').value = em;
    return;
  }
  try {
    const r = await busy('em-save', () => post('/api/auth/email', { email: em, password: pw }));
    S.ui.emailSent = em;
    S.ui.devLink = r.devLink || null;
    render();
  } catch (err) {
    S.ui.errors = { [err.field === 'password' ? 'emPw' : 'emNew']: err.message };
    render();
    if ($('#em-new')) $('#em-new').value = em;
  }
};
A.deleteAccount = async () => {
  const pw = $('#del-pw')?.value || '';
  if (!pw) {
    S.ui.errors = { delPw: 'Enter your current password' };
    return render();
  }
  confirmDlg({
    title: 'Delete your account?',
    body: `You'll lose access to ${esc(D().ws.name)} immediately. This can't be undone.`,
    ok: 'Delete account',
    danger: true,
    icon: 'user-x',
    run: async () => {
      try {
        await post('/api/auth/account/delete', { password: pw });
        signedOut('Your account was deleted.');
      } catch (err) {
        S.ui.errors = { delPw: err.message };
        render();
      }
    },
  });
};
