import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BridgeService } from '../service.js';
import { authenticate, RateLimiter } from '../auth.js';
import { BridgeError, publicError } from '../errors.js';
import { matchRoute, documentRoutes } from './routes.js';
import { serveDocument } from './documents.js';
import { streamAgent, type StreamOptions } from './events.js';

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 262144) throw new BridgeError('BODY_LIMIT', 'Request too large', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('REQUEST', 'Invalid JSON'); }
}
export function apiServer(service: BridgeService, authFile?: string, streamOptions: StreamOptions = {}): Server {
  const rate = new RateLimiter();
  const sourceRate = new RateLimiter(600);
  const docsRate = new RateLimiter(120);
  let inflight = 0; let streams = 0;
  const clientInflight = new Map<string, number>();
  const server = createServer(async (req, res) => {
    let counted = false; let streaming = false; let principal: string | undefined;
    try {
      if (req.method === 'GET' && documentRoutes.some(route => route.path === req.url)) {
        docsRate.take(req.socket.remoteAddress ?? 'local');
        if (await serveDocument(req, res)) return;
      }
      const { route, params, query } = matchRoute(req.method, req.url);
      let grant: Awaited<ReturnType<typeof authenticate>> | undefined;
      if (authFile) {
        try { grant = await authenticate(authFile, req.headers.authorization); }
        catch (error) { sourceRate.take(req.socket.remoteAddress ?? 'unknown'); throw error; }
        rate.take(`client:${grant.id}`);
        if ((clientInflight.get(grant.id) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Client has too many active requests', 503);
        principal = grant.id;
      }
      if (inflight >= 64) throw new BridgeError('CAPACITY', 'Too many active requests', 503);
      inflight++; counted = true;
      if (principal) clientInflight.set(principal, (clientInflight.get(principal) ?? 0) + 1);
      const permissions = [...route.permissions, ...(route.action === 'events' && query.include === 'activity' ? ['activity' as const] : [])];
      if (grant && permissions.some(operation => !grant.operations.includes(operation))) throw new BridgeError('FORBIDDEN', 'Operation not permitted', 403);
      let value: unknown;
      if (route.body) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError('CONTENT_TYPE', 'JSON required', 415);
        const input = await body(req);
        if (input && typeof input === 'object' && Object.keys(input).some(key => !Object.hasOwn(route.body!.shape, key)))
          throw new BridgeError('REQUEST', 'Unknown body field');
        const parsed = route.body.safeParse(input);
        if (!parsed.success) throw new BridgeError('REQUEST', 'Invalid request body');
        value = parsed.data;
      } else if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0)
        throw new BridgeError('REQUEST', 'This endpoint does not accept a request body');
      if (res.destroyed) return;
      const request = route.request(params, query, value);
      const allowed = grant ? new Set(grant.hosts) : undefined;
      if (route.action === 'events') {
        if (streams >= 32) throw new BridgeError('CAPACITY', 'Too many active streams', 503);
        streams++; streaming = true;
        await streamAgent(service, request, query.include === 'activity', req, res, authFile, streamOptions);
      } else {
        const result = route.action === 'snapshot' ? await service.snapshot(request, allowed) : await service.execute(request, allowed);
        const output = route.response.safeParse(result);
        if (!output.success) throw new BridgeError('RESPONSE', 'Invalid upstream response', 502);
        const accepted = route.permissions[0] === 'send' && (output.data as { status: string }).status === 'accepted';
        respond(res, accepted ? 202 : 200, { ok: true, data: output.data });
      }
    } catch (error) {
      const e = publicError(error);
      if (res.headersSent) res.destroy();
      else respond(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
    } finally {
      if (counted) inflight--;
      if (streaming) streams--;
      if (principal && counted) {
        const next = (clientInflight.get(principal) ?? 1) - 1;
        if (next) clientInflight.set(principal, next); else clientInflight.delete(principal);
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.setTimeout(35000, socket => socket.destroy());
  return server;
}
function respond(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed) return;
  const output = JSON.stringify(value);
  if (Buffer.byteLength(output) > 16 * 1024 * 1024) throw new BridgeError('RESPONSE_LIMIT', 'Response too large', 502);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(output);
}
export async function listenSocket(server: Server, socket: string) {
  await mkdir(dirname(socket), { recursive: true, mode: 0o750 });
  try {
    await lstat(socket);
    // Never unlink an existing pathname: it might belong to a live service.
    throw new BridgeError('SOCKET_EXISTS', 'Socket path exists; stop the owner or remove a confirmed stale socket');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await listen(server, socket);
  await chmod(socket, 0o660);
}
export function listen(server: Server, target: string | number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target as number, host, () => { server.off('error', reject); resolve(); });
  });
}
export function closeServer(server: Server): Promise<void> {
  server.closeIdleConnections();
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
