import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeService, requestSchema } from '../src/service.js';
import { SubmissionGuards, inspectSubmission, clearSubmission } from '../src/submissions.js';
import { serverSchema } from '../src/config.js';
import { directory, fixture, secret } from './fixtures.js';
const input = requestSchema.parse({ op: 'send', host: 'birch', agent: 'agent-1', prompt: 'hello' });
const exec = promisify(execFile);

test('SDK rejection after public timeout remains quarantined across service restart', async () => {
  const dir = await directory(); const a = fixture(); let reject!: (error: Error) => void;
  a.state.sendGate = new Promise<void>((_, fail) => { reject = fail; });
  const service = new BridgeService(new Map([['birch', a.connection]]), 200, dir);
  const result = await service.execute(input) as any; assert.equal(result.status, 'unknown');
  reject(new Error('SDK timed out or disconnected after possible delivery'));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(service.execute(input), { code: 'SEND_UNCERTAIN' });
  const next = new BridgeService(new Map([['birch', a.connection]]), 1000, dir);
  await assert.rejects(next.execute(input), { code: 'SEND_UNCERTAIN' }); assert.equal(a.state.sends.length, 1);
  const config = serverSchema.parse({ version: 1, hosts: { birch: { connectionFile: join(dir, 'credential') } }, socket: join(dir, 'sock'), stateDir: dir });
  assert.equal((await inspectSubmission(config, 'birch', 'agent-1')).guard.requestId, result.requestId);
  await assert.rejects(clearSubmission(config, 'birch', 'agent-1', 'wrong-id'), { code: 'SUBMISSION' });
  await secret(config.socket, 'existing-path');
  await assert.rejects(clearSubmission(config, 'birch', 'agent-1', result.requestId), { code: 'STOP_REQUIRED' });
  config.socket = join(dir, 'stopped-socket');
  await clearSubmission(config, 'birch', 'agent-1', result.requestId);
  a.state.sendGate = undefined;
  assert.equal((await next.execute(input) as any).status, 'accepted');
  assert.equal(await new SubmissionGuards(dir).inspect('birch', 'agent-1'), undefined);
});
test('guard is durably prepared before dispatch and removed only on acceptance', async () => {
  const dir = await directory(); const a = fixture(); const guards = new SubmissionGuards(dir);
  const agent = a.connection.api.agents.ref('agent-1');
  agent.send = async (_text, options) => {
    assert.equal((await guards.inspect('birch', 'agent-1'))?.requestId, options?.messageId);
  };
  const service = new BridgeService(new Map([['birch', a.connection]]), 1000, dir);
  assert.equal((await service.execute(input) as any).status, 'accepted');
  assert.equal(await guards.inspect('birch', 'agent-1'), undefined);
});
test('local CLI clear requires explicit reconciliation and matching request ID', async () => {
  const dir = await directory(); const file = join(dir, 'config.json'); const id = 'bbd6a813-68ce-4a09-b4a2-d61f7cd68308';
  await secret(file, { version: 1, hosts: { birch: { connectionFile: join(dir, 'credential') } }, socket: join(dir, 'socket'), stateDir: dir });
  await new SubmissionGuards(dir).prepare('birch', 'agent-1', id);
  const inspected = await exec(process.execPath, ['dist/cli.js', '--config', file, 'admin', 'inspect-send', 'birch', '--agent', 'agent-1']);
  assert.equal(JSON.parse(inspected.stdout).guard.requestId, id);
  const args = ['dist/cli.js', '--config', file, 'admin', 'clear-send', 'birch', '--agent', 'agent-1', '--request-id', id];
  await assert.rejects(exec(process.execPath, args), (error: any) => error.code === 1 && JSON.parse(error.stderr).error.code === 'USAGE');
  const cleared = await exec(process.execPath, [...args, '--confirm-reconciled']); assert.equal(JSON.parse(cleared.stdout).reconciled, true);
});
