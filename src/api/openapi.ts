import { z } from 'zod';
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { routes, documentRoutes } from './routes.js';
import { envelope, errorEnvelope, agentSchema, workspaceSchema, timelineSchema, streamEventSchema } from './models.js';

extendZodWithOpenApi(z);
const registry = new OpenAPIRegistry();
registry.registerComponent('securitySchemes', 'bridgeBearer', {
  type: 'http', scheme: 'bearer', description: 'Scoped Bridge token from a protected token file. Token administration is local-only. Never put tokens in URLs.'
});
// Zod's native converter supports SDK catch/default nodes which the route
// generator does not. Both conversions consume the same runtime schemas.
function jsonSchema(schema: z.ZodType) {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { io: 'output', cycles: 'ref' });
  return result;
}
for (const [name, schema] of Object.entries({ Agent: agentSchema, Workspace: workspaceSchema, Timeline: timelineSchema, AgentEvent: streamEventSchema, ApiError: errorEnvelope }))
  registry.registerComponent('schemas', name, jsonSchema(schema) as any);
const errors = Object.fromEntries([400, 401, 403, 404, 405, 409, 413, 415, 429, 502, 503, 504].map(status => [status, {
  description: ({ 401: 'Authentication required', 403: 'Host or operation not permitted', 409: 'Busy agent or unresolved send guard', 429: 'Rate limit exceeded; back off', 503: 'Offline host, unavailable authentication or capacity exhausted' } as Record<number, string>)[status] ?? 'Request failed; inspect the error code. Failure of a send request does not prove it was not delivered.',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } }
}]));
for (const route of routes) {
  const resultName = `${route.operationId}Response`;
  if (route.action !== 'events') registry.registerComponent('schemas', resultName, jsonSchema(envelope(route.response)) as any);
  const content = route.action === 'events'
    ? { 'text/event-stream': { schema: z.string(), example: 'event: connection\ndata: {"kind":"connection","state":"connected"}\n\n' } }
    : { 'application/json': { schema: { $ref: `#/components/schemas/${resultName}` } } };
  registry.registerPath({
    method: route.method, path: route.path, operationId: route.operationId, summary: route.summary,
    description: `${route.description}\nAuthorization operation scope: ${route.permissions.join(', ')}.`,
    tags: [route.action === 'events' ? 'Observation' : route.permissions[0]],
    'x-bridge-operations': route.permissions,
    security: [{ bridgeBearer: [] }],
    request: { params: route.params, query: route.query,
      ...(route.body ? { body: { required: true, content: { 'application/json': { schema: route.body } } } } : {}) },
    responses: { 200: { description: route.action === 'events' ? 'SSE stream; event data models are described by AgentEvent.' : 'Current result. Inspect partial or status=unknown; HTTP success alone is not task completion.', content },
      ...(route.permissions[0] === 'send' ? { 202: { description: 'Message accepted, not completed.', content } } : {}),
      ...errors,
      default: { description: 'An upstream gateway may return a non-JSON error. Never automatically retry a send.', content: { 'text/plain': { schema: z.string() }, 'text/html': { schema: z.string() } } }
    }
  });
}
for (const { path, media, summary } of documentRoutes) registry.registerPath({ method: 'get', path, security: [], summary,
  responses: { 200: { description: summary, content: { [media]: { schema: media === 'application/json' ? z.record(z.string(), z.unknown()) : z.string() } } },
    429: errors[429], 500: errors[502] } });

export function generateOpenAPI() { return new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: '3.1.0', info: { title: 'Paseo Bridge API', version: '0.2.0',
    description: 'REST commands and snapshots with recommended SSE observation. Prefer SSE for ongoing status/activity; clients without streaming support may poll agent and activity endpoints. Authentication, host/operation scopes and uncertainty rules apply to both modes. Local Unix-socket and central HTTPS clients use the same paths. Administrative operations are never exposed through HTTP.' },
  servers: [{ url: '/' }]
}); }
export const openapiDocument = generateOpenAPI();
export const openapiJSON = JSON.stringify(openapiDocument);
