import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createConnection, persistedConnection } from '../src/paseo/connection.js';
import { directory, secret } from './fixtures.js';
import { deadline } from '../src/errors.js';
import { runServer } from '../src/runtime.js';
import { clientSchema } from '../src/config.js';
import { call } from '../src/api/client.js';
import { requestSchema } from '../src/service.js';

async function daemon(port = 0) {
  const server = new WebSocketServer({ host: '127.0.0.1', port });
  await once(server, 'listening');
  let hellos = 0;
  server.on('connection', socket => socket.on('message', raw => {
    const value = JSON.parse(raw.toString());
    if (value.type === 'hello') {
      hellos++;
      socket.send(JSON.stringify({ type: 'session', message: { type: 'status', payload: { status: 'server_info', serverId: 'mock-daemon', version: '0.11.1' } } }));
    } else if (value.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    else if (value.type === 'session' && ['fetch_workspaces_request', 'fetch_agents_request'].includes(value.message.type)) {
      socket.send(JSON.stringify({ type: 'session', message: { type: value.message.type.replace('_request', '_response'), payload: {
        requestId: value.message.requestId, entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
      } } }));
    }
  }));
  return { server, port: (server.address() as { port: number }).port, hellos: () => hellos,
    close: async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
async function eventually(check: () => boolean, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!check() && Date.now() < until) await sleep(50);
  assert(check(), 'Expected connection state was not reached');
}
test('official SDK connects, recovers after daemon restart and persists identity', { timeout: 20000 }, async () => {
  let d = await daemon(); const port = d.port; const dir = await directory();
  const file = join(dir, 'credential.json'); await secret(file, { kind: 'direct', url: `ws://127.0.0.1:${port}/ws` });
  const connection = await persistedConnection(file, dir, 'birch');
  try {
    await connection.start(); assert.equal(connection.state(), 'connected');
    const result = await deadline(connection.api.workspaces.list({ page: { limit: 1 } }), 2000); assert.equal(result.entries.length, 0);
    const identity = await readFile(join(dir, 'birch.client-id'), 'utf8');
    await d.close(); await eventually(() => connection.state() !== 'connected');
    d = await daemon(port);
    await eventually(() => connection.state() === 'connected');
    assert(d.hellos() > 0);
    assert.equal((await deadline(connection.api.workspaces.list(), 2000)).entries.length, 0);
    await connection.close();
    await assert.rejects(connection.start(), { code: 'CLOSED' });
    const next = await persistedConnection(file, dir, 'birch');
    try { await next.start(); assert.equal(next.state(), 'connected'); assert.equal(await readFile(join(dir, 'birch.client-id'), 'utf8'), identity); }
    finally { await next.close(); }
  } finally { await connection.close(); await d.close(); }
});
test('initial connection failure later recovers', { timeout: 20000 }, async () => {
  let d = await daemon(); const port = d.port; await d.close();
  const connection = await createConnection({ kind: 'direct', url: `ws://127.0.0.1:${port}/ws` }, randomUUID());
  try {
    await connection.start(); assert.notEqual(connection.state(), 'connected');
    d = await daemon(port); await eventually(() => connection.state() === 'connected');
  } finally { await connection.close(); await d.close(); }
});
test('resident service reloads hosts, rejects invalid reload and restarts with persisted state', { timeout: 20000 }, async () => {
  const d = await daemon(); const dir = await directory(); const credential = join(dir, 'connection.json');
  await secret(credential, { kind: 'direct', url: `ws://127.0.0.1:${d.port}/ws` });
  const file = join(dir, 'bridge.json'); const socket = join(dir, 'bridge.sock');
  const config = { version: 1, hosts: { birch: { connectionFile: credential } } as Record<string, { connectionFile: string }>, socket, stateDir: dir };
  await secret(file, config);
  let runtime = await runServer(file);
  const client = clientSchema.parse({ version: 1, defaultProfile: 'local', profiles: { local: { kind: 'local', socket } } });
  try {
    await eventually(() => runtime.service.hosts.get('birch')?.state() === 'connected');
    const identity = await readFile(join(dir, 'birch.client-id'), 'utf8');
    config.hosts.aspen = { connectionFile: credential }; await secret(file, config); process.emit('SIGHUP');
    await eventually(() => runtime.service.hosts.get('aspen')?.state() === 'connected');
    assert.equal((await call(client, undefined, requestSchema.parse({ op: 'status', host: 'all' }))).results.length, 2);
    config.hosts.bad = { connectionFile: join(dir, 'missing') }; await secret(file, config); process.emit('SIGHUP');
    await sleep(150); assert.equal(runtime.service.hosts.has('bad'), false); assert.equal(runtime.service.hosts.get('aspen')?.state(), 'connected');
    delete config.hosts.bad; await secret(file, config);
    await runtime.stop(); runtime = await runServer(file);
    await eventually(() => runtime.service.hosts.get('birch')?.state() === 'connected');
    assert.equal(await readFile(join(dir, 'birch.client-id'), 'utf8'), identity);
    assert.equal((await call(client, undefined, requestSchema.parse({ op: 'workspaces', host: 'all' }))).partial, false);
  } finally { await runtime.stop(); await d.close(); }
});
test('non-loopback plaintext direct connections rejected', async () => {
  await assert.rejects(createConnection({ kind: 'direct', url: 'ws://example.com:6767/ws' }, randomUUID()), { code: 'DIRECT_URL' });
});
test('optional real local daemon read-only smoke test', { skip: !process.env.PASEO_TEST_LOCAL_CREDENTIAL, timeout: 20000 }, async () => {
  const connection = await createConnection({ kind: 'direct', url: 'ws://127.0.0.1:6767/ws', localCredentialFile: process.env.PASEO_TEST_LOCAL_CREDENTIAL! }, randomUUID());
  try {
    await connection.start(); assert.equal(connection.state(), 'connected');
    const workspaces = await connection.api.workspaces.list({ page: { limit: 10 } });
    assert(Array.isArray(workspaces.entries));
    const agents = await connection.api.agents.list({ page: { limit: 10 } }); assert(Array.isArray(agents.entries));
  } finally { await connection.close(); }
});
