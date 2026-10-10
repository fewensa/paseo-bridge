import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig, clientSchema, serverSchema, operations } from '../config.js';
import { requestSchema } from '../service.js';
import { call } from '../api/client.js';
import { importHost, issueToken, revokeToken, verifyPersistence } from '../admin.js';
import { inspectSubmission, clearSubmission } from '../submissions.js';
import { BridgeError, publicError } from '../errors.js';

const help = `paseo-bridge [--config FILE] [--profile NAME] COMMAND [OPTIONS]

Queries: status | agents | workspaces [--host NAME|all]
Actions: send --host NAME --agent ID --prompt-file FILE [--interrupt]
         activity --host NAME --agent ID [--tail 20]
         wait --host NAME --agent ID [--timeout 120] [--wait-mode sse|poll]
All commands print JSON. Send never waits or retries. Partial results exit 2.

Local administration (use --config SERVER.json):
  admin import-host NAME --pair-file FILE [--password-file FILE]
  admin verify-host NAME
  admin issue-token NAME --hosts birch,aspen --operations status,agents,workspaces,send,activity,wait --token-file FILE
  admin revoke-token NAME
  admin inspect-send HOST --agent ID
  admin clear-send HOST --agent ID --request-id UUID --confirm-reconciled (Bridge must be stopped)
Secrets are read/written through files, never printed. Import does not delete its input.
Server: paseo-bridge-server --config SERVER.json
`;
export async function cliMain(args = process.argv.slice(2)): Promise<void> {
  try {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
      config: { type: 'string' }, profile: { type: 'string' }, host: { type: 'string' }, agent: { type: 'string' },
      'prompt-file': { type: 'string' }, interrupt: { type: 'boolean' }, tail: { type: 'string' }, timeout: { type: 'string' }, 'wait-mode': { type: 'string' },
      'pair-file': { type: 'string' }, 'password-file': { type: 'string' }, hosts: { type: 'string' },
      operations: { type: 'string' }, 'token-file': { type: 'string' }, 'request-id': { type: 'string' }, 'confirm-reconciled': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }
    } });
    if (values.help || !positionals.length) { console.log(help); return; }
    if (values['wait-mode'] !== undefined && (positionals[0] !== 'wait' || !['sse', 'poll'].includes(values['wait-mode'])))
      throw new BridgeError('USAGE', '--wait-mode sse|poll is only valid with wait');
    let result: any;
    if (positionals[0] === 'admin') {
      if (positionals.length !== 3 || !values.config) throw new BridgeError('USAGE', 'Admin requires --config, action and name');
      const config = await readConfig(values.config, serverSchema);
      const [, action, name] = positionals;
      if (action === 'import-host' && values['pair-file']) result = await importHost(config, name, values['pair-file'], values['password-file']);
      else if (action === 'verify-host') result = await verifyPersistence(config, name);
      else if (action === 'issue-token' && values['token-file'] && values.hosts && values.operations)
        result = await issueToken(config, name, values.hosts.split(','), values.operations.split(','), values['token-file']);
      else if (action === 'revoke-token') result = await revokeToken(config, name);
      else if (action === 'inspect-send' && values.agent) result = await inspectSubmission(config, name, values.agent);
      else if (action === 'clear-send' && values.agent && values['request-id'] && values['confirm-reconciled'])
        result = await clearSubmission(config, name, values.agent, values['request-id']);
      else throw new BridgeError('USAGE', 'Invalid admin command; use --help');
    } else {
      if (positionals.length !== 1 || !operations.includes(positionals[0] as any)) throw new BridgeError('USAGE', 'Unknown command');
      const prompt = values['prompt-file'] ? await readFile(values['prompt-file'], 'utf8') : undefined;
      const parsed = requestSchema.safeParse({ op: positionals[0], host: values.host ?? 'all', agent: values.agent,
        prompt, interrupt: values.interrupt, tail: values.tail === undefined ? undefined : Number(values.tail),
        timeout: values.timeout === undefined ? undefined : Number(values.timeout) });
      if (!parsed.success) throw new BridgeError('USAGE', 'Invalid arguments; use --help');
      const file = values.config ?? process.env.PASEO_BRIDGE_CONFIG ?? join(homedir(), '.config/paseo-bridge/client.json');
      const config = await readConfig(file, clientSchema);
      result = await call(config, values.profile, parsed.data, { waitMode: values['wait-mode'] as 'sse' | 'poll' | undefined });
    }
    console.log(JSON.stringify(result, null, 2));
    if (result?.partial || result?.status === 'unknown' || result?.result?.status === 'timeout') process.exitCode = 2;
  } catch (error) {
    const e = publicError(error);
    console.error(JSON.stringify({ error: { code: e.code, message: e.message } }));
    process.exitCode = 1;
  }
}
