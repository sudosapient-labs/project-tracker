/* What the URL hash says to open.
   - A page (see hashFor in shell/render.js): `#project/web/list`, `#settings/sessions`, …
   - A page with a task open over it, as the app writes it while the task is open:
     `#project/web/list?task=WEB-12`. A reload, or a copied URL, opens both.
   - A link written by A.copyLink: `#task/WEB-12`, `#file/<id>`. These name no page.
   The hash comes from a URL anyone can send: a part that can't be decoded is dropped. */
const TASK = '?task=';

const decode = s => {
  try {
    return decodeURIComponent(s) || null;
  } catch {
    return null;
  }
};

/** @returns {{ page: string, task: string | null, file: string | null }} */
export function parseHash(h = '') {
  const s = String(h).replace(/^#/, '');
  const i = s.indexOf(TASK);
  if (i >= 0) return { page: s.slice(0, i), task: decode(s.slice(i + TASK.length)), file: null };
  const m = /^(task|file)\/(.*)$/.exec(s);
  if (m) return { page: '', task: m[1] === 'task' ? decode(m[2]) : null, file: m[1] === 'file' ? decode(m[2]) : null };
  return { page: s, task: null, file: null };
}

/* The hash for a page, with the task open over it (none: just the page). */
export const withTask = (page, key) => (key ? `${page}${TASK}${encodeURIComponent(key)}` : page);
