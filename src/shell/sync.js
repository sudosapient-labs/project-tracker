/* =====================================================================
   SYNC: keeps S.data in step with the server.
   Actions keep mutating S.data directly and calling save(). On save we diff
   S.data against `shadow` (the last state the server confirmed or we sent)
   and queue field-level operations; the queue is sent in order to /api/sync.
   Changes made by other people arrive over /api/events and are merged in,
   skipping fields that still have local edits on the way to the server.
   ===================================================================== */
import { $ } from '../core/utils.js';
import { D, PREFS_KEY, S, saveHooks, task } from '../core/store.js';
import { CLIENT_ID, api } from '../core/api.js';
import { toast } from '../ui/toast.js';
import { render } from './render.js';

export const COLLS = ['members', 'teams', 'projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'savedViews'];
const DOCS = ['ws', 'projOrder', 'recentSearches', 'notifPrefs'];
const NEWEST_FIRST = new Set(['activity', 'notifs', 'files']);
const ALL = 'all';
const BATCH = 200;

let shadow = null;
let queue = [];
let inflight = [];
let flushing = false;
let retryT = null;
let retryMs = 1000;
let stateSent = '';
let errSink = null;
const hooks = { signedOut: () => {}, resync: () => {} };
export const onSync = h => Object.assign(hooks, h);

const fields = o => new Map(Object.keys(o).map(k => [k, JSON.stringify(o[k])]));
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/* ---------- lifecycle ---------- */
export function prime(data) {
  shadow = { docs: {} };
  for (const c of COLLS) shadow[c] = new Map((data[c] || []).map(e => [e.id, fields(e)]));
  for (const d of DOCS) shadow.docs[d] = JSON.stringify(data[d] ?? null);
  queue = [];
  stateSent = JSON.stringify(stateBody());
  syncState();
}
export function stopSync() {
  shadow = null;
  queue = [];
  clearTimeout(retryT);
  disconnectLive();
}
export const pendingCount = () => queue.length + inflight.length;
/* <html data-sync="saving|saved|offline"> reflects whether every local change has reached the server. */
function syncState() {
  document.documentElement.dataset.sync = S.ui.offline ? 'offline' : queue.length || inflight.length || flushing ? 'saving' : 'saved';
}

/* ---------- local → server ---------- */
export function collect() {
  if (!shadow) return;
  const d = D();
  for (const c of COLLS) {
    const sh = shadow[c];
    const seen = new Set();
    for (const e of d[c] || []) {
      if (!e?.id) continue;
      seen.add(e.id);
      const prev = sh.get(e.id);
      if (!prev) {
        queue.push({ c, id: e.id, k: 'put', v: clone(e) });
        sh.set(e.id, fields(e));
        continue;
      }
      const set = {};
      let n = 0;
      for (const k of Object.keys(e)) {
        const j = JSON.stringify(e[k]);
        if (prev.get(k) !== j) {
          set[k] = clone(e[k]);
          prev.set(k, j);
          n++;
        }
      }
      for (const k of [...prev.keys()])
        if (!(k in e)) {
          set[k] = null;
          prev.delete(k);
          n++;
        }
      if (n) queue.push({ c, id: e.id, k: 'patch', v: set });
    }
    for (const id of [...sh.keys()])
      if (!seen.has(id)) {
        queue.push({ c, id, k: 'del' });
        sh.delete(id);
      }
  }
  for (const k of DOCS) {
    const j = JSON.stringify(d[k] ?? null);
    if (j !== shadow.docs[k]) {
      queue.push({ c: k, k: 'put', v: clone(d[k]) });
      shadow.docs[k] = j;
    }
  }
  if (queue.length && !S.ui.offline) flush();
  else syncState();
}

/* Fields of a record that still have unconfirmed local edits. */
function pendingKeys(c, id) {
  let out = null;
  for (const op of [...inflight, ...queue]) {
    if (op.c !== c || op.id !== id) continue;
    if (op.k === 'del' || !op.v || typeof op.v !== 'object' || Array.isArray(op.v)) return ALL;
    out ||= new Set();
    Object.keys(op.v).forEach(k => out.add(k));
  }
  return out;
}

/* Take the server's version of a record (or doc), keeping fields with pending local edits.
   Returns whether anything visible changed. */
function adopt(c, id, v) {
  if (!shadow) return false;
  const d = D();
  if (DOCS.includes(c)) {
    if (v == null || [...inflight, ...queue].some(op => op.c === c)) return false;
    if (c === 'ws') {
      const { onboarded, ...rest } = v;
      v = rest;
    }
    const j = JSON.stringify(v);
    shadow.docs[c] = j;
    if (JSON.stringify(d[c]) === j) return false;
    d[c] = v;
    return true;
  }
  if (!COLLS.includes(c)) return false;
  const arr = d[c];
  const i = arr.findIndex(e => e.id === id);
  const pend = pendingKeys(c, id);
  if (pend === ALL) return false;
  if (v == null) {
    shadow[c].delete(id);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  }
  if (i < 0) {
    if (NEWEST_FIRST.has(c)) arr.unshift(v);
    else arr.push(v);
    shadow[c].set(id, fields(v));
    if (c === 'projects' && !d.projOrder.includes(id)) {
      d.projOrder.unshift(id);
      shadow.docs.projOrder = JSON.stringify(d.projOrder);
    }
    return true;
  }
  // Merge in place: overlays and modals hold references to these objects.
  const e = arr[i];
  const sh = shadow[c].get(id) || new Map();
  let changed = false;
  for (const k of new Set([...Object.keys(e), ...Object.keys(v)])) {
    if (pend?.has(k)) continue;
    if (k in v) {
      const j = JSON.stringify(v[k]);
      if (JSON.stringify(e[k]) !== j) {
        e[k] = v[k];
        changed = true;
      }
      sh.set(k, j);
    } else {
      delete e[k];
      sh.delete(k);
      changed = true;
    }
  }
  shadow[c].set(id, sh);
  return changed;
}

export async function flush() {
  if (flushing || !queue.length || !shadow) return;
  flushing = true;
  inflight = queue.splice(0, BATCH);
  syncState();
  let ops = inflight;
  try {
    const res = await api('POST', '/api/sync', { ops });
    collect(); // move any edits made meanwhile into the queue before adopting server values
    inflight = [];
    online();
    const errs = [];
    let changed = false;
    res.results.forEach((r, i) => {
      if (!r.ok) errs.push(r.error);
      changed = adopt(ops[i].c, ops[i].id, r.v) || changed;
    });
    if (res.links?.length) S.ui.devLinks = res.links;
    errSink?.push(...errs);
    if (errs.length && !errSink) toast(errs[0] + (errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''), { kind: 'err', ms: 6000 });
    if (changed) refresh();
  } catch (e) {
    inflight = [];
    if (e.status === 401) hooks.signedOut(e);
    else if (e.offline || e.status >= 500 || e.status === 429) {
      queue.unshift(...ops);
      offline();
    } else {
      toast(e.message, { kind: 'err' });
      hooks.resync();
    }
  } finally {
    flushing = false;
  }
  if (queue.length && !S.ui.offline) flush();
  else syncState();
}

/* Send everything now and wait for the server. Resolves with the errors of rejected changes, so
   callers can report them in place of the generic toast. */
export async function commit() {
  collect();
  const errs = (errSink = []);
  try {
    while (shadow && (queue.length || flushing) && !S.ui.offline) {
      if (flushing) await new Promise(r => setTimeout(r, 25));
      else await flush();
    }
  } finally {
    errSink = null;
  }
  if (S.ui.offline) errs.push("You're offline. Your changes will be saved when you reconnect.");
  return errs;
}

function offline() {
  if (!S.ui.offline) {
    S.ui.offline = true;
    render();
  }
  syncState();
  clearTimeout(retryT);
  retryT = setTimeout(retryNow, retryMs);
  retryMs = Math.min(retryMs * 2, 30_000);
}
function online() {
  retryMs = 1000;
  clearTimeout(retryT);
  if (S.ui.offline) {
    S.ui.offline = false;
    render();
    toast('Back online. All changes are synced.');
  }
}
export async function retryNow() {
  if (!shadow) return;
  S.ui.offline = false;
  if (queue.length) await flush();
  else
    try {
      await api('GET', '/api/auth/session');
      online();
    } catch {
      offline();
    }
  if (!live && shadow) connectLive();
}

/* Before the tab goes away, send whatever is still queued. */
addEventListener('pagehide', () => {
  collect();
  if (!queue.length) return;
  fetch('/api/sync', {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'gr8r', 'x-client-id': CLIENT_ID },
    body: JSON.stringify({ ops: queue.splice(0, BATCH) }),
  }).catch(() => {});
});
addEventListener('online', () => retryNow());

