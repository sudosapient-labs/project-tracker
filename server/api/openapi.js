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
  403: errorResponse('The key’s person may not do this (project permission, Guest limits) or the key is read-only (`insufficient_scope`).'),
  404: errorResponse('Not found, or not visible to the key’s person.'),
  429: errorResponse('Rate limit reached; see Retry-After.'),
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
    if (rt.method !== 'get')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        description: 'Retries with the same key and body get the first response back (kept 24 hours).',
        schema: { type: 'string', maxLength: 255 },
      });
    const id = registry.get(rt.ok.schema)?.id;
    (paths[rt.path] ||= {})[rt.method] = {
      operationId: rt.id,
      summary: rt.summary,
      tags: [rt.tag],
      ...(parameters.length ? { parameters } : {}),
      ...(rt.body ? { requestBody: { required: true, content: { 'application/json': { schema: strip(z.toJSONSchema(rt.body, { io: 'input' })) } } } } : {}),
      responses: {
        [rt.ok.status]: { description: rt.ok.status === 201 ? 'Created' : 'OK', content: { 'application/json': { schema: ref(id) } } },
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
    tags: ['Me', 'Tasks', 'Comments', 'Projects', 'Members', 'Search'].map(name => ({ name })),
    paths,
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', description: 'A personal API key (ssk_…) from Settings → API.' } },
      schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, strip(v)])),
    },
  };
  cached = { appUrl, doc };
  return doc;
}
