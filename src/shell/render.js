/* =====================================================================
   SHELL: render loop, router, sidebar, topbar, skeletons, filter engine
   ===================================================================== */
import { $, $$ } from '../core/utils.js';
import { D, S, mem, proj, task, team } from '../core/store.js';
import { parseHash, withTask } from '../core/links.js';
import { applyPrefs } from '../core/theme.js';
import { enhanceSelects, selectMenu } from '../ui/select.js';
import { renderShell } from './layout.js';
import { PTABS } from '../pages/project.js';
import { tlAfter } from '../views/timeline.js';
import { renderLayer } from '../overlays/drawer.js';
import { placePop } from '../overlays/popovers.js';
import { renderAuth } from '../pages/auth.js';

export const ROUTE_NAMES = {
  home: 'Home',
  inbox: 'Inbox',
  mytasks: 'My Tasks',
  favorites: 'Favorites',
  notifications: 'Notifications',
  search: 'Search',
  overview: 'Overview',
  projects: 'Projects',
  tasks: 'Tasks',
  calendar: 'Calendar',
  timeline: 'Timeline',
  members: 'Members',
  member: 'Member',
  teams: 'Teams',
  team: 'Team',
  activity: 'Activity',
  settings: 'Settings',
  system: 'Design system',
  states: 'System states',
  archive: 'Archive',
};
export const ROUTE_ICONS = {
  home: 'house',
  inbox: 'inbox',
  mytasks: 'circle-check',
  favorites: 'star',
  notifications: 'bell',
  search: 'search',
  overview: 'layout-dashboard',
  projects: 'folder-kanban',
  tasks: 'list-checks',
  calendar: 'calendar',
  timeline: 'chart-gantt',
  members: 'users',
  activity: 'activity',
  teams: 'users',
  settings: 'settings',
  system: 'component',
  states: 'layers',
  archive: 'archive',
};

/* ---------- URL ↔ route ----------
   #home · #project/web/list · #member/<id> · #team/<id> · #settings/<section>, and the open task
   after the page (#project/web/list?task=WEB-12; see core/links.js). */
export function hashFor(route, params = {}) {
  if (route === 'project') {
    const p = proj(params.id);
    return p ? `project/${p.key.toLowerCase()}${params.tab ? '/' + params.tab : ''}` : 'projects';
  }
  if ((route === 'member' || route === 'team') && params.id) return `${route}/${params.id}`;
  if (route === 'settings' && params.sec) return `settings/${params.sec}`;
  return route;
}
/* Route parameters come from a URL anyone can send, so only ids and known tab / section names pass. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const okTab = t => PTABS.some(x => x[0] === t) || /^v:[A-Za-z0-9_-]{1,64}$/.test(t);
export function routeFromHash(h) {
  let parts;
  try {
    parts = h.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
  const [r, a, b] = parts;
  if (r === 'project') {
    const p = D().projects.find(x => x.key.toLowerCase() === a);
    return p ? { route: 'project', params: { id: p.id, tab: b && okTab(b) ? b : 'board' } } : null;
  }
  if (r === 'member' || r === 'team') return ID_RE.test(a || '') ? { route: r, params: { id: a } } : null;
  if (r === 'settings') return { route: 'settings', params: /^[a-z0-9-]{1,40}$/.test(a || '') ? { sec: a } : {} };
  return ROUTE_NAMES[r] && r !== 'member' && r !== 'team' ? { route: r, params: {} } : null;
}
/* On touch screens each open drawer, modal, menu or sidebar opened by a tap has a history entry of
   its own, so the system Back button closes it (actions/back.js sets these). `back` handles a
   popstate (true: nothing to route); `sync` adds or steps back over entries after each render;
   `added` is told when a page's entry is added (a tap adds one entry at most); `linkEntry` is the
   state for an entry a link made over the page shown; `replacing` is told before a page takes over
   the open layer's entry. */
