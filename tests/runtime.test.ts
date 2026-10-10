import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { runServer } from '../src/runtime.js';
import { directory, secret, fixture } from './fixtures.js';

test('shutdown waits for reload and never starts a replacement after stop', async () => {
  const dir = await directory(); const file = join(dir, 'bridge.json');
  await secret(file, { version: 1, hosts: { birch: { connectionFile: join(dir, 'credential') } }, socket: join(dir, 'socket'), stateDir: dir });
  const old = fixture().connection; const next = fixture().connection;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let closing!: () => void; const closeStarted = new Promise<void>(resolve => { closing = resolve; });
  old.close = async () => { closing(); await gate; };
  let starts = 0; let closes = 0;
  next.start = async () => { starts++; }; next.close = async () => { closes++; };
  let builds = 0;
  const runtime = await runServer(file, async () => new Map([['birch', ++builds === 1 ? old : next]]));
  const reloading = runtime.reload(); await closeStarted;
  const stopping = runtime.stop(); release();
  await reloading; await stopping;
  assert.equal(starts, 0); assert.equal(closes, 1);
});
