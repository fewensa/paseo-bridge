import { spawn } from 'node:child_process';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readConfig, serverSchema } from './config.js';
import { BridgeError } from './errors.js';

const privateSocket = '/run/paseo-bridge/socket/bridge.sock';

// Only the managed container launcher opts in. A private Pod-local runtime and
// Kubernetes' non-overlapping container restarts establish the previous owner
// has exited. Ordinary local/server startup retains strict SOCKET_EXISTS rules.
export async function recoverPrivateSocket(socket: string): Promise<void> {
  const parent = await lstat(dirname(socket));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077))
    throw new BridgeError('PRIVATE_RUNTIME', 'Socket directory must be private and owned by the current user');
  let before;
  try { before = await lstat(socket); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!before.isSocket() || before.uid !== process.getuid?.())
    throw new BridgeError('SOCKET_EXISTS', 'Existing path is not a current-user-owned socket');
  await new Promise<void>((accept, reject) => {
    const probe = createConnection(socket);
    probe.once('connect', () => { probe.destroy(); reject(new BridgeError('SOCKET_EXISTS', 'Existing socket has a live listener')); });
    probe.once('error', error => {
      probe.destroy();
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') accept();
      else reject(new BridgeError('SOCKET_EXISTS', 'Existing socket could not be confirmed stale'));
    });
    probe.setTimeout(1000, () => { probe.destroy(); reject(new BridgeError('SOCKET_EXISTS', 'Existing socket could not be confirmed stale')); });
  });
  const after = await lstat(socket);
  if (!after.isSocket() || before.dev !== after.dev || before.ino !== after.ino || after.uid !== process.getuid?.())
    throw new BridgeError('SOCKET_EXISTS', 'Socket changed during recovery; operator inspection required');
  await unlink(socket);
}

export async function runContainer(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, 'recover-private-socket': { type: 'boolean' } } });
  if (values.help) { console.log('paseo-bridge-container [--recover-private-socket] --config /absolute/server.json'); return; }
  if (!values.config) throw new BridgeError('USAGE', 'Use paseo-bridge-container --config FILE');
  if (values['recover-private-socket']) {
    if (process.pid !== 1) throw new BridgeError('PRIVATE_RUNTIME', 'Recovery requires an isolated container PID namespace');
    const config = await readConfig(values.config, serverSchema);
    if (config.socket !== privateSocket)
      throw new BridgeError('PRIVATE_RUNTIME', 'Recovery is restricted to the managed private socket path');
    await mkdir(dirname(privateSocket), { recursive: true, mode: 0o700 });
    await recoverPrivateSocket(privateSocket);
  }
  const child = spawn(process.execPath,
    [fileURLToPath(new URL('./paseo-bridge-server.mjs', import.meta.url)), '--config', values.config], { stdio: 'inherit' });
  const handlers = (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map(signal => {
    const handler = () => { child.kill(signal); };
    process.on(signal, handler); return { signal, handler };
  });
  try {
    await new Promise<void>((accept, reject) => {
      child.once('error', reject);
      child.once('exit', code => { process.exitCode = code ?? 1; accept(); });
    });
  } finally {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  }
}
