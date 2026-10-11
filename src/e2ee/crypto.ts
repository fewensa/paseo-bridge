import { createPrivateKey, createPublicKey, diffieHellman, hkdfSync, createCipheriv, createDecipheriv, randomBytes, createHash, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { hostName, operations, secretFile } from '../config.js';
import { BridgeError } from '../errors.js';

const b64 = z.string().max(524288).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const packetSchema = z.object({ v: z.literal(1), host: hostName, client: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().uuid(), expires: z.number().int().safe(), op: z.enum([...operations, 'observe-activity']),
  kind: z.enum(['request', 'headers', 'chunk', 'end']), seq: z.number().int().min(0).max(1000000),
  nonce: b64, data: b64 }).strict();
export type Packet = z.infer<typeof packetSchema>;
export type Context = Pick<Packet, 'v' | 'host' | 'client' | 'id' | 'expires' | 'op'>;
export const inputSchema = z.object({ method: z.enum(['GET', 'POST']), path: z.string().max(8192), body: b64,
  lastEventId: z.string().max(1024) }).strict();
function fail(): never { throw new BridgeError('E2EE', 'Encrypted channel authentication failed', 400); }
export function rawKey(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) fail();
  return bytes;
}
export function privateKey(value: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), rawKey(value)]), format: 'der', type: 'pkcs8' });
}
export function publicKey(value: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), rawKey(value)]), format: 'der', type: 'spki' });
}
export function publicRaw(key: KeyObject): Buffer { return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32); }
export function fingerprint(raw: Buffer): string { return createHash('sha256').update(raw).digest('hex'); }
export async function loadPrivate(file: string): Promise<KeyObject> { return privateKey(await secretFile(file)); }
export function shared(key: KeyObject, peer: string): Buffer { return diffieHellman({ privateKey: key, publicKey: publicKey(peer) }); }
function cipherKey(secret: Buffer, p: Context, direction: 'request' | 'response'): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(p.id), Buffer.from(`paseo-bridge-e2ee-v1/${direction}`), 32));
}
function aad(p: Packet): Buffer { return Buffer.from(JSON.stringify([p.v, p.host, p.client, p.id, p.expires, p.op, p.kind, p.seq])); }
export function seal(secret: Buffer, context: Context, kind: Packet['kind'], seq: number, value: unknown): Packet {
  const nonce = randomBytes(12);
  const p: Packet = { ...context, kind, seq, nonce: nonce.toString('base64'), data: '' };
  const cipher = createCipheriv('aes-256-gcm', cipherKey(secret, p, kind === 'request' ? 'request' : 'response'), nonce);
  cipher.setAAD(aad(p));
  p.data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64');
  return p;
}
export function unseal(secret: Buffer, packet: unknown, direction: 'request' | 'response'): any {
  try {
    const p = packetSchema.parse(packet);
    if ((p.kind === 'request') !== (direction === 'request')) fail();
    const nonce = Buffer.from(p.nonce, 'base64'); const data = Buffer.from(p.data, 'base64');
    if (nonce.length !== 12 || nonce.toString('base64') !== p.nonce || data.length < 16 || data.toString('base64') !== p.data) fail();
    const cipher = createDecipheriv('aes-256-gcm', cipherKey(secret, p, direction), nonce);
    cipher.setAAD(aad(p)); cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()]).toString('utf8'));
  } catch { fail(); }
}
export function sameContext(a: Context, b: Context): boolean {
  return a.v === b.v && a.host === b.host && a.client === b.client && a.id === b.id && a.expires === b.expires && a.op === b.op;
}
