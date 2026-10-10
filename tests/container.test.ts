import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { lstat, chmod, symlink, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { recoverPrivateSocket } from '../src/container-runtime.js';
import { directory, secret } from './fixtures.js';

test('private container socket recovery leaves live listeners untouched', async t => {
  const dir = await directory(); const socket = join(dir, 'bridge.sock');
  const server = createServer();
  await new Promise<void>(accept => server.listen(socket, accept));
  t.after(() => new Promise<void>(accept => server.close(() => accept())));
  const before = await lstat(socket);
  await assert.rejects(recoverPrivateSocket(socket), { code: 'SOCKET_EXISTS' });
  assert.equal((await lstat(socket)).ino, before.ino);
});

test('private container socket recovery removes only a confirmed stale socket', { timeout: 5000 }, async t => {
  const dir = await directory(); const socket = join(dir, 'bridge.sock');
  const child = spawn(process.execPath,
    ['-e', "require('node:net').createServer().listen(process.argv[1],()=>process.stdout.write('ready'));", socket],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  await new Promise<void>((accept, reject) => {
    child.stdout.once('data', () => accept()); child.once('error', reject);
    child.once('exit', () => reject(new Error('Fixture exited before socket was ready')));
  });
  child.kill('SIGKILL'); await once(child, 'exit');
  assert.equal((await lstat(socket)).isSocket(), true);
  await recoverPrivateSocket(socket);
  await assert.rejects(lstat(socket), { code: 'ENOENT' });
  await recoverPrivateSocket(socket); // Already absent is safe.
});

test('private socket recovery never deletes regular files or symlinks', async () => {
  const dir = await directory(); const regular = join(dir, 'regular'); const link = join(dir, 'symlink');
  await secret(regular, 'keep'); await symlink(regular, link);
  await assert.rejects(recoverPrivateSocket(regular), { code: 'SOCKET_EXISTS' });
  await assert.rejects(recoverPrivateSocket(link), { code: 'SOCKET_EXISTS' });
  assert.equal(await readFile(regular, 'utf8'), 'keep'); assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test('socket recovery refuses non-private directories and directory symlinks', async () => {
  const dir = await directory(); const linked = join(await directory(), 'linked');
  await chmod(dir, 0o755);
  await assert.rejects(recoverPrivateSocket(join(dir, 'bridge.sock')), { code: 'PRIVATE_RUNTIME' });
  await chmod(dir, 0o700); await symlink(dir, linked);
  await assert.rejects(recoverPrivateSocket(join(linked, 'bridge.sock')), { code: 'PRIVATE_RUNTIME' });
});
