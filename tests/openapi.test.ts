import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { apiServer, listen, closeServer } from '../src/api/server.js';
import { openapiDocument, generateOpenAPI } from '../src/api/openapi.js';
import { routes, documentRoutes } from '../src/api/routes.js';
import { workspaceSchema, agentSchema, timelineSchema } from '../src/api/models.js';
import { BridgeService } from '../src/service.js';
import { directory, fixture, secret } from './fixtures.js';
import { digest } from '../src/auth.js';

test('OpenAPI is deterministically generated from every route and concrete output schema', () => {
  const doc = openapiDocument as any;
  assert.deepEqual(generateOpenAPI(), doc); assert.equal(doc.openapi, '3.1.0');
  for (const route of routes) {
    const operation = doc.paths[route.path][route.method.toLowerCase()];
    assert.equal(operation.operationId, route.operationId); assert.deepEqual(operation['x-bridge-operations'], route.permissions);
    assert(operation.responses[200]); assert(operation.responses[401]); assert(operation.responses[403]);
  }
  for (const resource of documentRoutes) { assert.deepEqual(doc.paths[resource.path].get.security, []); assert(doc.paths[resource.path].get.responses[200].content[resource.media]); }
  assert(!doc.paths['/v1/request']);
  const send = doc.paths['/api/v1/hosts/{host}/agents/{agent}/messages'].post;
  assert(send.responses[202]); assert.deepEqual(Object.keys(send.requestBody.content['application/json'].schema.properties).sort(), ['interrupt', 'prompt']);
  const events = doc.paths['/api/v1/hosts/{host}/agents/{agent}/events'].get;
  assert(events.responses[200].content['text/event-stream']); assert(events.description.includes('No durable event replay'));
  assert.equal(doc.components.schemas.Agent.properties.id.type, 'string'); assert(doc.components.schemas.Agent.required.includes('capabilities'));
  assert(doc.components.schemas.Timeline.properties.entries.items.properties.item.anyOf.length > 5);
  assert(doc.components.schemas.Workspace.properties.workspaceDirectory); assert(doc.components.schemas.AgentEvent.oneOf || doc.components.schemas.AgentEvent.anyOf);
  const json = JSON.stringify(doc); assert(!json.includes('/root/')); assert(!json.includes('aspen')); assert(!json.includes('birch'));
});
test('output models validate actual SDK-normalized fixture shapes, including transformed workspace fields', () => {
  const f = fixture(); assert(agentSchema.safeParse(f.agent).success); assert(workspaceSchema.safeParse(f.workspace).success);
  assert.equal(f.workspace.statusEnteredAt, null); assert.equal(f.workspace.workspaceDirectory, '/project');
  assert(timelineSchema.safeParse({ ...f.connection.api.agents.ref('agent-1') }).success === false);
  const checkout = { cwd: '/project', isGit: false, currentBranch: null, remoteUrl: null, worktreeRoot: null, isPaseoOwnedWorktree: false, mainRepoRoot: null };
  const project = { projectKey: 'prj-1', projectName: 'Project', checkout };
  assert(workspaceSchema.safeParse({ ...f.workspace, project }).success);
});
test('application serves anonymous self-hosted Redoc, generated JSON and fixed assets; no runtime contents or arbitrary files', async () => {
  const dir = await directory(); const auth = join(dir, 'auth.json'); const token = randomBytes(32).toString('base64url');
  await secret(auth, { version: 1, clients: { privateClient: { digest: digest(token), hosts: ['secret-host'], operations: ['status'] } } });
  const server = apiServer(new BridgeService(new Map()), auth); await listen(server, 0, '127.0.0.1');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const spec = await fetch(url + '/api/v1/openapi.json'); assert.equal(spec.status, 200); assert.equal(spec.headers.get('cache-control'), 'no-store');
    const text = await spec.text(); assert.deepEqual(JSON.parse(text), openapiDocument); assert(!text.includes(token)); assert(!text.includes('secret-host')); assert(!text.includes('privateClient')); assert(!text.includes(dir));
    const html = await fetch(url + '/api/v1/openapi'); assert.equal(html.status, 200); assert(html.headers.get('content-security-policy')?.includes("script-src 'self'"));
    const page = await html.text(); assert(page.includes('./openapi/assets/redoc.standalone.js')); assert(!page.includes('https://')); assert(page.includes('disableGoogleFont:true'));
    const js = await fetch(url + '/api/v1/openapi/assets/redoc.standalone.js'); assert.equal(js.status, 200); assert(js.headers.get('content-type')?.includes('javascript')); const source = await js.text(); assert(source.length > 1000000); assert(!source.includes('https://cdn.redoc.ly/redoc/logo-mini.svg')); assert(source.includes('data:image/svg+xml;base64,'));
    const license = await fetch(url + '/api/v1/openapi/assets/redoc.licenses.txt'); assert.equal(license.status, 200); assert((await license.text()).includes('MIT'));
    for (const path of ['/api/v1/openapi/assets/package.json', '/api/v1/openapi/assets/redoc.standalone.js.map', '/api/v1/openapi.json?token=not-allowed', '/api/v1/hosts']) assert.equal((await fetch(url + path)).status, path.endsWith('/hosts') ? 401 : 404);
    assert.equal((await fetch(url + '/api/v1/openapi', { method: 'POST' })).status, 404);
  } finally { await closeServer(server); }
});
