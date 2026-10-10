import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSnapshotPayloadSchema, WorkspaceDescriptorPayloadSchema } from '@getpaseo/protocol/messages';
import type { Connection } from '../src/paseo/connection.js';
import type { PaseoApi } from '@getpaseo/client';
export async function directory() { return mkdtemp(join(tmpdir(), 'paseo-bridge-test-')); }
export async function secret(file: string, value: unknown) {
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  await chmod(file, 0o600);
}
export function fixture() {
  const state = { online: true, status: 'idle', sends: [] as unknown[], sendError: false, listError: false, pages: false,
    sendGate: undefined as Promise<void> | undefined, waitStatus: 'idle', refreshGate: undefined as Promise<void> | undefined,
    refreshes: 0, waitGate: undefined as Promise<void> | undefined, waits: 0,
    subscriptionGate: undefined as Promise<void> | undefined, subscriptions: 0, releases: 0, timelineSubscriptions: 0, timelineReadyGate: undefined as Promise<void> | undefined, timelineReads: 0, timelineText: 'received' };
  const agent = AgentSnapshotPayloadSchema.parse({ id: 'agent-1', archivedAt: null, status: 'idle', cwd: '/project', workspaceId: 'wks-1',
    provider: 'codex', model: null, createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z', lastUserMessageAt: null,
    capabilities: { supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: false,
      supportsMcpServers: false, supportsReasoningStream: false, supportsToolInvocations: true },
    currentModeId: null, availableModes: [], pendingPermissions: [], persistence: null, title: null });
  const workspace = WorkspaceDescriptorPayloadSchema.parse({ id: 'wks-1', projectId: 'prj-1', projectDisplayName: 'Project',
    projectRootPath: '/project', projectKind: 'directory', workspaceKind: 'directory', name: 'Workspace', status: 'done', activityAt: null });
  const agentListeners = new Set<(value: any) => void>(); const timelineListeners = new Set<(value: any) => void>();
  const current = () => ({ ...agent, status: state.status });
  const timeline = () => ({ requestId: 'timeline-test', agentId: agent.id, agent: current(), direction: 'before', projection: 'projected',
    epoch: 'test-epoch', reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
    startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, error: null,
    entries: [{ provider: 'codex', item: { type: 'assistant_message', text: state.timelineText }, timestamp: '2026-10-10T00:00:00Z',
      seqStart: 0, seqEnd: 0, sourceSeqRanges: [], collapsed: [] }] });
  const handle = {
    id: agent.id,
    refresh: async () => { state.refreshes++; await state.refreshGate; return { agent: current(), project: null }; },
    send: async (prompt: string, options: unknown) => { state.sends.push({ prompt, options }); await state.sendGate; if (state.sendError) throw new Error('secret://must-not-leak'); },
    waitForFinish: async () => { state.waits++; await state.waitGate; return { status: state.waitStatus, final: current(), error: null, lastMessage: 'received' }; },
    timeline: { refetch: async () => { state.timelineReads++; return timeline(); }, subscribe: (listener: (event: any) => void) => {
      state.timelineSubscriptions++; timelineListeners.add(listener);
      const remove = () => { if (timelineListeners.delete(listener)) state.timelineSubscriptions--; };
      return Object.assign(remove, { ready: state.timelineReadyGate ?? Promise.resolve() });
    } }
  };
  const connection: Connection = {
    state: () => state.online ? 'connected' : 'disconnected', start: async () => {}, close: async () => {},
    api: {
      agents: {
        ref: () => handle,
        subscribe: (listener: (event: any) => void) => { agentListeners.add(listener); return () => agentListeners.delete(listener); },
        list: async (options: any) => {
          if (state.listError) throw new Error('pair-link-secret');
          const result = { entries: [{ agent: { ...current(), id: options?.page?.cursor ? 'agent-2' : agent.id } }],
            pageInfo: { nextCursor: state.pages && !options?.page?.cursor ? 'next' : null } };
          if (!options?.subscribe) return result;
          state.subscriptions++; await state.subscriptionGate;
          let released = false;
          return { ...result, subscription: { release: async () => { if (!released) { released = true; state.subscriptions--; state.releases++; } } } };
        }
      },
      workspaces: { list: async () => ({ entries: [workspace], pageInfo: { nextCursor: null } }) }
    } as unknown as PaseoApi
  };
  return { state, connection, agent, workspace, timeline, emitAgent: () => agentListeners.forEach(listener => listener({ kind: 'upsert', agent: current() })),
    emitTimeline: (event: any) => timelineListeners.forEach(listener => listener(event)) };
}
