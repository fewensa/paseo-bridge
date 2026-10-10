import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chmod, readFile, symlink } from 'node:fs/promises';
import { issueToken, revokeToken } from '../src/admin.js';
import { authenticate } from '../src/auth.js';
import { secretFile, atomicSecret, serverSchema } from '../src/config.js';
import { relayConfig } from '../src/paseo/connection.js';
import { directory, secret } from './fixtures.js';

test('secret permissions and atomic replacement', async () => {
  const dir = await directory(); const file = join(dir, 'secret');
  await atomicSecret(file, 'one'); assert.equal(await secretFile(file), 'one');
  await atomicSecret(file, 'two'); assert.equal(await secretFile(file), 'two');
  await chmod(file, 0o644); await assert.rejects(secretFile(file), { code: 'SECRET_PERMISSIONS' });
});
test('atomic persistence durably provisions missing ancestor directories', async () => {
  const dir = await directory(); const file = join(dir, 'first', 'second', 'secret');
  await atomicSecret(file, 'one'); assert.equal(await secretFile(file), 'one');
  await atomicSecret(file, 'two'); assert.equal(await secretFile(file), 'two');
});
test('secret symlinks rejected', async () => {
  const dir = await directory(); const file = join(dir, 'secret'); const link = join(dir, 'link');
  await secret(file, 'sensitive'); await symlink(file, link); await assert.rejects(secretFile(link));
});
test('token issuance, independent scopes and revocation', async () => {
  const dir = await directory(); const authFile = join(dir, 'auth.json'); const tokenFile = join(dir, 'token');
  const config = serverSchema.parse({ version: 1, hosts: { birch: { connectionFile: join(dir, 'birch') } }, socket: join(dir, 'sock'), stateDir: dir, central: { port: 8787, authFile } });
  await issueToken(config, 'birch-client', ['birch'], ['status'], tokenFile);
  const token = await secretFile(tokenFile);
  const grant = await authenticate(authFile, `Bearer ${token}`); assert.deepEqual(grant.hosts, ['birch']);
  const persisted = await readFile(authFile, 'utf8'); assert(!persisted.includes(token));
  await assert.rejects(issueToken(config, 'birch-client', ['birch'], ['status'], join(dir, 'other')), { code: 'CLIENT_EXISTS' });
  await assert.rejects(issueToken(config, 'unknown-host', ['aspen'], ['status'], join(dir, 'bad')), { code: 'GRANT' });
  await revokeToken(config, 'birch-client'); await assert.rejects(authenticate(authFile, `Bearer ${token}`), { code: 'UNAUTHORIZED' });
});
test('invalid pair URL never appears in error and insecure relay is rejected', () => {
  for (const url of ['secret-invalid-url', 'https://app.paseo.sh/#offer=bad-secret']) {
    assert.throws(() => relayConfig(url, 'id'), (error: any) => error.code === 'PAIR_URL' && !error.message.includes(url));
  }
  const offer = { v: 2, serverId: 'server', daemonPublicKeyB64: Buffer.alloc(32).toString('base64'), relay: { endpoint: 'relay.paseo.sh:443', useTls: true } };
  const url = `https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`;
  assert.equal(relayConfig(url, 'id').e2ee.enabled, true);
  offer.relay.useTls = false;
  assert.throws(() => relayConfig(`https://app.paseo.sh/#offer=${Buffer.from(JSON.stringify(offer)).toString('base64url')}`, 'id'), { code: 'PAIR_URL' });
});
