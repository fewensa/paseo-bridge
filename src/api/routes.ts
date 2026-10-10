import { z } from 'zod';
import { hostName, type Operation } from '../config.js';
import { requestSchema, type Request } from '../service.js';
import { BridgeError } from '../errors.js';
import {
  targetParams, emptyQuery, hostQuery, activityQuery, eventsQuery, sendBody,
  statusData, agentsData, workspacesData, snapshotData, sendData, activityData
} from './models.js';

export const documentRoutes = [
  { path: '/api/v1/openapi', media: 'text/html', key: 'html', summary: 'Self-hosted Redoc documentation' },
  { path: '/api/v1/openapi.json', media: 'application/json', key: 'spec', summary: 'Automatically generated OpenAPI contract' },
  { path: '/api/v1/openapi/assets/redoc.standalone.js', media: 'application/javascript', key: 'script', summary: 'Bundled Redoc browser script' },
  { path: '/api/v1/openapi/assets/redoc.licenses.txt', media: 'text/plain', key: 'licenses', summary: 'Bundled Redoc and third-party license notices' }
] as const;
export interface Route {
  method: 'get' | 'post'; path: string; operationId: string; summary: string; description: string;
  permissions: Operation[]; action: 'execute' | 'snapshot' | 'events';
  params: z.ZodObject; query: z.ZodObject; body?: z.ZodObject; response: z.ZodType;
  request(params: any, query: any, body: any): Request;
}
const noParams = z.object({}).strict();
const oneHost = z.object({ host: hostName.refine(value => value !== 'all', 'Explicit host required') }).strict();
const make = (op: Operation, host: string, rest: object = {}) => requestSchema.parse({ op, host, ...rest });
const polling = 'For ongoing observation, prefer the SSE events endpoint. Clients without SSE support may poll this endpoint. Use an interval of at least 2 seconds, back off on transient failures and honor rate limits. Never resend a message to recover observation.';
export const routes: Route[] = [
  { method: 'get', path: '/api/v1/hosts', operationId: 'listHostStatus', summary: 'List authorized host connection states',
    description: 'Only hosts authorized by the bearer token are returned. A disconnected host is a state, not a failed send.', permissions: ['status'], action: 'execute', params: noParams, query: emptyQuery, response: statusData,
    request: () => make('status', 'all') },
  { method: 'get', path: '/api/v1/hosts/{host}', operationId: 'getHostStatus', summary: 'Get one host connection state',
    description: 'Read-only host connection snapshot.', permissions: ['status'], action: 'execute', params: oneHost, query: emptyQuery, response: statusData,
    request: p => make('status', p.host) },
  { method: 'get', path: '/api/v1/workspaces', operationId: 'listWorkspaces', summary: 'List workspaces',
    description: 'host=all queries only authorized hosts. Check partial and each host error before treating the result as complete.', permissions: ['workspaces'], action: 'execute', params: noParams, query: hostQuery, response: workspacesData,
    request: (_, q) => make('workspaces', q.host) },
  { method: 'get', path: '/api/v1/agents', operationId: 'listAgents', summary: 'List agents',
    description: 'host=all queries only authorized hosts. Check partial and each host error before treating the result as complete.', permissions: ['agents'], action: 'execute', params: noParams, query: hostQuery, response: agentsData,
    request: (_, q) => make('agents', q.host) },
  { method: 'get', path: '/api/v1/hosts/{host}/agents/{agent}', operationId: 'getAgentSnapshot', summary: 'Get current agent state for polling or resynchronization',
    description: `${polling} Requires wait permission. A terminal result observes the agent, not a request-ID-correlated message completion. Idle does not reconcile an uncertain send.`, permissions: ['wait'], action: 'snapshot', params: targetParams, query: emptyQuery, response: snapshotData,
    request: p => make('wait', p.host, { agent: p.agent }) },
  { method: 'post', path: '/api/v1/hosts/{host}/agents/{agent}/messages', operationId: 'sendMessage', summary: 'Send a message once',
    description: '202 means accepted, not completed. 200 with status=unknown and retrySafe=false means the outcome is unresolved. Never automatically retry this endpoint, including after connection loss, timeout, invalid responses or HTTP errors. requestId is not an exactly-once guarantee. Busy agents reject unless interrupt is explicitly true.', permissions: ['send'], action: 'execute', params: targetParams, query: emptyQuery, body: sendBody, response: sendData,
    request: (p, _, b) => make('send', p.host, { agent: p.agent, ...b }) },
  { method: 'get', path: '/api/v1/hosts/{host}/agents/{agent}/activity', operationId: 'getAgentActivity', summary: 'Get recent agent activity',
    description: `${polling} Timeline epochs, reset, staleCursor and gap must be honored. This bounded tail is not a permanent, lossless event log. tail=0 returns an empty entries array.`, permissions: ['activity'], action: 'execute', params: targetParams, query: activityQuery, response: activityData,
    request: (p, q) => make('activity', p.host, { agent: p.agent, tail: q.tail }) },
  { method: 'get', path: '/api/v1/hosts/{host}/agents/{agent}/events', operationId: 'observeAgent', summary: 'Recommended: observe agent state using SSE',
    description: 'Prefer SSE to repeated polling when supported. Requires wait permission; include=activity additionally requires activity permission. Named SSE events contain JSON matching AgentEvent. Initial connection sends a fresh snapshot. Comment heartbeats occur every 10 seconds; each connection lasts at most 60 seconds. Reconnect read-only with backoff and a shared overall deadline. Last-Event-ID does not promise replay: reconnect emits resync and a new snapshot; use activity queries to retrieve history and check its gap/epoch indicators. No durable event replay is promised. Stream errors are error events after HTTP headers. Agent idle is not proof of a particular message completion. Disconnecting never cancels work or resends messages. Browser consumers should use fetch streaming with Authorization headers, not tokens in URLs.', permissions: ['wait'], action: 'events', params: targetParams, query: eventsQuery, response: snapshotData,
    request: p => make('wait', p.host, { agent: p.agent }) }
];
export interface MatchedRoute { route: Route; params: any; query: any; }
export function matchRoute(method: string | undefined, target: string | undefined): MatchedRoute {
  if (!target?.startsWith('/') || target.length > 8192) throw new BridgeError('NOT_FOUND', 'Unknown endpoint', 404);
  const url = new URL(target, 'http://bridge');
  for (const route of routes) {
    const names: string[] = [];
    const pattern = route.path.replace(/\{(\w+)\}/g, (_, name) => { names.push(name); return '([^/]+)'; });
    const match = new RegExp(`^${pattern}$`).exec(url.pathname);
    if (!match) continue;
    if (method?.toLowerCase() !== route.method) throw new BridgeError('METHOD', 'Method not allowed', 405);
    const params: Record<string, string> = Object.create(null); const query: Record<string, string> = Object.create(null);
    try { names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); }); }
    catch { throw new BridgeError('REQUEST', 'Invalid path parameter'); }
    for (const [key, value] of url.searchParams) {
      if (!Object.hasOwn(route.query.shape, key)) throw new BridgeError('REQUEST', 'Unknown query parameter');
      if (Object.hasOwn(query, key)) throw new BridgeError('REQUEST', 'Duplicate query parameter');
      query[key] = value;
    }
    const p = route.params.safeParse(params); const q = route.query.safeParse(query);
    if (!p.success || !q.success) throw new BridgeError('REQUEST', 'Invalid path or query parameters');
    return { route, params: p.data, query: q.data };
  }
  throw new BridgeError('NOT_FOUND', 'Unknown endpoint', 404);
}
