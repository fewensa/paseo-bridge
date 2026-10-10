import { z } from 'zod';
import { readFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { BridgeError } from './errors.js';

const path = z.string().refine(isAbsolute, 'Absolute path required');
export const hostName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).refine(x => x !== 'all');
export const operations = ['status', 'agents', 'workspaces', 'send', 'activity', 'wait'] as const;
export const serverSchema = z.object({
  version: z.literal(1),
  hosts: z.record(hostName, z.object({ connectionFile: path }).strict()).refine(x => Object.keys(x).length > 0),
  socket: path,
  stateDir: path,
  requestTimeoutMs: z.number().int().min(100).max(120000).default(15000),
  central: z.object({ port: z.number().int().min(1).max(65535), authFile: path }).strict().optional()
}).strict();
export type ServerConfig = z.infer<typeof serverSchema>;
export const credentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('relay'), pairUrl: z.string(), password: z.string().optional() }).strict(),
  z.object({ kind: z.literal('direct'), url: z.string().url().refine(x => /^wss?:/.test(x)),
    password: z.string().optional(), localCredentialFile: path.optional() }).strict()
]);
export type Credential = z.infer<typeof credentialSchema>;
export const clientSchema = z.object({
  version: z.literal(1), defaultProfile: z.string(),
  profiles: z.record(z.string(), z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), socket: path }).strict(),
    z.object({ kind: z.literal('central'), url: z.string().url().refine(x => {
      const u = new URL(x); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
    }), tokenFile: path, caFile: path.optional() }).strict()
  ]))
}).strict().refine(x => x.defaultProfile in x.profiles);
export type ClientConfig = z.infer<typeof clientSchema>;

export async function secretFile(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await handle.stat();
    if (!s.isFile() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())
      throw new BridgeError('SECRET_PERMISSIONS', 'Secret must be an owner-only regular file owned by the current user');
    return (await handle.readFile('utf8')).trim();
  } finally { await handle.close(); }
}
export async function readConfig<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  try { return schema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  catch { throw new BridgeError('CONFIG', 'Invalid or unreadable configuration'); }
}
export async function atomicSecret(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(value); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); }
  catch (error) { await unlink(temp); throw error; }
  const directory = await open(dirname(file), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}
