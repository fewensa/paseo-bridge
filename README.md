# Paseo Bridge

A resident, multi-host bridge for agents using Paseo 0.11.1. Discover workspaces and agents, submit a prompt to an explicitly selected agent, read its timeline, and wait for it to finish. Connections and client identities persist across CLI calls and service restarts.

## Two deployment modes, one CLI

```text
Per-machine: CLI --profile local   → Unix socket → local Bridge → Paseo Relay → daemons
Central:     CLI → E2EE over HTTPS → opaque central broker → E2EE over WSS → host endpoint → local daemon
```

Relay connections use the official Paseo SDK's E2EE implementation. Central mode uses pinned X25519 keys and AES-256-GCM between the CLI and the destination host's local endpoint; the central broker cannot decrypt messages or activity. Central bearer tokens and endpoint public-key grants constrain hosts and operations independently. Both CLIs require explicit pinned key configuration and never fall back to plaintext. See [central E2EE protocol and migration](docs/e2ee.md).

## Install

Requires **Node.js 22+**.

```sh
npm ci --ignore-scripts
npm test
npm run bundle
```

`build/paseo-bridge.mjs` and `build/paseo-bridge-server.mjs` are executable, self-contained scripts that run directly with Node.js 22+. Install them on the target:

```sh
sudo install -d /opt/paseo-bridge
sudo install -m 755 build/paseo-bridge.mjs build/paseo-bridge-server.mjs /opt/paseo-bridge/
sudo ln -s /opt/paseo-bridge/paseo-bridge.mjs /usr/local/bin/paseo-bridge
sudo ln -s /opt/paseo-bridge/paseo-bridge-server.mjs /usr/local/bin/paseo-bridge-server
paseo-bridge --help
```

Alternatively, `npm pack` creates an installable package with both commands; install with `npm install -g /path/to/paseo-bridge-0.3.0.tgz --ignore-scripts`. `node scripts/verify-package.mjs` checks both distribution methods after building/bundling. GitHub CI uploads bundled artifacts for Node 22 and 24.

## Use

Set up the service and profiles using the [deployment guide](docs/deployment.md). Default client configuration: `~/.config/paseo-bridge/client.json`, overridden by `PASEO_BRIDGE_CONFIG` or `--config`.

```sh
paseo-bridge --profile local status --host all
paseo-bridge --profile central workspaces --host all
paseo-bridge --profile central agents --host aspen
paseo-bridge --profile central send --host aspen --agent AGENT_ID --prompt-file /path/to/prompt.txt
paseo-bridge --profile central activity --host aspen --agent AGENT_ID --tail 20
paseo-bridge --profile central wait --host aspen --agent AGENT_ID --timeout 120
# Polling observation:
paseo-bridge --profile central wait --host aspen --agent AGENT_ID --timeout 120 --wait-mode poll
```

Output is always JSON (`--json` is accepted). Queries return per-host results, timestamps, and an explicit `partial` flag. Exit codes: `0` successful/accepted, `1` invalid request or error, `2` partial results, unknown send outcome, or wait timeout. A completed agent can have `result.status: "error"`; inspect the result, not just the exit code.

- `all` is query-only. Sending/activity/wait require an explicit host and agent ID.
- Busy sends are rejected. `--interrupt` is an explicit opt-in and may interrupt the target's current turn.
- An accepted send is **not** a completed turn. Use `wait` followed by `activity`. `wait` defaults to read-only SSE observation and reconnects within its original deadline; use explicit `--wait-mode poll` for snapshot polling. Authentication and business errors are returned to the caller; reconnects repeat only observation.
- State observation keeps `result.lastMessage` null; activity permission is required to read replies. Idle is not proof of completion of a particular uncertain send.
- Unknown send outcomes are never retried automatically. Unresolved submissions are durably guarded across restarts; another send requires operator reconciliation and local clearance unless the original SDK request later confirms acceptance.
- Paseo 0.11.1 cannot atomically enforce idle-only delivery across other clients. A concurrent external turn may receive the default send as `steer`, not as an interrupt.

## REST API and application-owned documentation

