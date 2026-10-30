/* Fixed-window, in-memory rate limiting for the unauthenticated auth endpoints. Good enough for a
   single process; put a shared store behind this if the API ever runs on several instances. */
export function rateLimiter({ enabled = true } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000).unref();

  return (name, limit, windowMs) => async (c, next) => {
    if (!enabled) return next();
    const ip = c.get('ip');
    const key = `${name}:${ip}`;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > limit) {
      c.header('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return c.json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);
    }
    return next();
  };
}
