/* ---------- Back closes what's open (touch screens) ----------
   On a phone, and in the Android app (Chrome in a Trusted Web Activity, so the system Back button
   is the browser's Back), Back is how people close things. Each layer opened by a tap (a menu, a
   modal, the task drawer, the sidebar, …) gets a history entry of its own, with the page's URL (or
   the open task's) and the state `{ layer: n, id, below }`: n layers deep, over the entries `below`
   (the page's first). Back takes the top entry away and the topmost layer closes, in the order
   Escape closes them (closeTop), but keeping what was being done where Escape cancels it: a date
   picked is saved, and so is a table cell or field being typed in (as a tap outside does); a new
   task, a task or project being edited and the inline composer keep what was typed, which comes
   back when they open again (drafts.js).

   Chrome marks an entry as one Back skips when the page adds another on top of it with no tap
   since. So an entry is added only in a tap, one per tap, and never while Back is handled: Back
   only steps back, and the state of the entry it lands on says how many layers stay open. A layer
   that opened with no tap (a task from a link, a reload or a notification) gets no entry of its
   own: a link that stays on the page makes its own entry that layer's (layers.linkEntry), and
   otherwise the next tap adds it. Until then Back closes it with the layer under it, or leaves the
   page. Closing a layer another way (X, a backdrop, a pick) steps back over its entry, so Back then
   does the next thing at once; Forward onto an entry whose layer was closed steps back over it.
   Desktop browsers keep Back as navigation only: none of this runs there. */
import { touchUI } from '../core/utils.js';
import { S, task } from '../core/store.js';
import { entryId, hashFor, layers, pageEntry, render } from '../shell/render.js';
import { parseHash } from '../core/links.js';
import { selectMenu } from '../ui/select.js';
import { closeModal } from '../overlays/modals.js';
import { closePop } from '../overlays/popovers.js';
import { A, saveDatePop } from './actions.js';
import { keepComposer, keepModal } from './drafts.js';

const TYPING = 'input, textarea, select, [contenteditable="true"]';
/* Leave the field being typed in. Back (`keep`) saves it as a tap outside does; Escape cancels it
   first: a field that saves on blur (the drawer's title) goes back to what it showed, so its blur
   saves nothing. */
const blurTyping = (keep = true) => {
  const a = document.activeElement;
  if (!a?.matches?.(TYPING)) return;
  if (!keep && a.dataset.blur && 'defaultValue' in a) a.value = /** @type {HTMLInputElement} */ (a).defaultValue;
  a.blur();
};

/* What's open, top first: the order Escape and Back close things in. */
function open() {
  const u = S.ui;
  return [
    !!selectMenu.el,
    !!u.palette,
    !!u.pop,
    !!u.mention,
    !!u.editCell,
    !!u.composer,
    u.modals.length,
    !!u.subOpen,
    !!(u.drawer && task(u.drawer)),
    !!u.mnav,
  ];
}
/* How many layers are open (each modal is one). */
const count = () => open().reduce((n, x) => n + Number(x), 0);

/* Close the topmost layer (Escape, and Back on touch screens). False when nothing was open.
   `keep` (Back): what's typed in a window or the composer is kept for when it opens again. */
export function closeTop(keep = false) {
  const u = S.ui;
  if (selectMenu.el) {
    selectMenu.close(true);
    return true;
  }
  if (u.palette) {
    A.closePalette();
    return true;
  }
  if (u.pop) {
    closePop();
    return true;
  }
  if (u.mention) {
    u.mention = null;
    render();
    return true;
  }
  if (u.editCell) {
    u.editCell = null;
    render();
    return true;
  }
  if (u.composer) {
    if (keep) keepComposer();
    A.cancelComposer();
    return true;
  }
  if (u.modals.length) {
    if (keep) keepModal();
    closeModal({ keep });
    return true;
  }
  if (u.subOpen) {
    blurTyping(keep);
    u.lastSub = u.subOpen.sid;
    A.closeSub();
    return true;
  }
  if (u.drawer) {
    blurTyping(keep);
    A.closeDrawer();
    return true;
  }
  if (u.mnav) {
    A.closeMnav();
    return true;
  }
  return false;
}

/* What a tap outside does first: a date picker keeps the date picked, a field or table cell being
   typed in saves as when it loses focus. Back does this before it closes anything, and so does a
   link opening in the open app (openLink in session.js) before it closes everything. */
export function settle() {
  if (S.ui.pop?.type === 'date') saveDatePop(true);
  blurTyping();
}

