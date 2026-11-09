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
/* List and map fields (MERGED) are sent with the value they were edited from, so the server applies
   only this tab's changes to them: a stale edit can't undo someone else's. */
import { MERGED, mergeField } from '../core/merge.js';

export const COLLS = ['members', 'teams', 'projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'savedViews'];
const DOCS = ['ws', 'projOrder', 'recentSearches', 'notifPrefs'];
const NEWEST_FIRST = new Set(['activity', 'notifs', 'files']);
const ALL = 'all';
const BATCH = 200;

let shadow = null;
let queue = [];
/* Queued ops pagehide has sent with keepalive: they stay queued until answered, but are sealed. */
const keptAlive = new WeakSet();
let inflight = [];
let flushing = false;
let retryT = null;
let retryMs = 1000;
let stateSent = '';
/* Where commit() calls waiting for the queue collect the errors of refused changes. Each one gets
   every error (none can tell which changes are its own); with none waiting, errors are toasted. */
const errSinks = new Set();
/* A reload is waiting for the queue to reach the server (see reloadWhenSaved). */
let resyncWhenSaved = false;
/* Ask for a resync (a fresh bootstrap) once every queued change is saved. */
export const reloadWhenSaved = () => (resyncWhenSaved = true);
/* Records restoreSnapshot put back after they were deleted: `collection:id` → the record as it was. */
const restoring = new Map();
/* What the server had of a record when this tab queued its deletion: `collection:id` → its shadow
   fields (see collect: an Undo of the delete restores the server's copy). */
const gone = new Map();
/* Records someone else changed while a change of ours to them was on its way (see settle). */
const crossed = new Set();
const hooks = { signedOut: () => {}, otherUser: () => {}, stillMe: () => true, resync: () => {}, descConflict: () => false };
export const onSync = h => Object.assign(hooks, h);

const fields = o => new Map(Object.keys(o).map(k => [k, JSON.stringify(o[k])]));
/* Projects I can't open come as stubs; give them the empty fields pages read, in the record and its
   shadow alike, so nothing is sent back for them. */
const fill = (c, v) =>
  c === 'projects' && v && !('desc' in v) ? Object.assign(v, { members: [], desc: '', milestones: [], team: '', due: null, start: null, ...v }) : v;
const clone = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const keyOf = (c, id) => `${c}:${id}`;
/* Whose changes these are: the server refuses them if the session now belongs to someone else (a
   sign-in in another tab), so a stale tab can't save its queue as the new person. */
const who = () => (S.ui.me?.id ? { 'x-sudo-user': S.ui.me.id } : {});

/* ---------- lifecycle ---------- */
export function prime(data) {
  shadow = { docs: {} };
  (data.projects || []).forEach(p => fill('projects', p));
  for (const c of COLLS) shadow[c] = new Map((data[c] || []).map(e => [e.id, fields(e)]));
  for (const d of DOCS) shadow.docs[d] = JSON.stringify(data[d] ?? null);
  // First what the server did while this data was loading, in the order it reached this tab: our
  // changes it confirmed and other people's from the live stream. The data may have been read
  // before or after any of them; laid over it in that order, each record ends at its latest.
  for (const op of landed || []) replay(data, op, true);
  landed = null;
  // Then the changes the server hasn't confirmed yet: they stay queued and visible (and in the
  // shadow, as already sent), so reloading while some are still on their way loses none.
  for (const op of [...inflight, ...queue]) replay(data, op);
  stateSent = JSON.stringify(stateBody());
  syncState();
}
/* While a reload's bootstrap is loading, what the server saved meanwhile (as ops), for prime. */
let landed = null;
/* Call before fetching the bootstrap a reload will prime with; `false` stops (the reload failed). */
export function loadingFresh(on = true) {
  landed = on && shadow ? [] : null;
}
const asSaved = ({ c, id }, v) =>
  DOCS.includes(c) ? (v == null ? null : { c, k: 'put', v }) : v == null ? { c, id, k: 'del' } : { c, id, k: 'put', v: fill(c, clone(v)) };
/* The server's state of a record (or doc) reached this tab: note it for a bootstrap still loading. */
function land(c, id, v) {
  if (!landed || !(COLLS.includes(c) || DOCS.includes(c))) return;
  if (c === 'ws' && v) {
    const { onboarded, ...rest } = v;
    v = rest;
  }
  const op = asSaved({ c, id }, v);
  if (op) landed.push(op);
}
/* Apply an op to freshly loaded `data` and the shadow. `saved`: the server's own state of the record. */
function replay(data, op, saved = false) {
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
  // A project that came or went keeps the sidebar order in step, as adopt does.
  if (saved && op.c === 'projects' && Array.isArray(data.projOrder)) {
    const has = data.projOrder.includes(op.id);
    if (op.k === 'del' && has) data.projOrder = data.projOrder.filter(x => x !== op.id);
    else if (op.k === 'put' && !has) data.projOrder.unshift(op.id);
    shadow.docs.projOrder = JSON.stringify(data.projOrder);
  }
}
export function stopSync() {
  shadow = null;
  queue = [];
  inflight = [];
  landed = null;
  resyncWhenSaved = false;
  restoring.clear();
  gone.clear();
  crossed.clear();
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
      let prev = sh.get(e.id);
      if (!prev) {
        const key = keyOf(c, e.id);
        const was = restoring.get(key);
        const had = gone.get(key);
        restoring.delete(key);
        gone.delete(key);
        if (!was) {
          enqueue({ c, id: e.id, k: 'put', v: clone(e) });
          sh.set(e.id, fields(e));
          continue;
        }
        // A record Undo put back is restored by the server from its own copy (rules.js `restore`),
        // which ignores the value sent. That copy is what the server had when the delete was queued
        // (an edit made just before the delete, still waiting out the save delay, never reached
        // it), so anything different from that follows below as a patch on top.
        enqueue({ c, id: e.id, k: 'put', v: clone(was), restore: true });
        prev = had ? new Map(had) : fields(was);
        sh.set(e.id, prev);
      }
      const set = {};
      const base = {};
      let n = 0;
      for (const k of Object.keys(e)) {
        const j = JSON.stringify(e[k]);
        if (prev.get(k) !== j) {
          set[k] = clone(e[k]);
          // A task's description goes with the one it was edited from too: the server refuses it
          // if someone else's was saved meanwhile (desc_conflict), rather than replace theirs.
          if ((MERGED[c]?.includes(k) || (c === 'tasks' && k === 'desc')) && prev.has(k)) base[k] = JSON.parse(prev.get(k));
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
      if (!n) continue;
      const b = Object.keys(base).length ? { base } : {};
      // A description travels apart from the record's other fields: a refused op is rolled back
      // whole, and a refused description mustn't take a new title with it.
      if ('desc' in set && kind(set) === 'mixed') {
        const { desc, ...rest } = set;
        const { desc: from, ...lists } = base;
        enqueue({ c, id: e.id, k: 'patch', v: { desc }, ...(from !== undefined ? { base: { desc: from } } : {}) });
        enqueue({ c, id: e.id, k: 'patch', v: rest, ...(Object.keys(lists).length ? { base: lists } : {}) });
      } else enqueue({ c, id: e.id, k: 'patch', v: set, ...b });
    }
    for (const id of [...sh.keys()])
      if (!seen.has(id)) {
        queue.push({ c, id, k: 'del' });
        gone.delete(keyOf(c, id));
        gone.set(keyOf(c, id), sh.get(id));
        if (gone.size > 500) gone.delete(gone.keys().next().value);
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

/* What a patch changes: only the description ('desc', with the `updated` stamp that comes with
   it), only other fields ('fields'), or both ('mixed'). */
const kind = v => {
  const ks = Object.keys(v).filter(k => k !== 'updated');
  return !ks.includes('desc') ? 'fields' : ks.length === 1 ? 'desc' : 'mixed';
};
/* Queue an op. A change to the same record as the op at the end of the queue is folded into it
   (typing saves on every keystroke; offline, that would otherwise queue one full copy of the
   description per key): the later value of each field wins, and for merged fields the base stays
   the value before the first unsent edit. Only the tail is folded, so the order of changes to
   different records never changes. Never folded into: an Undo restore (the server rebuilds it from
   its own copy and ignores its value, so a later edit must travel as its own patch), an op pagehide
   already handed to a keepalive request (it is dropped when that request is answered, which would
   take the later edit with it), a re-read (see settle), and a different kind of change: a
   description and other fields go apart (a refused op is rolled back whole), and a description
   isn't folded into a new record (refused, it would take the record with it). */
function enqueue(op) {
  const tail = queue.at(-1);
  const foldable =
    tail &&
    !tail.restore &&
    !tail.read &&
    !keptAlive.has(tail) &&
    op.k === 'patch' &&
    tail.c === op.c &&
    tail.id === op.id &&
    (tail.k === 'put' ? !('desc' in op.v) : tail.k === 'patch' && kind(tail.v) === kind(op.v));
  if (!foldable) return void queue.push(op);
  if (tail.k === 'patch' && op.base) for (const [f, b] of Object.entries(op.base)) if (!(f in tail.v)) (tail.base ||= {})[f] = b;
  Object.assign(tail.v, op.v);
}

/* What one flush may carry: the server takes at most 500 ops, 10 MB, and 1,000,000 characters of
   descriptions a request (more is refused), so batches stay well inside all three. A request
   refused as too large anyway (413, e.g. by a proxy with a lower limit) lowers the byte cap until
   the queue is empty. One op always goes, however large: alone it can only be refused for good
   (the server's per-record limit is 256 KB), and is then reported and rolled back like any other. */
const FLUSH_BYTES = 4_000_000;
const FLUSH_DESC = 900_000;
let flushBytes = FLUSH_BYTES;
function takeBatch() {
  const out = [];
  let size = 0;
  let desc = 0;
  for (const op of queue) {
    const n = bytes(JSON.stringify(op));
    const d = typeof op.v?.desc === 'string' ? op.v.desc.length : 0;
    if (out.length && (out.length >= BATCH || size + n > flushBytes || desc + d > FLUSH_DESC)) break;
    out.push(op);
    size += n;
    desc += d;
  }
  queue.splice(0, out.length);
  return out;
}

/* Fields of a record that still have unconfirmed local edits. */
function pendingKeys(c, id) {
  let out = null;
  for (const op of [...inflight, ...queue]) {
    if (op.c !== c || op.id !== id || op.read) continue;
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

/* Take in the server's answers to `ops` (except `retry`, left to the caller): each record is
   adopted (a refused change is rolled back to what the server has) and errors are reported.
   Returns whether anything visible changed. */
function settle(ops, results) {
  const errs = [];
  let changed = false;
  results.forEach((r, i) => {
    const op = ops[i];
    if (!op || (!r.ok && r.retry)) return;
    // A description refused because someone else's was saved meanwhile: the text is handed over
    // to keep it and let the person choose, instead of only being reported.
    if (!r.ok && !op.read && !(r.code === 'desc_conflict' && hooks.descConflict(op))) errs.push(r.error);
    land(op.c, op.id, r.v);
    changed = adopt(op.c, op.id, r.v) || changed;
  });
  // Someone else changed one of these records while ours was on its way. The server's answer to
  // ours is the record as our change left it, which may be from before theirs (the live stream
  // can bring a later change before our answer), so ask for it once more: an empty patch changes
  // nothing and answers with the record as it is now. (Not needed while a later change of ours to
  // it is still to be sent: its answer comes after theirs.)
  for (const op of ops) {
    if (!crossed.delete(keyOf(op.c, op.id)) || op.k === 'del' || DOCS.includes(op.c) || pendingKeys(op.c, op.id)) continue;
    if (D()[op.c]?.some(e => e.id === op.id)) enqueue({ c: op.c, id: op.id, k: 'patch', v: {}, read: true });
  }
  if (errs.length) {
    if (errSinks.size) for (const sink of errSinks) sink.push(...errs);
    else toast(errs[0] + (errs.length > 1 ? ` (and ${errs.length - 1} more)` : ''), { kind: 'err', ms: 6000 });
  }
  return changed;
}

/* The batch on its way without keepalive (too large for it), so pagehide can take it back. */
let flushCtl = null;
export async function flush() {
  // While what pagehide sent is unanswered (back from the back/forward cache), wait for it.
  if (flushing || !queue.length || !shadow || exitSends) return;
  // Someone else signed in on this browser: their session mustn't send this person's changes.
  if (!hooks.stillMe()) return void hooks.otherUser();
  flushing = true;
  inflight = takeBatch();
  syncState();
  const ops = inflight;
  // A small batch goes with keepalive, so closing the tab doesn't cancel it; pagehide then only
  // has to send what's still queued behind it, in the keepalive budget that's left. A larger one
  // can be stopped, so pagehide can send it again at the head of what it sends.
  const body = JSON.stringify({ ops });
  inflightBytes = bytes(body) <= KEEPALIVE_BYTES / 2 ? bytes(body) : 0;
  const ctl = (flushCtl = inflightBytes ? null : new AbortController());
  try {
    const res = await api('POST', '/api/sync', { ops }, { keepalive: inflightBytes > 0, signal: ctl?.signal, headers: who() });
    collect(); // move any edits made meanwhile into the queue before adopting server values
    inflight = [];
    inflightBytes = 0;
    online();
    // Refused only because the request had done enough (the server's per-request budget, after
    // which it defers the rest of the batch): sent again next, ahead of anything queued since,
    // rather than undone. Queued back before adopting the rest, so their fields count as pending.
    queue.unshift(...ops.filter((op, i) => !res.results[i].ok && res.results[i].retry));
    const changed = settle(ops, res.results);
    // What the batch changed besides its own records (the next occurrence of a repeating task, or
    // its removal on reopen): the live stream doesn't send this tab its own changes.
    if (res.changes?.length) applyRemote(res.changes);
    if (res.links?.length) S.ui.devLinks = res.links;
    if (changed) refresh();
  } catch (e) {
    if (ctl?.signal.aborted) {
      // Stopped by pagehide, which put the batch back at the head of the queue and sent it.
    } else {
      inflight = [];
      inflightBytes = 0;
      if (e.status === 401) hooks.signedOut(e);
      else if (e.status === 409 && e.code === 'other_user') {
        queue.unshift(...ops);
        hooks.otherUser();
      } else if (e.status === 413 && ops.length > 1) {
        // The batch as a whole was too large: send it again in smaller ones.
        queue.unshift(...ops);
        flushBytes = Math.max(64_000, Math.floor(flushBytes / 4));
      } else if (e.offline || e.status >= 500 || e.status === 429) {
        queue.unshift(...ops);
        offline();
      } else {
        // Refused as a whole (a single op larger than a request may be, or a malformed batch):
        // reported, and the resync puts back what the server has.
        toast(e.message, { kind: 'err' });
        hooks.resync();
      }
    }
  } finally {
    flushing = false;
    if (flushCtl === ctl) flushCtl = null;
  }
  if (queue.length && !S.ui.offline) flush();
  else {
    syncState();
    if (!queue.length) flushBytes = FLUSH_BYTES;
    // A reload that waited for the queue to drain (see commit) can run now.
    if (resyncWhenSaved && !queue.length && !S.ui.offline) {
      resyncWhenSaved = false;
      hooks.resync();
    }
  }
}

/* Wait until everything queued has reached the server (or it can't be reached). Errors of refused
   changes are reported as usual. `retry`: try even if the last attempt left us offline (the live
   stream just reconnected, so the server may be back). */
export async function settled({ retry = false } = {}) {
  if (retry && shadow && S.ui.offline) await retryNow();
  else collect();
  while (shadow && (queue.length || flushing) && !S.ui.offline) {
    if (exitSends) await exitSends;
    else if (flushing) await new Promise(r => setTimeout(r, 25));
    else await flush();
  }
}
export const OFFLINE_MSG = "You're offline. Your changes will be saved when you reconnect.";
/* Send everything now and wait for the server. Resolves with the errors of changes refused
   meanwhile, so callers can report them in place of the generic toast (OFFLINE_MSG last if the
   server couldn't be reached). */
export async function commit(opts) {
  const errs = [];
  errSinks.add(errs);
  try {
    await settled(opts);
  } finally {
    errSinks.delete(errs);
  }
  if (S.ui.offline) errs.push(OFFLINE_MSG);
  return errs;
}

/* Going offline or back only re-renders when that doesn't disturb someone typing (the backoff
   below retries every few seconds); <html data-sync> shows the state meanwhile. */
function offline() {
  if (!S.ui.offline) {
    S.ui.offline = true;
    refresh();
  }
  document.querySelector('[data-a="retryOnline"].is-loading')?.classList.remove('is-loading');
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
    refresh();
    toast('Back online. All changes are synced.');
  }
}
/* Whether the person this tab belongs to is still the one signed in: someone else may have signed
   in on this browser meanwhile, and their session mustn't carry this person's changes. False (and
   handled: signed out, or offline and retrying) when not, or when the server can't be reached. */
export async function sameUser() {
  let s;
  try {
    s = await api('GET', '/api/auth/session');
  } catch {
    if (shadow) offline();
    return false;
  }
  if (!shadow) return false;
  if (!s.user || s.user.twoFactorPending) hooks.signedOut();
  else if (!hooks.stillMe() || (S.ui.me?.id && s.user.id !== S.ui.me.id)) hooks.otherUser();
  else return true;
  return false;
}
/* Try the server again (the backoff timer, the browser coming online, "Try again"). The tab stays
   offline until it answers. */
export async function retryNow() {
  if (!shadow) return;
  clearTimeout(retryT);
  collect(false);
  if (!(await sameUser())) return;
  if (queue.length) await flush();
  else {
    online();
    syncState();
    if (resyncWhenSaved && !flushing) {
      resyncWhenSaved = false;
      hooks.resync();
    }
  }
  if (!live && shadow) connectLive();
}

/* Before the tab goes away, send what's still queued with one keepalive request, which outlives
   the page. Browsers allow about 64 KB of keepalive bodies at once (the batch already on its way,
   sent with keepalive by flush, counts too), so as many ops as fit, in order. A batch on its way
   without keepalive would be cancelled with the page, so it's stopped and goes first. Nothing
   leaves the queue until the server confirms it: the page may only be going into the
   back/forward cache, or be offline, and then the queue must still be there when it comes back.
   Sending an op twice is harmless (a put becomes an update, a delete of something gone does
   nothing). */
const KEEPALIVE_BYTES = 60_000;
const enc = new TextEncoder();
const bytes = s => enc.encode(s).length;
let inflightBytes = 0;
/* The keepalive request pagehide sent, until it's answered, and how to stop it. */
let exitSends = null;
let exitCtl = null;
let exitOps = null;
/* The ops, from the first, that fit in one keepalive request of `budget` bytes. */
export function keepaliveBatch(ops, budget = KEEPALIVE_BYTES) {
  const out = [];
  let left = budget - 12; // {"ops":[]}
  for (const op of ops) {
    const cost = bytes(JSON.stringify(op)) + 1; // the op and its comma
    if (out.length >= BATCH || cost > left) break;
    out.push(op);
    left -= cost;
  }
  return out;
}
addEventListener('pagehide', () => {
  if (!shadow || !hooks.stillMe()) return;
  collect(false);
  const reclaim = flushCtl && inflight.length ? inflight : [];
  // From the head of the queue: what an earlier pagehide sent, if that is still unanswered (back
  // from the back/forward cache meanwhile), goes again ahead of the rest, in place of it.
  const ops = keepaliveBatch([...reclaim, ...queue], KEEPALIVE_BYTES - inflightBytes);
  if (!ops.length || (exitSends && ops.every(op => exitOps.has(op)))) return;
  if (reclaim.length) {
    flushCtl.abort();
    queue.unshift(...inflight);
    inflight = [];
  }
  exitCtl?.abort();
  for (const op of ops) keptAlive.add(op);
  const ctl = (exitCtl = new AbortController());
  const sent = (exitOps = new Set(ops));
  const p = (async () => {
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'sudo-sapient', 'x-client-id': CLIENT_ID, ...who() },
        body: JSON.stringify({ ops }),
      });
      if (!res.ok) return;
      const results = (await res.json())?.results || [];
      // Answered: what the server saved or refused leaves the queue (the resync on pageshow brings
      // back what it made of them); what it deferred (`retry`: everything after the first such op)
      // stays, unsealed, to be sent again.
      const keep = new Set(ops.filter((op, i) => !results[i] || (!results[i].ok && results[i].retry)));
      for (const op of keep) keptAlive.delete(op);
      queue = queue.filter(op => !sent.has(op) || keep.has(op));
      if (shadow && settle(ops, results)) refresh();
    } catch {
      /* offline, or stopped by a later pagehide that sent these again: they stay queued */
    }
  })();
  exitSends = p;
  p.finally(() => {
    if (exitSends !== p) return;
    exitSends = null;
    exitCtl = null;
  });
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
  if (!hooks.stillMe()) return void hooks.otherUser();
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
        if (S.ui.me?.id && s.user.id !== S.ui.me.id) return hooks.otherUser();
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
  const sending = [...inflight, ...queue.filter(op => keptAlive.has(op))];
  let changed = false;
  for (const ch of list) {
    land(ch.c, ch.id, ch.v);
    if (sending.some(op => op.c === ch.c && op.id === ch.id)) crossed.add(keyOf(ch.c, ch.id));
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
let blurWait = null;
export function refresh() {
  clearTimeout(refreshT);
  const a = document.activeElement;
  const editing = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && a.type !== 'checkbox';
  if (editing) {
    if (blurWait !== a) {
      blurWait = a;
      a.addEventListener(
        'blur',
        () => {
          blurWait = null;
          setTimeout(refresh, 0);
        },
        { once: true },
      );
    }
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
   puts back only the records that action touched, and in each only the fields it changed, so other
   people's edits made in between stay. */
export function takeSnapshot() {
  const snap = { before: JSON.stringify(S.data), after: null };
  setTimeout(() => (snap.after = JSON.stringify(S.data)), 0);
  return snap;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/* Put back in `e` the fields that went from `was` to `now`, each only while it still holds what the
   action left there: a later change to that field (someone else's, or mine) stays. A list or map
   gets back only the entries the action added, removed or changed. A flag the action added is turned
   off rather than removed (the server keeps a field it's sent without). */
function unchange(c, e, was, now) {
  for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) {
    if (same(was[k], now[k])) continue;
    if (MERGED[c]?.includes(k) && was[k] != null && now[k] != null) e[k] = mergeField(now[k], was[k], e[k]);
    else if (!same(e[k], now[k])) continue;
    else if (k in was) e[k] = was[k];
    else if (typeof now[k] === 'boolean') e[k] = false;
    else delete e[k];
  }
}
export function restoreSnapshot(snap) {
  const before = JSON.parse(snap.before);
  const after = JSON.parse(snap.after || JSON.stringify(S.data));
  const d = D();
  for (const c of COLLS) {
    const b = new Map((before[c] || []).map(e => [e.id, e]));
    const a = new Map((after[c] || []).map(e => [e.id, e]));
    for (const id of new Set([...b.keys(), ...a.keys()])) {
      if (same(b.get(id), a.get(id))) continue;
      const i = d[c].findIndex(e => e.id === id);
      if (!b.has(id)) {
        if (i >= 0) d[c].splice(i, 1);
      } else if (i >= 0) {
        if (a.has(id)) unchange(c, d[c][i], b.get(id), a.get(id));
        else d[c][i] = b.get(id);
      } else {
        // Put it back where it was relative to its old neighbours.
        const pos = (before[c] || []).findIndex(e => e.id === id);
        d[c].splice(Math.min(pos, d[c].length), 0, b.get(id));
        if (shadow && !shadow[c].has(id)) restoring.set(keyOf(c, id), clone(b.get(id)));
      }
    }
  }
  for (const k of DOCS) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) d[k] = before[k];
}
