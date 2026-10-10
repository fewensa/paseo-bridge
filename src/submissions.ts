import { z } from 'zod';
import { join, dirname } from 'node:path';
import { open, unlink, lstat } from 'node:fs/promises';
import { atomicSecret, secretFile, hostName, type ServerConfig } from './config.js';
import { BridgeError } from './errors.js';

const agentId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const recordSchema = z.object({ version: z.literal(1), host: hostName, agent: agentId,
  requestId: z.string().uuid(), createdAt: z.string().datetime() }).strict();
type Record = z.infer<typeof recordSchema>;

export class SubmissionGuards {
  private memory = new Map<string, Record>();
  constructor(private stateDir?: string) {}
  private file(host: string, agent: string) {
    if (!hostName.safeParse(host).success || !agentId.safeParse(agent).success)
      throw new BridgeError('TARGET', 'Invalid submission target');
    return this.stateDir ? join(this.stateDir, 'submissions', `${host}.${agent}.json`) : undefined;
  }
  async inspect(host: string, agent: string): Promise<Record | undefined> {
    const file = this.file(host, agent);
    if (!file) return this.memory.get(`${host}/${agent}`);
    try { return recordSchema.parse(JSON.parse(await secretFile(file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  async assertClear(host: string, agent: string) {
    if (await this.inspect(host, agent)) throw new BridgeError('SEND_UNCERTAIN', 'Earlier submission outcome is unresolved; local operator reconciliation required', 409);
  }
  async prepare(host: string, agent: string, requestId: string) {
    const record = recordSchema.parse({ version: 1, host, agent, requestId, createdAt: new Date().toISOString() });
    const file = this.file(host, agent);
    if (file) await atomicSecret(file, JSON.stringify(record));
    else this.memory.set(`${host}/${agent}`, record);
  }
  async clear(host: string, agent: string, requestId: string) {
    const record = await this.inspect(host, agent);
    if (!record || record.requestId !== requestId) throw new BridgeError('SUBMISSION', 'Submission guard missing or request ID does not match', 409);
    const file = this.file(host, agent);
    if (file) {
      await unlink(file);
      const directory = await open(dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } else this.memory.delete(`${host}/${agent}`);
  }
}
export async function inspectSubmission(config: ServerConfig, host: string, agent: string) {
  const guard = await new SubmissionGuards(config.stateDir).inspect(host, agent);
  if (!guard) throw new BridgeError('SUBMISSION', 'No unresolved submission guard', 404);
  return { guard };
}
export async function clearSubmission(config: ServerConfig, host: string, agent: string, requestId: string) {
  try {
    await lstat(config.socket);
    throw new BridgeError('STOP_REQUIRED', 'Stop the Bridge before clearing a reconciled submission');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await new SubmissionGuards(config.stateDir).clear(host, agent, requestId);
  return { host, agentId: agent, requestId, reconciled: true };
}
