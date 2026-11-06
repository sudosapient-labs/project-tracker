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
/* A reload is waiting for the queue to reach the server (see reloadWhenSaved). */
let resyncWhenSaved = false;
/* Ask for a resync (a fresh bootstrap) once every queued change is saved. */
export const reloadWhenSaved = () => (resyncWhenSaved = true);
/* `collection:id` of records restoreSnapshot put back after they were deleted. */
const restoring = new Set();
const hooks = { signedOut: () => {}, resync: () => {} };
export const onSync = h => Object.assign(hooks, h);

const fields = o => new Map(Object.keys(o).map(k => [k, JSON.stringify(o[k])]));
/* List and map fields sent with the value they were edited from, so the server applies only this
   tab's changes to them (server/sync/merge.js): a stale edit can't undo someone else's. */
const MERGED = { projects: ['members', 'perms'], tasks: ['subtasks', 'labels', 'deps'] };
/* Projects I can't open come as stubs; give them the empty fields pages read, in the record and its
   shadow alike, so nothing is sent back for them. */
const fill = (c, v) =>
  c === 'projects' && v && !('desc' in v) ? Object.assign(v, { members: [], desc: '', milestones: [], team: '', due: null, start: null, ...v }) : v;
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/* ---------- lifecycle ---------- */
export function prime(data) {
  shadow = { docs: {} };
  (data.projects || []).forEach(p => fill('projects', p));
  for (const c of COLLS) shadow[c] = new Map((data[c] || []).map(e => [e.id, fields(e)]));
  for (const d of DOCS) shadow.docs[d] = JSON.stringify(data[d] ?? null);
  // Changes the server hasn't confirmed yet stay queued and visible: lay them over the fresh data
  // (and its shadow, as already sent), so reloading while some are still on their way loses none.
  for (const op of [...inflight, ...queue]) replay(data, op);
  stateSent = JSON.stringify(stateBody());
  syncState();
}
/* Apply a queued operation to freshly loaded `data` and the shadow. */
function replay(data, op) {
  if (DOCS.includes(op.c)) {
    data[op.c] = clone(op.v);
    shadow.docs[op.c] = JSON.stringify(data[op.c] ?? null);
    return;
  }
  const arr = data[op.c];
  if (!Array.isArray(arr) || !shadow[op.c]) return;
  const i = arr.findIndex(e => e.id === op.id);
  if (op.k === 'del') {
    if (i >= 0) arr.splice(i, 1);
    shadow[op.c].delete(op.id);
  } else if (op.k === 'put') {
    const v = clone(op.v);
    if (i >= 0) arr[i] = v;
    else if (NEWEST_FIRST.has(op.c)) arr.unshift(v);
    else arr.push(v);
    shadow[op.c].set(op.id, fields(v));
  } else if (i >= 0) {
    // (Gone from the server meanwhile: the server refuses the patch and the record stays gone.)
    Object.assign(arr[i], clone(op.v));
    shadow[op.c].set(op.id, fields(arr[i]));
  }
}
export function stopSync() {
  shadow = null;
  queue = [];
  inflight = [];
  resyncWhenSaved = false;
  restoring.clear();
  clearTimeout(retryT);
  disconnectLive();
}
export const pendingCount = () => queue.length + inflight.length;
/* <html data-sync="saving|saved|offline"> reflects whether every local change has reached the server. */
function syncState() {
  document.documentElement.dataset.sync = S.ui.offline ? 'offline' : queue.length || inflight.length || flushing ? 'saving' : 'saved';
}