export const layers = {
  back: () => false,
  sync: () => {},
  onEntry: () => false,
  added: () => {},
  linkEntry: (/** @type {boolean} */ _samePage) => pageEntry(),
  replacing: () => {},
};
/* Every history entry the app writes for a page has a state like this (a layer's: `{ layer: n }`,
   see actions/back.js), with an id of its own. One without a state was made by a link (a
   notification or URL Android hands the open app, a hash typed or pasted): the popstate it fires is
   left alone, and the hashchange after it opens the link (openLink in actions/session.js). */
let seq = 0;
export const entryId = () => `${Date.now().toString(36)}.${(++seq).toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
export const pageEntry = () => ({ page: true, id: entryId() });
/* The hash for what's shown: the page, and the task open over it. */
export const urlHash = () => withTask(hashFor(S.ui.route, S.ui.params), S.ui.drawer ? task(S.ui.drawer)?.key : null);
function writeHash(route, params, replace) {
  const h = '#' + hashFor(route, params);
  if (location.hash === h) return;
  const url = location.pathname + location.search + h;
  // Going somewhere from an open layer takes over its entry, so Back returns to the page, not to it.
  if (layers.onEntry()) {
    layers.replacing();
    history.replaceState(pageEntry(), '', url);
  } else if (replace) history.replaceState(history.state?.page ? history.state : pageEntry(), '', url);
  else {
    history.pushState(pageEntry(), '', url);
    layers.added();
  }
}
/* After each render the URL names the open task, on the entry shown, adding no history entry. On a
   touch screen that is usually the open layer's entry (layers.sync has just added it in a tap), so
   the page's own entry under it keeps the page's URL and Back goes there; an entry Back lands on is
   rewritten to what's still open. An entry a link made is left for the link to open first. */
function showUrl() {
  if (S.ui.auth || !history.state) return;
  const h = '#' + urlHash();
  if (location.hash !== h) history.replaceState(history.state, '', location.pathname + location.search + h);
}
// Browser back / forward: follow the URL without adding another history entry. The open task
// isn't followed: on a desktop it stays open as before, and showUrl then writes it into the URL.
addEventListener('popstate', () => {
  if (layers.back()) return;
  if (S.ui.auth || !history.state) return;
  const r = routeFromHash(parseHash(location.hash).page);
  if (r) go(r.route, r.params, { back: true, fromUrl: true });
});

export function go(route, params = {}, opt = {}) {
  if (route === 'project' && !params.tab) params.tab = 'board';
  if (!opt.back) S.ui.history.push({ route: S.ui.route, params: S.ui.params });
  const same = S.ui.route === route && JSON.stringify(S.ui.params) === JSON.stringify(params);
  if (!opt.fromUrl) writeHash(route, params, opt.back || same);
  S.ui.route = route;
  S.ui.params = params;
  S.ui.mnav = false;
  S.ui.sel.clear();
  S.ui.pop = null;
  S.ui.composer = null;
  S.ui.editCell = null;
  if (!opt.keepDrawer && S.ui.drawer && innerWidth < 900) S.ui.drawer = null;
  // Pages render instantly; motion (not a fake wait) carries the transition.
  clearTimeout(go._t);
  S.ui.loading = false;
  if (!same) fxSet(opt.tab ? { tab: true, tabs: true } : { route: true, tabs: true });
  render();
  const c = $('.content');
  if (c && !same) c.scrollTop = 0;
}

/* One-shot motion flags: read by templates during the next render, then cleared, so full re-renders never replay them. */
export const reduceMotion = () => S.prefs.motion === 'reduce' || (S.prefs.motion !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
export function fxSet(o) {
  S.ui.fx = Object.assign(S.ui.fx || {}, o);
}
export const fxc = (kind, id) => (S.ui.fx && S.ui.fx[kind] === id ? ' fx-' + kind : '');
/* Focus survives full re-renders: every control is addressable by its data-* identity. */
export const FKEYS = ['a', 'id', 'r', 'tab', 'pop', 'ctx', 'k', 'v', 'sec', 'i', 'field', 'sid', 'key', 'e', 'f', 'dragCard', 'taskRow'];
export function focusKey(el) {
  if (!el || el === document.body || !el.tagName) return null;
  if (el.id) return '#' + CSS.escape(el.id);
  const d = el.dataset || {};
  const parts = FKEYS.filter(k => d[k] != null).map(k => `[data-${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}="${CSS.escape(d[k])}"]`);
  return parts.length ? el.tagName.toLowerCase() + parts.join('') : null;
}
export function tryFocus(key) {
  if (!key) return false;
  let el;
  try {
    el = document.querySelector(key);
  } catch {
    return false;
  }
  if (el && el.offsetParent !== null) {
    el.focus({ preventScroll: true });
    return document.activeElement === el;
  }
  return false;
}
export function pageTitle() {
  const u = S.ui;
  if (u.auth) return 'Sudo Sapient';
  let t = ROUTE_NAMES[u.route] || 'Not found';
  if (u.route === 'project' && proj(u.params.id)) t = `${(PTABS.find(x => x[0] === u.params.tab) || [0, 'Saved view'])[1]} · ${proj(u.params.id).name}`;
  if (u.route === 'member' && mem(u.params.id)) t = mem(u.params.id).name;
  if (u.route === 'team' && team(u.params.id)) t = team(u.params.id).name;
  return `${t} · ${D().ws.name}`;
}
/* Anything clickable is keyboard-reachable: non-native [data-a] controls get a role and a tab stop.
   Not a tap area (`data-tap-area`): a bigger target for a button inside it, which a keyboard and a
   screen reader use instead (a board card and its title). Made a button, it would hide its other
   buttons from a screen reader. */
export function makeFocusable() {
  for (const el of document.querySelectorAll(
    '[data-a]:not(button):not(a):not(input):not(label):not(select):not(textarea):not([tabindex]):not([data-tap-area])',
  )) {
    if (el.matches('.scrim,.modal-wrap,.drawer-scrim,.side-scrim')) continue;
    el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', el.dataset.a === 'go' ? 'link' : 'button');
  }
}
export function render() {
  applyPrefs();
  const prevOv = render._ov || {};
  const ov = { pop: !!S.ui.pop, modals: S.ui.modals.length, drawer: S.ui.drawer, pal: !!S.ui.palette, sub: !!S.ui.subOpen };
  // Entrances animate only on the render where the surface first appears.
  const fx = S.ui.fx || (S.ui.fx = {});
  if (ov.drawer && prevOv.drawer !== ov.drawer) fx.drawer = true;
  if (ov.modals > (prevOv.modals || 0)) fx.modal = ov.modals;
  const popSig = S.ui.pop ? [S.ui.pop.type, S.ui.pop.id, S.ui.pop.i, S.ui.pop.field, S.ui.pop.ctx, S.ui.pop.key].join('|') : '';
  if (popSig && popSig !== render._popSig) fx.pop = true;
  render._popSig = popSig;
  if (S.ui.sel.size && !render._selN) fx.bulk = true;
  render._selN = S.ui.sel.size;
  const authSig = S.ui.auth ? S.ui.auth + (S.ui.auth === 'onboarding' ? S.ui.onb : '') : '';
  if (authSig && authSig !== render._authSig) fx[S.ui.auth === 'onboarding' ? 'step' : 'auth'] = true;
  render._authSig = authSig;
  const a = document.activeElement;
  const fid = a && a.id;
  let s0 = null,
    s1 = null;
  const fkey = focusKey(a);
  try {
    s0 = a.selectionStart;
    s1 = a.selectionEnd;
  } catch {
    /* not supported here; safe to skip */
  }
  const keep = $$('[data-keep]').map(el => [el.dataset.keep, el.scrollTop, el.scrollLeft]);
  // A field marked data-hold is read only when its form is saved (Settings → Profile): what's
  // typed in it stays through a render, unless what it shows changed meanwhile (it was saved, or
  // changed elsewhere).
  const held = $$('[data-hold]').map(el => [el.id, /** @type {HTMLInputElement} */ (el).value, /** @type {HTMLInputElement} */ (el).defaultValue]);
  $('#app').innerHTML = S.ui.auth ? renderAuth() : renderShell();
  $('#layer').innerHTML = renderLayer();
  makeFocusable();
  held.forEach(([id, v, was]) => {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
    if (el?.dataset.hold != null && el.defaultValue === was) el.value = v;
  });
  keep.forEach(([k, t, l]) => {
    const el = document.querySelector(`[data-keep="${CSS.escape(k)}"]`);
    if (el) {
      el.scrollTop = t;
      el.scrollLeft = l;
    }
  });
  showOpenTabs();
  if (fid) {
    const el = document.getElementById(fid);
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try {
        if (s0 != null) el.setSelectionRange(s0, s1);
      } catch {
        /* not supported here; safe to skip */
      }
    }
  }
  // Return focus to whatever opened a surface that just closed; otherwise keep the control that had it.
  const lost = () => !document.activeElement || document.activeElement === document.body;
  if (prevOv.modals > ov.modals) {
    const k = S.ui.modalOpeners.splice(ov.modals).shift();
    if (lost()) tryFocus(k);
  }
  if (prevOv.pop && !ov.pop && lost()) tryFocus(S.ui.popOpener);
  if (prevOv.drawer && !ov.drawer && lost()) tryFocus(S.ui.drawerOpener);
  if (prevOv.pal && !ov.pal && lost()) tryFocus(S.ui.palOpener);
  if (prevOv.sub && !ov.sub && lost()) tryFocus('.drawer .subt [data-sid="' + (S.ui.lastSub || '') + '"]');
  if (lost() && fkey) tryFocus(fkey);
  render._ov = ov;
  const played = S.ui.fx;
  S.ui.fx = {};
  if (played.route && !reduceMotion()) countUp();
  const title = pageTitle();
  if (document.title !== title) {
    document.title = title;
    const live = document.getElementById('sr-live');
    if (live && !S.ui.loading) live.textContent = title.split(' · ').slice(0, -1).join(', ');
  }
  afterRender();
  layers.sync();
  showUrl();
}
export function afterRender() {
  selectMenu.close();
  enhanceSelects();
  placePop();
  $$('textarea[data-autosize]').forEach(autosize);
  const pal = $('#pal-in');
  if (pal && document.activeElement !== pal && !S.ui.pop) pal.focus();
  if ((S.ui.route === 'project' && S.ui.params.tab === 'timeline') || S.ui.route === 'timeline') tlAfter();
}
/* Headline numbers count up once when a dashboard is entered. */
export function countUp() {
  for (const el of document.querySelectorAll('.fx-route .stat .v')) {
    const m = el.textContent.match(/^(\d+)(%?)$/);
    if (!m) continue;
    const to = +m[1],
      suf = m[2];
    if (to < 2) continue;
    const t0 = performance.now(),
      dur = 520;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      if (!el.isConnected) return;
      el.textContent = Math.round(to * e) + suf;
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = '0' + suf;
    requestAnimationFrame(step);
  }
}
export function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
/* A strip of tabs too wide for the screen scrolls sideways (Settings and a project's views on a phone).
   Bring the open tab into view when it changes, or the strip is new. A strip that keeps its scroll
   across renders (data-keep) is otherwise left where it was scrolled to; one drawn anew each time
   is brought to its open tab each time, rather than left past the edge. */
const openTabs = new Map(); // data-keep: the open tab last brought into view in that strip
function showOpenTabs() {
  const seen = new Set();
  for (const on of $$('.tabs > .tab.on, .set-nav > .sitem.on')) {
    const strip = /** @type {HTMLElement} */ (on.parentElement);
    const k = strip.dataset.keep,
      v = /** @type {HTMLElement} */ (on).dataset.tab || /** @type {HTMLElement} */ (on).dataset.sec || on.textContent;
    if (k) {
      seen.add(k);
      const same = openTabs.get(k) === v;
      openTabs.set(k, v);
      if (same) continue;
    }
    if (strip.scrollWidth <= strip.clientWidth) continue;
    const s = strip.getBoundingClientRect(),
      r = on.getBoundingClientRect();
    if (r.left < s.left || r.right > s.right) strip.scrollLeft += r.left - s.left - (s.width - r.width) / 2;
  }
  // A strip that's gone starts again when it's back.
  for (const k of [...openTabs.keys()]) if (!seen.has(k)) openTabs.delete(k);
}
