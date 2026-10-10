import { z } from 'zod';
import {
  AgentSnapshotPayloadSchema, AgentStreamMessageSchema, FetchAgentTimelineResponseMessageSchema,
  ProjectCheckoutLiteNotGitPayloadSchema, ProjectCheckoutLiteGitNonPaseoPayloadSchema,
  ProjectCheckoutLiteGitPaseoPayloadSchema, ProjectPlacementPayloadSchema,
  WorkspaceDescriptorPayloadSchema, WaitForFinishResponseMessageSchema
} from '@getpaseo/protocol/messages';
import { hostName } from '../config.js';

// These pinned SDK transforms fill fields on output. Describe the resulting JSON,
// not the more permissive daemon input or an unrepresentable JS transform.
const checkout = z.union([
  ProjectCheckoutLiteNotGitPayloadSchema.in.extend({ worktreeRoot: z.null() }),
  ProjectCheckoutLiteGitNonPaseoPayloadSchema.in.extend({ worktreeRoot: z.string() }),
  ProjectCheckoutLiteGitPaseoPayloadSchema.in.extend({ worktreeRoot: z.string() })
]);
export const workspaceSchema = WorkspaceDescriptorPayloadSchema.in.extend({
  workspaceDirectory: z.string(), statusEnteredAt: z.string().nullable(),
  project: ProjectPlacementPayloadSchema.extend({ checkout }).optional()
});
export const agentSchema = AgentSnapshotPayloadSchema;
export const timelineSchema = FetchAgentTimelineResponseMessageSchema.shape.payload;
export const waitResultSchema = WaitForFinishResponseMessageSchema.shape.payload.omit({ requestId: true }).extend({ lastMessage: z.null() });
export const errorSchema = z.object({ code: z.string(), message: z.string() }).strict();
export const errorEnvelope = z.object({ ok: z.literal(false), error: errorSchema }).strict();
export const agentId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const explicitHost = hostName.refine(value => value !== 'all', 'Explicit host required');
export const targetParams = z.object({ host: explicitHost, agent: agentId }).strict();
export const selectedHost = z.union([hostName, z.literal('all')]).default('all');
export const emptyQuery = z.object({}).strict();
export const hostQuery = z.object({ host: selectedHost }).strict();
export const activityQuery = z.object({ tail: z.preprocess(value => typeof value === 'string' && !value.trim() ? NaN : value, z.coerce.number().int().min(0).max(200).default(20)) }).strict();
export const eventsQuery = z.object({ include: z.enum(['state', 'activity']).default('state') }).strict();
export const sendBody = z.object({
  prompt: z.string().min(1).max(65536).regex(/\S/, 'Prompt must contain non-whitespace text'),
  interrupt: z.boolean().default(false)
}).strict();
const fetchedAt = z.string();
const hostError = z.object({ host: hostName, fetchedAt, error: errorSchema });
export const statusData = z.object({ results: z.array(z.object({ host: hostName, state: z.string(), fetchedAt })), partial: z.boolean() });
export const agentsData = z.object({ results: z.array(z.union([z.object({ host: hostName, fetchedAt, entries: z.array(agentSchema) }), hostError])), partial: z.boolean() });
export const workspacesData = z.object({ results: z.array(z.union([z.object({ host: hostName, fetchedAt, entries: z.array(workspaceSchema) }), hostError])), partial: z.boolean() });
export const snapshotData = z.object({ host: hostName, agentId, fetchedAt, agent: agentSchema, result: waitResultSchema.optional() });
export const sendData = z.discriminatedUnion('status', [
  z.object({ host: hostName, agentId, requestId: z.string().uuid(), status: z.literal('accepted') }),
  z.object({ host: hostName, agentId, requestId: z.string().uuid(), status: z.literal('unknown'), retrySafe: z.literal(false) })
]);
export const activityData = z.union([
  z.object({ host: hostName, agentId, fetchedAt, timeline: timelineSchema }),
  z.object({ host: hostName, agentId, entries: z.array(z.never()).length(0) })
]);
export const streamEventSchema = z.discriminatedUnion('kind', [
  snapshotData.extend({ kind: z.literal('snapshot') }),
  z.object({ kind: z.literal('activity'), host: hostName, agentId, timeline: timelineSchema }),
  z.object({ kind: z.literal('update'), host: hostName, agentId, update: AgentStreamMessageSchema.shape.payload }),
  z.object({ kind: z.literal('connection'), state: z.string() }),
  z.object({ kind: z.literal('resync'), reason: z.string() }),
  z.object({ kind: z.literal('error'), error: errorSchema })
]);
export type Snapshot = z.infer<typeof snapshotData>;
export type StreamEvent = z.infer<typeof streamEventSchema>;
export function envelope<T extends z.ZodType>(data: T) { return z.object({ ok: z.literal(true), data }).strict(); }
