import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import WebSocket from 'ws';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { WebSocketLike } from '@getpaseo/client/internal/daemon-client-transport-types';
import { createPaseoApi } from '@getpaseo/client';
import { hostName, nativeHostSchema, nativePublicKeySchema, secretFile, type ClientConfig } from '../config.js';
import { BridgeError, deadline } from '../errors.js';
import { BridgeService, type Request } from '../service.js';
import type { Connection } from '../paseo/connection.js';
import { jsonRequest, type Transport } from '../api/client-transport.js';
import https from 'node:https';

const pinSchema = nativeHostSchema.omit({ url: true }).extend({ daemonPublicKeyB64: nativePublicKeySchema, passwordFile: z.string().startsWith('/').optional() }).strict();
export const nativeClientSchema = z.object({ version: z.literal(2), stateDir: z.string().startsWith('/'), hosts: z.record(hostName, pinSchema).refine(v => Object.keys(v).length > 0) }).strict();
const directorySchema = z.object({ hosts: z.record(hostName, nativeHostSchema.omit({ url: true }).strict()) }).strict();
const silent = { debug() {}, info() {}, warn() {}, error() {} };

export async function nativeConfig(config: ClientConfig, profile?: string) {
  const selected = config.profiles[profile ?? config.defaultProfile];
  if (selected?.kind !== 'central' || !selected.e2eeFile) return undefined;
  const value = JSON.parse(await secretFile(selected.e2eeFile));
  if (value.version !== 2) return undefined;
  return { pins: nativeClientSchema.parse(value), selected };
}
export async function nativeCall(config: NonNullable<Awaited<ReturnType<typeof nativeConfig>>>, input: Request, expiresAt = Date.now() + input.timeout * 1000): Promise<any> {
  const remaining = () => {
    const ms = expiresAt - Date.now();
    if (ms <= 0) throw new BridgeError('TIMEOUT', 'Operation timed out', 504);
    return ms;
  };
  const { pins, selected } = config;
  const base = new URL(selected.url);
  const token = await secretFile(selected.tokenFile);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BridgeError('TOKEN', 'Invalid client token');
  const ca = selected.caFile ? await readFile(selected.caFile) : undefined;
  const transport: Transport = { module: https, prefix: base.pathname.replace(/\/$/, ''), options: { hostname: base.hostname, port: base.port || 443, rejectUnauthorized: true, headers: { authorization: `Bearer ${token}` }, ...(ca ? { ca } : {}) } };
  const directory = directorySchema.parse(await jsonRequest(transport, '/api/v1/native/hosts', { timeoutMs: Math.min(15000, remaining()) }));
  const targets = input.host === 'all' ? Object.keys(pins.hosts) : [input.host];
  const hosts = new Map<string, Connection>();
  try {
    for (const host of targets) {
      const pin = pins.hosts[host]; const advertised = directory.hosts[host];
      if (!pin || !advertised || advertised.serverId !== pin.serverId)
        throw new BridgeError('E2EE_CONFIG', 'Native target is not authorized or does not match its pinned daemon identity');
      const url = new URL(selected.url); url.protocol = 'wss:';
      url.pathname = transport.prefix + `/api/v1/native/connect/${host}`; url.search = '';
      url.searchParams.set('role', 'client'); url.searchParams.set('serverId', pin.serverId);
      const password = pin.passwordFile ? await secretFile(pin.passwordFile) : undefined;
      const driver = new DaemonClient({ url: url.toString(), clientId: randomUUID(), password,
        e2ee: { enabled: true, daemonPublicKeyB64: pin.daemonPublicKeyB64 }, logger: silent,
        connectTimeoutMs: Math.min(10000, remaining()), reconnect: { enabled: false },
        // Override SDK compatibility password headers/subprotocols: only the Bridge token
        // reaches the center. Daemon credentials travel in the encrypted hello exclusively.
        webSocketFactory: address => new WebSocket(address, { headers: { authorization: `Bearer ${token}` },
          ...(ca ? { ca } : {}), maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 10000 }) as unknown as WebSocketLike });
      hosts.set(host, { api: createPaseoApi(driver), state: () => driver.getConnectionState().status,
        start: async () => { try { await deadline(driver.connect(), Math.min(12000, remaining())); }
          catch (error) { await driver.close(); throw error; } }, close: async () => { await driver.close(); } });
    }
    const connections = await Promise.allSettled([...hosts.values()].map(c => c.start()));
    if (input.host !== 'all') {
      const failed = connections.find(r => r.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
    const service = new BridgeService(hosts, Math.min(15000, remaining()), pins.stateDir);
    const result: any = await service.execute(input.op === 'wait' ? { ...input, timeout: remaining() / 1000 } : input);
    if (input.op === 'wait' && result?.result) result.result.lastMessage = null;
    return result;
  } finally { await Promise.allSettled([...hosts.values()].map(c => c.close())); }
}
