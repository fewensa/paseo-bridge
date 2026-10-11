import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { privateKey, publicRaw, shared, seal, unseal, fingerprint } from '../src/e2ee/crypto.js';
import { ReplayGuard } from '../src/e2ee/replay.js';
import http from 'node:http';
import { jsonRequest } from '../src/api/client-transport.js';
import { listen, closeServer } from '../src/api/server.js';
import { directory } from './fixtures.js';

test('pinned X25519 peers authenticate both directions and every routing/frame field', () => {
  const a = privateKey(randomBytes(32).toString('base64')); const b = privateKey(randomBytes(32).toString('base64'));
  const secret = shared(a, publicRaw(b).toString('base64'));
  assert.deepEqual(secret, shared(b, publicRaw(a).toString('base64')));
  const context = { v: 1 as const, host: 'birch', client: fingerprint(publicRaw(a)), id: randomUUID(), expires: Date.now() + 90000, op: 'send' as const };
  const marker = 'synthetic-private-prompt'; const packet = seal(secret, context, 'request', 0, { prompt: marker });
  assert(!JSON.stringify(packet).includes(marker)); assert.deepEqual(unseal(secret, packet, 'request'), { prompt: marker });
  for (const patch of [{ host: 'aspen' }, { client: 'a'.repeat(64) }, { id: randomUUID() }, { expires: context.expires + 1 }, { op: 'activity' }, { kind: 'chunk' }, { seq: 1 }, { data: Buffer.alloc(32).toString('base64') }])
    assert.throws(() => unseal(secret, { ...packet, ...patch }, 'request'));
  assert.throws(() => unseal(randomBytes(32), packet, 'request'));
  const reply = seal(secret, context, 'headers', 0, { status: 202 });
  assert.deepEqual(unseal(secret, reply, 'response'), { status: 202 });
  assert.throws(() => unseal(secret, reply, 'request'));
  assert.notEqual(packet.nonce, seal(secret, context, 'request', 0, {}).nonce);
});

test('durable replay guard rejects duplicate requests across restart and concurrent claims', async () => {
  const file = join(await directory(), 'replays.json'); const expiry = Date.now() + 90000;
  const guard = new ReplayGuard(file); await guard.claim('client:request', expiry);
  await assert.rejects(new ReplayGuard(file).claim('client:request', expiry), { code: 'E2EE_REPLAY' });
  const attempts = await Promise.allSettled([guard.claim('client:second', expiry), guard.claim('client:second', expiry)]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  await assert.rejects(guard.claim('client:expired', Date.now() - 1), { code: 'E2EE_REPLAY' });
});

test('encrypted JSON rejects missing end, truncation, reorder, duplicate and metadata substitution before exposing accepted', async () => {
  const clientKey = privateKey(randomBytes(32).toString('base64'));
  const hostKey = privateKey(randomBytes(32).toString('base64'));
  const secret = shared(hostKey, publicRaw(clientKey).toString('base64'));
  for (const mode of ['valid', 'missing-end', 'truncated', 'reorder', 'duplicate', 'wrong-host', 'tampered']) {
    let wire = '';
    const server = http.createServer(async (req, res) => {
      for await (const item of req) wire += item;
      const context = JSON.parse(wire);
      const input = unseal(secret, context, 'request');
      assert(input.path.includes('agent-1'));
      assert(!wire.includes('secret-long-prompt-marker'));
      const body = Buffer.from(JSON.stringify({ ok: true, data: { host: 'birch', agentId: 'agent-1', requestId: randomUUID(), status: 'accepted' } }));
      const frames = [seal(secret, context, 'headers', 0, { status: 202, contentType: 'application/json' }),
        seal(secret, context, 'chunk', 1, { data: body.toString('base64') }), seal(secret, context, 'end', 2, { frames: 2, bytes: body.length })];
      if (mode === 'missing-end') frames.pop();
      if (mode === 'reorder') [frames[0], frames[1]] = [frames[1], frames[0]];
      if (mode === 'duplicate') frames.splice(2, 0, frames[1]);
      if (mode === 'wrong-host') frames[1].host = 'aspen';
      if (mode === 'tampered') frames[1].data = Buffer.alloc(64).toString('base64');
      let output = frames.map(x => JSON.stringify(x)).join('\n') + '\n';
      if (mode === 'truncated') output = output.slice(0, -5);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.end(output);
    });
    await listen(server, 0, '127.0.0.1');
    const transport = { module: http, options: { hostname: '127.0.0.1', port: (server.address() as { port: number }).port }, prefix: '',
      e2ee: { key: clientKey, client: fingerprint(publicRaw(clientKey)), hosts: { birch: publicRaw(hostKey).toString('base64') } } };
    try {
      const result = jsonRequest(transport, '/api/v1/hosts/birch/agents/agent-1/messages', { body: { prompt: 'secret-long-prompt-marker', interrupt: false } });
      if (mode === 'valid') assert.equal((await result).status, 'accepted'); else await assert.rejects(result);
    } finally { await closeServer(server); }
  }
});
