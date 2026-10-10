import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PaseoAgentTimelineSubscription } from '@getpaseo/client';
import { BridgeService, type Request } from '../service.js';
import { authenticate } from '../auth.js';
import { BridgeError, deadline, publicError } from '../errors.js';
import { streamEventSchema, type StreamEvent, type Snapshot } from './models.js';

export interface StreamOptions { heartbeatMs?: number; snapshotMs?: number; lifetimeMs?: number; }
const frameLimit = 1024 * 1024;
export async function streamAgent(service: BridgeService, input: Request, includeActivity: boolean,
  req: IncomingMessage, res: ServerResponse, authFile?: string, options: StreamOptions = {}): Promise<void> {
  const authorize = async () => {
    if (!authFile) return undefined;
    const grant = await authenticate(authFile, req.headers.authorization);
    if (!grant.hosts.includes(input.host) || !grant.operations.includes('wait') || (includeActivity && !grant.operations.includes('activity')))
      throw new BridgeError('FORBIDDEN', 'Stream permission no longer available', 403);
    return new Set(grant.hosts);
  };
  const allowed = await authorize();
  const observed = service.hosts.get(input.host);
  const initial = await service.snapshot(input, allowed);
  await authorize();
  if (!observed || service.hosts.get(input.host) !== observed || observed.state() !== 'connected')
    throw new BridgeError('OFFLINE', 'Host changed during observation; reconnect for a fresh snapshot', 503);
  const connection = observed;
  const lastID = req.headers['last-event-id'];
  if (lastID !== undefined && (typeof lastID !== 'string' || !/^[a-f0-9-]{36}:\d{1,12}$/.test(lastID)))
    throw new BridgeError('REQUEST', 'Invalid event cursor');
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' });
  res.flushHeaders();
  const epoch = randomUUID(); let sequence = 0; let stopped = false;
  let resolve!: () => void;
  const ended = new Promise<void>(done => { resolve = done; });
  const timers: NodeJS.Timeout[] = [];
  const work = new Set<Promise<unknown>>();
  let removeAgent: (() => void) | undefined;
  let removeTimeline: PaseoAgentTimelineSubscription | undefined;
  let releaseAgents: (() => Promise<void>) | undefined;
  function stop() {
    if (stopped) return;
    stopped = true; timers.forEach(clearTimeout); res.off('close', stop);
    removeAgent?.(); removeTimeline?.(); resolve();
    if (!res.destroyed) res.end();
  }
  res.once('close', stop);
  function write(value: string) {
    if (stopped || res.destroyed) return;
    if (res.writableLength + Buffer.byteLength(value) > 2 * frameLimit) { res.destroy(); stop(); return; }
    res.write(value);
  }
  function send(event: StreamEvent) {
    if (stopped) return;
    const parsed = streamEventSchema.safeParse(event);
    if (!parsed.success) throw new BridgeError('RESPONSE', 'Invalid upstream event', 502);
    const data = JSON.stringify(parsed.data);
    if (Buffer.byteLength(data) > frameLimit) {
      if (event.kind === 'activity' || event.kind === 'update') {
        send({ kind: 'resync', reason: 'Activity event exceeds stream limit; use the bounded REST activity query' }); return;
      }
      throw new BridgeError('RESPONSE_LIMIT', 'Event exceeds stream limit', 502);
    }
    write(`id: ${epoch}:${++sequence}\nevent: ${event.kind}\ndata: ${data}\n\n`);
  }
  function fail(error: unknown) {
    const value = publicError(error);
    try { send({ kind: 'error', error: { code: value.code, message: value.message } }); }
    finally { stop(); }
  }
  function track(task: Promise<unknown>) {
    if (work.size >= 32) {
      void task.catch(() => {});
      fail(new BridgeError('CAPACITY', 'Observation processing capacity exhausted', 503)); return;
    }
    work.add(task);
    void task.catch(fail).finally(() => work.delete(task));
  }
  function sameConnection() {
    if (service.hosts.get(input.host) === connection) return true;
    send({ kind: 'resync', reason: 'Host configuration replaced' }); stop(); return false;
  }
  let refreshing = false; let dirty = false; let activityDirty = includeActivity; let timelineReady = !includeActivity;
  let previousState = connection.state(); let previousSnapshot = JSON.stringify(initial);
  async function refresh() {
    dirty = true;
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      do {
        dirty = false;
        const hosts = await authorize();
        if (!sameConnection()) return;
        const state = connection.state();
        if (state !== previousState) {
          send({ kind: 'connection', state });
          if (state === 'connected') { send({ kind: 'resync', reason: 'Upstream reconnected; refresh history' }); activityDirty = includeActivity; }
          previousState = state;
        }
        if (state !== 'connected') continue;
        const snapshot = await service.snapshot(input, hosts);
        await authorize();
        if (!sameConnection()) return;
        if (connection.state() !== 'connected') { dirty = true; continue; }
        // fetchedAt changes on each read, but is not a substantive state update.
        const comparable = (s: Snapshot) => JSON.stringify({ agent: s.agent, result: s.result });
        if (previousSnapshot !== comparable(snapshot)) { send({ kind: 'snapshot', ...snapshot }); previousSnapshot = comparable(snapshot); }
        if (includeActivity && timelineReady && activityDirty && !stopped) {
          activityDirty = false;
          const activity = await service.execute({ ...input, op: 'activity', tail: 20 }, hosts) as { timeline: StreamEvent & unknown };
          await authorize();
          if (!sameConnection()) return;
          send({ kind: 'activity', host: input.host, agentId: input.agent!, timeline: activity.timeline as any });
        }
      } while (dirty && !stopped);
    } finally { refreshing = false; }
  }
  try {
    if (lastID) send({ kind: 'resync', reason: 'No durable replay; fresh snapshot follows' });
    send({ kind: 'snapshot', ...initial });
    previousSnapshot = JSON.stringify({ agent: initial.agent, result: initial.result });
    send({ kind: 'connection', state: previousState });
    removeAgent = connection.api.agents.subscribe(update => {
      if (update.kind === 'upsert' && update.agent.id === input.agent) track(refresh());
      else if (update.kind === 'remove' && update.agentId === input.agent) fail(new BridgeError('AGENT', 'Agent removed', 404));
    });
    const pending = connection.api.agents.list({ page: { limit: 200 }, subscribe: {}, timeout: 15000 }).then(value => {
      const release = () => value.subscription.release();
      if (stopped) return release();
      releaseAgents = release;
    });
    track(deadline(pending, 15000));
    // Account for late subscription establishment until its cleanup settles.
    work.add(pending); void pending.catch(() => {}).finally(() => work.delete(pending));
    if (includeActivity) {
      removeTimeline = connection.api.agents.ref(input.agent!).timeline.subscribe(update => {
        if (update.agentId !== input.agent) return;
        track(authorize().then(() => {
          if (stopped || !sameConnection()) return;
          if (update.event.type === 'error') throw new BridgeError('UPSTREAM', 'Activity subscription failed', 502);
          if (update.event.type === 'replacement' || update.event.type === 'subscription_restored')
            send({ kind: 'resync', reason: 'Timeline changed or subscription restored; refresh history' });
          else send({ kind: 'update', host: input.host, agentId: input.agent!, update: update as any });
          activityDirty = true; return refresh();
        }));
      });
      track(deadline(removeTimeline.ready.then(() => {
        if (stopped) return;
        timelineReady = true; activityDirty = true; return refresh();
      }), 15000));
    }
    let checking = false;
    timers.push(setInterval(() => {
      if (checking || stopped) return;
      checking = true;
      track(authorize().then(() => write(': heartbeat\n\n')).finally(() => { checking = false; }));
    }, options.heartbeatMs ?? 10000));
    timers.push(setInterval(() => track(refresh()), options.snapshotMs ?? 2000));
    timers.push(setTimeout(stop, options.lifetimeMs ?? 60000));
    track(refresh());
    await ended;
  } catch (error) { fail(error); }
  finally {
    stop();
    await deadline(Promise.allSettled([...work]), 15000).catch(() => {});
    if (releaseAgents) await deadline(releaseAgents(), 5000).catch(() => {});
  }
}
