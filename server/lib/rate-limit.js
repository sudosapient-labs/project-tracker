// @ts-check
/* Fixed-window, in-memory rate limiting. Good enough for a single process; put a shared store behind
   this if the API ever runs on several instances. */
const TOO_MANY = 'Too many attempts. Wait a minute and try again.';

export function rateLimiter({ enabled = true } = {}) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, 60_000).unref();

  const entry = (key, windowMs, now) => {
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    return h;
  };
  /* Count one use of `key`; false (and nothing counted) once `limit` uses in the window are spent. */
  const hit = (key, limit, windowMs) => {
    if (!enabled) return true;
    const h = entry(key, windowMs, Date.now());
    if (h.n >= limit) return false;
    h.n++;
    return true;
  };
  /* Like `hit`, but also says how many uses are left and when the window resets (for RateLimit-*
     headers): { ok, limit, remaining, reset } with `reset` in seconds. `cost` uses at once (all or
     none), e.g. one per message in a batch. */
  const take = (key, limit, windowMs, cost = 1) => {
    const now = Date.now();
    if (!enabled) return { ok: true, limit, remaining: limit, reset: Math.ceil(windowMs / 1000) };
    const h = entry(key, windowMs, now);
    const ok = h.n + cost <= limit;
    if (ok) h.n += cost;
    return { ok, limit, remaining: limit - h.n, reset: Math.max(1, Math.ceil((h.reset - now) / 1000)) };
  };
  /* Give back one use of `key` taken with `hit` (e.g. a reserved attempt that succeeded). */
  const refund = key => {
    const h = enabled && hits.get(key);
    if (h && h.n > 0) h.n--;
  };
  /* Seconds until `key` may be used again, or 0 when it has uses left. Counts nothing. */
  const blocked = (key, limit) => {
    const h = enabled && hits.get(key);
    return h && h.reset >= Date.now() && h.n >= limit ? Math.ceil((h.reset - Date.now()) / 1000) : 0;
  };

  /* Middleware, keyed by client IP unless `keyOf(c)` says otherwise (e.g. the signed-in person). */
  const limit =
    (name, n, windowMs, { keyOf = c => c.get('ip'), message = TOO_MANY } = {}) =>
    async (c, next) => {
      const key = `${name}:${keyOf(c)}`;
      if (!hit(key, n, windowMs)) {
        c.header('Retry-After', String(blocked(key, n)));
        return c.json({ error: message }, 429);
      }
      return next();
    };
  return Object.assign(limit, { hit, take, blocked, refund });
}
