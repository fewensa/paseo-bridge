import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { secretFile, type ClientConfig } from '../config.js';
import { BridgeError } from '../errors.js';

export const RESPONSE_LIMIT = 16 * 1024 * 1024;
export interface Transport { module: typeof http | typeof https; options: https.RequestOptions; prefix: string }
export async function clientTransport(config: ClientConfig, profile?: string): Promise<Transport> {
  const selected = config.profiles[profile ?? config.defaultProfile];
  if (!selected) throw new BridgeError('PROFILE', 'Unknown client profile');
  if (selected.kind === 'local') return { module: http, options: { socketPath: selected.socket }, prefix: '' };
  const url = new URL(selected.url);
  if (url.protocol !== 'https:') throw new BridgeError('TLS', 'HTTPS required');
  const token = await secretFile(selected.tokenFile);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BridgeError('TOKEN', 'Invalid client token');
  return { module: https, prefix: url.pathname.replace(/\/$/, ''), options: {
    hostname: url.hostname, port: url.port || 443, rejectUnauthorized: true,
    headers: { authorization: `Bearer ${token}` }, ...(selected.caFile ? { ca: await readFile(selected.caFile) } : {})
  } };
}
// Never echo untrusted response messages (which may contain credentials or proxy HTML).
export function apiError(value: any, status = 502): BridgeError {
  const codes = ['AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'SCOPE', 'OFFLINE', 'CONNECTION', 'AGENT', 'HOST', 'BUSY', 'VALIDATION', 'REQUEST', 'NOT_FOUND', 'BODY_LIMIT', 'CONTENT_TYPE', 'CAPACITY', 'RESPONSE_LIMIT', 'RESULT_LIMIT', 'RATE_LIMIT', 'PAGINATION', 'TIMEOUT', 'INTERNAL', 'SEND_UNCERTAIN', 'SUBMISSION'];
  const code = codes.includes(value?.code) ? value.code : 'API';
  const messages: Record<string, string> = { AUTH: 'Authentication failed', UNAUTHORIZED: 'Authentication failed', FORBIDDEN: 'Operation not permitted', SCOPE: 'Operation not permitted', OFFLINE: 'Host is not connected', CONNECTION: 'Bridge connection failed', AGENT: 'Agent not found or archived', HOST: 'Unknown host', BUSY: 'Agent is busy', SEND_UNCERTAIN: 'A prior send outcome is unknown; do not retry before reconciliation', VALIDATION: 'Invalid request' };
  return new BridgeError(code, messages[code] ?? 'Bridge request failed', status);
}
export function jsonRequest(transport: Transport, path: string, options: { body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  const sending = options.body !== undefined;
  const ambiguous = sending ? '; send outcome may be unknown; do not retry automatically' : '';
  return new Promise((resolve, reject) => {
    const payload = sending ? JSON.stringify(options.body) : undefined;
    const req = transport.module.request({ ...transport.options, path: transport.prefix + path, method: sending ? 'POST' : 'GET', signal: options.signal,
      headers: { ...transport.options.headers, accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) { reject(new BridgeError('RESPONSE_LIMIT', 'Response too large' + ambiguous, 502)); req.destroy(); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new BridgeError('CONNECTION', 'Bridge response failed' + ambiguous, 502)));
      res.on('end', () => {
        try {
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) throw new BridgeError('REDIRECT', 'Unexpected redirect' + ambiguous, 502);
          if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? '')) throw new BridgeError('RESPONSE', 'Invalid Bridge response' + ambiguous, 502);
          const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (envelope?.ok === false) {
            if (typeof envelope.error?.code !== 'string' || typeof envelope.error?.message !== 'string') throw new BridgeError('RESPONSE', 'Invalid Bridge response' + ambiguous, 502);
            const error = apiError(envelope.error, res.statusCode);
            if (sending && (res.statusCode ?? 0) >= 500) error.message += ambiguous;
            throw error;
          }
          if (envelope?.ok !== true || !('data' in envelope) || ![200, ...(sending ? [202] : [])].includes(res.statusCode ?? 0)) throw new BridgeError('RESPONSE', 'Invalid Bridge response' + ambiguous, 502);
          if (sending && !((res.statusCode === 202 && envelope.data?.status === 'accepted') ||
              (res.statusCode === 200 && envelope.data?.status === 'unknown' && envelope.data.retrySafe === false)))
            throw new BridgeError('RESPONSE', 'Invalid send acknowledgement' + ambiguous, 502);
          resolve(envelope.data);
        } catch (error) { reject(error instanceof BridgeError ? error : new BridgeError('RESPONSE', 'Invalid Bridge response' + ambiguous, 502)); }
      });
    });
    const timer = setTimeout(() => { reject(new BridgeError('TIMEOUT', 'Bridge request timed out' + ambiguous, 504)); req.destroy(); }, options.timeoutMs ?? 120000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', (error: NodeJS.ErrnoException) => {
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? '');
      reject(new BridgeError(tls ? 'TLS' : 'CONNECTION', 'Cannot connect securely to Bridge' + ambiguous, 502));
    });
    req.end(payload);
  });
}
