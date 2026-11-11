/* ---------- What's typed survives a close nobody chose ----------
   A window that closes without its own buttons (Back on a phone, a link opening over it) keeps what
   was typed in it: a new task or project, a task or project being edited, the inline composer's
   task name. Opening the same window again (New task, Edit on the same task, Add task in the same
   group) brings it back, as a comment's draft comes back in S.ui.drafts. Its X, Cancel or Escape
   discards it, and saving uses it up. Signing out reloads the page, so nothing is kept for the next
   person. */
import { S } from '../core/store.js';
import { $, $$ } from '../core/utils.js';

const kept = () => (S.ui.kept ??= {});
const copy = o => ({ ...o, labels: o.labels && [...o.labels], subtasks: o.subtasks?.map(s => ({ ...s })), files: o.files && [...o.files] });
// What a window's form holds, without what it notes about where it started.
const fields = f => JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => !['opened', 'descOrig', 'descFrom', 'more', 'files'].includes(k))));

/* Which form a modal edits, and the key its draft is kept under (none: nothing typed to keep). Each
   modal holds its own form (openModal), so a window opened over another of its kind doesn't keep
   the other's under its key. */
function formOf(m) {
  if (m?.type === 'task') return { f: m.form || S.ui.form, k: `task:${m.edit || ''}`, field: 'form' };
  if (m?.type === 'project') return { f: m.form || S.ui.pform, k: `project:${m.edit || ''}`, field: 'pform' };
  return null;
}
/* Something was typed: a new window that isn't empty, an edit that changed something. */
function typed(f) {
  if (!f) return false;
  if (f.opened) return fields(f) !== fields(f.opened) || (f.files?.length ?? 0) > 0;
  return !!(f.title?.trim() || f.name?.trim() || f.desc?.trim() || f.subtasks?.length || f.files?.length);
}

/* Keep what's typed in the topmost window, before it closes. */
export function keepModal(m = S.ui.modals[S.ui.modals.length - 1]) {
  const w = formOf(m);
  if (!w) return;
  const f = w.f;
  // A field being typed in has its value in the form already (data-in); the topmost window's
  // fields are read too, in case the last keystroke's input event hasn't run: in that window only,
  // as one under it can have fields with the same ids.
  const el = m === S.ui.modals[S.ui.modals.length - 1] ? $$('.modal').at(-1) : null;
  const title = /** @type {HTMLInputElement | null} */ (el?.querySelector(w.field === 'form' ? '#f-title' : '#p-name')),
    desc = /** @type {HTMLTextAreaElement | null} */ (el?.querySelector(w.field === 'form' ? '#f-desc' : '#p-desc'));
  if (f && title) f[w.field === 'form' ? 'title' : 'name'] = title.value;
  if (f && desc) f.desc = desc.value;
  if (typed(f)) kept()[w.k] = copy(f);
  else delete kept()[w.k];
}
/* Keep the inline composer's text, before it closes. */
export function keepComposer() {
  const c = S.ui.composer,
    v = $('#composer-in')?.value;
  if (!c) return;
  const k = `composer:${c.ctx}:${c.group}`;
  if (v?.trim()) kept()[k] = v;
  else delete kept()[k];
}
/* Keep everything open, before it all closes at once (a link opening). */
export function keepAll() {
  if (S.ui.composer) keepComposer();
  // Only the topmost window's fields are on screen; the others' forms are what they hold.
  S.ui.modals.forEach(m => keepModal(m));
}

/* The kept form for a window about to open, taken (a later close keeps it again). */
export function takeForm(type, edit) {
  const k = `${type}:${edit || ''}`,
    f = kept()[k];
  delete kept()[k];
  return f || null;
}
/* Drop the kept form for a window closed on purpose (its X, Cancel, Escape) or saved. */
export function dropForm(m) {
  const w = formOf(m);
  if (w) delete kept()[w.k];
}
/* The composer's kept text for a group, taken. */
export function takeComposer(ctx, group) {
  const k = `composer:${ctx}:${group}`,
    v = kept()[k];
  delete kept()[k];
  return v || '';
}
