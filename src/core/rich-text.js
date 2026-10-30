/* What a rich-text description may contain: exactly what the drawer's editor produces (bold,
   italic, lists, a heading, links, and the paragraphs, line breaks and divs contenteditable writes).
   The client (DOMPurify, ui/helpers.js) and the server (sanitize-html, server/lib/rich-text.js) both
   sanitise against this list, so anything else is dropped before it's stored or rendered. */
export const RICH_TAGS = ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'h4', 'a'];
export const RICH_ATTRS = { a: ['href'] };
export const RICH_SCHEMES = ['http', 'https', 'mailto'];
