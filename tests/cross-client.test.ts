import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { brokerServer } from '../src/e2ee/broker.js';
import { runEndpoint } from '../src/e2ee/endpoint.js';
import { privateKey, publicRaw, fingerprint } from '../src/e2ee/crypto.js';
import { apiServer, listen, listenSocket, closeServer } from '../src/api/server.js';
import { BridgeService } from '../src/service.js';
import { digest } from '../src/auth.js';
import { directory, secret, fixture } from './fixtures.js';
const exec = promisify(execFile);

test('released Go command surface interoperates with Node broker/endpoint for JSON, send and encrypted SSE', { skip: !process.env.PASEO_BRIDGE_GO_CLIENT }, async () => {
  const dir = await directory(); const cert = join(dir, 'cert.pem'); const tlsKey = join(dir, 'tls.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', tlsKey, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
  const token = randomBytes(32).toString('base64url'); const tokenFile = join(dir, 'token'); const authFile = join(dir, 'auth');
  await secret(tokenFile, token); await secret(authFile, { version: 1, clients: { test: { digest: digest(token), hosts: ['aspen'], operations: ['status', 'agents', 'workspaces', 'send', 'activity', 'wait'] } } });
  const broker = brokerServer({ authFile, endpointClients: { aspen: 'test' } });
  const tls = createServer({ key: await readFile(tlsKey), cert: await readFile(cert) }, (req, res) => broker.server.emit('request', req, res));
  tls.on('upgrade', (req, socket, head) => broker.server.emit('upgrade', req, socket, head));
  await listen(tls, 0, '127.0.0.1'); const port = (tls.address() as { port: number }).port;
  const a = fixture(); const local = apiServer(new BridgeService(new Map([['aspen', a.connection]])), undefined, { lifetimeMs: 150 }); const socket = join(dir, 'sock'); await listenSocket(local, socket);
  const hostPrivate = randomBytes(32).toString('base64'); const clientPrivate = randomBytes(32).toString('base64');
  const cp = publicRaw(privateKey(clientPrivate)); const hp = publicRaw(privateKey(hostPrivate));
  const hostKeyFile = join(dir, 'host.key'); const clientKeyFile = join(dir, 'client.key'); const peersFile = join(dir, 'peers'); const e2eeFile = join(dir, 'e2ee.json');
  await secret(hostKeyFile, hostPrivate); await secret(clientKeyFile, clientPrivate);
  await secret(peersFile, { [fingerprint(cp)]: { publicKey: cp.toString('base64'), operations: ['status', 'agents', 'workspaces', 'send', 'activity', 'wait'] } });
  await secret(e2eeFile, { version: 1, keyFile: clientKeyFile, hosts: { aspen: hp.toString('base64') } });
  const configHome = join(dir, 'config'); const configDir = join(configHome, 'aicli/paseo-bridge'); await mkdir(configDir, { recursive: true, mode: 0o700 });
  await secret(join(configDir, 'config.toml'), `base_url = "https://localhost:${port}"\ne2ee_file = ${JSON.stringify(e2eeFile)}\n[auth]\nmode = "token"\naccess_token = ${JSON.stringify(token)}\n`);
  const endpoint = await runEndpoint({ host: 'aspen', url: `https://localhost:${port}`, tokenFile, keyFile: hostKeyFile, peersFile, caFile: cert }, socket, dir);
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, SSL_CERT_FILE: cert, PASEO_BRIDGE_WRITE_MODE: 'write', PASEO_BRIDGE_BASE_URL: '', PASEO_BRIDGE_ACCESS_TOKEN: '', PASEO_BRIDGE_E2EE_FILE: '', PASEO_BRIDGE_SPEC_URL: '', PASEO_BRIDGE_CONTEXT: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' };
  const call = async (args: string[]) => {
    const task = exec(process.env.PASEO_BRIDGE_GO_CLIENT!, [...args, '--rsh-retry', '0'], { env, timeout: 15000, killSignal: 'SIGKILL' });
    // Restish consumes redirected stdin even for reads; close the synthetic pipe.
    task.child.stdin?.end();
    return task;
  };
  try {
    for (let i = 0; !broker.endpoints.has('aspen') && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(broker.endpoints.has('aspen'));
    for (const args of [['status', 'list-host-status'], ['agents', 'list-agents', '--host', 'aspen'], ['wait', 'get-agent-snapshot', 'aspen', 'agent-1']]) {
      const output = await call([...args, '-o', 'json']); const result = JSON.parse(output.stdout); assert.equal(result.ok, true); assert(!output.stdout.includes(token));
    }
    const marker = 'synthetic-go-node-send-marker';
    const sent = JSON.parse((await call(['send', 'send-message', 'aspen', 'agent-1', JSON.stringify({ prompt: marker, interrupt: false }), '-o', 'json'])).stdout);
    assert.equal(sent.data.status, 'accepted'); assert.equal((a.state.sends[0] as any).prompt, marker);
    const activity = JSON.parse((await call(['activity', 'get-agent-activity', 'aspen', 'agent-1', '-o', 'json'])).stdout); assert.equal(activity.data.timeline.entries[0].item.text, 'received');
    // The SDK source remains running so the encrypted SSE observation exercises headers/chunks/end.
    const stream = await call(['observation', 'observe-agent', 'aspen', 'agent-1', '--include', 'activity', '-o', 'ndjson']);
    assert(stream.stdout.includes('snapshot')); assert(stream.stdout.includes('activity')); assert(!stream.stdout.includes(token));
  } finally { await endpoint.stop(); broker.stop(); await closeServer(local); await closeServer(tls); await closeServer(broker.server); }
});
