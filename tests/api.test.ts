import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { apiServer, listen, listenSocket, closeServer } from '../src/api/server.js';
import { call } from '../src/api/client.js';
import { BridgeService, requestSchema } from '../src/service.js';
import { digest, RateLimiter } from '../src/auth.js';
import { clientSchema, type Operation } from '../src/config.js';
import { directory, fixture, secret } from './fixtures.js';

async function central(operations: Operation[] = ['status', 'agents']) {
  const dir = await directory(); const auth = join(dir, 'auth.json');
  const token = randomBytes(32).toString('base64url');
  await secret(auth, { version: 1, clients: { client: { digest: digest(token), hosts: ['aspen'], operations } } });
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection], ['aspen', a.connection]]));
  const server = apiServer(service, auth); await listen(server, 0, '127.0.0.1');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (path: string, credential = token) => fetch(url + '/api/v1' + path, { headers: { authorization: `Bearer ${credential}` } });
  return { server, auth, token, get, url, state: a.state };
}
test('central REST requires auth, enforces scope and revokes without restarting', async () => {
  const s = await central();
  try {
    assert.equal((await s.get('/hosts', 'wrong')).status, 401);
    const ok = await s.get('/hosts'); assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as any).data.results.map((x: any) => x.host), ['aspen']);
    assert.equal((await s.get('/hosts/birch')).status, 403);
    assert.equal((await s.get('/hosts/aspen/agents/agent-1')).status, 403);
    await secret(s.auth, { version: 1, clients: {} });
    assert.equal((await s.get('/hosts/aspen')).status, 401);
  } finally { await closeServer(s.server); }
});
test('REST strictly validates paths, queries, bodies, limits, methods and content type; legacy route removed', async () => {
  const s = await central(['status', 'agents', 'send', 'wait', 'activity']);
  const path = '/api/v1/hosts/aspen/agents/agent-1/messages';
  const post = (body: string, type = 'application/json') => fetch(s.url + path, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': type }, body });
  try {
    for (const query of ['?extra=x', '?host=all&host=all', '?host=../escape', '?__proto__=bad']) assert.equal((await s.get('/agents' + query)).status, 400);
    for (const query of ['?tail=-1', '?tail=201', '?tail=no', '?tail=', '?tail=1.5']) assert.equal((await s.get('/hosts/aspen/agents/agent-1/activity' + query)).status, 400);
    assert.equal((await s.get('/hosts/all/agents/agent-1')).status, 400);
    assert.equal((await s.get('/hosts/aspen/agents/%FF')).status, 400);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('{}', 'text/plain')).status, 415);
    assert.equal((await post(JSON.stringify({ prompt: 'x'.repeat(270000) }))).status, 413);
    for (const value of [{ prompt: ' ' }, { prompt: 'hi', op: 'send' }, { prompt: 'hi', interrupt: 'true' }]) assert.equal((await post(JSON.stringify(value))).status, 400);
    for (const route of ['/v1/request', '/api/v1/admin', '/api/v1/openapi/assets/unknown.js']) assert.equal((await fetch(s.url + route)).status, 404);
    assert.equal((await fetch(s.url + '/v1/request', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(s.url + '/api/v1/hosts', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(s.url + '/api/v1/hosts', { method: 'GET', headers: { authorization: `Bearer ${s.token}`, 'content-length': '0' } })).status, 200);
    assert.equal(s.state.sends.length, 0);
  } finally { await closeServer(s.server); }
});
test('REST send has exact accepted/unknown HTTP semantics, no retries, and snapshots/activity remain ordinary queries', async () => {
  const s = await central(['send', 'wait', 'activity', 'workspaces']);
  const send = () => fetch(s.url + '/api/v1/hosts/aspen/agents/agent-1/messages', { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'synthetic fixture only', interrupt: false }) });
  try {
    const accepted = await send(); assert.equal(accepted.status, 202); assert.equal((await accepted.json() as any).data.status, 'accepted');
    s.state.sendError = true; const unknown = await send(); assert.equal(unknown.status, 200);
    const result = (await unknown.json() as any).data; assert.equal(result.status, 'unknown'); assert.equal(result.retrySafe, false); assert.equal(s.state.sends.length, 2);
    const snapshot = await s.get('/hosts/aspen/agents/agent-1'); assert.equal(snapshot.status, 200); assert.equal((await snapshot.json() as any).data.result.status, 'idle');
    const activity = await s.get('/hosts/aspen/agents/agent-1/activity?tail=1'); assert.equal(activity.status, 200); assert.equal((await activity.json() as any).data.timeline.entries[0].item.text, 'received');
    const workspaces = await s.get('/workspaces?host=all'); assert.equal(workspaces.status, 200); assert.equal((await workspaces.json() as any).data.results[0].entries[0].workspaceDirectory, '/project');
  } finally { await closeServer(s.server); }
});
test('local socket REST API and client work together; live socket cannot be replaced', async () => {
  const dir = await directory(); const socket = join(dir, 'bridge.sock'); const a = fixture();
  const server = apiServer(new BridgeService(new Map([['birch', a.connection]]))); await listenSocket(server, socket);
  const second = apiServer(new BridgeService(new Map()));
  try {
    const config = clientSchema.parse({ version: 1, defaultProfile: 'local', profiles: { local: { kind: 'local', socket } } });
    const result = await call(config, undefined, requestSchema.parse({ op: 'agents', host: 'all' }));
    assert.equal(result.results[0].entries[0].id, 'agent-1');
    await assert.rejects(listenSocket(second, socket), { code: 'SOCKET_EXISTS' });
    await assert.rejects(call(config, 'missing', requestSchema.parse({ op: 'status', host: 'all' })), { code: 'PROFILE' });
  } finally { await closeServer(server); await closeServer(second); }
});
test('central client rejects insecure urls and embedded credentials', () => {
  for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?token=x'])
    assert.equal(clientSchema.safeParse({ version: 1, defaultProfile: 'central', profiles: { central: { kind: 'central', url, tokenFile: '/tmp/token' } } }).success, false);
});
test('failed-auth flood at a shared proxy source cannot block valid tokens', async () => {
  const s = await central();
  try {
    const unknown = randomBytes(32).toString('base64url');
    for (let i = 0; i < 600; i++) assert.equal((await s.get('/hosts', unknown)).status, 401);
    assert.equal((await s.get('/hosts', unknown)).status, 429); assert.equal((await s.get('/hosts')).status, 200);
  } finally { await closeServer(s.server); }
});
test('pending snapshots retain per-client accounting after disconnect; another client remains usable', async () => {
  const s = await central(); const second = randomBytes(32).toString('base64url');
  await secret(s.auth, { version: 1, clients: {
    a: { digest: digest(s.token), hosts: ['aspen'], operations: ['status', 'wait'] },
    b: { digest: digest(second), hosts: ['aspen'], operations: ['status'] }
  } });
  let release!: () => void; s.state.refreshGate = new Promise<void>(resolve => { release = resolve; });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map(controller => fetch(s.url + '/api/v1/hosts/aspen/agents/agent-1', { headers: { authorization: `Bearer ${s.token}` }, signal: controller.signal }).catch(() => undefined));
  try {
    const until = Date.now() + 3000;
    while (s.state.refreshes < 8 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(s.state.refreshes, 8);
    assert.equal((await s.get('/hosts/aspen/agents/agent-1')).status, 503);
    for (const controller of controllers) controller.abort(); await Promise.all(pending);
    assert.equal((await s.get('/hosts/aspen/agents/agent-1')).status, 503);
    assert.equal((await s.get('/hosts', second)).status, 200);
  } finally { release(); await Promise.all(pending); await closeServer(s.server); }
});
test('rate limiter rejects excess requests and isolates clients', () => {
  const limiter = new RateLimiter(2); limiter.take('a'); limiter.take('a');
  assert.throws(() => limiter.take('a'), { code: 'RATE_LIMIT' }); limiter.take('b');
});
