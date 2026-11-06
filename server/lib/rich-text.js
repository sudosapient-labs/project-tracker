// @ts-check
/* Rich text (task descriptions) is sanitised on write against the same allowlist the client renders
   with (src/core/rich-text.js), so stored HTML never carries scripts, styles, forms or foreign tags.
   The output matches how browsers serialise the editor's HTML (`<br>`, `&nbsp;`), so a clean
   description comes back unchanged. */
import { createRequire } from 'node:module';
import sanitizeHtml from 'sanitize-html';
import { RICH_ATTRS, RICH_SCHEMES, RICH_TAGS } from '../../src/core/rich-text.js';

/* The longest description that can be stored (the task schema's limit), and how deeply its tags may
   nest. The editor never nests more than a few levels; parsing gets superlinear with depth, so both
   are checked before any parsing happens. */
export const RICH_MAX = 100_000;
export const RICH_MAX_DEPTH = 64;

/* sanitize-html's default nonTextTags, plus the tags whose content it would otherwise keep: when an
   <iframe> is discarded its content is re-parsed as HTML (a second parser per level), and noscript,
   noembed and noframes hold fallback markup too. Their content is dropped instead, so the one parse
   depth() measures is the only one. */
const NON_TEXT = ['script', 'style', 'textarea', 'option', 'xmp', 'iframe', 'noscript', 'noembed', 'noframes'];
const OPTS = {
  allowedTags: RICH_TAGS,
  allowedAttributes: RICH_ATTRS,
  allowedSchemes: RICH_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: NON_TEXT,
  nestingLimit: RICH_MAX_DEPTH,
};
/* The options sanitize-html gives its parser (its htmlParserDefaults merged with ours). */
const PARSER_OPTS = { decodeEntities: true };

/* How deeply `html`'s elements nest, measured by running the very parser sanitize-html uses
   (htmlparser2, the copy sanitize-html depends on, with the options it passes), so there is nothing
   to keep in step with it. That parser's stack costs time proportional to its depth on every tag,
   which is what makes sanitising deep markup superlinear; it stops as soon as the depth passes the
   limit, so this pass stays linear. */
const htmlparser = createRequire(createRequire(import.meta.url).resolve('sanitize-html'))('htmlparser2');
const TOO_DEEP = Symbol('too deep');
function depth(html) {
  let open = 0;
  let max = 0;
  const parser = new htmlparser.Parser(
    {
      // Every element the parser opens, explicit or implied, is closed with one onclosetag.
      onopentagname() {
        if (++open > max && (max = open) > RICH_MAX_DEPTH) throw TOO_DEEP;
      },
      onclosetag() {
        open--;
      },
    },
    { ...PARSER_OPTS },
  );
  try {
    parser.write(html);
    parser.end();
  } catch (e) {
    if (e !== TOO_DEEP) throw e;
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