/* ---------- local → server ---------- */
/* Queue what changed since the shadow; `send` false only queues (the page is going away). */
export function collect(send = true) {
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
        // A record Undo put back is restored by the server as it was (rules.js `restore`).
        const restore = restoring.delete(`${c}:${e.id}`);
        queue.push({ c, id: e.id, k: 'put', v: clone(e), ...(restore ? { restore } : {}) });
        sh.set(e.id, fields(e));
        continue;
      }
      const set = {};
      const base = {};
      let n = 0;
      for (const k of Object.keys(e)) {
        const j = JSON.stringify(e[k]);
        if (prev.get(k) !== j) {
          set[k] = clone(e[k]);
          if (MERGED[c]?.includes(k) && prev.has(k)) base[k] = JSON.parse(prev.get(k));
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
      if (n) queue.push({ c, id: e.id, k: 'patch', v: set, ...(Object.keys(base).length ? { base } : {}) });
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
  if (queue.length && !S.ui.offline && send) flush();
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
  v = fill(c, v);
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
  // While what pagehide sent is unanswered (back from the back/forward cache), wait for it.
  if (flushing || !queue.length || !shadow || exitSends) return;
  flushing = true;
  inflight = queue.splice(0, BATCH);
  syncState();
  let ops = inflight;
  // A small batch goes with keepalive, so closing the tab doesn't cancel it; pagehide then only
  // has to send what's still queued behind it, in the keepalive budget that's left.
  const body = JSON.stringify({ ops });
  inflightBytes = bytes(body) <= KEEPALIVE_BYTES / 2 ? bytes(body) : 0;
  try {
    const res = await api('POST', '/api/sync', { ops }, { keepalive: inflightBytes > 0 });
    collect(); // move any edits made meanwhile into the queue before adopting server values
    inflight = [];
    inflightBytes = 0;
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
    inflightBytes = 0;
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
  else {
    syncState();
    // A reload that waited for the queue to drain (see commit) can run now.
    if (resyncWhenSaved && !queue.length && !S.ui.offline) {
      resyncWhenSaved = false;
      hooks.resync();
    }
  }
}

/* Send everything now and wait for the server. Resolves with the errors of rejected changes, so
   callers can report them in place of the generic toast. `retry`: try even if the last attempt
   left us offline (the live stream just reconnected, so the server may be back). */
export async function commit({ retry = false } = {}) {
  if (retry && shadow && S.ui.offline) {
    S.ui.offline = false;
    clearTimeout(retryT);
  }
  collect();
  const errs = (errSink = []);
  try {
    while (shadow && (queue.length || flushing) && !S.ui.offline) {
      if (exitSends) await exitSends;
      else if (flushing) await new Promise(r => setTimeout(r, 25));
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

/* Before the tab goes away, send what's still queued with keepalive requests, which outlive the
   page. Browsers allow about 64 KB of keepalive bodies at once (the batch already on its way, sent
   with keepalive by flush, counts too), so as many ops as fit, in order. Nothing leaves the queue
   until the server confirms it: the page may only be going into the back/forward cache, or be
   offline, and then the queue must still be there when it comes back. Sending an op twice is
   harmless (a put becomes an update, a delete of something gone does nothing). */
const KEEPALIVE_BYTES = 60_000;
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;
let inflightBytes = 0;
/* The keepalive requests pagehide sent, until they're all answered. */
let exitSends = null;
export function keepaliveBatches(ops, budget = KEEPALIVE_BYTES) {
  const out = [];
  let left = budget;
  for (const op of ops) {
    const fresh = !out.length || out.at(-1).length >= BATCH;
    // The op and its comma, plus the {"ops":[]} around a new request.
    const cost = bytes(JSON.stringify(op)) + 1 + (fresh ? 12 : 0);
    if (cost > left) break;
    if (fresh) out.push([]);
    out.at(-1).push(op);
    left -= cost;
  }
  return out;
}
addEventListener('pagehide', () => {
  if (!shadow || exitSends) return;
  collect(false);
  const batches = keepaliveBatches(queue, KEEPALIVE_BYTES - inflightBytes);
  if (!batches.length) return;
  exitSends = Promise.allSettled(
    batches.map(async ops => {
      const res = await fetch('/api/sync', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'sudo-sapient', 'x-client-id': CLIENT_ID },
        body: JSON.stringify({ ops }),
      });
      if (!res.ok) return;
      // Confirmed: these are saved (the resync on pageshow brings back what the server made of them).
      const done = new Set(ops);
      queue = queue.filter(op => !done.has(op));
    }),
  ).finally(() => (exitSends = null));
});
// Back from the back/forward cache: once what pagehide sent is answered, catch up (that also sends
// whatever is still queued, then reloads).
addEventListener('pageshow', async e => {
  if (!e.persisted || !shadow) return;
  await exitSends;
  hooks.resync();
});
// Leaving with changes the server hasn't confirmed: ask first (they're sent meanwhile).
addEventListener('beforeunload', e => {
  if (!shadow) return;
  collect();
  if (pendingCount() > 0) {
    e.preventDefault();
    e.returnValue = '';
  }
});
addEventListener('online', () => retryNow());

/* ---------- per-person UI state (prefs, view settings, sidebar) ---------- */
const stateBody = () => ({ prefs: S.prefs, views: S.views, collapsed: !!S.ui.collapsed });
function saveState() {
  try {
    // Display preferences only: name and title are the person's, and the browser may be shared.
    const { name, title, ...cached } = S.prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(cached));
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
        if (shadow && !shadow[c].has(id)) restoring.add(`${c}:${id}`);
      }
    }
  }
  for (const k of DOCS) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) d[k] = before[k];
}
