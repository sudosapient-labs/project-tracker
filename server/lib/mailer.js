/* Email: messages are queued in `outbox` inside the caller's transaction, then delivered.
   With SMTP_URL set they go out through nodemailer; otherwise they are logged (and, outside
   production, the link is handed back to the API caller so local flows still complete). */
import nodemailer from 'nodemailer';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMailer(db, config, log = console) {
  const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;
  let draining = false;

  function queue({ to, subject, intro, action, link, outro = '' }) {
    const text = `${intro}\n\n${action}: ${link}\n\n${outro}`.trim();
    const html = `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#1d1c1a;max-width:480px">
      <p>${esc(intro)}</p>
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

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      const rows = db.all('SELECT * FROM outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT 50');
      for (const m of rows) {
        try {
          if (transport) await transport.sendMail({ from: config.mailFrom, to: m.to_addr, subject: m.subject, text: m.body_text, html: m.body_html });
          else if (!config.test) log.info?.(`[mail] to=${m.to_addr} subject="${m.subject}" link=${m.link}`);
          db.run('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?', Date.now(), m.id);
        } catch (e) {
          db.run('UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?', String(e.message || e), m.id);
          log.error?.(`[mail] failed to send to ${m.to_addr}: ${e.message}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  return { queue, drain, configured: !!transport };
}
