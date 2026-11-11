/* =====================================================================
   SETTINGS · AUTH · ONBOARDING · DESIGN SYSTEM · SYSTEM STATES
   ===================================================================== */
import { ago, dOff, dayKey, esc, fmtDate } from '../core/utils.js';
import { ic, wsLogo } from '../core/icons.js';
import { timeZones, tzCity } from '../core/constants.js';
import { isAdminRole } from '../core/access.js';
import { D, S, keysRevokedByPasswordChange, me } from '../core/store.js';
import { av, pIcon } from '../ui/helpers.js';
import { permsTable, teamsGrid } from './members.js';
import { page404 } from './errors.js';
import { SHORTCUTS } from '../overlays/modals.js';
import { pushHere, pushPermission, pushSupport, wantsPush } from '../actions/push.js';

/* The day a moment (Unix ms: a key made, a key that expires) falls on, on the reader's clock. */
const when = ms => (ms ? fmtDate(dayKey(ms)) : '');

export const SET_NAV = [
  [
    'General',
    [
      ['workspace', 'Workspace', 'building-2'],
      ['appearance', 'Appearance', 'palette'],
      ['language', 'Language', 'languages'],
      ['datetime', 'Date & time', 'clock'],
    ],
  ],
  [
    'Workspace',
    [
      ['members', 'Members', 'users'],
      ['teams', 'Teams', 'users-round'],
      ['projects', 'Projects', 'folder-kanban'],
      ['permissions', 'Permissions', 'shield'],
    ],
  ],
  [
    'Notifications',
    [
      ['notif-email', 'Email', 'mail'],
      ['notif-push', 'Push', 'smartphone'],
      ['notif-mentions', 'Mentions', 'at-sign'],
      ['notif-assign', 'Task assignments', 'user-check'],
    ],
  ],
  [
    'Personal',
    [
      ['profile', 'Profile', 'user'],
      ['preferences', 'Preferences', 'sliders-horizontal'],
      ['shortcuts', 'Keyboard shortcuts', 'keyboard'],
      ['api', 'API', 'braces'],
    ],
  ],
  [
    'Security',
    [
      ['password', 'Password', 'key-round'],
      ['sessions', 'Sessions', 'monitor-smartphone'],
      ['2fa', 'Two-factor authentication', 'shield-check'],
      ['account', 'Account', 'user-cog'],
    ],
  ],
];
/* A setting: its title, a description, and the control. A `tog` or `sel` in the row is named by the
   row's title (its `data-row-label` becomes aria-labelledby), so a screen reader says "Mentions",
   not the setting's key. */
let rows = 0;
export function srow(t, d, ctl) {
  const id = `srow-${++rows}`;
  const named = ctl.replace(/ data-row-label\b/g, ` aria-labelledby="${id}"`);
  return `<div class="srow"><div><div class="t"${named === ctl ? '' : ` id="${id}"`}>${t}</div>${d ? `<div class="d">${d}</div>` : ''}</div><div class="row">${named}</div></div>`;
}
/* Settings → Push: whether this device actually gets push. The toggles below are the account's;
   this says whether this browser is allowed and subscribed, and offers the one tap that fixes it. */
function pushDevice(np) {
  const box = (kind, icon, title, text, btn = '') =>
    `<div class="alert ${kind}" data-push-here="${kind}" style="margin-bottom:18px">${ic(icon, 16)}<div class="grow"><b>${title}</b><div class="muted" style="margin-top:2px">${text}</div>${btn ? `<div style="margin-top:10px">${btn}</div>` : ''}</div></div>`;
  const support = pushSupport();
  if (support === 'insecure')
    return box(
      'info',
      'info',
      'Push isn’t available on this connection.',
      'Browsers only allow push over HTTPS. Open Sudo Sapient at its https:// address to turn it on.',
    );
  if (support === 'ios')
    return box(
      'info',
      'info',
      'Add Sudo Sapient to your Home Screen first.',
      'On iPhone and iPad, push works only in the installed app: tap Share, then Add to Home Screen, and open it from there.',
    );
  if (support === 'noworker')
    return box(
      'info',
      'info',
      'This browser isn’t letting Sudo Sapient run in the background.',
      'Push needs that, and this browser blocks it here (private windows and some privacy settings do). Open Sudo Sapient in a normal window, or allow this site to store data, then reload.',
    );
  if (support !== 'ok')
    return box('info', 'info', 'This browser doesn’t support push notifications.', 'Try a current version of Chrome, Edge, Firefox or Safari.');
  const perm = pushPermission();
  if (perm === 'denied')
    return box(
      'danger',
      'bell-off',
      'Notifications are blocked on this device.',
      'To get push here, allow notifications for this site: in the browser, open the site settings (the icon next to the address) and set Notifications to Allow. For the installed app on Android, open App info → Notifications. Then come back to this page.',
      `<button class="btn btn-secondary btn-sm" data-a="pushRecheck">Check again</button>`,
    );
  if (!wantsPush(np))
    return box(
      'info',
      'bell-off',
      'Push is off.',
      'Nothing is pushed to your devices, access requests included. Turn on a kind of notification below to get push again.',
    );
  if (pushHere.subscribed)
    return box(
      'ok',
      'circle-check',
      'Push is on for this device.',
      'The notifications chosen below arrive here, and so do requests for access to projects you lead.',
    );
  if (pushHere.subscribed === null && perm === 'granted')
    return box('info', 'loader', 'Checking this device…', 'Connecting this browser to push notifications.');
  return box(
    'warn',
    'bell-off',
    'Push isn’t on for this device yet.',
    perm === 'default'
      ? 'You won’t get the notifications chosen below here until you turn it on. You’ll be asked to allow notifications.'
      : 'You won’t get the notifications chosen below here until you turn it on.',
    `<button class="btn btn-primary btn-sm" data-a="pushHere" ${pushHere.busy ? 'disabled' : ''}>${ic('bell', 14)}Turn on push on this device</button>`,
  );
}
export const tog = (k, on, src = 'pref') => `<input type="checkbox" class="toggle" data-in="${src}Toggle" data-k="${k}" ${on ? 'checked' : ''} data-row-label>`;
export const sel = (k, opts, v) =>
  `<select class="select" style="width:auto;min-width:180px" data-in="prefSel" data-k="${k}" data-row-label>${opts
    .map(o => {
      const [val, n] = Array.isArray(o) ? o : [o, o];
      return `<option value="${val}" ${String(v) === String(val) ? 'selected' : ''}>${n}</option>`;
    })
    .join('')}</select>`;
