import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { randomUUID, type KeyObject } from 'node:crypto';
import type http from 'node:http';
import { z } from 'zod';
import { secretFile, hostName } from '../config.js';
import { BridgeError } from '../errors.js';
import { matchRoute } from '../api/routes.js';
import { loadPrivate, rawKey, publicRaw, fingerprint, shared, seal, unseal, packetSchema, sameContext } from './crypto.js';
import type { Transport } from '../api/client-transport.js';

const configSchema = z.object({ version: z.literal(1), keyFile: z.string().startsWith('/'), hosts: z.record(hostName, z.string()).refine(x => Object.keys(x).length > 0) }).strict();
export interface Identity { key: KeyObject; client: string; hosts: Record<string, string> }
export async function loadIdentity(file: string): Promise<Identity> {
  const config = configSchema.parse(JSON.parse(await secretFile(file)));
  for (const peer of Object.values(config.hosts)) rawKey(peer);
  const key = await loadPrivate(config.keyFile);
  return { key, client: fingerprint(publicRaw(key)), hosts: config.hosts };
}
function failure(): BridgeError { return new BridgeError('E2EE', 'Encrypted response authentication failed; send outcome may be unknown; do not retry automatically', 502); }
type Response = PassThrough & { statusCode: number; headers: http.IncomingHttpHeaders };
function response(status: number, contentType: string): Response {
  const stream = new PassThrough(); stream.on('error', () => {});
  return Object.assign(stream, { statusCode: status, headers: { 'content-type': contentType, 'cache-control': 'no-store' } });
}
async function encrypted(transport: Transport, path: string, method: string, payload: Buffer, signal: AbortSignal, lastEventId: string, callback: (res: http.IncomingMessage) => void): Promise<void> {
  const identity = transport.e2ee!;
  const matched = matchRoute(method, path);
  const host = matched.params.host ?? matched.query.host;
  const peer = identity.hosts[host];
  if (!peer || host === 'all') throw new BridgeError('E2EE_CONFIG', 'Target host public key is not pinned');
  const secret = shared(identity.key, peer);
  const context = { v: 1 as const, host, client: identity.client, id: randomUUID(), expires: Date.now() + 90000, op: matched.route.action === 'events' && matched.query.include === 'activity' ? 'observe-activity' as const : matched.route.permissions[0] };
  const packet = seal(secret, context, 'request', 0, { method, path, body: payload.toString('base64'), lastEventId });
  const wire = JSON.stringify(packet);
  let output: Response | undefined; let total = 0; let seq = 0; let ended = false; let pending = ''; const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const req = transport.module.request({ ...transport.options, path: transport.prefix + '/api/v1/e2ee/requests', method: 'POST', signal,
      headers: { ...transport.options.headers, accept: 'application/x-ndjson', 'content-type': 'application/json', 'content-length': Buffer.byteLength(wire) } }, res => {
      if (res.statusCode !== 200 || res.headers['content-type'] !== 'application/x-ndjson') { res.resume(); reject(new BridgeError('E2EE', 'Encrypted endpoint unavailable', 502)); return; }
      const consume = (line: string) => {
        if (ended || line.length > 131072) throw failure();
        const p = packetSchema.parse(JSON.parse(line));
        if (!sameContext(p, context) || p.seq !== seq++) throw failure();
        const value = unseal(secret, p, 'response');
        if (p.kind === 'headers') {
          if (p.seq !== 0 || !Number.isInteger(value.status) || value.status < 200 || value.status > 599 || !['application/json', 'text/event-stream'].includes(value.contentType)) throw failure();
          output = response(value.status, value.contentType);
          output.once('close', () => { if (!ended) req.destroy(); });
          if (value.contentType === 'text/event-stream') callback(output as unknown as http.IncomingMessage);
        } else if (p.kind === 'chunk') {
          if (!output || typeof value.data !== 'string') throw failure();
          const bytes = Buffer.from(value.data, 'base64');
          if (bytes.toString('base64') !== value.data || bytes.length > 32768 || (total += bytes.length) > 16 * 1024 * 1024) throw failure();
          if (output.headers['content-type'] === 'application/json') chunks.push(bytes);
          else { if (output.writableLength > 1048576) throw failure(); output.write(bytes); }
        } else if (p.kind === 'end') {
          if (!output || value.frames !== p.seq || value.bytes !== total) throw failure();
          ended = true;
          if (output.headers['content-type'] === 'application/json') { callback(output as unknown as http.IncomingMessage); output.end(Buffer.concat(chunks)); }
          else output.end();
        } else throw failure();
      };
      res.on('data', (chunk: Buffer) => {
        try {
          pending += chunk.toString('utf8');
          let pos: number;
          while ((pos = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, pos); pending = pending.slice(pos + 1); consume(line); }
          if (pending.length > 131072) throw failure();
        } catch { output?.destroy(failure()); reject(failure()); req.destroy(); }
      });
      res.on('end', () => { if (!ended || pending) { output?.destroy(failure()); reject(failure()); } else resolve(); });
      res.on('error', () => { output?.destroy(failure()); reject(failure()); });
    });
    req.on('error', error => { output?.destroy(failure()); reject(error); });
    req.end(wire);
  });
}
// Minimal request adapter keeps the existing JSON/SSE parsers and timeout/cancel paths.
export function encryptedRequest(transport: Transport, options: http.RequestOptions, callback: (res: http.IncomingMessage) => void): http.ClientRequest {
  const emitter = new EventEmitter(); const controller = new AbortController();
  const signal = options.signal; const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const finish = () => { signal?.removeEventListener('abort', abort); emitter.emit('close'); };
  const path = String(options.path ?? '').slice(transport.prefix.length);
  const headers = options.headers as Record<string, string> | undefined;
  const request = Object.assign(emitter, {
    destroy: () => { controller.abort(); return request; },
    end: (value?: string | Buffer) => {
      const payload = value ? Buffer.from(value) : Buffer.alloc(0);
      void (async () => {
        const matched = matchRoute(String(options.method), path);
        const target = matched.params.host ?? matched.query.host ?? 'all';
        if (target !== 'all') return encrypted(transport, path, String(options.method), payload, controller.signal, headers?.['last-event-id'] ?? '', callback);
        if (options.method !== 'GET' || !['status', 'agents', 'workspaces'].includes(matched.route.permissions[0])) throw failure();
        const results: any[] = []; let partial = false;
        for (const host of Object.keys(transport.e2ee!.hosts)) {
          const url = new URL(path, 'http://local');
          if (url.pathname === '/api/v1/hosts') url.pathname += '/' + host;
          else url.searchParams.set('host', host);
          try {
            let data: any;
            await encrypted(transport, url.pathname + url.search, 'GET', Buffer.alloc(0), controller.signal, '', res => {
              const items: Buffer[] = []; res.on('data', item => items.push(item));
              res.on('end', () => { data = JSON.parse(Buffer.concat(items).toString('utf8')); });
            });
            if (data?.ok !== true || !Array.isArray(data.data?.results) || data.data.results.length !== 1 || data.data.results[0].host !== host) throw failure();
            results.push(...data.data.results); partial ||= data.data.partial;
          } catch (error) { if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test((error as NodeJS.ErrnoException).code ?? '')) throw error; partial = true; results.push({ host, fetchedAt: new Date().toISOString(), error: { code: 'E2EE', message: 'Encrypted host query failed' }, ...(matched.route.permissions[0] === 'status' ? { state: 'disconnected' } : {}) }); }
        }
        const out = response(200, 'application/json'); callback(out as unknown as http.IncomingMessage);
        out.end(JSON.stringify({ ok: true, data: { results, partial } }));
      })().catch(error => emitter.emit('error', error)).finally(finish);
      return request;
    }
  });
  return request as unknown as http.ClientRequest;
}
