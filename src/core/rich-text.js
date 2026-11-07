// @ts-check
/* What a rich-text description may contain: exactly what the drawer's editor produces (bold,
   italic, lists, a heading, links, and the paragraphs, line breaks and divs contenteditable writes).
   The client (DOMPurify, ui/helpers.js) and the server (sanitize-html, server/lib/rich-text.js) both
   sanitise against this list, so anything else is dropped before it's stored or rendered. */
export const RICH_TAGS = ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'h4', 'a'];
export const RICH_ATTRS = { a: ['href'] };
export const RICH_SCHEMES = ['http', 'https', 'mailto'];

const escHtml = s => String(s).replace(/[&<>"']/g, ch => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' }[ch]};`);

/* Plain text becomes paragraphs: a blank line starts a new one, a single newline is a <br>. Used by
   the task modal and the REST API, so a description typed in either is stored the same way. */
export const textToHtml = (/** @type {string} */ s) =>
  String(s || '')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

/* The text a description holds, decoded, if it's plain: nothing, bare text, or paragraphs of only
   text and line breaks (what textToHtml writes). Anything else (lists, links, bold, …) returns null,
   because a textarea can't show it without losing the formatting. `parse` turns HTML into a body
   element; it defaults to the browser's DOMParser. */
export function plainDescText(/** @type {string} */ html, parse = (/** @type {string} */ s) => new DOMParser().parseFromString(s, 'text/html').body) {
  const nodes = [...parse(String(html || '')).childNodes];
  if (nodes.every(n => n.nodeType === 3))
    return nodes
      .map(n => n.textContent)
      .join('')
      .trim();
  const paras = [];
  for (const n of nodes) {
    if (n.nodeType === 3 && !n.textContent.trim()) continue;
    if (n.nodeName !== 'P') return null;
    let s = '';
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.textContent;
      else if (c.nodeName === 'BR') s += '\n';
      else return null;
    }
    paras.push(s.trim());
  }
  return paras.filter(Boolean).join('\n\n');
}
