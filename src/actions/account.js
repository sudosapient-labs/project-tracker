/* =====================================================================
   ACTIONS · ACCOUNT SECURITY: password, signed-in sessions, two-factor
   ===================================================================== */
import { $ } from '../core/utils.js';
import { D, S } from '../core/store.js';
import { del, get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { render } from '../shell/render.js';
import { A, busy, confirmDlg } from './actions.js';

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
    await busy('pw-save', () => post('/api/auth/password', { current: cur, password: nw }));
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
A.setup2fa = async () => {
  S.ui.errors = {};
  S.ui.recoveryCodes = null;
  try {
    S.ui.tfaSetup = await busy('tfa-setup', () => post('/api/auth/2fa/setup'));
    render();
    setTimeout(() => $('#tfa-code')?.focus(), 0);
  } catch (err) {
    toast(err.message, { kind: 'err' });
  }
};
A.cancel2fa = () => {
  S.ui.tfaSetup = null;
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
A.disable2fa = () =>
  confirmDlg({
    title: 'Turn off two-factor authentication?',
    body: 'Your account will be protected by your password only.',
    ok: 'Turn off',
    danger: true,
    icon: 'shield-off',
    run: async () => {
      try {
        await post('/api/auth/2fa/disable');
        D().tfa = false;
        S.ui.recoveryCodes = null;
        render();
        toast('Two-factor authentication turned off');
      } catch (err) {
        toast(err.message, { kind: 'err' });
      }
    },
  });
