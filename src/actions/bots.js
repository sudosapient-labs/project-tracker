/* =====================================================================
   ACTIONS · BOT MEMBERS (Settings → API → Bots, Owners and Admins)
   ===================================================================== */
import { $ } from '../core/utils.js';
import { D, S, me } from '../core/store.js';
import { del, get, patch, post } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { render } from '../shell/render.js';
import { A, busy, confirmDlg } from './actions.js';

const admin = () => ['Owner', 'Admin'].includes(me()?.role);
const checked = name => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
const put = b => {
  D().bots = (D().bots || []).map(x => (x.id === b.id ? b : x));
};

/* Key use changes "last used": refresh whenever Settings → API opens. */
const go = A.go;
A.go = el => {
  const onApi = el.dataset.r === 'settings' && el.dataset.sec === 'api';
  if (!onApi) S.ui.newBotKey = null;
  go(el);
  if (onApi && admin())
    get('/api/bots')
      .then(b => {
        D().bots = b;
        if (S.ui.route === 'settings') render();
      })
      .catch(() => {});
};

A.createBot = async () => {
  const name = $('#bot-name').value.trim();
  S.ui.errors = {};
  S.ui.botName = name;
  if (!name) {
    S.ui.errors.botName = 'Name the bot, e.g. “Release Bot”';
    return render();
  }
  try {
    const b = await busy('bot-create', () => post('/api/bots', { name, role: $('#bot-role').value, projects: checked('bot-proj') }));
    D().bots = [...(D().bots || []), b];
    S.ui.botName = '';
    S.ui.botOpen = b.id;
    render();
    toast(`${b.name} created. Give it a key to use it.`);
    $('#bot-key-name')?.focus();
  } catch (err) {
    S.ui.errors.botName = err.message;
    render();
  }
};

A.openBot = el => {
  S.ui.botOpen = S.ui.botOpen === el.dataset.id ? null : el.dataset.id;
  S.ui.errors = {};
  render();
};

A.saveBot = async el => {
  const id = el.dataset.id;
  const name = $('#bot-edit-name').value.trim();
  S.ui.errors = {};
  if (!name) {
    S.ui.errors.botEdit = 'Name the bot, e.g. “Release Bot”';
    return render();
  }
  try {
    put(
      await busy('bot-save', () => patch(`/api/bots/${encodeURIComponent(id)}`, { name, role: $('#bot-edit-role').value, projects: checked('bot-edit-proj') })),
    );
    render();
    toast('Bot saved');
  } catch (err) {
    S.ui.errors.botEdit = err.message;
    render();
  }
};

A.removeBot = el => {
  const b = (D().bots || []).find(x => x.id === el.dataset.id);
  if (!b) return;
  confirmDlg({
    title: `Remove ${b.name}?`,
    body: 'Its keys stop working straight away. What it made stays, shown as a former member.',
    ok: 'Remove bot',
    danger: true,
    icon: 'bot',
    run: async () => {
      try {
        D().bots = await del(`/api/bots/${encodeURIComponent(b.id)}`);
        S.ui.botOpen = null;
        if (S.ui.newBotKey?.botId === b.id) S.ui.newBotKey = null;
        render();
        toast('Bot removed');
      } catch (err) {
        toast(err.message, { kind: 'err' });
      }
    },
  });
};

A.createBotKey = async el => {
  const id = el.dataset.id;
  const name = $('#bot-key-name').value.trim();
  const password = $('#bot-key-pw').value;
  S.ui.errors = {};
  S.ui.botKeyName = name;
  if (!name) S.ui.errors.botKey = 'Name the key, e.g. “GitHub Actions”';
  if (!password) S.ui.errors.botKeyPw = 'Enter your current password';
  if (Object.keys(S.ui.errors).length) return render();
  const exp = $('#bot-key-exp').value;
  try {
    const r = await busy('bot-key-create', () =>
      post(`/api/bots/${encodeURIComponent(id)}/keys`, { name, password, scope: $('#bot-key-scope').value, expiresInDays: exp ? Number(exp) : null }),
    );
    put(r.bot);
    S.ui.newBotKey = { key: r.key, token: r.token, bot: r.bot.name, botId: id };
    S.ui.botKeyName = '';
    render();
    $('#bot-token')?.select();
  } catch (err) {
    S.ui.errors[err.field === 'password' ? 'botKeyPw' : 'botKey'] = err.message;
    render();
  }
};

A.dismissBotKey = () => {
  S.ui.newBotKey = null;
  render();
};

A.revokeBotKey = el => {
  const b = (D().bots || []).find(x => x.id === el.dataset.id);
  const k = b?.keys.find(x => x.id === el.dataset.key);
  if (!k) return;
  confirmDlg({
    title: `Revoke “${k.name}”?`,
    body: `Anything using this key as ${b.name} stops working straight away.`,
    ok: 'Revoke key',
    danger: true,
    icon: 'key-round',
    run: async () => {
      try {
        put(await del(`/api/bots/${encodeURIComponent(b.id)}/keys/${encodeURIComponent(k.id)}`));
        if (S.ui.newBotKey?.key.id === k.id) S.ui.newBotKey = null;
        render();
        toast('Key revoked');
      } catch (err) {
        toast(err.message, { kind: 'err' });
      }
    },
  });
};
