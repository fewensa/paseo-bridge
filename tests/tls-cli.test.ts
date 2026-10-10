import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { apiServer, listen, listenSocket, closeServer } from '../src/api/server.js';
import { call } from '../src/api/client.js';
import { BridgeService, requestSchema } from '../src/service.js';
import { digest } from '../src/auth.js';
import { clientSchema } from '../src/config.js';
import { directory, fixture, secret } from './fixtures.js';
const exec = promisify(execFile);

test('HTTPS client validates trust, uses tokens and CLI switches profiles', async () => {
  const dir = await directory(); const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
  const auth = join(dir, 'auth'); const tokenFile = join(dir, 'token'); const token = randomBytes(32).toString('base64url');
  await secret(tokenFile, token);
  await secret(auth, { version: 1, clients: { birch: { digest: digest(token), hosts: ['birch'], operations: ['status', 'agents', 'send', 'activity', 'wait'] } } });
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection]]));
  const handler = apiServer(service, auth);
  const tls = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
    assert(req.url);
    assert(req.url.startsWith('/bridge/api/v1/')); // Preserve reverse-proxy base URL prefixes.
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    req.url = req.url.slice('/bridge'.length);
    handler.emit('request', req, res);
  });
  await listen(tls, 0, '127.0.0.1'); const port = (tls.address() as { port: number }).port;
  const local = apiServer(service); const socket = join(dir, 'sock'); await listenSocket(local, socket);
  const config = clientSchema.parse({ version: 1, defaultProfile: 'local', profiles: {
    local: { kind: 'local', socket }, central: { kind: 'central', url: `https://localhost:${port}/bridge/`, tokenFile, caFile: cert }
  } });
  const clientFile = join(dir, 'client.json'); await secret(clientFile, config);
  try {
    const result = await call(config, 'central', requestSchema.parse({ op: 'agents', host: 'all' })); assert.equal(result.results[0].host, 'birch');
    const untrusted = clientSchema.parse({ ...config, profiles: { central: { kind: 'central', url: `https://localhost:${port}`, tokenFile } }, defaultProfile: 'central' });
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
  } finally { await closeServer(local); await closeServer(tls); await closeServer(handler); }
});
