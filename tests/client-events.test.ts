import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { call } from '../src/api/client.js';
import { EventParser } from '../src/api/event-parser.js';
import { clientSchema } from '../src/config.js';
import { requestSchema } from '../src/service.js';
import { directory, secret, fixture } from './fixtures.js';
const exec = promisify(execFile);
const data = fixture(); const agent = data.agent;
const ack = { host: 'birch', agentId: 'agent-1', requestId: '12345678-1234-4234-8234-123456789abc' };
const aggregate = (entries?: unknown[]) => ({ results: [{ host: 'birch', fetchedAt: new Date().toISOString(), ...(entries ? { entries } : { state: 'connected' }) }], partial: false });
const snapshot = (terminal = true) => ({ kind: 'snapshot', host: 'birch', agentId: 'agent-1', fetchedAt: new Date().toISOString(), agent,
  ...(terminal ? { result: { status: 'idle', final: agent, error: null, lastMessage: null } } : {}) });
const wait = requestSchema.parse({ op: 'wait', host: 'birch', agent: 'agent-1', timeout: 1 });
async function mock(handler: RequestListener) {
  const dir = await directory(); const socket = join(dir, 'sock'); const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(socket, resolve));
  const config = clientSchema.parse({ version: 1, defaultProfile: 'local', profiles: { local: { kind: 'local', socket } } });
  return { config, dir, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
function event(value: unknown, id?: string) { return `${id ? `id: ${id}\n` : ''}event: snapshot\ndata: ${JSON.stringify(value)}\n\n`; }

test('SSE parser handles byte segmentation, UTF-8, CRLF, comments and multi-line data', () => {
  const frames: any[] = []; const parser = new EventParser(frame => frames.push(frame));
  for (const byte of Buffer.from(': heartbeat\r\nevent: snapshot\r\nid: abc\r\ndata: {"text":\r\ndata: "🌳"}\r\n\r\n')) parser.push(Buffer.from([byte]));
  parser.end(); assert.deepEqual(frames, [{ event: 'snapshot', id: 'abc', data: '{"text":\n"🌳"}' }]);
});
test('SSE parser bounds frames including comments and rejects malformed UTF-8', () => {
  assert.throws(() => new EventParser(() => {}, 8).push(Buffer.from(':123456789')), { code: 'RESPONSE_LIMIT' });
  const parser = new EventParser(() => {}); parser.push(Buffer.from([0xc3]));
  assert.throws(() => parser.end(), { code: 'RESPONSE' });
});
test('default SSE reconnects read-only with Last-Event-ID and fresh terminal snapshot', async () => {
  let requests = 0; const id = '12345678-1234-1234-1234-123456789abc:1';
  const server = await mock((req, res) => {
    assert.equal(req.url, '/api/v1/hosts/birch/agents/agent-1/events'); assert.equal(req.method, 'GET');
    assert.equal(req.headers.accept, 'text/event-stream'); requests++;
    if (requests > 1) assert.equal(req.headers['last-event-id'], id);
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(event(snapshot(requests > 1), id));
  });
  try { const result = await call(server.config, undefined, wait); assert.equal(result.result.status, 'idle'); assert.equal(requests, 2); }
  finally { await server.close(); }
});
test('stream end, disconnected and recoverable 503 do not terminate wait; overall deadline stays fixed', async () => {
  let requests = 0; const server = await mock((_req, res) => {
    requests++;
    if (requests === 1) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'OFFLINE', message: 'private' } })); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: connection\ndata: {"kind":"connection","state":"disconnected"}\n\n' + event(snapshot(false))); }
  });
  const start = Date.now();
  try { const result = await call(server.config, undefined, wait); assert.equal(result.result.status, 'timeout'); assert.equal(result.result.final.id, 'agent-1'); assert(requests > 1); assert(Date.now() - start < 1800); }
  finally { await server.close(); }
});
test('deadline aborts a hanging handshake and hanging stream', async () => {
  for (const headers of [false, true]) {
    let closed = false; const server = await mock((req, res) => { req.on('close', () => { closed = true; }); if (headers) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': heartbeat\n\n'); } });
    try { assert.equal((await call(server.config, undefined, wait)).result.status, 'timeout'); await new Promise(resolve => setTimeout(resolve, 20)); assert(closed); }
    finally { await server.close(); }
  }
});
test('auth, non-SSE, redirects, malformed events and archived snapshots fail without retry or fallback', async () => {
  const cases = [
    { status: 401, type: 'application/json', body: '{"ok":false,"error":{"code":"AUTH","message":"secret-token"}}', code: 'AUTH' },
    { status: 403, type: 'application/json', body: '{"ok":false,"error":{"code":"FORBIDDEN","message":"secret-token"}}', code: 'FORBIDDEN' },
    { status: 200, type: 'application/json', body: '{}', code: 'RESPONSE' },
    { status: 302, type: 'text/html', body: '', code: 'REDIRECT' },
    { status: 200, type: 'text/event-stream', body: 'event: snapshot\ndata: {oops}\n\n', code: 'RESPONSE' },
    { status: 200, type: 'text/event-stream', body: event({ ...snapshot(), result: { status: 'made-up' } }), code: 'RESPONSE' },
    { status: 200, type: 'text/event-stream', body: event({ ...snapshot(), agent: { ...agent, archivedAt: '2026-01-01' } }), code: 'AGENT' },
    { status: 200, type: 'text/event-stream', body: 'event: connection\ndata: {"kind":"snapshot"}\n\n', code: 'RESPONSE' }
  ];
  for (const item of cases) {
    let requests = 0; const server = await mock((_req, res) => { requests++; res.writeHead(item.status, { 'content-type': item.type }); res.end(item.body); });
    try { await assert.rejects(call(server.config, undefined, wait), (error: any) => error.code === item.code && !error.message.includes('secret-token')); assert.equal(requests, 1); }
    finally { await server.close(); }
  }
});
test('first terminal event wins even when another snapshot arrives in the same chunk', async () => {
  const server = await mock((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(event(snapshot()) + event(snapshot(false))); });
  try { assert.equal((await call(server.config, undefined, wait)).result.status, 'idle'); }
  finally { await server.close(); }
});
test('poll observes a later error result without turning it into a send failure', async () => {
  let requests = 0; const server = await mock((_req, res) => {
    requests++; const value = snapshot(false);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: requests === 1 ? value : { ...value, agent: { ...agent, status: 'error' }, result: { status: 'error', final: { ...agent, status: 'error' }, error: 'agent failed', lastMessage: null } } }));
  });
  try { assert.equal((await call(server.config, undefined, { ...wait, timeout: 4 }, { waitMode: 'poll' })).result.status, 'error'); assert.equal(requests, 2); }
  finally { await server.close(); }
});
test('poll uses snapshot GET and keeps business result output', async () => {
  const server = await mock((req, res) => { assert.equal(req.url, '/api/v1/hosts/birch/agents/agent-1'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: snapshot() })); });
  try { assert.equal((await call(server.config, undefined, wait, { waitMode: 'poll' })).result.lastMessage, null); }
  finally { await server.close(); }
});
test('REST routes and send body contain no legacy request fields; ambiguous send never retries', async () => {
  const paths: string[] = []; let sends = 0;
  const server = await mock((req, res) => {
    paths.push(req.url!);
    if (req.method === 'POST') {
      sends++; let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        assert.deepEqual(JSON.parse(body), { prompt: 'test-only', interrupt: false }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('malformed');
      });
    } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: req.url?.includes('/activity') ? { host: 'birch', agentId: 'agent-1', fetchedAt: new Date().toISOString(), timeline: data.timeline() } : aggregate(req.url?.startsWith('/api/v1/agents') ? [agent] : req.url?.startsWith('/api/v1/workspaces') ? [data.workspace] : undefined) })); }
  });
  try {
    for (const input of [{ op: 'status', host: 'all' }, { op: 'status', host: 'birch' }, { op: 'agents', host: 'all' }, { op: 'workspaces', host: 'birch' }, { op: 'activity', host: 'birch', agent: 'agent-1', tail: 5 }]) await call(server.config, undefined, requestSchema.parse(input));
    await assert.rejects(call(server.config, undefined, requestSchema.parse({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'test-only' })), /send outcome may be unknown; do not retry automatically/);
    assert.equal(sends, 1); assert.deepEqual(paths, ['/api/v1/hosts', '/api/v1/hosts/birch', '/api/v1/agents?host=all', '/api/v1/workspaces?host=birch', '/api/v1/hosts/birch/agents/agent-1/activity?tail=5', '/api/v1/hosts/birch/agents/agent-1/messages']);
  } finally { await server.close(); }
});
test('send acknowledgements preserve accepted/unknown semantics and errors are sanitized', async () => {
  for (const item of [
    { status: 202, envelope: { ok: true, data: { ...ack, status: 'accepted' } }, expected: 'accepted' },
    { status: 200, envelope: { ok: true, data: { ...ack, status: 'unknown', retrySafe: false } }, expected: 'unknown' },
    { status: 202, envelope: { ok: true, data: { status: 'accepted' } }, expected: 'RESPONSE' },
    { status: 202, envelope: { ok: true, data: { ...ack, host: 'aspen', status: 'accepted' } }, expected: 'RESPONSE' },
    { status: 202, envelope: { ok: true, data: { ...ack, agentId: 'agent-2', status: 'accepted' } }, expected: 'RESPONSE' },
    { status: 202, envelope: { ok: true, data: { ...ack, requestId: 'invalid', status: 'accepted' } }, expected: 'RESPONSE' },
    { status: 200, envelope: { ok: true, data: { status: 'accepted' } }, expected: 'RESPONSE' },
    { status: 500, envelope: { ok: false, error: { code: 'INTERNAL', message: 'must-not-leak' } }, expected: 'INTERNAL' }
  ]) {
    let requests = 0; const server = await mock((_req, res) => { requests++; res.writeHead(item.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(item.envelope)); });
    try {
      const request = requestSchema.parse({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'test-only' });
      if (['accepted', 'unknown'].includes(item.expected)) assert.equal((await call(server.config, undefined, request)).status, item.expected);
      else await assert.rejects(call(server.config, undefined, request), (error: any) => error.code === item.expected && error.message.includes('do not retry automatically') && !error.message.includes('must-not-leak'));
      assert.equal(requests, 1);
    } finally { await server.close(); }
  }
});
test('CLI defaults to SSE, supports explicit poll, and rejects misplaced/invalid wait modes', async () => {
  const paths: string[] = []; const server = await mock((req, res) => {
    paths.push(req.url!);
    if (req.url?.endsWith('/events')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(event(snapshot())); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: snapshot() })); }
  });
  const file = join(server.dir, 'client.json'); await secret(file, server.config);
  try {
    for (const mode of [[], ['--wait-mode', 'poll']]) {
      const output = await exec(process.execPath, ['dist/cli.js', '--config', file, 'wait', '--host', 'birch', '--agent', 'agent-1', ...mode]); assert.equal(JSON.parse(output.stdout).result.status, 'idle');
    }
    for (const args of [['status', '--wait-mode', 'poll'], ['wait', '--wait-mode', 'invalid']]) await assert.rejects(exec(process.execPath, ['dist/cli.js', '--config', file, ...args]), (error: any) => error.code === 1 && JSON.parse(error.stderr).error.code === 'USAGE');
    assert.deepEqual(paths, ['/api/v1/hosts/birch/agents/agent-1/events', '/api/v1/hosts/birch/agents/agent-1']);
  } finally { await server.close(); }
});
test('query clients reject incomplete, malformed and wrong-target shared-contract results', async () => {
  for (const [input, response] of [
    [{ op: 'status', host: 'all' }, {}], [{ op: 'agents', host: 'all' }, {}],
    [{ op: 'workspaces', host: 'all' }, {}], [{ op: 'activity', host: 'birch', agent: 'agent-1' }, {}],
    [{ op: 'status', host: 'aspen' }, aggregate()],
    [{ op: 'agents', host: 'birch' }, aggregate([{ id: 'agent-1' }])],
    [{ op: 'workspaces', host: 'birch' }, aggregate([{ id: 'wks-1' }])],
    [{ op: 'activity', host: 'birch', agent: 'agent-1' }, { host: 'aspen', agentId: 'agent-1', entries: [] }],
    [{ op: 'activity', host: 'birch', agent: 'agent-1' }, { host: 'birch', agentId: 'agent-2', entries: [] }],
    [{ op: 'activity', host: 'birch', agent: 'agent-1' }, { host: 'birch', agentId: 'agent-1', fetchedAt: new Date().toISOString(), timeline: { ...data.timeline(), agentId: 'agent-2' } }]
  ] as const) {
    let requests = 0; const server = await mock((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: response })); });
    try { await assert.rejects(call(server.config, undefined, requestSchema.parse(input)), { code: 'RESPONSE' }); assert.equal(requests, 1); }
    finally { await server.close(); }
  }
});
test('SSE OFFLINE error reconnects observation only; state text and wrong-target terminal snapshots are rejected', async () => {
  let requests = 0; const server = await mock((_req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(requests === 1 ? 'event: error\ndata: {"kind":"error","error":{"code":"OFFLINE","message":"private"}}\n\n' : event(snapshot()));
  });
  try { assert.equal((await call(server.config, undefined, wait)).result.status, 'idle'); assert.equal(requests, 2); }
  finally { await server.close(); }
  for (const response of [{ ...snapshot(), result: { ...snapshot().result, lastMessage: 'timeline leak' } }, { ...snapshot(), agent: { ...agent, id: 'agent-2' } }, { ...snapshot(), result: { ...snapshot().result, final: { ...agent, id: 'agent-2' } } }]) {
    const invalid = await mock((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(event(response)); });
    try { await assert.rejects(call(invalid.config, undefined, wait), { code: 'RESPONSE' }); }
    finally { await invalid.close(); }
  }
});
