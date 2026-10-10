import { createPaseoClient, createPaseoApi, type PaseoApi, type PaseoClient } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { parseConnectionOfferFromUrl } from '@getpaseo/protocol/connection-offer';
import { buildRelayWebSocketUrl, shouldUseTlsForDefaultHostedRelay } from '@getpaseo/protocol/daemon-endpoints';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { credentialSchema, secretFile, atomicSecret, type Credential } from '../config.js';
import { BridgeError, deadline } from '../errors.js';

export interface Connection {
  api: PaseoApi;
  state(): string;
  start(): Promise<void>;
  close(): Promise<void>;
}
const silent = { debug() {}, info() {}, warn() {}, error() {} };
export function relayConfig(pairUrl: string, clientId: string) {
  try {
    const offer = parseConnectionOfferFromUrl(pairUrl);
    if (!offer) throw new Error();
    const tls = offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint);
    if (!tls) throw new Error();
    return {
      url: buildRelayWebSocketUrl({ endpoint: offer.relay.endpoint, serverId: offer.serverId, role: 'client', useTls: true }),
      clientId, e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 }
    };
  } catch { throw new BridgeError('PAIR_URL', 'Invalid or insecure Relay pairing URL'); }
}
export async function loadCredential(file: string): Promise<Credential> {
  try { return credentialSchema.parse(JSON.parse(await secretFile(file))); }
  catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError('CREDENTIAL', 'Invalid connection credential');
  }
}
export async function createConnection(credential: Credential, clientId: string): Promise<Connection> {
  const common = { clientId, logger: silent, connectTimeoutMs: 8000,
    reconnect: { enabled: false } };
  let client: PaseoClient | DaemonClient;
  let api: PaseoApi;
  if (credential.kind === 'relay') {
    client = createPaseoClient({ ...common, ...relayConfig(credential.pairUrl, clientId), password: credential.password });
    api = client;
  } else {
    const u = new URL(credential.url);
    if (u.username || u.password || u.search || u.hash ||
      (u.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
      throw new BridgeError('DIRECT_URL', 'Direct connection must use TLS or loopback, without embedded credentials');
    // Only the pinned low-level driver exposes localCredential. Never copy the daemon home.
    client = new DaemonClient({ ...common, url: credential.url, password: credential.password,
      ...(credential.localCredentialFile ? { localCredential: () => secretFile(credential.localCredentialFile!) } : {}) });
    api = createPaseoApi(client);
  }
  // Own retry lifecycle so failed initial connections also recover. Each attempt is bounded;
  // recreating a host connection restores its API without retaining stale subscriptions.
  let stopped = true;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> | undefined;
  let attempt = 0;
  async function connect() {
    if (stopped || pending) return;
    if (client.getConnectionState().status !== 'connected') {
      pending = deadline(client.connect(), 10000).catch(() => {}).finally(() => { pending = undefined; });
      await pending;
    }
    if (stopped) return;
    const connected = client.getConnectionState().status === 'connected';
    attempt = connected ? 0 : attempt + 1;
    timer = setTimeout(() => void connect(), connected ? 1000 : Math.min(30000, 500 * 2 ** Math.min(attempt, 6)) + Math.random() * 300);
  }
  return {
    api,
    state: () => client.getConnectionState().status,
    start: async () => {
      if (closed) throw new BridgeError('CLOSED', 'A closed host connection cannot be restarted');
      stopped = false; await connect();
    },
    close: async () => { closed = true; stopped = true; clearTimeout(timer); await client.close(); await pending; }
  };
}
export async function persistedConnection(file: string, stateDir: string, host: string): Promise<Connection> {
  const identity = join(stateDir, `${host}.client-id`);
  let id: string;
  try { id = await secretFile(identity); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    id = randomUUID(); await atomicSecret(identity, id);
  }
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new BridgeError('CLIENT_ID', 'Invalid persisted client identity');
  return createConnection(await loadCredential(file), id);
}