/* Back: settle first; if that already closed something, that was this Back's step. */
function back() {
  const was = open().join();
  settle();
  if (open().join() !== was) return;
  closeTop(true);
}

/* The history entries of what's open: the page's, then one per layer (see the top of this file). */
const depth = s => (typeof s?.layer === 'number' ? s.layer : 0);
const chainOf = s => (s?.id ? [...(depth(s) ? s.below || [] : []), s.id] : []);

/* The state of the entry shown, as last seen (popstate has already moved on when it runs). */
let shown = history.state;
/* A tap (or key) since the app last added an entry or moved in history: Chrome counts an entry
   added then as one the person asked for. The events are the ones that give the page a user
   activation; a touch's comes when the finger lifts. */
let tapped = false;
for (const type of ['keydown', 'mousedown', 'pointerup', 'touchend'])
  addEventListener(
    type,
    e => {
      if (!e.isTrusted || (type === 'keydown' && /** @type {KeyboardEvent} */ (e).key === 'Escape')) return;
      tapped = true;
      // A layer that opened with no tap gets its entry with the next one, even if that changes nothing.
      setTimeout(sync, 0);
    },
    true,
  );
const canAdd = () => tapped && navigator.userActivation?.isActive !== false;

// steps back the app took itself (a layer closed another way), whose popstate only lands; `busy`
// while a popstate is handled, so the renders it makes don't sync
let leaving = 0,
  busy = false;

/* After each render: one entry per layer open, as far as taps allow. Fewer layers than entries
   (closed with X, a pick, Escape): step back over the extra ones. More: add one, in a tap. */
function sync() {
  if (leaving || busy || S.ui.auth || !touchUI()) return;
  const s = history.state;
  if (!s) return; // a link's entry, until openLink gives it a state
  const d = depth(s),
    c = count();
  if (c < d) {
    leaving++;
    history.go(c - d);
  } else if (c > d && canAdd()) {
    tapped = false;
    history.pushState({ layer: d + 1, id: entryId(), below: chainOf(s) }, '', location.href);
  }
  shown = history.state;
}

/* Close layers until `d` are left (Back's step first, then any opened with no entry of their own);
   if more closed than that, step back to the entry for what's left. */
function closeTo(d) {
  if (count() > d) back();
  for (let n = 0; count() > d && n < 30; n++) if (!closeTop(true)) break;
  const c = count();
  if (c < d) {
    leaving++;
    history.go(c - d);
  }
}

layers.onEntry = () => !S.ui.auth && touchUI() && depth(history.state) > 0;
/* A page went to from a layer over another layer (the sidebar's project menu → Open) takes over the
   top layer's entry, so the layers' entries under it are left between that page and the one before.
   Back over them steps back to the page before; Forward onto one goes on to the page it led to, by
   the number of entries up to it, remembered here for this page load. */
const ahead = new Map();
layers.replacing = () => {
  const s = history.state;
  for (const id of chainOf(s).slice(1, -1)) ahead.set(id, depth(s));
};
layers.sync = sync;
layers.added = () => {
  tapped = false;
};
/* A link that stays on the page shown: its entry is one layer over that page's, so Back from what
   it opens returns to the page (sync steps back over it when it opened nothing). */
layers.linkEntry = same => {
  const base = chainOf(shown)[0];
  return same && base && touchUI() ? { layer: 1, id: entryId(), below: [base] } : pageEntry();
};
layers.back = () => {
  tapped = false;
  const s = history.state;
  if (!s) return false; // made by a link, not by Back: the link opens it (openLink); `shown` stays
  const was = shown;
  shown = s;
  if (S.ui.auth || !touchUI()) return false;
  if (leaving) {
    leaving--;
    sync();
    return true;
  }
  busy = true;
  try {
    const j = s.id ? chainOf(was).indexOf(s.id) : -1;
    // Back to an entry of what's open: close what's over it. Another page's entry (Back or
    // Forward), or one of a layer closed since: nothing stays open.
    closeTo(Math.max(j, 0));
    if (j < 0 && depth(s)) {
      // Forward from the page under it onto one left under a page gone to: on to that page.
      const to = ahead.get(s.id);
      if (to && was?.id && (s.below || []).includes(was.id)) {
        history.go(to - depth(s));
        return true;
      }
      // A closed layer's: step back to the page it was over, which then routes as below.
      history.go(-depth(s));
      return true;
    }
  } finally {
    busy = false;
  }
  // The page this entry is for, if it isn't the one shown (the popstate handler goes there).
  return parseHash(location.hash).page === hashFor(S.ui.route, S.ui.params);
};
selectMenu.changed = sync;
