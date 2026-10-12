import { createServer, type ServerResponse } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { authenticate, RateLimiter } from '../auth.js';
import { operations } from '../config.js';
import { serveDocument } from '../api/documents.js';
import { BridgeError, publicError } from '../errors.js';

export interface NativeRoute { serverId: string; url: string }
export interface NativeProxyConfig { authFile: string; hosts: Record<string, NativeRoute> }
const frameLimit = 4 * 1024 * 1024;
const queueLimit = 8 * 1024 * 1024;
function fail(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: { code, message: 'Native encrypted Bridge request failed' } }));
}
function encryptedFrame(data: RawData, binary: boolean, fromClient: boolean): boolean {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  if (binary) return bytes.length >= 40;
  const text = bytes.toString('utf8');
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    return decoded.length >= 40 && decoded.toString('base64') === text;
  }
  if (bytes.length > 512) return false;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    if (Object.keys(v).some(k => !['type', 'key', 'capabilities'].includes(k))) return false;
    if (v.capabilities !== undefined && (!v.capabilities || typeof v.capabilities !== 'object' || Array.isArray(v.capabilities) ||
      Object.keys(v.capabilities).some(k => k !== 'binaryCiphertext') || typeof v.capabilities.binaryCiphertext !== 'boolean')) return false;
    if (fromClient) return v.type === 'e2ee_hello' && typeof v.key === 'string' && Buffer.from(v.key, 'base64').length === 32 && Buffer.from(v.key, 'base64').toString('base64') === v.key;
    return v.type === 'e2ee_ready' && v.key === undefined;
  } catch { return false; }
}
export function nativeProxyServer(config: NativeProxyConfig, connectUpstream = (url: string) => new WebSocket(url, { maxPayload: frameLimit, perMessageDeflate: false, handshakeTimeout: 10000 })) {
  const sockets = new Set<WebSocket>();
  const counts = new Map<string, number>();
  const admissions = new Set<{ close(): void; header: string; id: string; host: string }>();
  const sourceRate = new RateLimiter(600); const clientRate = new RateLimiter(120);
  const wss = new WebSocketServer({ noServer: true, maxPayload: frameLimit, perMessageDeflate: false });
  const alive = new WeakSet<WebSocket>();
  const owner = async (header: string | undefined) => {
    const grant = await authenticate(config.authFile, header);
    // Native Relay admission is owner-level. Never admit an operation-restricted token.
    if (operations.some(op => !grant.operations.includes(op))) throw new BridgeError('FORBIDDEN', 'Full trusted management grant required', 403);
    return grant;
  };
  const server = createServer(async (req, res) => {
    try {
      sourceRate.take(req.socket.remoteAddress ?? 'local');
      if (await serveDocument(req, res)) return;
      if (req.method !== 'GET' || req.url !== '/api/v1/native/hosts') { fail(res, 426, 'ENCRYPTION_REQUIRED'); return; }
      const grant = await owner(req.headers.authorization); clientRate.take(grant.id);
      const hosts = Object.fromEntries(Object.entries(config.hosts).filter(([host]) => grant.hosts.includes(host))
        .map(([host, route]) => [host, { serverId: route.serverId }]));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify({ ok: true, data: { hosts } }));
    } catch (e) { const value = publicError(e); fail(res, value.status, value.code); }
  });
  server.on('upgrade', (req, socket, head) => {
    // Authentication and upstream dialing are asynchronous; own raw socket
    // errors until ws takes over so a reset cannot crash the proxy.
    const rawError = () => socket.destroy();
    socket.on('error', rawError);
    void (async () => {
      let release: (() => void) | undefined;
      try {
        sourceRate.take(req.socket.remoteAddress ?? 'local');
        const target = new URL(req.url ?? '', 'http://local');
        const match = /^\/api\/v1\/native\/connect\/([a-z][a-z0-9-]{0,62})$/.exec(target.pathname);
        const host = match?.[1]; const route = host ? config.hosts[host] : undefined;
        if (!host || !route || target.searchParams.get('role') !== 'client' || target.searchParams.get('serverId') !== route.serverId ||
          [...target.searchParams.keys()].length !== 2) throw new BridgeError('NOT_FOUND', 'Unknown native route', 404);
        const grant = await owner(req.headers.authorization); clientRate.take(grant.id);
        if (!grant.hosts.includes(host)) throw new BridgeError('FORBIDDEN', 'Host not permitted', 403);
        if (admissions.size >= 64 || (counts.get(grant.id) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Native connection capacity exhausted', 503);
        let client: WebSocket | undefined; let done = false;
        // Deliberately forward no client authorization header, subprotocol or daemon credential upstream.
        const upstream = connectUpstream(route.url);
        const admission = { header: req.headers.authorization!, id: grant.id, host,
          close() { if (done) return; done = true; admissions.delete(admission); counts.set(grant.id, Math.max(0, (counts.get(grant.id) ?? 1) - 1));
            sockets.delete(upstream); if (client) sockets.delete(client); upstream.terminate(); client?.terminate(); if (!client) socket.destroy(); } };
        counts.set(grant.id, (counts.get(grant.id) ?? 0) + 1);
        admissions.add(admission); sockets.add(upstream); alive.add(upstream); release = () => admission.close();
        upstream.on('pong', () => alive.add(upstream));
        const pipe = (destination: WebSocket, data: RawData, binary: boolean, fromClient: boolean) => {
          if (!encryptedFrame(data, binary, fromClient) || destination.readyState !== WebSocket.OPEN || destination.bufferedAmount > queueLimit) { admission.close(); return; }
          destination.send(data, { binary }, error => { if (error) admission.close(); });
        };
        upstream.on('error', () => admission.close()); upstream.on('close', () => admission.close());
        socket.once('close', () => { if (!client) admission.close(); });
        upstream.once('open', () => {
          if (done || socket.destroyed) { admission.close(); return; }
          try { wss.handleUpgrade(req, socket, head, ws => {
            socket.removeListener('error', rawError);
            client = ws; sockets.add(ws); alive.add(ws);
            ws.on('pong', () => alive.add(ws)); ws.on('error', () => admission.close()); ws.on('close', () => admission.close());
            ws.on('message', (data, binary) => pipe(upstream, data, binary, true));
            upstream.on('message', (data, binary) => pipe(ws, data, binary, false));
          }); } catch { admission.close(); }
        });
      } catch (e) {
        release?.(); const value = publicError(e);
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${value.status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    })();
  });
  const heartbeat = setInterval(() => {
    for (const ws of sockets) { if (!alive.has(ws)) { ws.terminate(); continue; } alive.delete(ws); if (ws.readyState === WebSocket.OPEN) ws.ping(); }
    for (const a of admissions) void owner(a.header).then(grant => { if (grant.id !== a.id || !grant.hosts.includes(a.host)) a.close(); }).catch(() => a.close());
  }, 10000); heartbeat.unref();
  const stop = () => { clearInterval(heartbeat); for (const a of admissions) a.close(); wss.close(); };
  server.once('close', stop); server.headersTimeout = 10000; server.requestTimeout = 15000;
  return { server, stop };
}
