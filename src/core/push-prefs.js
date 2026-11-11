// @ts-check
/* The account's Push preferences (Settings → Notifications → Push), shared by the app and the
   server. A preference that was never saved is on. */
export const PUSH_KEYS = ['push_mention', 'push_assign', 'push_comment', 'push_due'];

/* Whether the person gets any push at all. When every kind is off, nothing is pushed to any of their
   devices, access requests included (they stay in the Inbox), and the app says "Push is off". */
export const wantsPush = (/** @type {Record<string, unknown>} */ prefs = {}) => PUSH_KEYS.some(k => prefs[k] !== false);
