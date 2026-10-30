/* Rich text (task descriptions) is sanitised on write against the same allowlist the client renders
   with (src/core/rich-text.js), so stored HTML never carries scripts, styles, forms or foreign tags.
   The output matches how browsers serialise the editor's HTML (`<br>`, `&nbsp;`), so a clean
   description comes back unchanged. */
import sanitizeHtml from 'sanitize-html';
import { RICH_ATTRS, RICH_SCHEMES, RICH_TAGS } from '../../src/core/rich-text.js';

const OPTS = {
  allowedTags: RICH_TAGS,
  allowedAttributes: RICH_ATTRS,
  allowedSchemes: RICH_SCHEMES,
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
};

export const cleanRich = html =>
  sanitizeHtml(String(html ?? ''), OPTS)
    .replace(/<br \/>/g, '<br>')
    .replace(/\u00a0/g, '&nbsp;');
