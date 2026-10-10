import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { apiServer, listen, closeServer } from '../src/api/server.js';
import { EventParser } from '../src/api/event-parser.js';
import { BridgeService } from '../src/service.js';
import { digest } from '../src/auth.js';
import { directory, fixture, secret } from './fixtures.js';
import { atomicSecret, type Operation } from '../src/config.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { const end = Date.now() + 1500; while (!check() && Date.now() < end) await sleep(10); assert(check()); }
async function setup(operations: Operation[] = ['wait', 'activity', 'status']) {
  const dir = await directory(); const auth = join(dir, 'auth.json'); const token = randomBytes(32).toString('base64url');
  const a = fixture(); a.state.status = 'running';
  const service = new BridgeService(new Map([['birch', a.connection]]));
  const grant = async (next: Operation[] = operations, hosts = ['birch']) => atomicSecret(auth, JSON.stringify({ version: 1, clients: { client: { digest: digest(token), hosts, operations: next } } }));
  await grant();
  const server = apiServer(service, auth, { heartbeatMs: 30, snapshotMs: 40, lifetimeMs: 1500 }); await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const controllers: AbortController[] = [];
  const get = (path: string) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
  async function stream(query = '', lastId?: string) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(base + '/hosts/birch/agents/agent-1/events' + query, { signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body!.getReader(); const events: any[] = []; let raw = '';
    const parser = new EventParser(frame => events.push({ ...JSON.parse(frame.data), cursor: frame.id }));
    async function next(check: (event: any) => boolean) {
      for (;;) {
        const found = events.findIndex(check); if (found >= 0) return events.splice(found, 1)[0];
        const timeout = setTimeout(() => controller.abort(), 1500);
        try {
          const chunk = await reader.read(); assert(!chunk.done, 'Stream ended before expected event');
          raw += Buffer.from(chunk.value).toString('utf8'); parser.push(chunk.value);
        } finally { clearTimeout(timeout); }
      }
    }
    return { next, events, reader, controller, raw: () => raw };
  }
  return { ...a, service, get, grant, stream, auth, close: async () => { controllers.forEach(value => value.abort()); await closeServer(server); } };
}
test('state-only SSE provides initial/fresh snapshots and heartbeat without activity access; disconnect cleans subscriptions', async () => {
  const s = await setup(['wait']);
  try {
    const stream = await s.stream(); const first = await stream.next(e => e.kind === 'snapshot'); assert.equal(first.agent.status, 'running');
    assert.equal(s.state.timelineSubscriptions, 0);
    await sleep(40); s.state.status = 'idle'; s.emitAgent();
    const terminal = await stream.next(e => e.kind === 'snapshot' && e.result?.status === 'idle'); assert.equal(terminal.result.lastMessage, null);
    assert(stream.raw().includes(': heartbeat')); assert(!stream.events.some(e => e.kind === 'activity' || e.kind === 'update'));
    stream.controller.abort(); await until(() => s.state.subscriptions === 0); assert.equal(s.state.timelineSubscriptions, 0); assert.equal(s.state.sends.length, 0);
  } finally { await s.close(); }
});
test('activity opt-in requires both scopes and sends structured timeline updates; live scope/host changes terminate streams', async () => {
  const s = await setup(['wait']);
  try {
    assert.equal((await s.get('/hosts/birch/agents/agent-1/events?include=activity')).status, 403); assert.equal(s.state.subscriptions, 0);
    await s.grant(['wait', 'activity']); const stream = await s.stream('?include=activity');
    const activity = await stream.next(e => e.kind === 'activity'); assert.equal(activity.timeline.entries[0].item.text, 'received'); assert.equal(s.state.timelineSubscriptions, 1);
    s.emitTimeline({ agentId: 'other-agent', event: { type: 'turn_started', provider: 'codex' }, timestamp: new Date().toISOString() });
    s.emitTimeline({ agentId: 'agent-1', event: { type: 'turn_started', provider: 'codex' }, timestamp: new Date().toISOString() });
    const update = await stream.next(e => e.kind === 'update'); assert.equal(update.update.agentId, 'agent-1');
    await s.grant(['wait']); s.emitTimeline({ agentId: 'agent-1', event: { type: 'turn_started', provider: 'codex' }, timestamp: new Date().toISOString() });
    assert.equal((await stream.next(e => e.kind === 'error')).error.code, 'FORBIDDEN'); await until(() => s.state.subscriptions === 0 && s.state.timelineSubscriptions === 0);
    const stateStream = await s.stream(); await stateStream.next(e => e.kind === 'snapshot'); await s.grant(['wait'], ['other-host']);
    assert.equal((await stateStream.next(e => e.kind === 'error')).error.code, 'FORBIDDEN');
  } finally { await s.close(); }
});
test('revocation is live, and late upstream subscription establishment is released after observer disconnect', async () => {
  const s = await setup();
  try {
    const stream = await s.stream(); await stream.next(e => e.kind === 'snapshot');
    await atomicSecret(s.auth, JSON.stringify({ version: 1, clients: {} })); assert.equal((await stream.next(e => e.kind === 'error')).error.code, 'UNAUTHORIZED');
    await until(() => s.state.subscriptions === 0); await s.grant();
    let release!: () => void; s.state.subscriptionGate = new Promise(resolve => { release = resolve; });
    const late = await s.stream(); await late.next(e => e.kind === 'snapshot'); await until(() => s.state.subscriptions === 1);
    late.controller.abort(); await sleep(20); release(); await until(() => s.state.subscriptions === 0); assert(s.state.releases >= 2);
  } finally { await s.close(); }
});
test('Last-Event-ID explicitly resynchronizes without replay; offline/reconnect and replacement are observation-only', async () => {
  const s = await setup();
  try {
    const cursor = `${randomUUID()}:1`; const stream = await s.stream('', cursor);
    const resync = await stream.next(e => e.kind === 'resync'); assert(resync.reason.includes('No durable replay'));
    const snapshot = await stream.next(e => e.kind === 'snapshot'); assert.notEqual(snapshot.cursor.split(':')[0], cursor.split(':')[0]);
    s.state.online = false; await stream.next(e => e.kind === 'connection' && e.state === 'disconnected');
    s.state.online = true; await stream.next(e => e.kind === 'resync' && e.reason.includes('reconnected'));
    s.service.hosts.set('birch', fixture().connection); await stream.next(e => e.kind === 'resync' && e.reason.includes('replaced'));
    assert.equal(s.state.sends.length, 0);
    s.state.online = false; s.service.hosts.set('birch', s.connection); assert.equal((await s.get('/hosts/birch/agents/agent-1/events')).status, 503);
  } finally { await s.close(); }
});
test('SSE per-client capacity is reclaimed after disconnect and does not grow retained subscriptions', async () => {
  const s = await setup();
  try {
    const streams = [];
    for (let i = 0; i < 8; i++) { const stream = await s.stream(); await stream.next(e => e.kind === 'snapshot'); streams.push(stream); }
    assert.equal((await s.get('/hosts/birch/agents/agent-1/events')).status, 503);
    streams.forEach(stream => stream.controller.abort()); await until(() => s.state.subscriptions === 0);
    await sleep(20); const next = await s.stream(); await next.next(e => e.kind === 'snapshot'); next.controller.abort();
    await until(() => s.state.subscriptions === 0); assert.equal(s.state.timelineSubscriptions, 0);
  } finally { await s.close(); }
});
test('initial SSE acquisition rechecks revocation, host/wait scopes and connection identity before disclosing a snapshot', async () => {
  for (const change of ['revoke', 'host', 'wait', 'replace', 'offline']) {
    const s = await setup(); let release!: () => void;
    s.state.refreshGate = new Promise(resolve => { release = resolve; });
    try {
      const pending = s.get('/hosts/birch/agents/agent-1/events'); await until(() => s.state.refreshes === 1);
      if (change === 'revoke') await atomicSecret(s.auth, JSON.stringify({ version: 1, clients: {} }));
      if (change === 'host') await s.grant(['wait'], ['other-host']);
      if (change === 'wait') await s.grant(['activity']);
      if (change === 'replace') s.service.hosts.set('birch', fixture().connection);
      if (change === 'offline') s.state.online = false;
      release(); const response = await pending;
      assert.equal(response.status, change === 'revoke' ? 401 : ['host', 'wait'].includes(change) ? 403 : 503);
      const body = await response.json(); assert.equal(body.ok, false); assert.equal(body.data, undefined);
      assert.equal(s.state.subscriptions, 0); assert.equal(s.state.timelineSubscriptions, 0);
    } finally { release(); await s.close(); }
  }
});
test('initial activity waits for timeline readiness, refetches intervening history and cleans up late readiness', async () => {
  const s = await setup(); let ready!: () => void;
  s.state.timelineReadyGate = new Promise(resolve => { ready = resolve; });
  try {
    const stream = await s.stream('?include=activity'); await stream.next(e => e.kind === 'snapshot');
    await sleep(100); assert.equal(s.state.timelineReads, 0);
    s.state.timelineText = 'arrived before readiness without a live notification'; ready();
    const activity = await stream.next(e => e.kind === 'activity'); assert.equal(activity.timeline.entries[0].item.text, s.state.timelineText);
    stream.controller.abort(); await until(() => s.state.timelineSubscriptions === 0 && s.state.subscriptions === 0);
    let lateReady!: () => void; s.state.timelineReadyGate = new Promise(resolve => { lateReady = resolve; });
    const late = await s.stream('?include=activity'); await late.next(e => e.kind === 'snapshot'); late.controller.abort();
    await until(() => s.state.timelineSubscriptions === 0); const reads = s.state.timelineReads;
    lateReady(); await sleep(60); assert.equal(s.state.timelineReads, reads); assert.equal(s.state.sends.length, 0);
  } finally { ready(); await s.close(); }
});
test('queued timeline callbacks never emit old-connection updates after host replacement', async () => {
  const s = await setup();
  try {
    const stream = await s.stream('?include=activity'); await stream.next(e => e.kind === 'activity');
    s.emitTimeline({ agentId: 'agent-1', event: { type: 'turn_started', provider: 'codex' }, timestamp: new Date().toISOString() });
    s.service.hosts.set('birch', fixture().connection);
    await stream.next(e => e.kind === 'resync' && e.reason.includes('replaced'));
    assert(!stream.events.some(e => e.kind === 'update')); assert(!stream.raw().includes('event: update'));
    await until(() => s.state.subscriptions === 0 && s.state.timelineSubscriptions === 0); assert.equal(s.state.sends.length, 0);
  } finally { await s.close(); }
});
