/* Parse and validate a JSON body. Returns { data } or { error: Response } with the first issue. */
export async function parseBody(c, schema) {
  let raw;
  try {
    raw = await c.req.json();
  } catch {
    return { error: c.json({ error: 'Request body must be JSON.' }, 400) };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    return { error: c.json({ error: i.message, field: i.path[0] ?? null }, 400) };
  }
  return { data: r.data };
}

/* Thrown inside sync rules to reject one operation without failing the batch. */
export class Reject extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}
