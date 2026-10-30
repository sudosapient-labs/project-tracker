/* Email: messages are queued in `outbox` inside the caller's transaction, then delivered.
   With RESEND_API_KEY set they go out through Resend's HTTP API; otherwise they are logged (and,
   outside production, the link is handed back to the API caller so local flows still complete). */

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RESEND_URL = 'https://api.resend.com/emails';
const MAX_ATTEMPTS = 5;

/* `fetchImpl` is injectable so tests can stand in for Resend. */
export function createMailer(db, config, log = console, fetchImpl = globalThis.fetch) {
  const configured = !!config.resendApiKey;
  let draining = false;

  function queue({ to, subject, intro, action, link, outro = '' }) {
    const text = `${intro}\n\n${action}: ${link}\n\n${outro}`.trim();
    const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1d1c1a;max-width:480px">
      <p>${esc(intro).replace(/\n/g, '<br>')}</p>
      <p><a href="${esc(link)}" style="display:inline-block;background:#1d1c1a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(action)}</a></p>
      <p style="color:#6b6760;font-size:12px">${esc(outro)}<br>Or paste this link into your browser: ${esc(link)}</p></div>`;
    db.run(
      'INSERT INTO outbox (to_addr, subject, body_text, body_html, link, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      to,
      subject,
      text,
      html,
      link,
      Date.now(),
    );
  }

  /* Resend's Idempotency-Key makes a retried row (e.g. after a timeout) send at most once. */
  async function sendViaResend(m) {
    const res = await fetchImpl(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `outbox-${m.id}-${m.created_at}`,
      },
      body: JSON.stringify({ from: config.mailFrom, to: [m.to_addr], subject: m.subject, text: m.body_text, html: m.body_html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    const err = new Error(`Resend ${res.status}: ${body.message || res.statusText}`);
    // Rate limits and server errors are worth retrying; other 4xx (bad sender, unverified domain,
    // invalid address) won't fix themselves.
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const rows = db.all('SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < ? ORDER BY id LIMIT 50', MAX_ATTEMPTS);
      for (const m of rows) {
        try {
          if (configured) await sendViaResend(m);
          else if (!config.test) log.info?.(`[mail] to=${m.to_addr} subject="${m.subject}" link=${m.link}`);
          db.run('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?', Date.now(), m.id);
        } catch (e) {
          db.run('UPDATE outbox SET attempts = ?, error = ? WHERE id = ?', e.permanent ? MAX_ATTEMPTS : m.attempts + 1, String(e.message || e), m.id);
          log.error?.(`[mail] failed to send to ${m.to_addr}: ${e.message}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  return { queue, drain, configured };
}
