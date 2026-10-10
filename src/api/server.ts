import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BridgeService, requestSchema } from '../service.js';
import { authenticate, RateLimiter } from '../auth.js';
import { BridgeError, publicError } from '../errors.js';

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
export function apiServer(service: BridgeService, authFile?: string): Server {
  const rate = new RateLimiter();
  const sourceRate = new RateLimiter(600);
  let inflight = 0; let waits = 0;
  const clientInflight = new Map<string, number>();
  const server = createServer(async (req, res) => {
    let counted = false; let waiting = false; let principal: string | undefined;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/request') throw new BridgeError('NOT_FOUND', 'Unknown endpoint', 404);
      if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError('CONTENT_TYPE', 'JSON required', 415);
      let grant: Awaited<ReturnType<typeof authenticate>> | undefined;
      if (authFile) {
        // Failed authentication may be throttled, but never let a shared proxy
        // source bucket prevent a valid independent client from authenticating.
        try { grant = await authenticate(authFile, req.headers.authorization); }
        catch (error) { sourceRate.take(req.socket.remoteAddress ?? 'unknown'); throw error; }
        rate.take(`client:${grant.id}`);
        if ((clientInflight.get(grant.id) ?? 0) >= 8) throw new BridgeError('CAPACITY', 'Client has too many active requests', 503);
        principal = grant.id;
      }
      if (inflight >= 64) throw new BridgeError('CAPACITY', 'Too many active requests', 503);
      inflight++; counted = true;
      if (principal) clientInflight.set(principal, (clientInflight.get(principal) ?? 0) + 1);
      const parsed = requestSchema.safeParse(await body(req));
      if (!parsed.success) throw new BridgeError('REQUEST', 'Invalid request');
      if (grant && !grant.operations.includes(parsed.data.op)) throw new BridgeError('FORBIDDEN', 'Operation not permitted', 403);
      if (parsed.data.op === 'wait') {
        if (waits >= 32) throw new BridgeError('CAPACITY', 'Too many active waits', 503);
        waits++; waiting = true;
      }
      const result = await service.execute(parsed.data, grant ? new Set(grant.hosts) : undefined);
      respond(res, 200, { ok: true, data: result });
    } catch (error) {
      const e = publicError(error);
      respond(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
    } finally {
      if (counted) inflight--;
      if (waiting) waits--;
      if (principal && counted) {
        const next = (clientInflight.get(principal) ?? 1) - 1;
        if (next) clientInflight.set(principal, next); else clientInflight.delete(principal);
      }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.setTimeout(610000, socket => socket.destroy());
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