/* ---------- per-person UI state (prefs, view settings, sidebar) ---------- */
const stateBody = () => ({ prefs: S.prefs, views: S.views, collapsed: !!S.ui.collapsed });
function saveState() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs));
  } catch {
    /* storage blocked: the server copy is the one that matters */
  }
  if (!shadow) return;
  const body = stateBody();
  const j = JSON.stringify(body);
  if (j === stateSent) return;
  stateSent = j;
  api('PUT', '/api/me/state', body).catch(() => (stateSent = ''));
}

saveHooks.onSave = () => {
  collect();
  saveState();
};

/* ---------- server → local ---------- */
let live = null;
let liveDelay = 1000;
let liveT = null;
let missed = false;

export function connectLive() {
  disconnectLive();
  const es = new EventSource(`/api/events?client=${CLIENT_ID}`);
  live = es;
  es.addEventListener('hello', () => {
    liveDelay = 1000;
    if (missed) {
      missed = false;
      hooks.resync();
    }
  });
  es.addEventListener('changes', e => applyRemote(JSON.parse(e.data)));
  es.addEventListener('resync', () => hooks.resync());
  es.onerror = () => {
    if (live !== es) return;
    es.close();
    live = null;
    missed = true;
    api('GET', '/api/auth/session')
      .then(s => {
        if (!s.user || s.user.twoFactorPending) return hooks.signedOut();
        liveT = setTimeout(connectLive, liveDelay);
      })
      .catch(() => {
        offline();
        liveT = setTimeout(connectLive, liveDelay);
      });
    liveDelay = Math.min(liveDelay * 2, 30_000);
  };
}
export function disconnectLive() {
  clearTimeout(liveT);
  if (live) live.close();
  live = null;
}

