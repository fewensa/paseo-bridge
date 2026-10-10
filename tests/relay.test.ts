import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { createDaemonChannel, generateKeyPair, exportPublicKey, type Transport } from '@getpaseo/relay';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listen, closeServer } from '../src/api/server.js';
import { directory, secret } from './fixtures.js';
const exec = promisify(execFile);

test('official Relay E2EE imports protected pairing and verifies durable credentials', { timeout: 30000 }, async () => {
  const dir = await directory(); const key = join(dir, 'key.pem'); const cert = join(dir, 'cert.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
  const tls = createServer({ key: await readFile(key), cert: await readFile(cert) });
  const ws = new WebSocketServer({ server: tls }); const keys = generateKeyPair();
  const rawFrames: string[] = []; let authenticated = 0;
  ws.on('connection', socket => {
    const transport: Transport = { send: data => { socket.send(data); }, close: (code, reason) => socket.close(code, reason), onmessage: null, onclose: null, onerror: null };
    socket.on('message', (data, isBinary) => {
      rawFrames.push(data.toString());
      transport.onmessage?.({ data: isBinary ? new Uint8Array(data as Buffer).buffer : data.toString(), isBinary });
    });
    socket.on('close', (code, reason) => transport.onclose?.(code, reason.toString()));
    socket.on('error', error => transport.onerror?.(error));
    const channel = createDaemonChannel(transport, keys, {
      onmessage: data => {
        const value = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString());
        let reply: unknown;
        if (value.type === 'hello') {
          assert.equal(value.auth?.password, 'test-only-daemon-password'); authenticated++;
          reply = { type: 'session', message: { type: 'status', payload: { status: 'server_info', serverId: 'test-relay-daemon' } } };
        } else if (value.type === 'ping') reply = { type: 'pong' };
        else if (value.type === 'session' && ['fetch_agents_request', 'fetch_workspaces_request'].includes(value.message.type)) {
          reply = { type: 'session', message: { type: value.message.type.replace('_request', '_response'), payload: {
            requestId: value.message.requestId, entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
          } } };
        }
        if (reply) void channel.then(value => value.send(JSON.stringify(reply)));
      }
    });
    void channel.catch(() => socket.close());
  });
  await listen(tls, 0, '127.0.0.1'); const port = (tls.address() as { port: number }).port;
  const offer = { v: 2, serverId: 'test-relay-daemon', daemonPublicKeyB64: exportPublicKey(keys.publicKey), relay: { endpoint: `localhost:${port}`, useTls: true } };
  const pairUrl = `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`;
  const pair = join(dir, 'pair'); const password = join(dir, 'password'); const credential = join(dir, 'persisted.json'); const config = join(dir, 'bridge.json');
  await secret(pair, pairUrl); await secret(password, 'test-only-daemon-password');
  await secret(config, { version: 1, hosts: { aspen: { connectionFile: credential } }, stateDir: dir, socket: join(dir, 'sock') });
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  try {
    const imported = await exec(process.execPath, ['dist/cli.js', '--config', config, 'admin', 'import-host', 'aspen', '--pair-file', pair, '--password-file', password], { env });
    assert.equal(JSON.parse(imported.stdout).imported, true); assert.equal(await readFile(pair, 'utf8'), pairUrl);
    assert(!imported.stdout.includes(pairUrl)); assert(!imported.stderr.includes(pairUrl));
    await secret(pair, 'invalidated-temporary-input'); await secret(password, 'invalidated-temporary-password');
    const verified = await exec(process.execPath, ['dist/cli.js', '--config', config, 'admin', 'verify-host', 'aspen'], { env });
    assert.equal(JSON.parse(verified.stdout).persistedConnectionVerified, true); assert(authenticated >= 2);
    assert(!rawFrames.some(frame => frame.includes('test-only-daemon-password') || frame.includes('fetch_workspaces_request')));
    await assert.rejects(exec(process.execPath, ['dist/cli.js', '--config', config, 'admin', 'import-host', 'aspen', '--pair-file', pair], { env }),
      (error: any) => error.code === 1 && JSON.parse(error.stderr).error.code === 'PAIR_URL' && !error.stderr.includes('invalidated-temporary-input'));
  } finally {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve())); await closeServer(tls);
  }
});
