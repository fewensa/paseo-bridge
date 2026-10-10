import { randomBytes, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { atomicSecret, secretFile, hostName, operations, type ServerConfig } from './config.js';
import { authSchema, digest, type AuthRegistry } from './auth.js';
import { createConnection, relayConfig } from './paseo/connection.js';
import { BridgeError, deadline } from './errors.js';

export async function importHost(config: ServerConfig, host: string, pairFile: string, passwordFile?: string) {
  if (!hostName.safeParse(host).success || !config.hosts[host]) throw new BridgeError('HOST', 'Configure the host before importing credentials');
  const pairUrl = await secretFile(pairFile);
  relayConfig(pairUrl, randomUUID());
  const credential = { kind: 'relay' as const, pairUrl,
    ...(passwordFile ? { password: await secretFile(passwordFile) } : {}) };
  const connection = await createConnection(credential, randomUUID());
  try {
    await deadline(connection.start(), 12000);
    if (connection.state() !== 'connected') throw new BridgeError('PAIR_CONNECT', 'Pairing connection could not be verified');
    await deadline(connection.api.workspaces.list({ page: { limit: 1 } }), 10000);
    await atomicSecret(config.hosts[host].connectionFile, JSON.stringify(credential));
  } finally { await connection.close(); }
  return { host, imported: true, reloadRequired: true, temporaryFileDeleted: false };
}
export async function changeRegistry(file: string, change: (value: AuthRegistry) => Promise<void>) {
  const lock = `${file}.lock`;
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch { throw new BridgeError('AUTH_LOCK', 'Cannot acquire registry lock; verify directory and concurrent administrators'); }
  try {
    let value: AuthRegistry;
    try { value = authSchema.parse(JSON.parse(await secretFile(file))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BridgeError('AUTH_CONFIG', 'Invalid authentication registry');
      value = { version: 1, clients: {} };
    }
    await change(value);
    await atomicSecret(file, JSON.stringify(authSchema.parse(value), null, 2));
  } finally { await handle.close(); await unlink(lock); }
}
export async function issueToken(config: ServerConfig, id: string, hosts: string[], ops: string[], tokenFile: string) {
  if (!config.central) throw new BridgeError('CENTRAL', 'Central listener is not configured');
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(id) || !hosts.length || !ops.length ||
      hosts.some(host => !config.hosts[host]) || ops.some(op => !operations.includes(op as any)))
    throw new BridgeError('GRANT', 'Invalid client ID, host scope or operations');
  await changeRegistry(config.central.authFile, async value => {
    if (value.clients[id]) throw new BridgeError('CLIENT_EXISTS', 'Revoke existing client before issuing a new token');
    const token = randomBytes(32).toString('base64url');
    // Exclusive creation prevents overwriting another credential or following symlinks.
    const output = await open(tokenFile, 'wx', 0o600);
    try { await output.writeFile(token); await output.sync(); } finally { await output.close(); }
    value.clients[id] = { digest: digest(token), hosts, operations: ops as typeof operations[number][] };
  });
  return { client: id, issued: true, tokenFile };
}
export async function revokeToken(config: ServerConfig, id: string) {
  if (!config.central) throw new BridgeError('CENTRAL', 'Central listener is not configured');
  await changeRegistry(config.central.authFile, async value => {
    if (!value.clients[id]) throw new BridgeError('CLIENT', 'Client does not exist', 404);
    delete value.clients[id];
  });
  return { client: id, revoked: true };
}
export async function verifyPersistence(config: ServerConfig, host: string) {
  const { persistedConnection } = await import('./paseo/connection.js');
  if (!config.hosts[host]) throw new BridgeError('HOST', 'Unknown host');
  const connection = await persistedConnection(config.hosts[host].connectionFile, config.stateDir, host);
  try {
    await deadline(connection.start(), 12000);
    if (connection.state() !== 'connected') throw new BridgeError('OFFLINE', 'Persisted host is offline');
    await deadline(connection.api.workspaces.list({ page: { limit: 1 } }), 10000);
    return { host, persistedConnectionVerified: true };
  } finally { await connection.close(); }
}
