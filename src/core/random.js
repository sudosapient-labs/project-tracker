// @ts-check
/* Random hex for ids, from crypto.getRandomValues. Not crypto.randomUUID: browsers only offer that in
   a secure context (https or localhost), so calling it at load left a blank page when the app was
   opened over plain http on another address (e.g. http://100.64.0.7:8787 on a tailnet).
   getRandomValues is available everywhere. */
export function randomHex(length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.slice(0, length);
}