The TypeScript CLI uses `/api/v1` REST routes over either Unix sockets or HTTPS. Sends use a dedicated messages POST; discovery, snapshots and activity use GET. SSE is recommended for ongoing observation, while ordinary snapshot/activity polling remains supported. See the [route and scope contract](docs/security.md#requestresponse-contract).

The service anonymously serves generated OpenAPI 3.1 at `/api/v1/openapi.json` and Redoc at `/api/v1/openapi`, with self-hosted script/license assets under `/api/v1/openapi/assets/`. Shared route definitions and Zod schemas drive both runtime validation and generation, including concrete SDK agent, workspace, timeline and event outputs. `npm run openapi` also generates `build/openapi.json` for other-language client tooling. The application serves documentation describing its API contract independently of runtime configuration. Redoc, its assets and licenses are bundled in npm and standalone/container distributions and served locally.

SSE has heartbeats, bounded lifetime/buffering/processing, authorization rechecks and subscription cleanup. Reconnect sends a fresh snapshot and resync; refetch authorized activity to reconcile missing history. Browser clients use fetch streaming with an Authorization header.

## Administration and security

Administration is file-based and local-only. Pair URLs, passwords and tokens are never CLI arguments or output. Inputs must be current-user-owned regular files with no group/other permissions; symlinks are rejected.

```sh
paseo-bridge --config /etc/paseo-bridge/bridge.json admin import-host aspen --pair-file /protected/aspen.pair
paseo-bridge --config /etc/paseo-bridge/bridge.json admin verify-host aspen
# Verify durable configuration before manually deleting the temporary pair file.
```

Import verifies Relay connectivity before persisting and retains the input file. Reload host configuration using `systemctl reload paseo-bridge`; listener changes require restart. Tokens can be scoped, issued, and revoked through local administration. `admin inspect-send HOST --agent ID` exposes only submission metadata. Clearing an unresolved send requires stopping the Bridge, matching its request ID and explicitly confirming reconciliation; see the deployment guide.

See [security and protocol](docs/security.md), [deployment/rollback](docs/deployment.md), and [agent usage](docs/agent-usage.md).

## Container runtime

After the Node.js 22/24 checks pass on `main`, CI publishes an amd64 runtime image to `ghcr.io/fewensa/paseo-bridge:sha-<commit>`. Pin the resulting digest when deploying; private packages require a registry pull credential. The image runs as UID/GID 1000 and contains the self-contained server and `paseo-bridge` CLI.

Mount the server configuration at `/etc/paseo-bridge/bridge.json`, current-user-owned mode-600 credentials at its configured paths, and persistent storage at `/var/lib/paseo-bridge`. Use one replica with a stop-before-start rollout: submission guards are not cross-process locks. Keep central HTTP loopback-only and proxy it to authenticated HTTPS; never expose port 8787 directly. The chart opts into PID-1, private-container socket recovery at `/run/paseo-bridge/socket/bridge.sock`: only a current-user-owned stale socket with no listener is removed. Ordinary server/local startup still refuses any existing socket; never share this runtime with another writer.

The `fes-de0` deployment is maintained in `repotea-workflow/gitops-fes`, under `charts/infra/paseo-bridge-helm` and `argocd/infra/paseo-bridge-de0`. Its chart documents Secret projection, credential ownership, persistent-state preservation, and stopped-service reconciliation.

## Verification

```sh
npm run check
npm test
npm audit --omit=dev
npm run bundle
npm run openapi
node scripts/verify-package.mjs
# Optional, read-only real local daemon test (never sends prompts):
PASEO_TEST_LOCAL_CREDENTIAL=/absolute/path/to/local-credential npm test
```

Tests exercise SDK WebSocket connections and official Relay E2EE channels, protected pairing import/persisted verification, daemon restart/reconnect, persistent identity, reload/shutdown races, Unix sockets, HTTPS trust, authentication/revocation/scopes, client-capacity isolation, pagination/partial failure, send busy/uncertain behavior and durable quarantine/reconciliation, CLI profiles, generated concrete OpenAPI, anonymous bundled documentation, SSE/poll deadlines, scopes/live revocation/stream cleanup and packaging. HTTPS tests use a generated local certificate and require `openssl`.

## License

[MIT](LICENSE) © 2026 fewensa.
