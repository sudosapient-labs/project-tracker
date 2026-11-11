/* ---------- Back closes what's open (touch screens) ----------
   On a phone, and in the Android app, the system Back button is how people close things. While
   anything closable is open (a menu, a modal, the task drawer, the sidebar, …) the page has one
   extra history entry with the same URL, marked `{ layer: true }`. Back leaves it, and the popstate
   that follows closes the topmost layer, exactly as Escape would; the entry comes back while more
   remain open. Closing the last one another way (X, a backdrop, a pick) removes the entry, so Back
   then navigates at once. Desktop browsers keep Back as navigation only: none of this runs there. */
import { touchUI } from '../core/utils.js';
import { S, task } from '../core/store.js';
import { hashFor, layers, render } from '../shell/render.js';
import { selectMenu } from '../ui/select.js';
import { closeModal } from '../overlays/modals.js';
import { closePop } from '../overlays/popovers.js';
import { A, saveDatePop } from './actions.js';

const TYPING = 'input, textarea, select, [contenteditable="true"]';
const blurTyping = () => {
  const a = document.activeElement;
  if (a?.matches?.(TYPING)) a.blur();
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
const anyOpen = () => open().some(Boolean);

/* Close the topmost layer (Escape, and Back on touch screens). False when nothing was open. */
export function closeTop() {
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
    A.cancelComposer();
    return true;
  }
  if (u.modals.length) {
    closeModal();
    return true;
  }
  if (u.subOpen) {
    blurTyping();
    u.lastSub = u.subOpen.sid;
    A.closeSub();
    return true;
  }
  if (u.drawer) {
    blurTyping();
    A.closeDrawer();
    return true;
  }
  if (u.mnav) {
    A.closeMnav();
    return true;
  }
  return false;
}

/* Back: what a tap outside does first (a date picker keeps the date picked, a field being typed in
   saves as when it loses focus); if that already closed something, that was this Back's step. */
function back() {
  const was = open().join();
  if (S.ui.pop?.type === 'date') saveDatePop(true);
  blurTyping();
  if (open().join() !== was) return;
  closeTop();
}

const onEntry = () => history.state?.layer === true;
// popstates caused here by taking our own entry away, to ignore; `busy` while Back closes a layer
let leaving = 0,
  busy = false;

function sync() {
  if (leaving || busy || S.ui.auth || !touchUI()) return;
  const any = anyOpen();
  if (any && !onEntry()) history.pushState({ layer: true }, '', location.href);
  else if (!any && onEntry()) {
    leaving++;
    history.back();
  }
}

layers.onEntry = () => !S.ui.auth && touchUI() && onEntry();
layers.sync = sync;
layers.back = () => {
  if (leaving) {
    leaving--;
    // A page opened while the entry was being taken away (a menu item that navigates) replaced it,
    // so this went back one page too far: put the page shown back on top.
    const h = '#' + hashFor(S.ui.route, S.ui.params);
    if (!S.ui.auth && location.hash !== h) history.pushState(null, '', location.pathname + location.search + h);
    sync();
    return true;
  }
  if (S.ui.auth || !touchUI()) return false;
  if (onEntry()) {
    // Forward onto an entry whose layer was closed since: step back over it, nothing reopens.
    if (!anyOpen()) {
      leaving++;
      history.back();
    }
    return true;
  }
  if (!anyOpen()) return false;
  busy = true;
  try {
    back();
  } finally {
    busy = false;
  }
  sync();
  return true;
};
selectMenu.changed = sync;

// A reload, or a restored tab, starts with nothing open; an entry left from before is just the page.
if (onEntry()) history.replaceState(null, '', location.href);
