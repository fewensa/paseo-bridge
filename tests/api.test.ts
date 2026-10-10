import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { apiServer, listen, listenSocket, closeServer } from '../src/api/server.js';
import { call } from '../src/api/client.js';
import { BridgeService, requestSchema } from '../src/service.js';
import { digest, RateLimiter } from '../src/auth.js';
import { clientSchema } from '../src/config.js';
import { directory, fixture, secret } from './fixtures.js';

async function central() {
  const dir = await directory(); const auth = join(dir, 'auth.json');
  const token = randomBytes(32).toString('base64url');
  await secret(auth, { version: 1, clients: { birch: { digest: digest(token), hosts: ['aspen'], operations: ['status', 'agents'] } } });
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection], ['aspen', a.connection]]));
  const server = apiServer(service, auth); await listen(server, 0, '127.0.0.1');
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/v1/request`;
  async function post(input: unknown, credential = token) {
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(input) });
  }
  return { server, auth, token, post, url, state: a.state };
}
test('central requires auth, enforces scope and revokes without restarting', async () => {
  const s = await central();
  try {
    assert.equal((await s.post({ op: 'status', host: 'all' }, 'wrong')).status, 401);
    const ok = await s.post({ op: 'status', host: 'all' }); assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json() as any).data.results.map((x: any) => x.host), ['aspen']);
    assert.equal((await s.post({ op: 'status', host: 'birch' })).status, 403);
    assert.equal((await s.post({ op: 'send', host: 'aspen', agent: 'x', prompt: 'hi' })).status, 403);
    await secret(s.auth, { version: 1, clients: {} });
    assert.equal((await s.post({ op: 'status', host: 'aspen' })).status, 401);
  } finally { await closeServer(s.server); }
});
test('invalid body, size limits, content type and routes', async () => {
  const s = await central();
  try {
    assert.equal((await s.post({ op: 'delete', host: 'all' })).status, 400);
    assert.equal((await s.post({ op: 'status', host: 'all', extra: 'x'.repeat(270000) })).status, 413);
    assert.equal((await fetch(s.url)).status, 404);
    assert.equal((await fetch(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: '{}' })).status, 415);
    const invalid = await fetch(s.url, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
  } finally { await closeServer(s.server); }
});
test('local socket API and client work together; live socket cannot be replaced', async () => {
  const dir = await directory(); const socket = join(dir, 'bridge.sock'); const a = fixture();
  const server = apiServer(new BridgeService(new Map([['birch', a.connection]])));
  await listenSocket(server, socket);
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
    for (let i = 0; i < 600; i++) assert.equal((await s.post({ op: 'status', host: 'all' }, unknown)).status, 401);
    assert.equal((await s.post({ op: 'status', host: 'all' }, unknown)).status, 429);
    assert.equal((await s.post({ op: 'status', host: 'all' })).status, 200);
  } finally { await closeServer(s.server); }
});
test('long waits have per-client caps and disconnects cannot evade accounting', async () => {
  const s = await central(); const second = randomBytes(32).toString('base64url');
  await secret(s.auth, { version: 1, clients: {
    a: { digest: digest(s.token), hosts: ['aspen'], operations: ['status', 'wait'] },
    b: { digest: digest(second), hosts: ['aspen'], operations: ['status'] }
  } });
  let release!: () => void; s.state.waitGate = new Promise<void>(resolve => { release = resolve; });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const pending = controllers.map(controller => fetch(s.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ op: 'wait', host: 'aspen', agent: 'agent-1', timeout: 10 }), signal: controller.signal }).catch(() => undefined));
  try {
    const until = Date.now() + 3000;
    while (s.state.waits < 8 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(s.state.waits, 8);
    assert.equal((await s.post({ op: 'wait', host: 'aspen', agent: 'agent-1', timeout: 10 })).status, 503);
    assert.equal((await s.post({ op: 'status', host: 'all' }, second)).status, 200);
    for (const controller of controllers) controller.abort(); await Promise.all(pending);
    assert.equal((await s.post({ op: 'wait', host: 'aspen', agent: 'agent-1', timeout: 10 })).status, 503);
    assert.equal((await s.post({ op: 'status', host: 'all' }, second)).status, 200);
  } finally { release(); await Promise.all(pending); await closeServer(s.server); }
});
test('rate limiter rejects excess requests and isolates clients', () => {
  const limiter = new RateLimiter(2);
  limiter.take('a'); limiter.take('a');
  assert.throws(() => limiter.take('a'), { code: 'RATE_LIMIT' }); limiter.take('b');
});
