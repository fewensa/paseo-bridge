import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { apiServer, listen, listenSocket, closeServer } from '../src/api/server.js';
import { call } from '../src/api/client.js';
import { BridgeService, requestSchema } from '../src/service.js';
import { digest } from '../src/auth.js';
import { clientSchema } from '../src/config.js';
import { directory, fixture, secret } from './fixtures.js';
import { brokerServer } from '../src/e2ee/broker.js';
import { runEndpoint } from '../src/e2ee/endpoint.js';
import { privateKey, publicRaw, fingerprint, shared, seal } from '../src/e2ee/crypto.js';
const exec = promisify(execFile);

test('HTTPS client validates trust, uses tokens and CLI switches profiles', async () => {
  const dir = await directory(); const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
  const auth = join(dir, 'auth'); const tokenFile = join(dir, 'token'); const token = randomBytes(32).toString('base64url');
  await secret(tokenFile, token);
  await secret(auth, { version: 1, clients: { birch: { digest: digest(token), hosts: ['birch'], operations: ['status', 'agents', 'send', 'activity', 'wait'] } } });
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection]]));
  const broker = brokerServer({ authFile: auth, endpointClients: { birch: 'birch' } });
  const handler = broker.server;
  const tls = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    assert(req.url);
    assert(req.url.startsWith('/bridge/api/v1/')); // Preserve reverse-proxy base URL prefixes.
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    req.url = req.url.slice('/bridge'.length);
    handler.emit('request', req, res);
  });
  tls.on('upgrade', (req, socket, head) => handler.emit('upgrade', req, socket, head));
  await listen(tls, 0, '127.0.0.1'); const port = (tls.address() as { port: number }).port;
  const local = apiServer(service); let localCalls = 0; local.on('request', () => { localCalls++; }); const socket = join(dir, 'sock'); await listenSocket(local, socket);
  const privateFile = join(dir, 'e2ee.key');
  const clientPrivate = randomBytes(32).toString('base64'); const serverPrivate = randomBytes(32).toString('base64');
  const cp = publicRaw(privateKey(clientPrivate)); const sp = publicRaw(privateKey(serverPrivate));
  await secret(privateFile, clientPrivate); const serverKey = join(dir, 'server.key'); await secret(serverKey, serverPrivate);
  const peersFile = join(dir, 'peers.json'); await secret(peersFile, { [fingerprint(cp)]: { publicKey: cp.toString('base64'), operations: ['status', 'agents', 'send', 'activity', 'wait'] } });
  const e2eeFile = join(dir, 'e2ee.json'); await secret(e2eeFile, { version: 1, keyFile: privateFile, hosts: { birch: sp.toString('base64') } });
  const endpoint = await runEndpoint({ host: 'birch', url: `https://localhost:${port}`, tokenFile, keyFile: serverKey, peersFile, caFile: cert }, socket, dir);
  for (let i = 0; !broker.endpoints.has('birch') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(broker.endpoints.has('birch'));
  const config = clientSchema.parse({ version: 1, defaultProfile: 'local', profiles: {
    local: { kind: 'local', socket }, central: { kind: 'central', url: `https://localhost:${port}/bridge/`, tokenFile, caFile: cert, e2eeFile }
  } });
  const clientFile = join(dir, 'client.json'); await secret(clientFile, config);
  try {
    const result = await call(config, 'central', requestSchema.parse({ op: 'agents', host: 'all' })); assert.equal(result.results[0].host, 'birch');
    const untrusted = clientSchema.parse({ ...config, profiles: { central: { kind: 'central', url: `https://localhost:${port}`, tokenFile, e2eeFile } }, defaultProfile: 'central' });
    await assert.rejects(call(untrusted, undefined, requestSchema.parse({ op: 'status', host: 'all' })), { code: 'TLS' });
    for (const profile of ['local', 'central']) {
      const output = await exec(process.execPath, ['dist/cli.js', '--config', clientFile, '--profile', profile, 'agents', '--host', 'all']);
      assert.equal(JSON.parse(output.stdout).results[0].entries[0].id, 'agent-1'); assert(!output.stdout.includes(token));
    }
    const promptFile = join(dir, 'prompt'); await secret(promptFile, 'hello');
    const sent = await exec(process.execPath, ['dist/cli.js', '--config', clientFile, '--profile', 'central', 'send', '--host', 'birch', '--agent', 'agent-1', '--prompt-file', promptFile]);
    assert.equal(JSON.parse(sent.stdout).status, 'accepted');
    const activity = await exec(process.execPath, ['dist/cli.js', '--config', clientFile, 'activity', '--host', 'birch', '--agent', 'agent-1']);
    assert.equal(JSON.parse(activity.stdout).timeline.entries[0].item.text, 'received');
    const waited = await exec(process.execPath, ['dist/cli.js', '--config', clientFile, '--profile', 'central', 'wait', '--host', 'birch', '--agent', 'agent-1']);
    assert.equal(JSON.parse(waited.stdout).result.status, 'idle');
    const polled = await exec(process.execPath, ['dist/cli.js', '--config', clientFile, '--profile', 'central', 'wait', '--host', 'birch', '--agent', 'agent-1', '--wait-mode', 'poll']);
    assert.equal(JSON.parse(polled.stdout).result.status, 'idle');
    a.state.status = 'running';
    await assert.rejects(exec(process.execPath, ['dist/cli.js', '--config', clientFile, 'wait', '--host', 'birch', '--agent', 'agent-1', '--timeout', '1']), (error: any) => error.code === 2 && JSON.parse(error.stdout).result.status === 'timeout');
    a.state.status = 'idle';
    a.state.online = false;
    await assert.rejects(exec(process.execPath, ['dist/cli.js', '--config', clientFile, 'agents', '--host', 'all']), (error: any) => error.code === 2 && JSON.parse(error.stdout).partial);
    a.state.online = true; a.state.sendError = true;
    await assert.rejects(exec(process.execPath, ['dist/cli.js', '--config', clientFile, 'send', '--host', 'birch', '--agent', 'agent-1', '--prompt-file', promptFile]), (error: any) => error.code === 2 && JSON.parse(error.stdout).status === 'unknown');

    const channel = shared(privateKey(clientPrivate), sp.toString('base64'));
    const deliver = async (packet: unknown) => {
      for (let i = 0; !broker.endpoints.has('birch') && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(broker.endpoints.has('birch'));
      await new Promise<void>(resolve => {
        const req = httpsRequest({ hostname: 'localhost', port, path: '/bridge/api/v1/e2ee/requests', method: 'POST', ca: awaitCert,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
          res.resume(); res.on('end', resolve); res.on('error', () => resolve());
        });
        req.on('error', () => resolve()); req.setTimeout(3000, () => { req.destroy(); resolve(); }); req.end(JSON.stringify(packet));
      });
    };
    const awaitCert = await readFile(cert);
    for (const kind of ['no-send', 'op-mismatch', 'no-activity']) {
      const peerOperations = kind === 'op-mismatch' ? ['status', 'send', 'wait', 'activity'] : ['wait'];
      await secret(peersFile, { [fingerprint(cp)]: { publicKey: cp.toString('base64'), operations: peerOperations } });
      const op = kind === 'op-mismatch' ? 'status' : kind === 'no-activity' ? 'observe-activity' : 'send';
      const context = { v: 1 as const, host: 'birch', client: fingerprint(cp), id: randomUUID(), expires: Date.now() + 90000, op: op as any };
      const body = kind === 'no-activity' ? '' : Buffer.from(JSON.stringify({ prompt: 'synthetic-denied-request', interrupt: false })).toString('base64');
      const path = kind === 'no-activity' ? '/api/v1/hosts/birch/agents/agent-1/events?include=activity' : '/api/v1/hosts/birch/agents/agent-1/messages';
      const before = localCalls;
      await deliver(seal(channel, context, 'request', 0, { method: kind === 'no-activity' ? 'GET' : 'POST', path, body, lastEventId: '' }));
      assert.equal(localCalls, before, kind + ' must never reach local API');
    }
    await secret(peersFile, { [fingerprint(cp)]: { publicKey: cp.toString('base64'), operations: ['status'] } });
    const context = { v: 1 as const, host: 'birch', client: fingerprint(cp), id: randomUUID(), expires: Date.now() + 90000, op: 'status' as const };
    const replay = seal(channel, context, 'request', 0, { method: 'GET', path: '/api/v1/hosts/birch', body: '', lastEventId: '' });
    const firstReplayCall = localCalls; await deliver(replay); assert.equal(localCalls, firstReplayCall + 1); const beforeReplay = localCalls; await deliver(replay);
    assert.equal(localCalls, beforeReplay, 'authenticated replay must never reach local API');
  } finally { await endpoint.stop(); broker.stop(); await closeServer(local); await closeServer(tls); await closeServer(handler); }
});
