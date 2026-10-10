import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeService, requestSchema } from '../src/service.js';
import { fixture } from './fixtures.js';
const request = (value: object) => requestSchema.parse(value);

test('aggregation, pagination and host labels', async () => {
  const a = fixture(); a.state.pages = true;
  const b = fixture();
  const service = new BridgeService(new Map([['birch', a.connection], ['aspen', b.connection]]));
  const result = await service.execute(request({ op: 'agents', host: 'all' })) as any;
  assert.equal(result.partial, false); assert.equal(result.results.length, 2);
  assert.equal(result.results[0].host, 'birch'); assert.equal(result.results[0].entries.length, 2);
});
test('partial failure is explicit and sanitized', async () => {
  const a = fixture(); const b = fixture(); b.state.listError = true;
  const service = new BridgeService(new Map([['birch', a.connection], ['aspen', b.connection]]));
  const result = await service.execute(request({ op: 'agents', host: 'all' })) as any;
  assert.equal(result.partial, true); assert.equal(result.results[1].error.code, 'INTERNAL');
  assert(!JSON.stringify(result).includes('pair-link-secret'));
});
test('offline host and unknown host', async () => {
  const a = fixture(); a.state.online = false;
  const service = new BridgeService(new Map([['birch', a.connection]]));
  const result = await service.execute(request({ op: 'workspaces', host: 'all' })) as any;
  assert.equal(result.results[0].error.code, 'OFFLINE');
  await assert.rejects(service.execute(request({ op: 'status', host: 'aspen' })), { code: 'HOST' });
});
test('busy sends rejected; explicit interrupt accepted', async () => {
  const a = fixture(); a.state.status = 'running'; const service = new BridgeService(new Map([['birch', a.connection]]));
  await assert.rejects(service.execute(request({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello' })), { code: 'BUSY' });
  assert.equal(a.state.sends.length, 0);
  await service.execute(request({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello', interrupt: true }));
  assert.equal((a.state.sends[0] as any).options.activeTurnBehavior, 'interrupt');
});
test('idle sends accepted without implicit interruption and ambiguous send not retried', async () => {
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection]]));
  const input = request({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello' });
  const result = await service.execute(input) as any;
  assert.equal(result.status, 'accepted'); assert(result.requestId);
  assert.equal((a.state.sends[0] as any).options.activeTurnBehavior, 'steer');
  a.state.sendError = true;
  const failed = await service.execute(input) as any;
  assert.equal(failed.status, 'unknown'); assert.equal(failed.retrySafe, false); assert.equal(a.state.sends.length, 2);
  assert(!JSON.stringify(failed).includes('must-not-leak'));
});
test('scoped all query never exposes other hosts', async () => {
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection], ['aspen', a.connection]]));
  const result = await service.execute(request({ op: 'status', host: 'all' }), new Set(['aspen'])) as any;
  assert.deepEqual(result.results.map((x: any) => x.host), ['aspen']);
  await assert.rejects(service.execute(request({ op: 'status', host: 'birch' }), new Set(['aspen'])), { code: 'FORBIDDEN' });
});
test('activity tail zero and wait', async () => {
  const a = fixture(); const service = new BridgeService(new Map([['birch', a.connection]]));
  const zero = await service.execute(request({ op: 'activity', host: 'birch', agent: 'agent-1', tail: 0 })) as any;
  assert.deepEqual(zero.entries, []);
  const activity = await service.execute(request({ op: 'activity', host: 'birch', agent: 'agent-1' })) as any;
  assert.equal(activity.timeline.entries[0].item.text, 'received');
  const waited = await service.execute(request({ op: 'wait', host: 'birch', agent: 'agent-1' })) as any;
  assert.equal(waited.result.lastMessage, 'received');
});
test('concurrent sends guarded and timeout stays unknown without retry', async () => {
  const a = fixture(); let release!: () => void; a.state.sendGate = new Promise<void>(resolve => { release = resolve; });
  const service = new BridgeService(new Map([['birch', a.connection]]), 50);
  const input = request({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello' });
  const first = service.execute(input);
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(service.execute(input), { code: 'BUSY' });
  const result = await first as any; assert.equal(result.status, 'unknown'); assert.equal(a.state.sends.length, 1);
  await assert.rejects(service.execute(input), { code: 'BUSY' });
  release(); a.state.sendGate = undefined;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.execute(input) as any).status, 'accepted');
});
test('send guard covers the refresh preflight, preventing stale simultaneous snapshots', async () => {
  const a = fixture(); let release!: () => void;
  a.state.refreshGate = new Promise<void>(resolve => { release = resolve; });
  const service = new BridgeService(new Map([['birch', a.connection]]));
  const input = request({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello' });
  const first = service.execute(input); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.execute(input), { code: 'BUSY' }); assert.equal(a.state.refreshes, 1);
  release(); assert.equal((await first as any).status, 'accepted'); assert.equal(a.state.sends.length, 1);
  a.state.status = 'running';
  await assert.rejects(service.execute(input), { code: 'BUSY' });
});
test('query timeout is isolated and repeated cursors rejected', async () => {
  const a = fixture(); const b = fixture();
  a.connection.api.agents.list = async () => new Promise(() => {});
  const service = new BridgeService(new Map([['birch', a.connection], ['aspen', b.connection]]), 20);
  const result = await service.execute(request({ op: 'agents', host: 'all' })) as any;
  assert.equal(result.partial, true); assert.equal(result.results[0].error.code, 'TIMEOUT'); assert.equal(result.results[1].entries.length, 1);
  a.connection.api.agents.list = (async () => ({ requestId: 'test', entries: [], pageInfo: { nextCursor: 'same', prevCursor: null, hasMore: true } })) as unknown as typeof a.connection.api.agents.list;
  const repeated = await service.execute(request({ op: 'agents', host: 'birch' })) as any;
  assert.equal(repeated.results[0].error.code, 'PAGINATION');
});
test('aggregate query budget fails explicitly', async () => {
  const a = fixture();
  a.connection.api.agents.list = (async () => ({ requestId: 'test', entries: Array.from({ length: 10001 }, () => ({ agent: { id: 'x' } })), pageInfo: { nextCursor: null, prevCursor: null, hasMore: false } })) as unknown as typeof a.connection.api.agents.list;
  const service = new BridgeService(new Map([['birch', a.connection]]));
  const result = await service.execute(request({ op: 'agents', host: 'all' })) as any;
  assert.equal(result.partial, true); assert.equal(result.results[0].error.code, 'RESULT_LIMIT');
});
test('wait timeout result remains observable', async () => {
  const a = fixture(); a.state.waitStatus = 'timeout';
  const service = new BridgeService(new Map([['birch', a.connection]]));
  assert.equal((await service.execute(request({ op: 'wait', host: 'birch', agent: 'agent-1' })) as any).result.status, 'timeout');
});
test('strict request validation rejects broadcasts, extra fields and invalid limits', () => {
  for (const value of [
    { op: 'send', host: 'all', agent: 'x', prompt: 'hello' },
    { op: 'send', host: 'birch', agent: 'x', prompt: ' ' },
    { op: 'wait', host: 'birch', agent: 'x', timeout: 601 },
    { op: 'status', host: 'all', password: 'secret' },
    { op: 'activity', host: 'birch', agent: 'x', tail: -1 },
    { op: 'status', host: 'all', interrupt: true }
  ]) assert.equal(requestSchema.safeParse(value).success, false);
});
