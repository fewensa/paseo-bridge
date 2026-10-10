import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, mkdir, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'paseo-bridge-package-'));
const packed = await exec('npm', ['pack', '--json', '--pack-destination', dir]);
const archive = join(dir, JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[\n')))[0].filename);
const prefix = join(dir, 'installed');
await exec('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', archive]);
for (const name of ['paseo-bridge', 'paseo-bridge-server']) {
  const output = await exec(join(prefix, 'bin', name), ['--help'], { cwd: dir });
  assert(output.stdout.includes(name));
}
const isolated = join(dir, 'standalone'); await mkdir(isolated);
for (const name of ['paseo-bridge', 'paseo-bridge-server']) {
  const target = join(isolated, `${name}.mjs`); await copyFile(resolve(`build/${name}.mjs`), target); await chmod(target, 0o755);
  const output = await exec(target, ['--help'], { cwd: isolated }); assert(output.stdout.includes(name));
}
const daemon = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(daemon, 'listening');
daemon.on('connection', socket => socket.on('message', raw => {
  const value = JSON.parse(raw.toString());
  let reply;
  if (value.type === 'hello') reply = { type: 'session', message: { type: 'status', payload: { status: 'server_info', serverId: 'package-test' } } };
  else if (value.type === 'ping') reply = { type: 'pong' };
  else if (value.type === 'session' && ['fetch_agents_request', 'fetch_workspaces_request'].includes(value.message.type))
    reply = { type: 'session', message: { type: value.message.type.replace('_request', '_response'), payload: {
      requestId: value.message.requestId, entries: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false }
    } } };
  if (reply) socket.send(JSON.stringify(reply));
}));
try {
  for (const distribution of ['npm', 'standalone']) {
    const state = join(dir, `${distribution}-state`); await mkdir(state, { mode: 0o700 });
    const credential = join(state, 'credential.json'); const config = join(state, 'server.json'); const client = join(state, 'client.json'); const socket = join(state, 'bridge.sock');
    await writeFile(credential, JSON.stringify({ kind: 'direct', url: `ws://127.0.0.1:${daemon.address().port}/ws` }), { mode: 0o600 });
    await writeFile(config, JSON.stringify({ version: 1, hosts: { mock: { connectionFile: credential } }, socket, stateDir: state }), { mode: 0o600 });
    await writeFile(client, JSON.stringify({ version: 1, defaultProfile: 'local', profiles: { local: { kind: 'local', socket } } }), { mode: 0o600 });
    const executable = name => distribution === 'npm' ? join(prefix, 'bin', name) : join(isolated, `${name}.mjs`);
    const server = spawn(executable('paseo-bridge-server'), ['--config', config], { cwd: isolated, stdio: 'pipe' });
    const exited = once(server, 'exit'); let connected = false;
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const output = await exec(executable('paseo-bridge'), ['--config', client, 'status', '--host', 'mock'], { cwd: isolated });
          connected = JSON.parse(output.stdout).results[0].state === 'connected'; if (connected) break;
        } catch { /* listener may still be starting */ }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(connected, `${distribution} server did not connect`);
      const output = await exec(executable('paseo-bridge'), ['--config', client, 'workspaces', '--host', 'all'], { cwd: isolated });
      assert.equal(JSON.parse(output.stdout).partial, false);
    } finally { server.kill('SIGTERM'); await exited; }
  }
} finally { for (const client of daemon.clients) client.terminate(); await new Promise(resolve => daemon.close(resolve)); }
console.log('npm-installed and isolated standalone commands verified, including resident server startup, SDK queries and shutdown.');
