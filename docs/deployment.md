# Deployment and rollback

## Choose a mode

**Per-machine:** install a Bridge on BIRCH and ASPEN; each has its own protected host credentials and Unix socket. Agents on each machine use `local`. Each Bridge reconnects independently to configured remote daemons through Paseo Relay.

**Central:** install one Bridge (initially BIRCH, later HUB), configure both BIRCH and ASPEN as Relay hosts, enable the loopback HTTP listener, and put Caddy/TLS in front. Each client machine only needs the CLI, its own token file and the HTTPS profile. Use separate tokens for BIRCH and ASPEN. Keep the local socket for administrative/debug access, not as a central-client fallback.

Node.js must be available to systemd outside an interactive NVM shell. The unit assumes `/usr/bin/node`; adjust `ExecStart` to the installed absolute Node 22+ path. macOS clients can use the bundled CLI; the service template targets Linux/systemd.

## 1. Install files and service account

Build/install commands are in the README. Example Linux preparation (review paths before executing):

```sh
sudo useradd --system --home-dir /var/lib/paseo-bridge --shell /usr/sbin/nologin paseo-bridge
sudo install -d -o root -g paseo-bridge -m 750 /etc/paseo-bridge
sudo install -d -o paseo-bridge -g paseo-bridge -m 700 /etc/paseo-bridge/credentials /var/lib/paseo-bridge
sudo install -m 644 deploy/paseo-bridge.service /etc/systemd/system/paseo-bridge.service
# Choose ONE configuration, edit it to contain only the intended hosts:
sudo install -o root -g paseo-bridge -m 640 examples/bridge.local.json /etc/paseo-bridge/bridge.json
# Or use examples/bridge.central.json for central deployment.
```

All configuration paths are absolute. `requestTimeoutMs` defaults to 15000 and bounds the entire query/action (100–120000 ms); wait has its own 1–600 second budget including the initial agent refresh. Host names are lowercase letters/digits/hyphens, start with a letter and cannot be `all`. Never commit real connection credentials, pair URLs, passwords, token files or identity files.

## 2. Import Relay credentials safely

On each daemon, obtain its pairing URL through the official Paseo UI/CLI and place it in a **protected file**, without printing it into logs or putting it into command arguments. Transfer that file securely. Pairing files contain sensitive daemon identity material; a daemon password, if enabled, remains necessary.

The service account must own/read the file. For example, install an already protected input to a protected import path (this copies a single file, not the daemon home):

```sh
sudo install -o paseo-bridge -g paseo-bridge -m 600 /protected/aspen.pair /etc/paseo-bridge/credentials/aspen.pair
sudo -u paseo-bridge paseo-bridge --config /etc/paseo-bridge/bridge.json admin import-host aspen --pair-file /etc/paseo-bridge/credentials/aspen.pair
sudo -u paseo-bridge paseo-bridge --config /etc/paseo-bridge/bridge.json admin verify-host aspen
```

Repeat for `birch` if configured. A password must use `--password-file /protected/daemon.password`, also owned by the importing user and mode 600. Import validates TLS/E2EE pairing and a workspace query **before** writing the host's credential file atomically. Verification reconnects from the persisted credential and persisted client identity, independent of the temporary file. Only after both commands succeed, manually delete each specifically identified temporary input if desired. No import command automatically deletes it.

For a local daemon you can instead create a service-owned mode-600 credential JSON file:

```json
{"kind":"direct","url":"ws://127.0.0.1:6767/ws","localCredentialFile":"/etc/paseo-bridge/credentials/local-credential"}
```

Copy only the official daemon's `local-credential` file to that protected path with appropriate ownership, if you intend to grant the Bridge the corresponding local authority. Do not make `/root` readable or copy the entire Paseo home. Refresh this one file if the daemon rotates it. `ProtectHome=true` deliberately prevents service access to `/root/.paseo`. Relay pairing is the simpler option for a dedicated service account. Direct remote connections require `wss:`; plaintext is allowed only for literal loopback or `localhost`. Embedded URL credentials/query/fragment are rejected.

