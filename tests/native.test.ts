import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createDaemonChannel, generateKeyPair, exportPublicKey, type Transport } from '@getpaseo/relay';
import { nativeProxyServer } from '../src/native/proxy.js';
import { nativeCall, nativeConfig } from '../src/native/client.js';
import { operations, serverSchema } from '../src/config.js';
import { digest } from '../src/auth.js';
import { listen, closeServer } from '../src/api/server.js';
import { directory, secret } from './fixtures.js';
import { requestSchema } from '../src/service.js';
const exec = promisify(execFile);

test('native proxy admits trusted owner only and rejects legacy plaintext business routes', async () => {
  const dir = await directory(); const token = randomBytes(32).toString('base64url'); const restricted = randomBytes(32).toString('base64url');
  const auth = join(dir, 'auth.json'); await secret(auth, { version: 1, clients: {
    owner: { digest: digest(token), hosts: ['aspen'], operations },
    query: { digest: digest(restricted), hosts: ['aspen'], operations: ['status', 'agents', 'activity', 'wait'] }
  } });
  const proxy = nativeProxyServer({ authFile: auth, hosts: { aspen: { serverId: 'synthetic', url: 'wss://localhost/ws?role=client&serverId=synthetic' } } });
  await listen(proxy.server, 0, '127.0.0.1'); const origin = `http://127.0.0.1:${(proxy.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(origin + '/api/v1/hosts')).status, 426);
    assert.equal((await fetch(origin + '/api/v1/native/hosts')).status, 401);
    assert.equal((await fetch(origin + '/api/v1/native/hosts', { headers: { authorization: `Bearer ${restricted}` } })).status, 403);
    const result = await fetch(origin + '/api/v1/native/hosts', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(result.status, 200); assert.deepEqual((await result.json()).data.hosts.aspen, { serverId: 'synthetic' });
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/v1/native/connect/aspen?role=client&serverId=synthetic', { headers: { authorization: `Bearer ${restricted}` } });
      ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode!); ws.terminate(); }); ws.on('error', () => {}); ws.on('open', () => { ws.terminate(); reject(Error('Restricted token admitted')); });
    }); assert.equal(code, 403);
    for (const query of ['&password=secret', '&daemonPublicKey=secret', '&role=client', '&v=1']) {
      assert.throws(() => serverSchema.parse({ version: 1, hosts: {}, socket: join(dir, 'socket'), stateDir: dir, central: { port: 8787, authFile: auth }, nativeRelay: { hosts: { aspen: { serverId: 'synthetic', url: 'wss://localhost/ws?role=client&serverId=synthetic' + query } } } }));
    }
    assert.throws(() => serverSchema.parse({ version: 1, hosts: {}, socket: join(dir, 'socket'), stateDir: dir, central: { port: 8787, authFile: auth }, nativeRelay: { hosts: { aspen: { serverId: 'different', url: 'wss://localhost/ws?role=client&serverId=synthetic' } } } }));
  } finally { proxy.stop(); await closeServer(proxy.server); }
});

test('official SDK uses opaque TLS proxy without daemon credential headers or a local Bridge service', { timeout: 30000 }, async () => {
  const dir = await directory(); const certFile = join(dir, 'cert.pem'); const keyFile = join(dir, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  const key = generateKeyPair(); const pub = exportPublicKey(key.publicKey); const tls = { key: await readFile(keyFile), cert: await readFile(certFile) };
  const upstream = createServer(tls); const relay = new WebSocketServer({ server: upstream }); let queries = 0; const wire: string[] = [];
  relay.on('connection', (socket, req) => {
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers['sec-websocket-protocol'], undefined);
    const t: Transport = { send: data => socket.send(data), close: (c, r) => socket.close(c, r), onmessage: null, onclose: null, onerror: null };
    socket.on('message', (data, binary) => { wire.push(data.toString()); t.onmessage?.({ data: binary ? Uint8Array.from(data as Buffer).buffer : data.toString(), isBinary: binary }); });
    socket.on('close', (c, r) => t.onclose?.(c, r.toString())); socket.on('error', e => t.onerror?.(e));
    let channel: ReturnType<typeof createDaemonChannel>;
    channel = createDaemonChannel(t, key, { onmessage: data => {
      const v = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString()); let reply: unknown;
      if (v.type === 'hello') { assert.equal(v.auth.password, 'synthetic-daemon-password'); reply = { type: 'session', message: { type: 'status', payload: { status: 'server_info', serverId: 'native-test' } } }; }
      else if (v.type === 'ping') reply = { type: 'pong' };
      else if (v.type === 'session' && v.message.type === 'fetch_agents_request') { queries++; reply = { type: 'session', message: { type: 'fetch_agents_response', payload: { requestId: v.message.requestId, entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } } } }; }
      if (reply) void channel.then(c => c.send(JSON.stringify(reply)));
    } }); void channel.catch(() => socket.terminate());
  });
  await listen(upstream, 0, '127.0.0.1');
  const token = randomBytes(32).toString('base64url'); const auth = join(dir, 'auth'); await secret(auth, { version: 1, clients: { owner: { digest: digest(token), hosts: ['aspen'], operations } } });
  // Trust only this test certificate for the upstream, never disable TLS validation.
  const proxy = nativeProxyServer({ authFile: auth, hosts: { aspen: { serverId: 'native-test', url: `wss://127.0.0.1:${(upstream.address() as { port: number }).port}/ws?role=client&serverId=native-test` } } }, url => new WebSocket(url, { ca: tls.cert, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false }));
  const center = createServer(tls); center.on('request', (req, res) => proxy.server.emit('request', req, res)); center.on('upgrade', (req, socket, head) => proxy.server.emit('upgrade', req, socket, head));
  await listen(center, 0, '127.0.0.1');
  await secret(join(dir, 'token'), token); await secret(join(dir, 'password'), 'synthetic-daemon-password');
  const pinsFile = join(dir, 'pins.json'); await secret(pinsFile, { version: 2, stateDir: dir, hosts: { aspen: { serverId: 'native-test', daemonPublicKeyB64: pub, passwordFile: join(dir, 'password') } } });
  try {
    const config = await nativeConfig({ version: 1, defaultProfile: 'central', profiles: { central: { kind: 'central', url: `https://127.0.0.1:${(center.address() as { port: number }).port}`, tokenFile: join(dir, 'token'), caFile: certFile, e2eeFile: pinsFile } } });
    assert(config);
    // An owner bearer token never enables a plaintext daemon RPC path.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`wss://127.0.0.1:${(center.address() as { port: number }).port}/api/v1/native/connect/aspen?role=client&serverId=native-test`, { ca: tls.cert, headers: { authorization: `Bearer ${token}` } });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', auth: { password: 'must-not-forward' } })));
      ws.on('close', () => resolve()); ws.on('error', reject);
    });
    assert(!wire.some(frame => frame.includes('must-not-forward')));
    const result = await nativeCall(config, requestSchema.parse({ op: 'agents', host: 'aspen' }));
    assert.equal(result.partial, false); assert.deepEqual(result.results[0].entries, []); assert.equal(queries, 1);
    assert(!wire.some(frame => frame.includes('synthetic-daemon-password') || frame.includes('fetch_agents_request')));
    if (process.env.PASEO_NATIVE_GO_BIN) {
      const response = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const child = execFile(process.env.PASEO_NATIVE_GO_BIN!, ['agents', 'list-agents', '--host', 'aspen', '-o', 'json'], {
        timeout: 15000, killSignal: 'SIGKILL',
        env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, SSL_CERT_FILE: certFile,
          PASEO_BRIDGE_BASE_URL: `https://127.0.0.1:${(center.address() as { port: number }).port}`,
          PASEO_BRIDGE_ACCESS_TOKEN: token, PASEO_BRIDGE_E2EE_FILE: pinsFile, PASEO_BRIDGE_CONTEXT: '', RSH_CACHE_DIR: dir + '/cache', RSH_CONFIG_DIR: dir + '/rsh' }
        }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        // Restish consumes piped stdin before issuing a request. End this
        // synthetic input instead of leaving execFile's pipe open indefinitely.
        child.stdin?.end();
      });
      const goResult = JSON.parse(response.stdout);
      assert.equal(goResult.data.partial, false); assert.deepEqual(goResult.data.results[0].entries, []);
      assert.equal(queries, 2);
    }
    const confirmedQueries = queries;
    config.pins.hosts.aspen.daemonPublicKeyB64 = exportPublicKey(generateKeyPair().publicKey);
    await assert.rejects(nativeCall(config, requestSchema.parse({ op: 'agents', host: 'aspen' })));
    assert.equal(queries, confirmedQueries);
    config.pins.hosts.aspen.serverId = 'unexpected-server';
    await assert.rejects(nativeCall(config, requestSchema.parse({ op: 'agents', host: 'aspen' })), { code: 'E2EE_CONFIG' }); assert.equal(queries, confirmedQueries);
  } finally {
    proxy.stop(); for (const c of relay.clients) c.terminate(); center.closeAllConnections(); upstream.closeAllConnections(); await closeServer(center); await new Promise<void>(r => relay.close(() => r())); await closeServer(upstream);
  }
});