/* A time zone picker: the common zones, then every other one. `v` is listed even if this browser
   doesn't know it; `none` labels an empty first choice. */
export function zoneSel(attrs, v, none = '') {
  const all = timeZones();
  const opt = z => `<option value="${esc(z.id)}" ${z.id === v ? 'selected' : ''}>${esc(z.name)}</option>`;
  const unknown = v && !all.some(z => z.id === v) ? [{ id: v, name: tzCity(v) }] : [];
  return `<select class="select" style="width:auto;min-width:180px;max-width:320px" ${attrs}>${none ? `<option value="" ${v ? '' : 'selected'}>${esc(none)}</option>` : ''}${unknown.map(opt).join('')}<optgroup label="Common">${all
    .filter(z => z.common)
    .map(opt)
    .join('')}</optgroup><optgroup label="All time zones">${all
    .filter(z => !z.common)
    .map(opt)
    .join('')}</optgroup></select>`;
}
export function pageSettings() {
  const sec = S.ui.params.sec || S.ui.settings || 'appearance';
  const title = SET_NAV.flatMap(g => g[1]).find(x => x[0] === sec) || ['appearance', 'Appearance'];
  return `<div class="set">
    <nav class="set-nav" aria-label="Settings" data-keep="set-nav">${SET_NAV.map(([g, items]) => `<div class="gh">${g}</div>${items.map(([k, n, i]) => `<button class="sitem ${sec === k ? 'on' : ''}" data-a="go" data-r="settings" data-sec="${k}">${ic(i, 15)}<span>${n}</span></button>`).join('')}`).join('')}</nav>
    <div class="set-body" data-keep="set:${esc(sec)}"><div class="set-in">${settingsBody(sec, title[1])}</div></div>
  </div>`;
}
export function settingsBody(sec, title) {
  const P = S.prefs;
  const d = D();
  const np = d.notifPrefs;
  const H = lead => `<h1>${title}</h1><p class="lead">${lead}</p>`;
  switch (sec) {
    case 'workspace':
      return (
        H('Your workspace name and identity.') +
        `
      <form data-submit="saveWorkspace">
      <div class="sblock" style="margin-top:0"><div class="row" style="gap:14px;margin-bottom:18px">${wsLogo(d.ws, 52)}<div><div class="label" style="margin-bottom:6px">Workspace icon</div><div class="swatches">${['#2F2E2A', '#5A67D8', '#3B82C4', '#23918A', '#C54B78', '#C48A1E'].map(c => `<button type="button" class="sw ${d.ws.c === c ? 'on' : ''}" style="--c:${c};width:22px;height:22px" data-a="wsColor" data-v="${c}" aria-label="Color ${c}"></button>`).join('')}</div></div></div>
      <div class="col" style="gap:14px;max-width:440px"><div class="field"><label class="label" for="ws-name">Workspace name</label><input class="input" id="ws-name" value="${esc(d.ws.name)}"></div>
      <div><button class="btn btn-primary" data-a="saveWorkspace" id="ws-save">Save changes</button></div></div></div></form>
      <div class="sblock">${srow(
        'Workspace time zone',
        isAdminRole(me())
          ? 'For people who haven’t set their own time zone, and for bots: their reminders, digests and due times use it.'
          : 'For people who haven’t set their own time zone, and for bots. Owners and Admins can change it.',
        zoneSel(`data-in="wsTz" aria-label="Workspace time zone" id="ws-tz" ${isAdminRole(me()) ? '' : 'disabled'}`, d.ws.tz || '', 'Not set (UTC)'),
      )}</div>`
      );
    case 'appearance':
      return (
        H('Customize how Sudo Sapient looks on this device.') +
        `
      <div class="sblock" style="margin-top:0"><h2>Theme</h2><div class="themecards" style="margin-top:12px" role="radiogroup" aria-label="Theme">${[
        ['light', 'Light'],
        ['dark', 'Dark'],
        ['system', 'System'],
      ]
        .map(([k, n]) => {
          const L = { bg: '#FBFAF8', s: '#F2F1EE', t: '#1D1C1A', b: '#E3E1DC', a: '#4B5BD6' },
            Dk = { bg: '#1D1D1C', s: '#151514', t: '#ECEAE5', b: '#333230', a: '#8E9AF3' };
          const pv = c =>
            `<div class="s" style="background:${c.s}"><i style="background:${c.b};width:70%"></i><i style="background:${c.a};width:55%"></i><i style="background:${c.b};width:80%"></i><i style="background:${c.b};width:60%"></i></div><div class="m" style="background:${c.bg}"><i style="background:${c.t};width:45%;height:7px"></i><i style="background:${c.b}"></i><i style="background:${c.b};width:80%"></i><i style="background:${c.a};width:30%;height:10px;margin-top:4px"></i></div>`;
          return `<button class="tcard ${P.theme === k ? 'on' : ''}" role="radio" aria-checked="${P.theme === k}" data-a="setTheme" data-v="${k}"><div class="tprev" style="${k === 'system' ? 'grid-template-columns:1fr 1fr;display:grid' : ''}">${k === 'system' ? `<div style="display:grid;grid-template-columns:30% 1fr">${pv(L)}</div><div style="display:grid;grid-template-columns:30% 1fr">${pv(Dk)}</div>` : pv(k === 'light' ? L : Dk)}</div><span class="row" style="font-weight:500;font-size:13px;gap:6px">${ic(k === 'light' ? 'sun' : k === 'dark' ? 'moon' : 'monitor', 14)}${n}${P.theme === k ? `<span class="sp"></span><span style="color:var(--accent)">${ic('circle-check', 15)}</span>` : ''}</span></button>`;
        })
        .join('')}</div></div>
      <div class="sblock"><h2>Accent color</h2>${srow(
        'Accent',
        'Used for primary buttons, focus rings, and selection.',
        `<div class="swatches" role="radiogroup" aria-label="Accent color">${[
          ['indigo', '#4B5BD6'],
          ['blue', '#2F6CD4'],
          ['violet', '#7348CC'],
          ['teal', '#1A7F7A'],
          ['rose', '#B93D68'],
          ['graphite', '#34332F'],
        ]
          .map(
            ([k, c]) =>
              `<button class="sw ${P.accent === k ? 'on' : ''}" style="--c:${c}" role="radio" aria-checked="${P.accent === k}" data-a="setPref" data-k="accent" data-v="${k}" aria-label="${k}" data-tip="${k[0].toUpperCase() + k.slice(1)}">${P.accent === k ? ic('check', 13) : ''}</button>`,
          )
          .join('')}</div>`,
      )}</div>
      <div class="sblock"><h2>Density</h2>
        ${srow('Sidebar density', 'Compact fits more projects on screen.', `<div class="seg">${['comfortable', 'compact'].map(k => `<button class="${P.side === k ? 'on' : ''}" data-a="setPref" data-k="side" data-v="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>`)}
        ${srow('Task display', 'Row height in lists and card padding on boards.', `<div class="seg">${['comfortable', 'compact'].map(k => `<button class="${P.density === k ? 'on' : ''}" data-a="setPref" data-k="density" data-v="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}</div>`)}
        ${srow(
          'Motion',
          'Reduce animations for drawers, modals, and transitions.',
          sel(
            'motion',
            [
              ['system', 'Follow system'],
              ['reduce', 'Reduce motion'],
            ],
            P.motion,
          ),
        )}
      </div>`
      );
    case 'language':
      return (
        H('Language and regional formats.') +
        srow(
          'Language',
          'The language used throughout the interface.',
          sel('lang', ['English (US)', 'English (UK)', 'Deutsch', 'Español', 'Français', '日本語'], P.lang),
        ) +
        srow('Spellcheck', 'Check spelling in descriptions and comments.', tog('spell', P.spell !== false))
      );
    case 'datetime':
      return (
        H('How dates and times appear across the workspace.') +
        srow(
          'Time zone',
          'Used for due dates and reminders.',
          zoneSel('data-in="prefSel" data-k="tz" aria-label="tz"', P.tz || '', P.tz ? '' : `Workspace time zone (${tzCity(d.ws.tz || 'UTC')})`),
        ) +
        srow(
          'Time format',
          'Used for start and due times.',
          sel(
            'timeFmt',
            [
              ['12', '12-hour (2:30 PM)'],
              ['24', '24-hour (14:30)'],
            ],
            P.timeFmt || '12',
          ),
        ) +
        srow(
          'Date format',
          `Preview: <b>${fmtDate(dOff(8))}</b>`,
          sel(
            'dateFmt',
            [
              ['MMM d', 'Oct 1'],
              ['d/M', '1/10'],
              ['M/d', '10/1'],
              ['yyyy-MM-dd', '2026-10-01'],
            ],
            P.dateFmt,
          ),
        ) +
        srow(
          'Start week on',
          'Affects calendars and the timeline.',
          sel(
            'weekStart',
            [
              ['1', 'Monday'],
              ['0', 'Sunday'],
              ['6', 'Saturday'],
            ],
            P.weekStart,
          ),
        )
      );
    case 'members':
      return (
        H(`${d.members.length} people have access to ${esc(d.ws.name)}.`) +
        `<div class="row" style="margin-bottom:12px"><button class="btn btn-primary" data-a="invite">${ic('user-plus', 14)}Invite member</button><button class="btn btn-secondary" data-a="go" data-r="members">Open member directory</button></div>
      <div class="panel" style="overflow:hidden">${d.members.map(m => `<div class="mini" style="min-height:52px;cursor:default" data-ctx="member" data-id="${m.id}">${av(m.id, 'md', false)}<div class="grow"><div style="font-weight:500">${esc(m.name)}</div><div class="faint" style="font-size:12px">${esc(m.email)}</div></div>${m.status === 'invited' ? '<span class="badge amber">Invited</span>' : ''}${m.role === 'Owner' ? `<span class="pillbtn">${ic('crown', 13)}Owner</span>` : `<button class="pillbtn bordered" data-a="pop" data-pop="role" data-id="${m.id}">${m.role}${ic('chevron-down', 12)}</button>`}<button class="ibtn ibtn-sm" data-a="ctxBtn" data-ctx="member" data-id="${m.id}" aria-label="Options">${ic('ellipsis', 14)}</button></div>`).join('')}</div>`
      );
    case 'teams':
      return H('Teams group people and projects.') + teamsGrid();
    case 'projects': {
      const arch = d.projects.filter(p => p.archived);
      return (
        H('Defaults for new projects and archived work.') +
        srow(
          'Default project view',
          'The tab that opens when you open a project.',
          sel(
            'defaultTab',
            [
              ['board', 'Board'],
              ['list', 'List'],
              ['table', 'Table'],
              ['overview', 'Overview'],
              ['timeline', 'Timeline'],
            ],
            P.defaultTab || 'board',
          ),
        ) +
        srow('Show completed tasks on boards', '', tog('showDoneBoard', P.showDoneBoard !== false)) +
        `<div class="sblock"><h2>Archived projects</h2>${arch.length ? arch.map(p => `<div class="srow"><div class="row">${pIcon(p, '', 14)}<b style="font-weight:500">${esc(p.name)}</b></div><div class="row"><button class="btn btn-secondary btn-sm" data-a="restoreProject" data-id="${p.id}">Restore</button><button class="btn btn-danger-ghost btn-sm" data-a="delProject" data-id="${p.id}">Delete</button></div></div>`).join('') : `<p class="faint" style="padding:12px 0">No archived projects. Archived projects are hidden from the sidebar but keep all their tasks.</p>`}<div style="margin-top:12px"><button class="btn btn-secondary btn-sm" data-a="go" data-r="archive">${ic('archive', 13)}Open archive</button></div></div>`
      );
    }
    case 'permissions':
      return (
        H('Control what each role can do.') +
        srow('Members can create projects', '', tog('permCreate', P.permCreate !== false)) +
        srow('Members can invite guests', 'Guests only see projects they are added to.', tog('permGuests', P.permGuests !== false)) +
        srow('Allow public share links', 'Anyone with the link can view a project.', tog('permPublic', !!P.permPublic)) +
        `<div class="sblock"><h2>Role permissions</h2><div style="margin-top:12px">${permsTable()}</div></div>`
      );
    case 'notif-email':
      return (
        H('Choose which emails you receive.') +
        srow('Mentions', 'When someone @mentions you.', tog('email_mention', np.email_mention, 'np')) +
        srow('Assignments', 'When a task is assigned to you.', tog('email_assign', np.email_assign, 'np')) +
        srow('Comments', 'On tasks you created or are assigned.', tog('email_comment', np.email_comment, 'np')) +
        srow('Daily digest', 'A summary of what changed, every weekday at 8:00.', tog('email_digest', np.email_digest, 'np'))
      );
    case 'notif-push':
      return (
        H('Choose what’s pushed to your devices, even when Sudo Sapient is closed.') +
        pushDevice(np) +
        srow('Mentions', '', tog('push_mention', np.push_mention, 'np')) +
        srow('Assignments', '', tog('push_assign', np.push_assign, 'np')) +
        srow('Comments', '', tog('push_comment', np.push_comment, 'np')) +
        srow('Due date reminders', 'One day before a task is due.', tog('push_due', np.push_due, 'np'))
      );
    case 'notif-mentions':
      return (
        H('Decide which mentions reach you.') +
        srow('@mentions in comments and descriptions', '', tog('mention_all', np.mention_all, 'np')) +
        srow('@team mentions', 'When your team is mentioned, e.g. @Product.', tog('mention_team', np.mention_team !== false, 'np')) +
        srow('@workspace mentions', 'Announcements to everyone.', tog('mention_ws', !!np.mention_ws, 'np'))
      );
    case 'notif-assign':
      return (
        H('Updates about tasks assigned to you.') +
        srow("When I'm assigned a task", '', tog('assign_self', np.assign_self, 'np')) +
        srow('When my task changes status', '', tog('assign_status', np.assign_status !== false, 'np')) +
        srow('When my task is overdue', '', tog('assign_over', np.assign_over !== false, 'np'))
      );
    case 'profile': {
      const err = S.ui.errors.pname2;
      return (
        H('How you appear to others in the workspace.') +
        `<form data-submit="saveProfile" class="col" style="gap:16px;max-width:440px">
      <div class="row" style="gap:14px">${av(d.me, 'xl', false)}<div><div class="label" style="margin-bottom:6px">Avatar color</div><div class="swatches">${['#5A67D8', '#C54B78', '#3B82C4', '#23918A', '#C48A1E', '#8662C9'].map(c => `<button type="button" class="sw ${me().c === c ? 'on' : ''}" style="--c:${c};width:22px;height:22px" data-a="avColor" data-v="${c}" aria-label="Color"></button>`).join('')}</div></div></div>
      <div class="field"><label class="label" for="pf-name">Full name</label><input class="input ${err ? 'is-error' : ''}" id="pf-name" value="${esc(P.name)}">${err ? `<span class="err">${ic('circle-alert', 12)}${err}</span>` : ''}</div>
      <div class="field"><label class="label" for="pf-title">Title</label><input class="input" id="pf-title" value="${esc(P.title)}"></div>
      <div class="field"><label class="label" for="pf-email">Email</label><input class="input" id="pf-email" value="${esc(me().email)}" disabled><span class="hint">Change your sign-in email in <button type="button" class="link" data-a="go" data-r="settings" data-sec="account">Account</button>.</span></div>
      <div><button class="btn btn-primary" data-a="saveProfile" id="pf-save">Save profile</button></div></form>`
      );
    }
    case 'preferences':
      return (
        H('Personal defaults for how you work.') +
        srow(
          'Open on launch',
          'The page you see when Sudo Sapient opens.',
          sel(
            'home',
            [
              ['home', 'Home'],
              ['mytasks', 'My Tasks'],
              ['inbox', 'Inbox'],
            ],
            P.home,
          ),
        ) +
        srow(
          'Open tasks in',
          'Side panel keeps your place in the list.',
          sel(
            'openTasks',
            [
              ['drawer', 'Side panel'],
              ['full', 'Full page'],
            ],
            P.openTasks,
          ),
        ) +
        srow('Confirm before deleting tasks', '', tog('confirmDel', P.confirmDel !== false))
      );
    case 'shortcuts':
      return (
        H('Move faster with the keyboard.') +
        SHORTCUTS.map(
          ([g, list]) =>
            `<div class="sblock" style="margin-top:18px"><h2>${g}</h2>${list.map(([n, k]) => `<div class="srow" style="padding:9px 0"><span>${n}</span><span class="row" style="gap:4px">${k.map((x, i) => `${i && k[0] === 'G' ? '<span class="faint" style="font-size:11px">then</span>' : ''}<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}</div>`,
        ).join('')
      );
    case 'api':
      return (
        H('Personal API keys let scripts, the CLI and AI assistants (MCP) act as you, with your projects and permissions.') +
        apiSection() +
        (['Owner', 'Admin'].includes(me().role) ? botsSection() : '')
      );
    case 'password': {
      const e = S.ui.errors;
      const pw = S.ui.pwNew || '';
      const revoking = keysRevokedByPasswordChange();
      const botKeysMine = revoking > D().apiKeys.length;
      return (
        H("Use a long password you don't use anywhere else.") +
        `${S.ui.pwDone ? `<div class="alert ok" style="margin-bottom:14px">${ic('circle-check', 15)}<span>Password updated. Your other sessions were signed out${S.ui.pwRevoked ? ` and ${S.ui.pwRevoked === 1 ? 'your API key was' : `${S.ui.pwRevoked} API keys were`} revoked` : ''}.</span></div>` : ''}<form data-submit="savePassword" class="col" style="gap:14px;max-width:400px">
      <div class="field"><label class="label" for="pw-cur">Current password</label><input type="password" class="input ${e.pwCur ? 'is-error' : ''}" id="pw-cur" autocomplete="current-password">${e.pwCur ? `<span class="err">${ic('circle-alert', 12)}${e.pwCur}</span>` : ''}</div>
      <div class="field"><label class="label" for="pw-new">New password</label><input type="password" class="input ${e.pwNew ? 'is-error' : ''}" id="pw-new" data-in="pwStrength" value="${esc(pw)}" autocomplete="new-password">${strengthMeter(pw)}${e.pwNew ? `<span class="err">${ic('circle-alert', 12)}${e.pwNew}</span>` : '<span class="hint">At least 10 characters with a number or symbol.</span>'}</div>
      <div class="field"><label class="label" for="pw-conf">Confirm new password</label><input type="password" class="input ${e.pwConf ? 'is-error' : ''}" id="pw-conf" autocomplete="new-password">${e.pwConf ? `<span class="err">${ic('circle-alert', 12)}${e.pwConf}</span>` : ''}</div>
      <div><button class="btn btn-primary" data-a="savePassword" id="pw-save">Update password</button>${revoking ? `<span class="hint" style="display:block;margin-top:8px">This also revokes ${revoking === 1 ? 'your API key' : `your ${revoking} API keys`}${botKeysMine ? ', including bot keys you made' : ''}. Make new ones in Settings → API afterwards.</span>` : ''}</div></form>`
      );
    }
    case 'sessions':
      return (
        H('Devices currently signed in to your account.') +
        d.sessions
          .map(s =>
            srow(
              `<span class="row" style="gap:8px">${ic(s.dev.includes('iPhone') ? 'smartphone' : 'monitor', 15)}${esc(s.dev)}${s.cur ? '<span class="badge green">This device</span>' : ''}</span>`,
              `${esc(s.loc)} · ${esc(s.at)}`,
              s.cur ? '' : `<button class="btn btn-secondary btn-sm" data-a="revokeSession" data-id="${s.id}">Sign out</button>`,
            ),
          )
          .join('') +
        `<div style="margin-top:16px"><button class="btn btn-danger-ghost" data-a="revokeAll" ${d.sessions.length > 1 ? '' : 'disabled'}>Sign out of all other sessions</button></div>`
      );
    case '2fa':
      return (
        H('Add a second step when signing in.') +
        (d.tfa
          ? `<div class="alert ok">${ic('shield-check', 16)}<div><b>Two-factor authentication is on.</b><div class="muted">You'll enter a code from your authenticator app when signing in on a new device.</div></div></div><div class="sblock"><h2>Recovery codes</h2>${
              S.ui.recoveryCodes
                ? `<p class="muted" style="font-size:13px">Store these somewhere safe. Each code works once, and they won't be shown again.</p><div style="display:grid;grid-template-columns:repeat(2,max-content);gap:6px 28px;font-family:var(--mono);font-size:13px;padding:14px;border:1px solid var(--border);border-radius:var(--r);background:var(--sunken);user-select:all" id="tfa-codes">${S.ui.recoveryCodes.map(c => `<span>${esc(c)}</span>`).join('')}</div>`
                : `<p class="muted" style="font-size:13px">Your recovery codes were shown when you turned this on. To get new ones, turn two-factor authentication off and on again.</p>`
            }<div style="margin-top:14px">${
              S.ui.tfaOff
                ? `<form data-submit="confirmDisable2fa" class="col" style="gap:10px;max-width:400px"><div class="field"><label class="label" for="tfa-off">Your password, or a code from your authenticator app</label><input type="password" class="input ${S.ui.errors.tfaOff ? 'is-error' : ''}" id="tfa-off" autocomplete="current-password" autofocus>${S.ui.errors.tfaOff ? `<span class="err">${ic('circle-alert', 12)}${esc(S.ui.errors.tfaOff)}</span>` : ''}</div><div class="row"><button class="btn btn-danger" data-a="confirmDisable2fa" id="tfa-off-btn">Turn off</button><button type="button" class="btn btn-ghost" data-a="cancelDisable2fa">Cancel</button></div></form>`
                : `<button class="btn btn-danger-ghost" data-a="disable2fa">Turn off two-factor authentication</button>`
            }</div></div>`
          : S.ui.tfaSetup
            ? `<div class="panel" style="padding:18px;display:flex;gap:20px;flex-wrap:wrap"><div style="width:148px;height:148px;padding:8px;background:#fff;border-radius:8px;border:1px solid var(--border);flex:none" role="img" aria-label="QR code for your authenticator app">${S.ui.tfaSetup.qr.replace('<svg', '<svg width="130" height="130"')}</div>
        <div class="grow col" style="gap:10px;min-width:220px"><div><b>1. Scan the QR code</b><div class="muted" style="font-size:13px">Use 1Password, Authy, or Google Authenticator.</div></div><div><b>2. Enter the 6-digit code</b></div><form data-submit="verify2fa" class="row"><input class="input mono ${S.ui.errors.tfa ? 'is-error' : ''}" id="tfa-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" style="width:130px;letter-spacing:.2em;font-size:15px" autofocus><button class="btn btn-primary" data-a="verify2fa" id="tfa-verify">Verify</button><button type="button" class="btn btn-ghost" data-a="cancel2fa">Cancel</button></form>${S.ui.errors.tfa ? `<span class="err">${ic('circle-alert', 12)}${esc(S.ui.errors.tfa)}</span>` : `<span class="hint">Can't scan it? Enter this key instead: <span class="mono" style="user-select:all">${esc(S.ui.tfaSetup.secret.replace(/(.{4})/g, '$1 ').trim())}</span></span>`}</div></div>`
            : `<div class="panel" style="padding:18px" ><div class="row" style="gap:14px;align-items:flex-start"><span class="ftype" style="--c:var(--amber);width:36px;height:36px">${ic('shield-alert', 18)}</span><div class="grow"><b>Two-factor authentication is off</b><p class="muted" style="margin:4px 0 12px;font-size:13px">Protect your account with a code from an authenticator app in addition to your password.</p>${
                S.ui.tfaAsk
                  ? `<form data-submit="setup2fa" class="col" style="gap:10px;max-width:400px"><div class="field"><label class="label" for="tfa-pw">Your current password</label><input type="password" class="input ${S.ui.errors.tfaPw ? 'is-error' : ''}" id="tfa-pw" autocomplete="current-password" autofocus>${S.ui.errors.tfaPw ? `<span class="err">${ic('circle-alert', 12)}${esc(S.ui.errors.tfaPw)}</span>` : ''}</div><div class="row"><button class="btn btn-primary" data-a="setup2fa" id="tfa-setup">Continue</button><button type="button" class="btn btn-ghost" data-a="cancel2fa">Cancel</button></div></form>`
                  : `<button class="btn btn-primary" data-a="ask2fa" id="tfa-setup">Set up two-factor authentication</button>`
              }</div></div></div>`)
      );
    case 'account': {
      const e = S.ui.errors;
      const owner = me().role === 'Owner';
      return (
        H('Your sign-in email, your data, and closing your account.') +
        `<div class="sblock"><h2>Email</h2>${
          S.ui.emailSent
            ? `<div class="alert info">${ic('mail', 15)}<span>We sent a confirmation link to <b>${esc(S.ui.emailSent)}</b>. You keep signing in with ${esc(me().email)} until you open it.${S.ui.devLink ? ` <button class="link" data-a="openDevLink" id="dev-link">Open the link</button>` : ''}</span></div>`
            : `<form data-submit="requestEmailChange" class="col" style="gap:14px;max-width:400px"><p class="muted" style="margin:0;font-size:13px">You sign in with <b>${esc(me().email)}</b>. We'll send a link to the new address to confirm it, and sign you out everywhere else.</p>
        <div class="field"><label class="label" for="em-new">New email</label><input type="email" class="input ${e.emNew ? 'is-error' : ''}" id="em-new" autocomplete="email">${e.emNew ? `<span class="err">${ic('circle-alert', 12)}${esc(e.emNew)}</span>` : ''}</div>
        <div class="field"><label class="label" for="em-pw">Current password</label><input type="password" class="input ${e.emPw ? 'is-error' : ''}" id="em-pw" autocomplete="current-password">${e.emPw ? `<span class="err">${ic('circle-alert', 12)}${esc(e.emPw)}</span>` : ''}</div>
        <div><button class="btn btn-primary" data-a="requestEmailChange" id="em-save">Change email</button></div></form>`
        }</div>
        <div class="sblock"><h2>Your data</h2><p class="muted" style="font-size:13px">Download your profile, preferences, notifications, the tasks assigned to you and your comments as JSON.${owner ? ' As the owner, the file also includes the whole workspace.' : ''}</p><a class="btn btn-secondary" href="/api/me/export" download id="export-btn">${ic('download', 14)}Download my data</a></div>
        <div class="sblock"><h2>Delete account</h2>${
          owner
            ? `<p class="muted" style="font-size:13px">Owners can't delete their account. Make another member an Owner in <button class="link" data-a="go" data-r="members">Members</button>, then ask them to change your role.</p>`
            : `<form data-submit="deleteAccount" class="col" style="gap:14px;max-width:400px"><p class="muted" style="margin:0;font-size:13px">This removes you from ${esc(D().ws.name)} straight away. Your tasks become unassigned; your comments stay. This can't be undone.</p>
        <div class="field"><label class="label" for="del-pw">Current password</label><input type="password" class="input ${e.delPw ? 'is-error' : ''}" id="del-pw" autocomplete="current-password">${e.delPw ? `<span class="err">${ic('circle-alert', 12)}${esc(e.delPw)}</span>` : ''}</div>
        <div><button class="btn btn-danger" data-a="deleteAccount" id="del-btn">Delete my account</button></div></form>`
        }</div>`
      );
    }
  }
  return page404();
}
/* Settings → API: create and revoke personal keys. A new key's token is shown once, with the
   snippets to use it from the CLI and an MCP client. */
function apiSection() {
  const keys = D().apiKeys || [];
  const fresh = S.ui.newApiKey;
  const err = S.ui.errors.apiName;
  const origin = location.origin;
  const mcp = JSON.stringify(
    { mcpServers: { 'sudo-sapient': { url: `${origin}/api/mcp`, headers: { Authorization: `Bearer ${fresh?.token || 'ssk_…'}` } } } },
    null,
    2,
  );
  return `${
    fresh
      ? `<div class="alert ok" style="margin-bottom:18px;display:block" id="api-new"><div class="row" style="gap:8px;margin-bottom:6px">${ic('circle-check', 15)}<b>Copy “${esc(fresh.key.name)}” now. You won’t see it again.</b></div>
      <div class="row" style="gap:8px"><input class="input mono" id="api-token" readonly value="${esc(fresh.token)}" style="flex:1" aria-label="New API key"><button class="btn btn-primary btn-sm" data-a="copyText" data-text="${esc(fresh.token)}">${ic('copy', 13)}Copy</button><button class="btn btn-ghost btn-sm" data-a="dismissApiKey">Done</button></div>
      <p class="muted" style="font-size:12.5px;margin:12px 0 4px">Terminal: run this, then paste the key when asked (keeps it out of your shell history)</p><pre class="mono" style="margin:0;padding:10px;background:var(--sunken);border-radius:var(--r);font-size:12px;white-space:pre-wrap;user-select:all">sudo-cli login --url ${esc(origin)}</pre>
      <p class="muted" style="font-size:12.5px;margin:12px 0 4px">MCP over HTTP, e.g. Cursor’s <span class="mono">mcp.json</span></p><pre class="mono" style="margin:0;padding:10px;background:var(--sunken);border-radius:var(--r);font-size:12px;white-space:pre-wrap;user-select:all">${esc(mcp)}</pre></div>`
      : ''
  }
  <form data-submit="createApiKey" class="sblock" style="margin-top:0"><h2>New key</h2><div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start;margin-top:10px">
    <div class="field" style="flex:1;min-width:200px"><label class="label" for="api-name">Name</label><input class="input ${err ? 'is-error' : ''}" id="api-name" placeholder="e.g. Laptop CLI, Claude" maxlength="60" value="${esc(S.ui.apiName || '')}">${err ? `<span class="err">${ic('circle-alert', 12)}${esc(err)}</span>` : ''}</div>
    <div class="field"><label class="label" for="api-scope">Access</label><select class="select" id="api-scope" style="width:auto;min-width:150px"><option value="write">Read and write</option><option value="read">Read only</option></select></div>
    <div class="field" style="min-width:170px"><label class="label" for="api-pw">Your password</label><input type="password" class="input ${S.ui.errors.apiPw ? 'is-error' : ''}" id="api-pw" autocomplete="current-password">${S.ui.errors.apiPw ? `<span class="err">${ic('circle-alert', 12)}${esc(S.ui.errors.apiPw)}</span>` : ''}</div>
    <div class="field"><label class="label" for="api-exp">Expires</label><select class="select" id="api-exp" style="width:auto;min-width:120px"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="">Never</option></select></div>
    <div class="field"><span class="label" aria-hidden="true">&nbsp;</span><button class="btn btn-primary" data-a="createApiKey" id="api-create">${ic('plus', 14)}Create key</button></div>
  </div></form>
  <div class="sblock"><h2>Your keys</h2>${
    keys.length
      ? keys
          .map(k => {
            const expired = k.expiresAt && k.expiresAt < Date.now();
            return srow(
              `<span class="row" style="gap:8px">${ic('key-round', 14)}${esc(k.name)}<span class="badge">${k.scope === 'write' ? 'Read and write' : 'Read only'}</span>${expired ? '<span class="badge red">Expired</span>' : ''}</span>`,
              `<span class="mono">${esc(k.prefix)}…</span> · Created ${when(k.createdAt)} · ${k.lastUsedAt ? `Last used ${ago(k.lastUsedAt)}` : 'Never used'}${k.expiresAt && !expired ? ` · Expires ${when(k.expiresAt)}` : ''}`,
              `<button class="btn btn-danger-ghost btn-sm" data-a="revokeApiKey" data-id="${esc(k.id)}">Revoke</button>`,
            );
          })
          .join('')
      : `<p class="faint" style="padding:12px 0">No keys yet.</p>`
  }</div>
  <div class="sblock"><h2>Docs</h2><p class="muted" style="font-size:13px">REST reference and a console to try requests: <a class="link" href="/api/docs" target="_blank" rel="noopener">API docs</a> (<a class="link" href="/api/v1/openapi.json" target="_blank" rel="noopener">OpenAPI</a>). MCP endpoint: <span class="mono" style="user-select:all">${esc(origin)}/api/mcp</span>. Changes made with a key show in Activity as “via” the app that made them.</p></div>`;
}
/* Settings → API → Bots (Owners and Admins): members for automation, with their own role, projects
   and keys, so a release script doesn't borrow a person's key. A new key is shown once. */
const keyOpts = `<select class="select" id="bot-key-scope" style="width:auto;min-width:150px" aria-label="Access"><option value="write">Read and write</option><option value="read">Read only</option></select>
  <select class="select" id="bot-key-exp" style="width:auto;min-width:120px" aria-label="Expires"><option value="90">In 90 days</option><option value="30">In 30 days</option><option value="365">In a year</option><option value="">Never</option></select>`;
function botsSection() {
  const bots = D().bots || [];
  const e = S.ui.errors;
  const fresh = S.ui.newBotKey;
  const open = S.ui.botOpen;
  const projects = D().projects.filter(p => !p.archived);
  const projPick = (name, on = []) =>
    projects.length
      ? `<div class="row" style="gap:6px 14px;flex-wrap:wrap">${projects.map(p => `<label class="row" style="gap:6px;font-size:13px"><input type="checkbox" class="check" name="${name}" value="${esc(p.id)}" ${on.includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div>`
      : '<span class="faint" style="font-size:13px">No projects yet.</span>';
  const roleSel = (id, v = 'Member') =>
    `<select class="select" id="${id}" style="width:auto;min-width:120px" aria-label="Role">${['Member', 'Guest'].map(r => `<option ${r === v ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
  const who = id => (id ? esc(D().members.find(m => m.id === id)?.name || 'Former member') : 'Former member');
  const err = k => (e[k] ? `<span class="err">${ic('circle-alert', 12)}${esc(e[k])}</span>` : '');
  const row = b => {
    const m = b.id === open;
    const head = srow(
      `<span class="row" style="gap:8px">${av(b.id, 'sm', false)}${esc(b.name)}<span class="badge accent bot-badge">Bot</span><span class="badge">${esc(b.role)}</span></span>`,
      `${b.projects.length} project${b.projects.length === 1 ? '' : 's'} · ${b.keys.length} key${b.keys.length === 1 ? '' : 's'} · Created ${when(b.createdAt)}`,
      `<button class="btn btn-secondary btn-sm" data-a="openBot" data-id="${esc(b.id)}" aria-expanded="${m}">${m ? 'Close' : 'Manage'}</button>`,
    );
    if (!m) return head;
    const keys = b.keys.length
      ? b.keys
          .map(k =>
            srow(
              `<span class="row" style="gap:8px">${ic('key-round', 14)}${esc(k.name)}<span class="badge">${k.scope === 'write' ? 'Read and write' : 'Read only'}</span></span>`,
              `<span class="mono">${esc(k.prefix)}…</span> · Created by ${who(k.createdBy)} ${when(k.createdAt)} · ${k.lastUsedAt ? `Last used ${ago(k.lastUsedAt)}` : 'Never used'}${k.expiresAt ? ` · Expires ${when(k.expiresAt)}` : ''}`,
              `<button class="btn btn-danger-ghost btn-sm" data-a="revokeBotKey" data-id="${esc(b.id)}" data-key="${esc(k.id)}">Revoke</button>`,
            ),
          )
          .join('')
      : '<p class="faint" style="padding:8px 0;font-size:13px">No keys yet.</p>';
    return `${head}<div class="panel" style="padding:14px;margin:4px 0 12px" id="bot-panel">
      <form data-submit="saveBot" data-id="${esc(b.id)}" class="col" style="gap:12px">
        <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1;min-width:200px"><label class="label" for="bot-edit-name">Name</label><input class="input ${e.botEdit ? 'is-error' : ''}" id="bot-edit-name" maxlength="80" value="${esc(b.name)}">${err('botEdit')}</div>
        <div class="field"><label class="label" for="bot-edit-role">Role</label>${roleSel('bot-edit-role', b.role)}</div></div>
        <div class="field"><span class="label">Projects</span>${projPick('bot-edit-proj', b.projects)}<span class="hint">Set Can view or Can comment for it in each project’s share dialog, as for a person.</span></div>
        <div class="row"><button class="btn btn-primary btn-sm" data-a="saveBot" data-id="${esc(b.id)}" id="bot-save">Save</button><span class="sp"></span><button type="button" class="btn btn-danger-ghost btn-sm" data-a="removeBot" data-id="${esc(b.id)}">Remove bot</button></div>
      </form>
      <h3 style="font-size:13px;margin:16px 0 4px">Keys</h3>${keys}
      <form data-submit="createBotKey" data-id="${esc(b.id)}" class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start;margin-top:10px">
        <div class="field" style="flex:1;min-width:180px"><label class="label" for="bot-key-name">Key name</label><input class="input ${e.botKey ? 'is-error' : ''}" id="bot-key-name" placeholder="e.g. GitHub Actions" maxlength="60" value="${esc(S.ui.botKeyName || '')}">${err('botKey')}</div>
        <div class="field"><span class="label">Access</span><span class="row" style="gap:8px">${keyOpts}</span></div>
        <div class="field" style="min-width:170px"><label class="label" for="bot-key-pw">Your password</label><input type="password" class="input ${e.botKeyPw ? 'is-error' : ''}" id="bot-key-pw" autocomplete="current-password">${err('botKeyPw')}</div>
        <div class="field"><span class="label" aria-hidden="true">&nbsp;</span><button class="btn btn-primary" data-a="createBotKey" data-id="${esc(b.id)}" id="bot-key-create">${ic('plus', 14)}Create key</button></div>
      </form></div>`;
  };
  return `<div class="sblock" id="bots"><h2>Bots</h2><p class="muted" style="font-size:13px;margin:4px 0 12px">For release scripts, CI and internal tools. A bot is a member with its own role and projects that acts only through its keys: it can’t sign in, gets no notifications, and its changes show as the bot in Activity. Removing the admin who made a key doesn’t revoke it.</p>
  ${
    fresh
      ? `<div class="alert ok" style="margin-bottom:14px;display:block" id="bot-new-key"><div class="row" style="gap:8px;margin-bottom:6px">${ic('circle-check', 15)}<b>Copy “${esc(fresh.key.name)}” for ${esc(fresh.bot)} now. You won’t see it again.</b></div>
      <div class="row" style="gap:8px"><input class="input mono" id="bot-token" readonly value="${esc(fresh.token)}" style="flex:1" aria-label="New bot key"><button class="btn btn-primary btn-sm" data-a="copyText" data-text="${esc(fresh.token)}">${ic('copy', 13)}Copy</button><button class="btn btn-ghost btn-sm" data-a="dismissBotKey">Done</button></div></div>`
      : ''
  }
  ${bots.map(row).join('') || '<p class="faint" style="padding:8px 0">No bots yet.</p>'}
  <form data-submit="createBot" class="col" style="gap:12px;margin-top:14px"><h3 style="font-size:13px;margin:0">New bot</h3>
    <div class="row" style="gap:10px;flex-wrap:wrap;align-items:flex-start"><div class="field" style="flex:1;min-width:200px"><label class="label" for="bot-name">Name</label><input class="input ${e.botName ? 'is-error' : ''}" id="bot-name" placeholder="e.g. Release Bot" maxlength="80" value="${esc(S.ui.botName || '')}">${err('botName')}</div>
    <div class="field"><label class="label" for="bot-role">Role</label>${roleSel('bot-role')}</div></div>
    <div class="field"><span class="label">Projects</span>${projPick('bot-proj')}<span class="hint">As a Member it also sees every project open to the workspace; as a Guest only these.</span></div>
    <div><button class="btn btn-primary" data-a="createBot" id="bot-create">${ic('bot', 14)}Create bot</button></div>
  </form></div>`;
}
export function strengthMeter(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (pw.length >= 12) s++;
  if (/[0-9]/.test(pw) && /[a-zA-Z]/.test(pw)) s++;
  if (/[^a-zA-Z0-9]/.test(pw)) s++;
  const c = ['var(--red)', 'var(--red)', 'var(--amber)', 'var(--green)', 'var(--green)'][s];
  const n = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s];
  return pw
    ? `<div class="row" style="gap:8px"><div class="strength grow" aria-hidden="true">${[0, 1, 2, 3].map(i => `<i class="${i < s ? 'on' : ''}" style="--c:${c}"></i>`).join('')}</div><span style="font-size:11.5px;color:${c};width:60px;text-align:right">${n}</span></div>`
    : '';
}
