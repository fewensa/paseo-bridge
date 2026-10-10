import type { Request } from '../service.js';
import { BridgeError } from '../errors.js';
import { apiError, jsonRequest, RESPONSE_LIMIT, type Transport } from './client-transport.js';
import { EventParser, type SSEFrame } from './event-parser.js';
import { snapshotData } from './models.js';

type Agent = Record<string, any>;
type Result = { status: 'idle' | 'error' | 'permission' | 'timeout'; final: Agent | null; error: string | null; lastMessage: null };
function malformed(): never { throw new BridgeError('RESPONSE', 'Invalid observation response', 502); }
function agent(value: any, id: string): Agent {
  if (!value || typeof value !== 'object' || value.id !== id || !['initializing', 'idle', 'running', 'error', 'closed'].includes(value.status)) malformed();
  if (value.archivedAt != null && typeof value.archivedAt !== 'string') malformed();
  if (value.archivedAt || value.status === 'closed') throw new BridgeError('AGENT', 'Agent not found or archived', 404);
  if (value.pendingPermissions !== undefined && !Array.isArray(value.pendingPermissions)) malformed();
  return value;
}
export function validateSnapshot(value: any, host: string, id: string): { agent: Agent; result?: Result } {
  const parsed = snapshotData.safeParse(value); if (!parsed.success) malformed();
  value = parsed.data;
  if (!value || value.host !== host || value.agentId !== id || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) malformed();
  const latest = agent(value.agent, id);
  if (value.result === undefined) return { agent: latest };
  const result = value.result;
  if (!result || !['idle', 'error', 'permission', 'timeout'].includes(result.status) ||
      !(result.error === null || typeof result.error === 'string') || result.lastMessage !== null) malformed();
  if (result.final !== null) agent(result.final, id);
  return { agent: latest, result };
}
function recoverable(error: unknown): boolean {
  return error instanceof BridgeError && (error.code === 'CONNECTION' && error.status === 502 || error.status === 503 && ['OFFLINE', 'CONNECTION'].includes(error.code));
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true });
  });
}
function stream(transport: Transport, path: string, signal: AbortSignal, lastId: string | undefined, onSnapshot: (value: any) => boolean, onId: (id: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false; let timer: NodeJS.Timeout;
    const finish = (error?: unknown) => {
      if (done) return; done = true; clearTimeout(timer); req.destroy();
      if (error) reject(error); else resolve();
    };
    const watchdog = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => finish(new BridgeError('CONNECTION', 'Observation stream stalled', 502)), ms); };
    const req = transport.module.request({ ...transport.options, path: transport.prefix + path, method: 'GET', signal,
      headers: { ...transport.options.headers, accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) } }, res => {
      if (res.statusCode !== 200) {
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > RESPONSE_LIMIT) finish(new BridgeError('RESPONSE_LIMIT', 'Response too large', 502)); else chunks.push(chunk); });
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) return finish(new BridgeError('REDIRECT', 'Unexpected redirect', 502));
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) malformed();
            const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (envelope?.ok !== false || typeof envelope.error?.code !== 'string' || typeof envelope.error?.message !== 'string') malformed();
            finish(apiError(envelope.error, res.statusCode));
          } catch (error) { finish(error instanceof BridgeError ? error : new BridgeError('RESPONSE', 'Invalid observation response', 502)); }
        });
        res.on('error', () => finish(new BridgeError('CONNECTION', 'Observation connection failed', 502))); return;
      }
      if (!/^text\/event-stream(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) return finish(new BridgeError('RESPONSE', 'Expected event stream', 502));
      watchdog(30000);
      const parser = new EventParser((frame: SSEFrame) => {
        if (done) return;
        let event: any;
        try { event = JSON.parse(frame.data); } catch { malformed(); }
        if (!event || !['snapshot', 'resync', 'connection', 'error', 'activity'].includes(event.kind) || frame.event !== event.kind) malformed();
        if (frame.id !== undefined) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i.test(frame.id)) malformed();
          onId(frame.id);
        }
        if (event.kind === 'snapshot') { if (onSnapshot(event)) finish(); }
        else if (event.kind === 'error') {
          if (!event.error || typeof event.error.code !== 'string' || typeof event.error.message !== 'string') malformed();
          throw apiError(event.error, event.error.code === 'OFFLINE' ? 503 : 502);
        } else if (event.kind === 'resync' && typeof event.reason !== 'string' || event.kind === 'connection' && typeof event.state !== 'string') malformed();
        else if (event.kind === 'activity') malformed(); // State-only subscription never requests timeline data.
      });
      res.on('data', (chunk: Buffer) => { if (done) return; watchdog(30000); try { parser.push(chunk); } catch (error) { finish(error); } });
      res.on('end', () => { try { parser.end(); finish(); } catch (error) { finish(error); } });
      res.on('error', () => finish(new BridgeError('CONNECTION', 'Observation connection failed', 502)));
    });
    req.on('error', (error: NodeJS.ErrnoException) => {
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '');
      finish(new BridgeError(tls ? 'TLS' : 'CONNECTION', 'Cannot connect securely to Bridge', 502));
    });
    watchdog(15000); req.end();
  });
}
export async function observe(transport: Transport, input: Request, mode: 'sse' | 'poll', expiresAt = Date.now() + input.timeout * 1000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()));
  const base = `/api/v1/hosts/${encodeURIComponent(input.host)}/agents/${encodeURIComponent(input.agent!)}`;
  let latest: Agent | null = null; let result: Result | undefined; let lastId: string | undefined;
  const snapshot = (value: any) => { const parsed = validateSnapshot(value, input.host, input.agent!); latest = parsed.agent; if (Date.now() < expiresAt) result = parsed.result; return result !== undefined; };
  try {
    while (!controller.signal.aborted && Date.now() < expiresAt && !result) {
      try {
        if (mode === 'poll') snapshot(await jsonRequest(transport, base, { signal: controller.signal, timeoutMs: Math.min(15000, Math.max(1, expiresAt - Date.now())) }));
        else await stream(transport, base + '/events', controller.signal, lastId, snapshot, id => { lastId = id; });
      } catch (error) {
        if (controller.signal.aborted) break;
        if (!recoverable(error) && !(mode === 'poll' && error instanceof BridgeError && error.code === 'TIMEOUT')) throw error;
      }
      if (!result) await pause(mode === 'poll' ? 2000 : 250, controller.signal);
    }
    return { host: input.host, agentId: input.agent!, result: result ?? { status: 'timeout', final: latest, error: null, lastMessage: null } };
  } finally { clearTimeout(timer); controller.abort(); }
}
