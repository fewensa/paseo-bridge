import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { operations, hostName } from './config.js';
import type { Connection } from './paseo/connection.js';
import { BridgeError, deadline, publicError } from './errors.js';
import { SubmissionGuards } from './submissions.js';
import type { Snapshot } from './api/models.js';

export const requestSchema = z.object({
  op: z.enum(operations), host: z.union([hostName, z.literal('all')]),
  agent: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  prompt: z.string().min(1).max(65536).optional(),
  interrupt: z.boolean().default(false),
  tail: z.number().int().min(0).max(200).default(20),
  timeout: z.number().int().min(1).max(600).default(120)
}).strict().superRefine((r, ctx) => {
  if (['send', 'activity', 'wait'].includes(r.op) && (!r.agent || r.host === 'all'))
    ctx.addIssue({ code: 'custom', message: 'Explicit host and agent required' });
  if (r.op === 'send' && !r.prompt?.trim()) ctx.addIssue({ code: 'custom', message: 'Prompt required' });
  if (r.interrupt && r.op !== 'send') ctx.addIssue({ code: 'custom', message: 'Interrupt is send-only' });
});
export type Request = z.infer<typeof requestSchema>;
export class BridgeService {
  private sending = new Set<string>();
  private guards: SubmissionGuards;
  constructor(public hosts: Map<string, Connection>, private timeoutMs = 15000, stateDir?: string) {
    this.guards = new SubmissionGuards(stateDir);
  }
  async execute(request: Request, allowed?: ReadonlySet<string>): Promise<unknown> {
    const expiresAt = Date.now() + (request.op === 'wait' ? request.timeout * 1000 : this.timeoutMs);
    const remaining = () => {
      const ms = expiresAt - Date.now();
      if (ms <= 0) throw new BridgeError('TIMEOUT', 'Operation timed out', 504);
      return ms;
    };
    const selected = request.host === 'all' ? [...this.hosts.keys()].filter(x => !allowed || allowed.has(x)) : [request.host];
    if (selected.some(x => allowed && !allowed.has(x))) throw new BridgeError('FORBIDDEN', 'Host not permitted', 403);
    if (selected.some(x => !this.hosts.has(x))) throw new BridgeError('HOST', 'Unknown host', 404);
    if (['status', 'agents', 'workspaces'].includes(request.op)) {
      let totalEntries = 0; let totalBytes = 0;
      const results = await Promise.all(selected.map(async host => {
        const connection = this.hosts.get(host)!;
        const fetchedAt = new Date().toISOString();
        if (request.op === 'status') return { host, state: connection.state(), fetchedAt };
        try {
          this.online(connection);
          const entries: unknown[] = [];
          let cursor: string | undefined;
          const seen = new Set<string>();
          do {
            const page = { limit: 200, ...(cursor ? { cursor } : {}) };
            const result = request.op === 'agents'
              ? await deadline(connection.api.agents.list({ page }), remaining())
              : await deadline(connection.api.workspaces.list({ page }), remaining());
            const batch = result.entries.map(entry => request.op === 'agents' ? (entry as { agent: unknown }).agent : entry);
            totalEntries += batch.length;
            totalBytes += Buffer.byteLength(JSON.stringify(batch));
            if (totalEntries > 10000 || totalBytes > 12 * 1024 * 1024)
              throw new BridgeError('RESULT_LIMIT', 'Query exceeds aggregate limit; narrow the host selection', 502);
            entries.push(...batch);
            cursor = result.pageInfo.nextCursor ?? undefined;
            if (cursor && seen.has(cursor)) throw new BridgeError('PAGINATION', 'Repeated pagination cursor', 502);
            if (cursor) seen.add(cursor);
            if (seen.size > 1000) throw new BridgeError('PAGINATION', 'Too many pages', 502);
          } while (cursor);
          return { host, fetchedAt, entries };
        } catch (error) { const e = publicError(error); return { host, fetchedAt, error: { code: e.code, message: e.message } }; }
      }));
      return { results, partial: results.some(r => 'error' in r) };
    }
    const connection = this.hosts.get(request.host)!;
    this.online(connection);
    const agent = connection.api.agents.ref(request.agent!);
    const key = `${request.host}/${agent.id}`;
    if (request.op === 'send') {
      if (this.sending.has(key)) throw new BridgeError('BUSY', 'Another send is in progress', 409);
      // Serialize preflight and dispatch, not just dispatch after stale refreshes.
      this.sending.add(key);
    }
    let submitted = false; let prepared: string | undefined;
    try {
      if (request.op === 'send') await this.guards.assertClear(request.host, agent.id);
      const snapshot = await deadline(agent.refresh(), Math.min(this.timeoutMs, remaining()));
      if (!snapshot || snapshot.agent.archivedAt) throw new BridgeError('AGENT', 'Agent not found or archived', 404);
      if (request.op === 'activity') {
        if (request.tail === 0) return { host: request.host, agentId: agent.id, entries: [] };
        const page = await deadline(agent.timeline.refetch({ direction: 'before', limit: request.tail }), remaining());
        return { host: request.host, agentId: agent.id, fetchedAt: new Date().toISOString(), timeline: page };
      }
      if (request.op === 'wait') {
        const ms = remaining();
        const result = await deadline(agent.waitForFinish(ms), ms + 1000);
        return { host: request.host, agentId: agent.id, result };
      }
      if (snapshot.agent.status !== 'idle' && !request.interrupt)
        throw new BridgeError('BUSY', 'Agent is not idle; explicit interrupt required', 409);
      const requestId = randomUUID();
      await this.guards.prepare(request.host, agent.id, requestId);
      prepared = requestId;
      const sendTimeout = remaining();
      // steer avoids implicit interruption if an external client starts a turn
      // between idle check and dispatch. Atomic cross-client idle-only delivery
      // is not supported by Paseo 0.11.1.
      const submission = Promise.resolve().then(() => agent.send(request.prompt!, { messageId: requestId,
        activeTurnBehavior: request.interrupt ? 'interrupt' : 'steer' }));
      submitted = true;
      // Only confirmed acceptance clears the durable guard. SDK rejection/timeout
      // is still ambiguous and must survive restart until local reconciliation.
      const settlement = submission.then(() => this.guards.clear(request.host, agent.id, requestId));
      void settlement.then(() => this.sending.delete(key), () => this.sending.delete(key));
      try {
        await deadline(settlement, sendTimeout);
        return { host: request.host, agentId: agent.id, requestId, status: 'accepted' };
      } catch { return { host: request.host, agentId: agent.id, requestId, status: 'unknown', retrySafe: false }; }
    } finally {
      if (request.op === 'send' && !submitted) {
        try { if (prepared) await this.guards.clear(request.host, agent.id, prepared); }
        finally { this.sending.delete(key); }
      }
    }
  }
  async snapshot(request: Request, allowed?: ReadonlySet<string>): Promise<Snapshot> {
    if (!request.agent || request.host === 'all') throw new BridgeError('TARGET', 'Explicit host and agent required');
    if (allowed && !allowed.has(request.host)) throw new BridgeError('FORBIDDEN', 'Host not permitted', 403);
    const connection = this.hosts.get(request.host);
    if (!connection) throw new BridgeError('HOST', 'Unknown host', 404);
    this.online(connection);
    const handle = connection.api.agents.ref(request.agent);
    const expires = Date.now() + this.timeoutMs;
    const value = await deadline(handle.refresh(), this.timeoutMs);
    if (!value || value.agent.archivedAt) throw new BridgeError('AGENT', 'Agent not found or archived', 404);
    const snapshot: Snapshot = { host: request.host, agentId: request.agent,
      fetchedAt: new Date().toISOString(), agent: value.agent };
    // Read-only, bounded reconciliation with the SDK's existing terminal result.
    // A new turn racing this refresh can yield timeout; that is not completion.
    if (value.agent.status === 'idle' || value.agent.status === 'error' || value.agent.pendingPermissions.length) {
      const remaining = expires - Date.now();
      if (remaining > 0) {
        const result = await deadline(handle.waitForFinish(Math.min(1000, remaining)), remaining);
        // State observation must not smuggle timeline text through wait scope.
        if (result.status !== 'timeout') snapshot.result = { ...result, lastMessage: null };
      }
    }
    return snapshot;
  }
  private online(connection: Connection) {
    if (connection.state() !== 'connected') throw new BridgeError('OFFLINE', 'Host is not connected', 503);
  }
}