## 3. Start the service and local client

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now paseo-bridge
sudo systemctl status paseo-bridge
sudo journalctl -u paseo-bridge --since '5 minutes ago'
```

The service opens its API while connections are starting; poll status until `connected`. Invalid credential files fail startup; valid but unreachable hosts remain independently offline and reconnect automatically. Retry delay grows from roughly 1 second to 30 seconds with jitter. Each initial connection attempt is bounded. Bridge shutdown closes its connections and listeners.

Socket permissions are 660, directory 750. Add only trusted local agent users to the `paseo-bridge` group, then start a new login session; alternatively run the CLI as the service account. **Group socket access grants all local operations/all hosts**, not scoped central permissions. Credential and state directories remain 700, even for socket group members.

Create `~/.config/paseo-bridge/client.json` from `examples/client.json`; use your real home path for token files. A local-only installation can remove the central profile. Configuration itself contains no token and may be 600 for convenience. Then:

```sh
paseo-bridge --profile local status --host all
paseo-bridge --profile local workspaces --host all
paseo-bridge --profile local agents --host all
```

Running the server manually also works with an explicitly prepared socket directory: `paseo-bridge-server --config /absolute/server.json`. Never start two servers on the same socket/state directory. An existing socket is not automatically unlinked; confirm its owner is stopped before manually removing a stale socket. systemd manages `/run/paseo-bridge` lifetime during normal service stops.

## 4. Central tokens, TLS and profiles

Enable `central: {"port":8787,"authFile":"/etc/paseo-bridge/credentials/clients.json"}` in the server config. Listener changes require a restart. Issue the first token before starting/restarting a central listener:

```sh
sudo -u paseo-bridge paseo-bridge --config /etc/paseo-bridge/bridge.json admin issue-token birch-client --hosts birch,aspen --operations status,agents,workspaces,send,activity,wait --token-file /etc/paseo-bridge/credentials/birch-client.token
sudo -u paseo-bridge paseo-bridge --config /etc/paseo-bridge/bridge.json admin issue-token aspen-client --hosts birch,aspen --operations status,agents,workspaces,send,activity,wait --token-file /etc/paseo-bridge/credentials/aspen-client.token
```

Prefer narrower host/operation lists where possible (read-only: `status,agents,workspaces,activity,wait`). Registry changes are atomic and lock-protected. If the process crashes during an admin command, check for a stale `clients.json.lock`; confirm no administrator is active before manually removing that one lock file. Token output is exclusively created and never printed. If registry persistence fails after token-file creation, the token is not active: verify issuance, inspect/revoke the registry as appropriate, and use a fresh output pathname when retrying.

Transfer only the corresponding client's token through a secure file transfer; on the client, make it owned by the CLI user and mode 600, with parent directory 700. Do not use a shared token, put tokens into URLs/env arguments, or add them to shell history.

Configure Caddy using `deploy/Caddyfile`, replace `bridge.example.com` with a reachable domain, provide correct DNS, and permit inbound HTTPS 443 on the central host. Caddy normally manages public certificates; private PKI is also supported via a client's optional absolute `caFile` path. Never disable certificate validation. The backend binds **127.0.0.1 only**, and is not a direct remote-access endpoint. Do not expose/forward port 8787. Restrict access from local untrusted users too if your deployment needs stronger same-host isolation. No Authorization/body/access logging is enabled by the template.

Set the central client's URL and token file in `client.json`; do not silently change `defaultProfile` during validation:

```sh
paseo-bridge --profile central status --host all
paseo-bridge --profile central agents --host aspen
```

TLS authenticates the endpoint; the Bridge independently authenticates client tokens and checks operation/host scopes. `host: all` is filtered to the token's hosts, rather than revealing other hosts.

Revoke a compromised/lost token on the central host:

```sh
sudo -u paseo-bridge paseo-bridge --config /etc/paseo-bridge/bridge.json admin revoke-token birch-client
```

Revocation affects the next request immediately (registry is reread). Already authorized in-flight requests are not retroactively canceled. Issue replacement into a **new** file and transfer securely. Revoking central tokens does not revoke local Unix-socket permissions.

## 5. Reload, migration and rollback

After importing/updating host credentials or editing host mappings, `sudo systemctl reload paseo-bridge`. SIGHUP validates/builds the new configuration before replacing the host map; invalid reloads retain the current configuration. Existing host connections are replaced and outstanding operations can fail; schedule reloads when no sends/waits are in flight. Changing socket, state directory, central listener or request timeout requires `restart`. IDs in `/var/lib/paseo-bridge/*.client-id` must survive upgrades.

To move central deployment from BIRCH to HUB:

1. Install the same build/config with service-account permissions on HUB. Securely transfer only the Bridge credential registry, intended host credentials and client identity files—not the Paseo home.
2. Stop the old central Bridge before starting the new one with the same client IDs. Do not run concurrent owners of a state directory/identity.
3. Verify all host statuses on HUB through its local socket; point DNS/TLS proxy to HUB and explicitly test each central profile.
4. Retire old access only after verification. Tokens remain valid if the digest registry is migrated; rotate them if the old host is not trusted.

Keep the previous binaries/config before upgrading. Rollback: stop the Bridge, restore the previous two binaries and compatible server config, retain credential/state files, start it, verify status/queries. This version uses schema version 1 and no database migration. Do not “rollback” by deleting credentials or rewriting identity files. Connection credentials and token digests are sensitive even in backups.

## Acceptance checks requiring real infrastructure

Local tests do not replace these checks:

- BIRCH local profile discovers ASPEN's expected workspace and agent; ASPEN discovers BIRCH's expected targets.
- With the user's authorization, send a harmless unique prompt to a selected **idle** test agent, wait, and confirm the same marker in its activity. Never send to an active production agent for testing.
- Restart the Bridge, temporarily interrupt daemon/Relay connectivity, and confirm recovery without reimporting pairing information.
- Test central HTTPS from both machines; wrong/revoked token, untrusted certificate, disallowed operation/host must fail. Stop the local Bridge to confirm central profile does not depend on it.
- Choose the preferred deployment only after latency, maintenance and trust tradeoffs are understood.
