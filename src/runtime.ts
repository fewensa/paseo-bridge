import { readConfig, serverSchema, type ServerConfig } from './config.js';
import { persistedConnection, type Connection } from './paseo/connection.js';
import { BridgeService } from './service.js';
import { apiServer, listenSocket, listen, closeServer } from './api/server.js';
import { BridgeError } from './errors.js';
import type { Server } from 'node:http';

export async function loadHosts(config: ServerConfig): Promise<Map<string, Connection>> {
  const hosts = new Map<string, Connection>();
  try {
    for (const [name, host] of Object.entries(config.hosts)) {
      hosts.set(name, await persistedConnection(host.connectionFile, config.stateDir, name));
    }
    return hosts;
  } catch (error) { await Promise.all([...hosts.values()].map(host => host.close())); throw error; }
}
export async function runServer(configFile: string, createHosts = loadHosts) {
  const config = await readConfig(configFile, serverSchema);
  const service = new BridgeService(await createHosts(config), config.requestTimeoutMs, config.stateDir);
  const servers: Server[] = [];
  try {
    const local = apiServer(service); servers.push(local); await listenSocket(local, config.socket);
    if (config.central) {
      const central = apiServer(service, config.central.authFile); servers.push(central);
      await listen(central, config.central.port, '127.0.0.1');
    }
  } catch (error) {
    await Promise.all(servers.map(closeServer));
    await Promise.all([...service.hosts.values()].map(host => host.close()));
    throw error;
  }
  void Promise.all([...service.hosts.values()].map(host => host.start()));
  let stopping = false;
  let reloadTask: Promise<void> | undefined;
  function reload() {
    if (reloadTask || stopping) return reloadTask;
    reloadTask = replaceHosts().finally(() => { reloadTask = undefined; });
    return reloadTask;
  }
  async function replaceHosts() {
    try {
      const next = await readConfig(configFile, serverSchema);
      if (next.socket !== config.socket || next.stateDir !== config.stateDir ||
          JSON.stringify(next.central) !== JSON.stringify(config.central) || next.requestTimeoutMs !== config.requestTimeoutMs)
        throw new BridgeError('RESTART_REQUIRED', 'Listener, state and timeout changes require restart');
      const hosts = await createHosts(next);
      if (stopping) { await Promise.all([...hosts.values()].map(host => host.close())); return; }
      const previous = service.hosts; service.hosts = hosts;
      await Promise.all([...previous.values()].map(host => host.close()));
      if (stopping) return;
      void Promise.all([...hosts.values()].map(host => host.start()));
      console.error('Host configuration reloaded');
    } catch { console.error('Reload failed; existing configuration retained'); }
  }
  async function stop() {
    if (stopping) return; stopping = true;
    process.off('SIGHUP', reload);
    await Promise.all(servers.map(closeServer));
    await reloadTask;
    await Promise.all([...service.hosts.values()].map(host => host.close()));
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
  }
  process.on('SIGHUP', reload); process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.error('Bridge listening; use status to inspect host availability');
  return { service, stop, reload };
}
