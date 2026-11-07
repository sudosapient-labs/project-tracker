// @ts-check
/* What one request may make the server spend on rich text (see richDesc in rules.js). */
/* Characters of descriptions checked and sanitised in all: 10 full descriptions. */
export const RICH_PER_REQUEST = 1_000_000;
/* Milliseconds spent checking and sanitising them, a backstop that doesn't rely on the checks. */
export const RICH_MS_PER_REQUEST = 500;
