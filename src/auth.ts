import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { secretFile, operations, hostName } from './config.js';
import { BridgeError } from './errors.js';
export const authSchema = z.object({ version: z.literal(1), clients: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), hosts: z.array(hostName).min(1),
    operations: z.array(z.enum(operations)).min(1) }).strict()) }).strict();
export type AuthRegistry = z.infer<typeof authSchema>;
export function digest(token: string) { return createHash('sha256').update(token).digest('hex'); }
export async function registry(file: string): Promise<AuthRegistry> {
  try { return authSchema.parse(JSON.parse(await secretFile(file))); }
  catch { throw new BridgeError('AUTH_CONFIG', 'Authentication configuration unavailable', 503); }
}
export async function authenticate(file: string, header: string | undefined) {
  if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) throw new BridgeError('UNAUTHORIZED', 'Authentication required', 401);
  const supplied = Buffer.from(digest(header.slice(7)), 'hex');
  const config = await registry(file);
  for (const [id, grant] of Object.entries(config.clients)) {
    if (timingSafeEqual(supplied, Buffer.from(grant.digest, 'hex'))) return { id, ...grant };
  }
  throw new BridgeError('UNAUTHORIZED', 'Authentication required', 401);
}
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(private limit = 60, private interval = 60000) {}
  take(key: string) {
    const now = Date.now();
    // Remove expired entries, bounding memory for unauthenticated source addresses.
    for (const [id, window] of this.windows) if (now - window.start >= this.interval) this.windows.delete(id);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= 10000) throw new BridgeError('RATE_LIMIT', 'Rate limit exceeded', 429);
      window = { start: now, count: 0 }; this.windows.set(key, window);
    }
    if (++window.count > this.limit) throw new BridgeError('RATE_LIMIT', 'Rate limit exceeded', 429);
  }
}
