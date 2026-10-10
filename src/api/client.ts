import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { secretFile, type ClientConfig } from '../config.js';
import type { Request } from '../service.js';
import { BridgeError } from '../errors.js';
export async function call(config: ClientConfig, profile: string | undefined, input: Request): Promise<any> {
  const selected = config.profiles[profile ?? config.defaultProfile];
  if (!selected) throw new BridgeError('PROFILE', 'Unknown client profile');
  const payload = JSON.stringify(input);
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) };
  let transport: typeof http | typeof https = http;
  let options: https.RequestOptions = { method: 'POST', path: '/v1/request', headers };
  if (selected.kind === 'local') options.socketPath = selected.socket;
  else {
    transport = https;
    const url = new URL(selected.url);
    if (url.protocol !== 'https:') throw new BridgeError('TLS', 'HTTPS required');
    const token = await secretFile(selected.tokenFile);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new BridgeError('TOKEN', 'Invalid client token');
    headers.authorization = `Bearer ${token}`;
    options = { ...options, hostname: url.hostname, port: url.port || 443,
      path: `${url.pathname.replace(/\/$/, '')}/v1/request`, rejectUnauthorized: true,
      ...(selected.caFile ? { ca: await readFile(selected.caFile) } : {}) };
  }
  return new Promise((resolve, reject) => {
    const req = transport.request(options, res => {
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { req.destroy(); reject(new BridgeError('RESPONSE_LIMIT', 'Response too large')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(new BridgeError('CONNECTION', input.op === 'send' ? 'Bridge response failed; send outcome may be unknown; do not retry automatically' : 'Bridge response failed', 502)));
      res.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (!result.ok) reject(new BridgeError(result.error?.code ?? 'API', result.error?.message ?? 'Bridge request failed', res.statusCode));
          else if (res.statusCode !== 200) reject(new BridgeError('API', 'Unexpected HTTP response', 502));
          else resolve(result.data);
        } catch { reject(new BridgeError('RESPONSE', input.op === 'send' ? 'Invalid Bridge response; send outcome may be unknown; do not retry automatically' : 'Invalid Bridge response', 502)); }
      });
    });
    // Absolute deadline covers DNS/connect/TLS as well as response inactivity.
    const timer = setTimeout(() => {
      req.destroy(); reject(new BridgeError('TIMEOUT', input.op === 'send' ? 'Send outcome unknown; do not retry automatically' : 'Bridge request timed out', 504));
    }, input.op === 'wait' ? input.timeout * 1000 + 5000 : 120000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', () => reject(new BridgeError('CONNECTION', input.op === 'send' ? 'Connection failed; send outcome may be unknown; do not retry automatically' : 'Cannot connect securely to Bridge', 502)));
    req.end(payload);
  });
}
