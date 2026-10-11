import { z } from 'zod';
import { atomicSecret, secretFile } from '../config.js';
import { BridgeError } from '../errors.js';
const ledger = z.record(z.string(), z.number().int().safe());
export class ReplayGuard {
  private queue: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  claim(id: string, expires: number): Promise<void> {
    const task = this.queue.then(async () => {
      let entries: Record<string, number>;
      try { entries = ledger.parse(JSON.parse(await secretFile(this.file))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BridgeError('E2EE_REPLAY', 'Replay protection unavailable', 503); entries = {}; }
      if (entries[id] !== undefined) throw new BridgeError('E2EE_REPLAY', 'Request already received', 409);
      const now = Date.now(); entries = Object.fromEntries(Object.entries(entries).filter(([, expiry]) => expiry >= now));
      if (expires <= now || expires > now + 120000 || Object.keys(entries).length >= 4096) throw new BridgeError('E2EE_REPLAY', 'Request expired or replay capacity exhausted', 409);
      entries[id] = expires;
      await atomicSecret(this.file, JSON.stringify(entries));
    });
    this.queue = task.catch(() => {}); return task;
  }
}
