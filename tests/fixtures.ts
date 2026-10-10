import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from '../src/paseo/connection.js';
import type { PaseoApi } from '@getpaseo/client';
export async function directory() { return mkdtemp(join(tmpdir(), 'paseo-bridge-test-')); }
export async function secret(file: string, value: unknown) {
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode: 0o600 });
  await chmod(file, 0o600);
}
export function fixture() {
  const state = { online: true, status: 'idle', sends: [] as unknown[], sendError: false, listError: false, pages: false, sendGate: undefined as Promise<void> | undefined, waitStatus: 'idle', refreshGate: undefined as Promise<void> | undefined, refreshes: 0, waitGate: undefined as Promise<void> | undefined, waits: 0 };
  const agent = { id: 'agent-1', archivedAt: null, status: 'idle', cwd: '/project', workspaceId: 'wks-1' };
  const handle = {
    id: agent.id,
    refresh: async () => { state.refreshes++; await state.refreshGate; return { agent: { ...agent, status: state.status }, project: null }; },
    send: async (prompt: string, options: unknown) => { state.sends.push({ prompt, options }); await state.sendGate; if (state.sendError) throw new Error('secret://must-not-leak'); },
    waitForFinish: async () => { state.waits++; await state.waitGate; return { status: state.waitStatus, lastMessage: 'received' }; },
    timeline: { refetch: async () => ({ entries: [{ text: 'received' }], hasMore: false }) }
  };
  const connection: Connection = {
    state: () => state.online ? 'connected' : 'disconnected', start: async () => {}, close: async () => {},
    api: {
      agents: {
        ref: () => handle,
        list: async (options: any) => {
          if (state.listError) throw new Error('pair-link-secret');
          return { entries: [{ agent: { ...agent, id: options?.page?.cursor ? 'agent-2' : agent.id } }],
            pageInfo: { nextCursor: state.pages && !options?.page?.cursor ? 'next' : null } };
        }
      },
      workspaces: { list: async () => ({ entries: [{ workspaceId: 'wks-1' }], pageInfo: { nextCursor: null } }) }
    } as unknown as PaseoApi
  };
  return { state, connection };
}