export function applyRemote(list) {
  if (!shadow) return;
  collect();
  let changed = false;
  for (const ch of list) {
    changed = adopt(ch.c, ch.id, ch.v) || changed;
    if (ch.c === 'projects' && ch.v == null) {
      D().projOrder = D().projOrder.filter(x => x !== ch.id);
      shadow.docs.projOrder = JSON.stringify(D().projOrder);
    }
  }
  if (S.ui.drawer && !task(S.ui.drawer)) S.ui.drawer = null;
  if (changed) refresh();
}

/* Re-render for changes that came from elsewhere, without disturbing someone mid-edit or mid-drag. */
let refreshT = null;
function refresh() {
  clearTimeout(refreshT);
  const a = document.activeElement;
  const editing = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && a.type !== 'checkbox';
  if (editing) {
    a.addEventListener('blur', () => setTimeout(refresh, 0), { once: true });
    return;
  }
  if ($('.dragging') || S.ui.pop?.type === 'date') {
    refreshT = setTimeout(refresh, 300);
    return;
  }
  render();
}

/* ---------- undo that only rewinds what the action changed ---------- */
/* Take before an action; the matching after-state is captured once the action has run. Restoring
   puts back only the records that action touched, so other people's edits made in between stay. */
export function takeSnapshot() {
  const snap = { before: JSON.stringify(S.data), after: null };
  setTimeout(() => (snap.after = JSON.stringify(S.data)), 0);
  return snap;
}
export function restoreSnapshot(snap) {
  const before = JSON.parse(snap.before);
  const after = JSON.parse(snap.after || JSON.stringify(S.data));
  const d = D();
  for (const c of COLLS) {
    const b = new Map((before[c] || []).map(e => [e.id, e]));
    const a = new Map((after[c] || []).map(e => [e.id, e]));
    for (const id of new Set([...b.keys(), ...a.keys()])) {
      if (JSON.stringify(b.get(id)) === JSON.stringify(a.get(id))) continue;
      const i = d[c].findIndex(e => e.id === id);
      if (!b.has(id)) {
        if (i >= 0) d[c].splice(i, 1);
      } else if (i >= 0) d[c][i] = b.get(id);
      else {
        // Put it back where it was relative to its old neighbours.
        const pos = (before[c] || []).findIndex(e => e.id === id);
        d[c].splice(Math.min(pos, d[c].length), 0, b.get(id));
      }
    }
  }
  for (const k of DOCS) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) d[k] = before[k];
}
