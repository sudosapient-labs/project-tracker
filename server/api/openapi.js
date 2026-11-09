/* The OpenAPI 3.1 document for /api/v1, generated from the route table (v1.js) and the zod schemas
   requests are validated with (schemas.js). OpenAPI 3.1 uses JSON Schema 2020-12, which is what
   zod emits. */
import { z } from 'zod';
import { registry } from './schemas.js';

const ref = id => ({ $ref: `#/components/schemas/${id}` });
const strip = ({ $schema, $id, ...s }) => s;
const errorResponse = description => ({ description, content: { 'application/json': { schema: ref('Error') } } });
const ERRORS = {
  400: errorResponse('The request is invalid; `field` names the input at fault.'),
  401: errorResponse('Missing, revoked or expired API key.'),
  403: errorResponse('The key’s person may not do this (project permission, role, Guest limits), or the key is read-only (`insufficient_scope`).'),
  404: errorResponse('Not found, or not visible to the key’s person.'),
  429: errorResponse('Rate limit reached; see Retry-After.'),
};

/* Sudo-Time-Zone (v1.js clockOf): the caller's clock for one request, for a client acting for
   someone on another clock than the key's person's. */
const TIME_ZONE_PARAM = {
  name: 'Sudo-Time-Zone',
  in: 'header',
  required: false,
  description:
    'An IANA time zone (Asia/Dubai) to word and read dates on for this request instead of the key’s person’s: activity text, event `date` and `time`, `sort=due`, “today”, and an event’s `date` and `time` sent. For a client acting for someone else, such as a bot with one key for a team. The time format stays the key’s person’s; nothing is saved, and notifications, reminders and repeats keep each person’s own clock. A value that isn’t a zone is ignored.',
  schema: { type: 'string', maxLength: 64, examples: ['Asia/Dubai'] },
};

let cached;
export function openapi(routes, { appUrl }) {
  if (cached?.appUrl === appUrl) return cached.doc;
  const { schemas } = z.toJSONSchema(registry, { uri: id => `#/components/schemas/${id}` });
  const paths = {};
  for (const rt of routes) {
    const parameters = [];
    if (rt.params)
      for (const [name, s] of Object.entries(z.toJSONSchema(rt.params, { io: 'input' }).properties))
        parameters.push({ name, in: 'path', required: true, description: s.description, schema: { type: 'string' } });
    if (rt.query) {
      const js = z.toJSONSchema(rt.query, { io: 'input' });
      for (const [name, { description, ...schema }] of Object.entries(js.properties))
        parameters.push({ name, in: 'query', required: (js.required || []).includes(name), ...(description ? { description } : {}), schema });
    }
    parameters.push(TIME_ZONE_PARAM);
    if (rt.method !== 'get')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Retries with the same key and body get the first response back (kept 24 hours).',
        schema: { type: 'string', maxLength: 255 },
      });
    const id = rt.ok.schema && registry.get(rt.ok.schema)?.id;
    const body = rt.rawBody
      ? { requestBody: { required: true, description: rt.rawBody, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } }
      : rt.body
        ? { requestBody: { required: true, content: { 'application/json': { schema: strip(z.toJSONSchema(rt.body, { io: 'input' })) } } } }
        : {};
    const okContent = rt.ok.binary ? { '*/*': { schema: { type: 'string', format: 'binary' } } } : { 'application/json': { schema: ref(id) } };
    (paths[rt.path] ||= {})[rt.method] = {
      operationId: rt.id,
      summary: rt.summary,
      tags: [rt.tag],
      ...(parameters.length ? { parameters } : {}),
      ...(rt.description || rt.admin ? { description: [rt.description, rt.admin ? 'Owners and Admins only.' : ''].filter(Boolean).join(' ') } : {}),
      ...body,
      responses: {
        [rt.ok.status]: { description: rt.ok.status === 201 ? 'Created' : 'OK', content: okContent },
        ...ERRORS,
      },
    };
  }
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Sudo Sapient API',
      version: '1.0.0',
      description:
        'Personal API keys act as the person who created them: the same projects, role and Guest limits as in the app. Writes go through the same rules as the app and appear live in open tabs. Create a key in Settings → API.',
    },
    servers: [{ url: `${appUrl}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [...new Set(routes.map(rt => rt.tag))].map(name => ({ name })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A personal API key (ssk_…) from Settings → API.' } },
      schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, strip(v)])),
    },
  };
  cached = { appUrl, doc };
  return doc;
}
