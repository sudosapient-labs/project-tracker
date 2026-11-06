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

const OPTS = {
  allowedTags: RICH_TAGS,
  allowedAttributes: RICH_ATTRS,
  allowedSchemes: RICH_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nestingLimit: RICH_MAX_DEPTH,
};

/* How deeply the parser sanitize-html uses (htmlparser2) will nest `html`'s elements. Its own stack
   costs time proportional to the depth on every tag (and on every end tag that matches nothing), so
   nesting is what makes sanitising superlinear. This runs htmlparser2's own tokenizer (the instance
   sanitize-html uses, so comments, CDATA, raw text and attribute quoting are read exactly as it
   reads them) and replays the parser's stack rules from Parser.js: end tags that match nothing are
   ignored, optional end tags (p, li, dd, td, …) close implicitly, void elements never open. Linear:
   each element is pushed and popped once, and membership is a counter. */
const htmlparser = createRequire(createRequire(import.meta.url).resolve('sanitize-html'))('htmlparser2');
const VOID = new Set([
  'area',
  'base',
  'basefont',
  'br',
  'col',
  'command',
  'embed',
  'frame',
  'hr',
  'img',
  'input',
  'isindex',
  'keygen',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const FORM = ['input', 'option', 'optgroup', 'select', 'button', 'datalist', 'textarea'];
const HEADING = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'];
const CLOSES_P = [
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'header',
  'hr',
  'main',
  'nav',
  'ol',
  'pre',
  'section',
  'table',
  'ul',
];
const IMPLIES_CLOSE = new Map(
  [
    ['tr', ['tr', 'th', 'td']],
    ['th', ['th']],
    ['td', ['thead', 'th', 'td']],
    ['body', ['head', 'link', 'script']],
    ['a', ['a']],
    ['li', ['li']],
    ['p', ['p']],
    ...HEADING.slice(0, 6).map(h => [h, HEADING]),
    ...['select', 'input', 'output', 'button', 'datalist', 'textarea'].map(t => [t, FORM]),
    ['option', ['option']],
    ['optgroup', ['optgroup', 'option']],
    ['dd', ['dd', 'dt']],
    ['dt', ['dd', 'dt']],
    ...CLOSES_P.map(t => [t, ['p']]),
    ['rt', ['rt', 'rp']],
    ['rp', ['rt', 'rp']],
    ['tbody', ['thead', 'tbody']],
    ['tfoot', ['thead', 'tbody']],
  ].map(([k, v]) => [k, new Set(v)]),
);
const INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml', 'desc', 'title']);
const TOO_DEEP = Symbol('too deep');

function depth(html) {
  const stack = []; // { name, ctx } with the innermost last; ctx: it pushed a foreign context
  const open = new Map(); // name → how many are on the stack
  const foreign = ['none']; // innermost first, as in Parser.js
  let max = 0;
  let tag = '';
  const push = name => {
    const ctx = name === 'svg' ? 'svg' : name === 'math' ? 'math' : INTEGRATION.has(name) || (name === 'foreignobject' && foreign[0] === 'svg') ? 'none' : null;
    if (ctx) foreign.unshift(ctx);
    stack.push({ name, ctx });
    open.set(name, (open.get(name) || 0) + 1);
    if (stack.length > max && (max = stack.length) > RICH_MAX_DEPTH) throw TOO_DEEP;
  };
  const pop = () => {
    const e = stack.pop();
    open.set(e.name, open.get(e.name) - 1);
    if (e.ctx) foreign.shift();
  };
  const top = () => stack.at(-1)?.name;
  const noop = () => {};
  const tokenizer = new htmlparser.Tokenizer(
    { decodeEntities: true },
    {
      onopentagname(start, end) {
        tag = html.slice(start, end).toLowerCase();
        if (tag === 'image' && foreign[0] === 'none') tag = 'img';
        // A second <form> is ignored while one is open.
        if (tag === 'form' && open.get('form')) return void (tag = '');
        const implied = IMPLIES_CLOSE.get(tag);
        if (implied) while (stack.length && implied.has(top())) pop();
        if (!VOID.has(tag)) push(tag);
      },
      onclosetag(start, end) {
        const name = html.slice(start, end).toLowerCase();
        if (VOID.has(name) || !open.get(name)) return;
        while (top() !== name) pop();
        pop();
      },
      // Self-closing only counts inside SVG and MathML; elsewhere `<b/>` opens a <b>.
      onselfclosingtag() {
        if (foreign[0] !== 'none' && tag && top() === tag) pop();
      },
      isInForeignContext: () => foreign[0] !== 'none',
      onopentagend: noop,
      onattribdata: noop,
      onattribentity: noop,
      onattribend: noop,
      onattribname: noop,
      oncdata: noop,
      oncomment: noop,
      ondeclaration: noop,
      onend: noop,
      onprocessinginstruction: noop,
      ontext: noop,
      ontextentity: noop,
    },
  );
  try {
    tokenizer.write(html);
    tokenizer.end();
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
