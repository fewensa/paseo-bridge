import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { secretFile, operations, type Operation } from '../config.js';
import { BridgeError } from '../errors.js';
import { matchRoute } from '../api/routes.js';
import { ReplayGuard } from './replay.js';
import { loadPrivate, rawKey, fingerprint, shared, packetSchema, inputSchema, unseal, seal, type Packet } from './crypto.js';
export interface EndpointConfig { host: string; url: string; tokenFile: string; keyFile: string; peersFile: string; caFile?: string; }
const peerSchema = z.record(z.string().regex(/^[a-f0-9]{64}$/), z.object({ publicKey: z.string(), operations: z.array(z.enum(operations)).min(1) }).strict());

export async function runEndpoint(config: EndpointConfig, socket: string, stateDir: string) {
  const key = await loadPrivate(config.keyFile); const guard = new ReplayGuard(join(stateDir, 'e2ee-replays.json'));
  // Validate configuration before starting; do not wait for the first request.
  peerSchema.parse(JSON.parse(await secretFile(config.peersFile)));
  const endpointURL = new URL(config.url);
  if (endpointURL.protocol !== 'https:' || endpointURL.username || endpointURL.password || endpointURL.search || endpointURL.hash || !['', '/'].includes(endpointURL.pathname))
    throw new BridgeError('E2EE_CONFIG', 'Endpoint requires an HTTPS origin');
  endpointURL.protocol = 'wss:'; endpointURL.pathname = `/api/v1/e2ee/connect/${config.host}`;
  const active = new Map<string, http.ClientRequest>(); const peerCounts = new Map<string, number>();
  let stopped = false; let ws: WebSocket | undefined; let timer: NodeJS.Timeout | undefined; let attempts = 0;
  function disconnect() { for (const req of active.values()) req.destroy(); active.clear(); peerCounts.clear(); }
  async function receive(connection: WebSocket, raw: string) {
    let p: Packet; let secret: Buffer;
    try {
      const message = JSON.parse(raw);
      if (message.type === 'cancel') { if (typeof message.id === 'string') active.get(message.id)?.destroy(); return; }
      if (message.type !== 'request') return;
      p = packetSchema.parse(message.packet);
      if (p.host !== config.host || p.kind !== 'request' || p.seq !== 0 || p.expires <= Date.now() || p.expires > Date.now() + 120000) return;
      const peers = peerSchema.parse(JSON.parse(await secretFile(config.peersFile))); const peer = peers[p.client];
      if (!peer || fingerprint(rawKey(peer.publicKey)) !== p.client) return;
      secret = shared(key, peer.publicKey);
      const input = inputSchema.parse(unseal(secret, p, 'request'));
      const { route, params, query } = matchRoute(input.method, input.path);
      const request = route.request(params, query, route.body ? JSON.parse(Buffer.from(input.body, 'base64').toString('utf8')) : undefined);
      const permissions: Operation[] = [...route.permissions, ...(route.action === 'events' && query.include === 'activity' ? ['activity' as const] : [])];
      if (request.host !== config.host || p.op !== (route.action === 'events' && query.include === 'activity' ? 'observe-activity' : route.permissions[0]) || permissions.some(op => !peer.operations.includes(op)))
        throw new BridgeError('FORBIDDEN', 'Operation not permitted', 403);
      const payload = Buffer.from(input.body, 'base64');
      if (payload.length > 262144 || payload.toString('base64') !== input.body || (!route.body && payload.length)) throw new BridgeError('REQUEST', 'Invalid request');
      if (active.size >= 32 || (peerCounts.get(p.client) ?? 0) >= 8 || active.has(p.id)) throw new BridgeError('CAPACITY', 'Endpoint capacity exhausted', 503);
      // The durable claim completes before creating any local request. Crash recovery fails closed.
      await guard.claim(`${p.client}:${p.id}`, p.expires);
      if (stopped || connection.readyState !== WebSocket.OPEN) return;
      if (active.size >= 32 || (peerCounts.get(p.client) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Endpoint capacity exhausted', 503);
      let seq = 0; let bytes = 0; let finished = false;
      const emit = (kind: Packet['kind'], value: unknown) => {
        if (connection.readyState !== WebSocket.OPEN || connection.bufferedAmount > 1048576) throw new BridgeError('CAPACITY', 'Encrypted channel unavailable', 503);
        connection.send(JSON.stringify({ type: 'response', packet: seal(secret, p, kind, seq++, value) }));
      };
      const req = http.request({ socketPath: socket, path: input.path, method: input.method,
        headers: { accept: route.action === 'events' ? 'text/event-stream' : 'application/json',
          ...(route.body ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(input.lastEventId ? { 'last-event-id': input.lastEventId } : {}) } }, res => {
        try {
          const contentType = res.headers['content-type']?.split(';')[0] ?? '';
          if (!['application/json', 'text/event-stream'].includes(contentType)) throw new Error();
          emit('headers', { status: res.statusCode, contentType });
        } catch { req.destroy(); return; }
        res.on('data', (chunk: Buffer) => {
          try {
            bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new Error();
            for (let offset = 0; offset < chunk.length; offset += 32768) emit('chunk', { data: chunk.subarray(offset, offset + 32768).toString('base64') });
          } catch { req.destroy(); }
        });
        res.on('end', () => { try { emit('end', { frames: seq, bytes }); finished = true; } catch { connection.terminate(); } });
        res.on('error', () => { if (!finished) connection.terminate(); });
      });
      active.set(p.id, req); peerCounts.set(p.client, (peerCounts.get(p.client) ?? 0) + 1);
      req.once('close', () => { if (active.get(p.id) === req) { active.delete(p.id); const count = (peerCounts.get(p.client) ?? 1) - 1; if (count) peerCounts.set(p.client, count); else peerCounts.delete(p.client); } });
      req.on('error', () => { if (!finished && connection.readyState === WebSocket.OPEN) connection.terminate(); });
      req.setTimeout(120000, () => req.destroy()); req.end(payload.length ? payload : undefined);
    } catch {
      // Malformed, unauthorized or replayed ciphertext never reaches the local API.
      // Closing the tunnel makes the caller report an uncertain send, never retry.
      connection.close(1008, 'Encrypted request rejected');
    }
  }
  async function connect() {
    if (stopped) return;
    try {
      const token = await secretFile(config.tokenFile);
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
      const connection = new WebSocket(endpointURL, { headers: { authorization: `Bearer ${token}` }, maxPayload: 524288, perMessageDeflate: false, handshakeTimeout: 10000, ...(config.caFile ? { ca: await readFile(config.caFile) } : {}) });
      ws = connection; connection.on('error', () => {});
      connection.on('open', () => { attempts = 0; });
      connection.on('message', raw => { void receive(connection, raw.toString()); });
      connection.once('close', () => { disconnect(); if (!stopped) timer = setTimeout(() => void connect(), Math.min(30000, 500 * 2 ** Math.min(++attempts, 6))); });
    } catch { if (!stopped) timer = setTimeout(() => void connect(), 30000); }
  }
  void connect();
  return { stop: async () => { stopped = true; clearTimeout(timer); disconnect(); ws?.terminate(); } };
}
