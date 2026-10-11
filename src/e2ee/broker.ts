import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { authenticate, RateLimiter } from '../auth.js';
import { BridgeError, publicError } from '../errors.js';
import { packetSchema, sameContext, type Packet } from './crypto.js';
import { serveDocument } from '../api/documents.js';
import { documentRoutes } from '../api/routes.js';

export interface BrokerConfig { authFile: string; endpointClients: Record<string, string>; }
function error(res: ServerResponse, status: number, code: string) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: { code, message: 'Encrypted Bridge request failed' } }));
}
async function packetBody(req: IncomingMessage): Promise<Packet> {
  if (!/^application\/json(?:;|$)/.test(req.headers['content-type'] ?? '')) throw new BridgeError('CONTENT_TYPE', 'JSON required', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 524288) throw new BridgeError('BODY_LIMIT', 'Encrypted request too large', 413);
    chunks.push(chunk);
  }
  try { return packetSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch { throw new BridgeError('E2EE', 'Invalid encrypted request'); }
}
export function brokerServer(config: BrokerConfig) {
  const endpoints = new Map<string, WebSocket>();
  const requests = new Map<string, { packet: Packet; endpoint: WebSocket; res: ServerResponse; seq: number; bytes: number; principal: string; timer: NodeJS.Timeout }>();
  const counts = new Map<string, number>(); const rate = new RateLimiter(120); const sourceRate = new RateLimiter(600);
  const alive = new WeakSet<WebSocket>();
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 131072, perMessageDeflate: false });
  const cleanup = (id: string) => {
    const state = requests.get(id); if (!state) return;
    requests.delete(id); clearTimeout(state.timer);
    const count = (counts.get(state.principal) ?? 1) - 1;
    if (count) counts.set(state.principal, count); else counts.delete(state.principal);
    if (state.endpoint.readyState === WebSocket.OPEN) state.endpoint.send(JSON.stringify({ type: 'cancel', id }));
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && documentRoutes.some(route => route.path === req.url)) {
        sourceRate.take(req.socket.remoteAddress ?? 'local'); await serveDocument(req, res); return;
      }
      if (req.method !== 'POST' || req.url !== '/api/v1/e2ee/requests') {
        error(res, 426, 'ENCRYPTION_REQUIRED'); return;
      }
      sourceRate.take(req.socket.remoteAddress ?? 'local');
      const grant = await authenticate(config.authFile, req.headers.authorization); rate.take(grant.id);
      if (requests.size >= 64 || (counts.get(grant.id) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Capacity exhausted', 503);
      const p = await packetBody(req);
      if (p.kind !== 'request' || p.seq !== 0 || p.expires <= Date.now() || p.expires > Date.now() + 120000) throw new BridgeError('E2EE', 'Invalid request');
      if (!grant.hosts.includes(p.host) || (p.op === 'observe-activity' ? !grant.operations.includes('wait') || !grant.operations.includes('activity') : !grant.operations.includes(p.op))) throw new BridgeError('FORBIDDEN', 'Operation not permitted', 403);
      if (requests.has(p.id)) throw new BridgeError('E2EE_REPLAY', 'Duplicate request', 409);
      const endpoint = endpoints.get(p.host);
      if (!endpoint || endpoint.readyState !== WebSocket.OPEN) throw new BridgeError('OFFLINE', 'Encrypted endpoint offline', 503);
      // Recheck capacity after asynchronous body/auth reads.
      if (requests.size >= 64 || (counts.get(grant.id) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Capacity exhausted', 503);
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store, no-transform', 'x-content-type-options': 'nosniff' });
      res.flushHeaders();
      const timer = setTimeout(() => { res.destroy(); cleanup(p.id); }, 150000);
      const state = { packet: p, endpoint, res, seq: 0, bytes: 0, principal: grant.id, timer, authHeader: req.headers.authorization };
      requests.set(p.id, state);
      counts.set(grant.id, (counts.get(grant.id) ?? 0) + 1);
      res.once('close', () => cleanup(p.id));
      if (endpoint.bufferedAmount > 1048576) { res.destroy(); return; }
      endpoint.send(JSON.stringify({ type: 'request', packet: p }));
    } catch (e) { const safe = publicError(e); error(res, safe.status, safe.code); }
  });
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        sourceRate.take(req.socket.remoteAddress ?? 'local');
        const match = /^\/api\/v1\/e2ee\/connect\/([a-z][a-z0-9-]{0,62})$/.exec(req.url ?? '');
        if (!match) throw new Error();
        const host = match[1]; const grant = await authenticate(config.authFile, req.headers.authorization);
        if (config.endpointClients[host] !== grant.id || !grant.hosts.includes(host)) throw new Error();
        if (endpoints.has(host)) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
        wsServer.handleUpgrade(req, socket, head, ws => {
          endpoints.set(host, ws); alive.add(ws); ws.on('pong', () => alive.add(ws));
          (ws as WebSocket & { authHeader?: string }).authHeader = req.headers.authorization;
          ws.on('error', () => {});
          ws.on('message', raw => {
            try {
              const message = JSON.parse(raw.toString());
              if (message.type !== 'response') throw new Error();
              const p = packetSchema.parse(message.packet); const state = requests.get(p.id);
              if (!state || state.endpoint !== ws) return;
              if (!sameContext(p, state.packet) || p.kind === 'request' || p.seq !== state.seq++) throw new Error();
              state.bytes += Buffer.byteLength(raw.toString());
              if (state.bytes > 32 * 1024 * 1024 || state.res.writableLength > 1048576) { state.res.destroy(); return; }
              state.res.write(JSON.stringify(p) + '\n');
              if (p.kind === 'end') { state.res.end(); cleanup(p.id); }
            } catch { ws.close(1008, 'Invalid encrypted frame'); }
          });
          ws.once('close', () => {
            if (endpoints.get(host) === ws) endpoints.delete(host);
            for (const [id, state] of requests) if (state.endpoint === ws) { state.res.destroy(); cleanup(id); }
          });
        });
      } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }
    })();
  });
  // Heartbeats bound dead registrations and recheck revocation without restart.
  const heartbeat = setInterval(() => {
    for (const [host, ws] of endpoints) {
      if (!alive.has(ws)) { ws.terminate(); continue; }
      alive.delete(ws);
      void authenticate(config.authFile, (ws as WebSocket & { authHeader?: string }).authHeader).then(grant => {
        if (config.endpointClients[host] !== grant.id || !grant.hosts.includes(host)) ws.terminate();
      }).catch(() => ws.terminate());
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
    for (const [id, state] of requests) {
      void authenticate(config.authFile, (state as typeof state & { authHeader?: string }).authHeader).then(grant => {
        const scopes = state.packet.op === 'observe-activity' ? ['wait', 'activity'] : [state.packet.op];
        if (grant.id !== state.principal || !grant.hosts.includes(state.packet.host) || scopes.some(op => !grant.operations.includes(op as any))) { state.res.destroy(); cleanup(id); }
      }).catch(() => { state.res.destroy(); cleanup(id); });
    }
  }, 10000); heartbeat.unref();
  // Registration authorization is retained privately for periodic revocation checks.
  wsServer.on('connection', () => {});
  const stop = () => { clearInterval(heartbeat); for (const ws of endpoints.values()) ws.terminate(); for (const state of requests.values()) state.res.destroy(); wsServer.close(); };
  server.once('close', stop);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.setTimeout(160000, socket => socket.destroy());
  return { server, stop, endpoints };
}
