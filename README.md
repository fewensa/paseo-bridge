# Paseo Bridge

A resident, multi-host bridge for agents using Paseo 0.11.1. Discover workspaces and agents, submit a prompt to an explicitly selected agent, read its timeline, and wait for it to finish. Connections and client identities persist across CLI calls and service restarts.

## Two deployment modes, one CLI

```text
Per-machine: CLI --profile local   → Unix socket → local Bridge → Paseo Relay → daemons
Central:     CLI --profile central → HTTPS      → central Bridge → Paseo Relay → daemons
```

Relay connections use the official Paseo SDK's E2EE implementation. The central Bridge decrypts and sees prompts/activity: it is a trusted endpoint, not an opaque Relay. Each machine can have a separate central token with host and operation scopes. There is no fallback between profiles.

## Install

Requires **Node.js 22+**; no Go/Rust toolchain required.

```sh
npm ci --ignore-scripts
npm test
npm run bundle
```

`build/paseo-bridge.mjs` and `build/paseo-bridge-server.mjs` are executable, self-contained scripts. Copy them to a target with Node.js 22+; **npm and node_modules are not required on the target**:

```sh
sudo install -d /opt/paseo-bridge
sudo install -m 755 build/paseo-bridge.mjs build/paseo-bridge-server.mjs /opt/paseo-bridge/
sudo ln -s /opt/paseo-bridge/paseo-bridge.mjs /usr/local/bin/paseo-bridge
sudo ln -s /opt/paseo-bridge/paseo-bridge-server.mjs /usr/local/bin/paseo-bridge-server
paseo-bridge --help
```

Alternatively, `npm pack` creates an installable package with both commands; install with `npm install -g /path/to/paseo-bridge-0.1.0.tgz --ignore-scripts`. `node scripts/verify-package.mjs` checks both distribution methods after building/bundling. GitHub CI uploads bundled artifacts for Node 22 and 24; it does not publish to npm.

## Use

Set up the service and profiles using the [deployment guide](docs/deployment.md). Default client configuration: `~/.config/paseo-bridge/client.json`, overridden by `PASEO_BRIDGE_CONFIG` or `--config`.

```sh
paseo-bridge --profile local status --host all
paseo-bridge --profile central workspaces --host all
paseo-bridge --profile central agents --host aspen
paseo-bridge --profile central send --host aspen --agent AGENT_ID --prompt-file /path/to/prompt.txt
paseo-bridge --profile central activity --host aspen --agent AGENT_ID --tail 20
paseo-bridge --profile central wait --host aspen --agent AGENT_ID --timeout 120
```

Output is always JSON (`--json` is accepted). Queries return per-host results, timestamps, and an explicit `partial` flag. Exit codes: `0` successful/accepted, `1` invalid request or error, `2` partial results, unknown send outcome, or wait timeout. A completed agent can have `result.status: "error"`; inspect the result, not just the exit code.

- `all` is query-only. Sending/activity/wait require explicit host and agent ID, never name matching.
- Busy sends are rejected. `--interrupt` is an explicit opt-in and may interrupt the target's current turn.
- An accepted send is **not** a completed turn. Use `wait` followed by `activity`.
- Unknown send outcomes are never retried automatically. Inspect activity before deciding whether to send again.
- Paseo 0.11.1 cannot atomically enforce idle-only delivery across other clients. A concurrent external turn may receive the default send as `steer`, not as an interrupt.
- No autonomous forwarding, agent creation/deletion, terminal execution, workspace mutation, or recursive conversations.

## Administration and security

Administration is file-based and local-only. Pair URLs, passwords and tokens are never CLI arguments or output. Inputs must be current-user-owned regular files with no group/other permissions; symlinks are rejected.

```sh
paseo-bridge --config /etc/paseo-bridge/bridge.json admin import-host aspen --pair-file /protected/aspen.pair
paseo-bridge --config /etc/paseo-bridge/bridge.json admin verify-host aspen
# Verify durable configuration before manually deleting the temporary pair file.
```

Import verifies Relay connectivity before persisting. It does **not** delete its input. Reload host configuration using `systemctl reload paseo-bridge`; listener changes require restart. Tokens can be scoped, issued, and revoked without exposing administrative operations through the API.

See [security and protocol](docs/security.md), [deployment/rollback](docs/deployment.md), and [agent usage](docs/agent-usage.md).

## Verification

```sh
npm run check
npm test
npm audit --omit=dev
npm run bundle
node scripts/verify-package.mjs
# Optional, read-only real local daemon test (never sends prompts):
PASEO_TEST_LOCAL_CREDENTIAL=/absolute/path/to/local-credential npm test
```

Tests exercise SDK WebSocket connections and official Relay E2EE channels, protected pairing import/persisted verification, daemon restart/reconnect, persistent identity, reload/shutdown races, Unix sockets, HTTPS trust, authentication/revocation/scopes, client-capacity isolation, pagination/partial failure, send busy/uncertain behavior, CLI profiles and packaging. HTTPS tests use a generated local certificate and require `openssl`. Live ASPEN Relay acceptance and public HTTPS deployment need operator-supplied pairing files/domain; passing local tests does not assert those deployments have happened.
