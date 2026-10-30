/* Web Push. VAPID keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once and kept
   in `server_keys` so a plain install works without setup. Sending happens after the database commit
   (see engine.publish); subscriptions the push service reports as gone are deleted. */
import webpush from 'web-push';

export function createPusher(db, config, log = console, send = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts)) {
  let keys = config.vapidPublicKey && config.vapidPrivateKey ? { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey } : null;
  if (!keys) {
    const row = db.get("SELECT value FROM server_keys WHERE name = 'vapid'");
    keys = row ? JSON.parse(row.value) : webpush.generateVAPIDKeys();
    if (!row) db.run("INSERT INTO server_keys (name, value) VALUES ('vapid', ?)", JSON.stringify(keys));
  }
  const vapidDetails = { subject: config.vapidSubject, publicKey: keys.publicKey, privateKey: keys.privateKey };

  function subscribe(userId, sub, userAgent = '') {
    db.run(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, user_agent, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      sub.endpoint,
      userId,
      sub.keys.p256dh,
      sub.keys.auth,
      userAgent.slice(0, 400),
      Date.now(),
    );
  }
  const unsubscribe = (userId, endpoint) => db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, userId);

  /* Deliver to every browser the person subscribed. Never throws; returns the number delivered. */
  async function notify(userId, message) {
    const subs = db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
    const body = JSON.stringify(message);
    let ok = 0;
    await Promise.all(
      subs.map(async s => {
        try {
          await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails, TTL: 24 * 3600, urgency: 'normal' });
          ok++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
          else log.error?.(`[push] ${s.endpoint.slice(0, 60)}… failed: ${e.statusCode || ''} ${e.message}`);
        }
      }),
    );
    return ok;
  }

  return { publicKey: keys.publicKey, subscribe, unsubscribe, notify };
}
