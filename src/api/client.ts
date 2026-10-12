import { nativeConfig, nativeCall } from '../native/client.js';
import type { ClientConfig } from '../config.js';
import type { Request } from '../service.js';
import { BridgeError } from '../errors.js';
import { clientTransport, jsonRequest } from './client-transport.js';
import { observe } from './client-events.js';
import { statusData, agentsData, workspacesData, activityData, sendData } from './models.js';
const results = { status: statusData, agents: agentsData, workspaces: workspacesData, activity: activityData, send: sendData };

export async function call(config: ClientConfig, profile: string | undefined, input: Request, options: { waitMode?: 'sse' | 'poll' } = {}): Promise<any> {
  const expiresAt = Date.now() + input.timeout * 1000;
  if (options.waitMode !== undefined && (input.op !== 'wait' || !['sse', 'poll'].includes(options.waitMode))) throw new BridgeError('USAGE', 'Wait mode is only valid with wait: sse or poll');
  const native = await nativeConfig(config, profile);
  if (native) return nativeCall(native, input, expiresAt);
  const transport = await clientTransport(config, profile);
  if (input.op === 'wait') return observe(transport, input, options.waitMode ?? 'sse', expiresAt);
  const host = encodeURIComponent(input.host);
  const agent = encodeURIComponent(input.agent ?? '');
  const base = `/api/v1/hosts/${host}/agents/${agent}`;
  let value: unknown;
  if (input.op === 'status') value = await jsonRequest(transport, input.host === 'all' ? '/api/v1/hosts' : `/api/v1/hosts/${host}`);
  else if (input.op === 'agents' || input.op === 'workspaces') value = await jsonRequest(transport, `/api/v1/${input.op}?host=${host}`);
  else if (input.op === 'activity') value = await jsonRequest(transport, `${base}/activity?tail=${input.tail}`);
  else value = await jsonRequest(transport, `${base}/messages`, { body: { prompt: input.prompt, interrupt: input.interrupt } });
  const parsed = results[input.op].safeParse(value);
  const malformed = () => { throw new BridgeError('RESPONSE', `Invalid operation response${input.op === 'send' ? '; send outcome may be unknown; do not retry automatically' : ''}`, 502); };
  if (!parsed.success) return malformed();
  const data = parsed.data;
  if ('results' in data) {
    if (input.host !== 'all' && (data.results.length !== 1 || data.results[0].host !== input.host)) return malformed();
  } else {
    if (data.host !== input.host || data.agentId !== input.agent) return malformed();
    if ('timeline' in data && (data.timeline.agentId !== input.agent || data.timeline.agent && data.timeline.agent.id !== input.agent)) return malformed();
  }
  return data;
}
