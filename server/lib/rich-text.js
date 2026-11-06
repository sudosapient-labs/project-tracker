// @ts-check
/* Rich text (task descriptions) is sanitised on write against the same allowlist the client renders
   with (src/core/rich-text.js), so stored HTML never carries scripts, styles, forms or foreign tags.
   The output matches how browsers serialise the editor's HTML (`<br>`, `&nbsp;`), so a clean
   description comes back unchanged. */
import sanitizeHtml from 'sanitize-html';
import { RICH_ATTRS, RICH_SCHEMES, RICH_TAGS } from '../../src/core/rich-text.js';

/* The longest description that can be stored (the task schema's limit), and how deeply its tags may
   nest. The editor never nests more than a few levels; parsing gets superlinear with depth, so both
   are checked before any parsing happens. */
export const RICH_MAX = 100_000;
export const RICH_MAX_DEPTH = 64;

const OPTS = {
  allowedTags: RICH_TAGS,
  allowedAttributes: RICH_ATTRS,
  allowedSchemes: RICH_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nestingLimit: RICH_MAX_DEPTH,
};

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'embed', 'source', 'track', 'param']);
/* How deeply tags nest, estimated in one linear pass (unclosed tags count as open, so it never
   underestimates well-formed markup). */
function depth(html) {
  let d = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    if (m[1]) d = Math.max(0, d - 1);
    else if (!VOID.has(m[2].toLowerCase())) max = Math.max(max, ++d);
    if (max > RICH_MAX_DEPTH) break;
  }
  return max;
}

/* Why `html` can't be stored as rich text, or null when it can. Cheap: call it before cleanRich. */
export function richTextProblem(html) {
  if (html == null) return null;
  if (typeof html !== 'string') return 'Expected text.';
  if (html.length > RICH_MAX) return `Keep it under ${RICH_MAX.toLocaleString('en-US')} characters.`;
  if (depth(html) > RICH_MAX_DEPTH) return 'Its formatting is nested too deeply.';
  return null;
}

export const cleanRich = html => {
  const problem = richTextProblem(html);
  if (problem) throw new RangeError(`Rich text refused: ${problem}`);
  return sanitizeHtml(String(html ?? ''), OPTS)
    .replace(/<br \/>/g, '<br>')
    .replace(/\u00a0/g, '&nbsp;');
};
