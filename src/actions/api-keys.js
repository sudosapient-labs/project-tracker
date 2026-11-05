/* =====================================================================
   ACTIONS · PERSONAL API KEYS (Settings → API)
   ===================================================================== */
import { $ } from '../core/utils.js';
import { D, S } from '../core/store.js';
import { del, get, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { render } from '../shell/render.js';
import { A, busy, confirmDlg } from './actions.js';

/* Last-used times change as keys are used: refresh the list whenever the section opens. */
async function refreshKeys() {
  try {
    D().apiKeys = await get('/api/keys');
    if (S.ui.route === 'settings') render();
  } catch {
    /* keep the list from bootstrap */
  }
}
const go = A.go;
A.go = el => {
  const onApi = el.dataset.r === 'settings' && el.dataset.sec === 'api';
  // A new key's token is only shown until you move on.
  if (!onApi) S.ui.newApiKey = null;
  go(el);
  if (onApi) refreshKeys();
};

A.createApiKey = async () => {
  const name = $('#api-name').value.trim();
  const password = $('#api-pw').value;
  S.ui.errors = {};
  S.ui.apiName = name;
  if (!name) S.ui.errors.apiName = 'Name the key, e.g. “Laptop CLI”';
  if (!password) S.ui.errors.apiPw = 'Enter your current password';
  if (Object.keys(S.ui.errors).length) return render();
  const exp = $('#api-exp').value;
  try {
    const r = await busy('api-create', () => post('/api/keys', { name, password, scope: $('#api-scope').value, expiresInDays: exp ? Number(exp) : null }));
    D().apiKeys = [r.key, ...(D().apiKeys || [])];
    S.ui.newApiKey = r;
    S.ui.apiName = '';
    render();
    $('#api-token')?.select();
  } catch (err) {
    S.ui.errors[err.field === 'password' ? 'apiPw' : 'apiName'] = err.message;
    render();
  }
};

/* The token stays on screen only until it's dismissed or the page is left. */
A.dismissApiKey = () => {
  S.ui.newApiKey = null;
  render();
};

A.revokeApiKey = el => {
  const k = (D().apiKeys || []).find(x => x.id === el.dataset.id);
  if (!k) return;
  confirmDlg({
    title: `Revoke “${k.name}”?`,
    body: 'Anything using this key (scripts, the CLI, AI assistants) stops working straight away.',
    ok: 'Revoke key',
    danger: true,
    icon: 'key-round',
    run: async () => {
      try {
        D().apiKeys = await del(`/api/keys/${encodeURIComponent(k.id)}`);
        if (S.ui.newApiKey?.key.id === k.id) S.ui.newApiKey = null;
        render();
        toast('Key revoked');
      } catch (err) {
        toast(err.message, { kind: 'err' });
      }
    },
  });
};
