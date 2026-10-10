# Security and API semantics

## Trust boundaries

- Paseo Relay transport/cryptography is implemented by the pinned official SDK, not this project. Relay pairing always uses TLS plus E2EE with the offered daemon public key. Pair credentials are sensitive; the Relay operator cannot read encrypted prompt content, but the Bridge and destination daemon can.
- CLI ↔ central Bridge uses validated HTTPS and a separate random 256-bit client token. Server storage contains SHA-256 verification digests, not plaintext client tokens. Comparisons use `timingSafeEqual`.
- CLI ↔ local Bridge uses a Unix socket with filesystem user/group authorization. Local socket access is broad and trusted. There is no agent-level sandboxing or central-token authentication on the socket.
- The central backend listens only on loopback. Use the included TLS reverse-proxy template; never expose the backend port. Backend requests still need tokens. The proxy is trusted with Authorization and plaintext request content.
- Administration is never exposed via HTTP. An authorized API user cannot import hosts, issue/revoke tokens, execute terminals, mutate workspaces or delete agents. Prompt content can still ask a destination agent to act; destination permissions are outside this Bridge's enforcement.

## Secret handling

Credentials, tokens and persisted client IDs must be owned by the reading user and not readable/writable/executable by group/other (normally 600). They must be regular files; `O_NOFOLLOW` and descriptor-based permission checks reject symlinks and path-swap races. Protected directories should be 700. Writes use exclusive mode-600 temporary files, file sync, atomic rename and parent-directory sync, including each ancestor entry provisioned during first-time directory creation. Server/client configurations contain paths, not secret values. SDK logs are silenced; unknown errors are replaced by a generic public error. The Bridge does not log prompts, pairing URLs, credentials or tokens.

No command accepts a pair URL, password or token as an argument. Import input is retained for operator-controlled deletion after persistent verification. A prompt is supplied with `--prompt-file`, keeping content out of process arguments too. Do not run CLI/admin commands under shell tracing that prints file contents, or enable proxy body/Authorization logging.

Central credentials authorize named operations on named hosts. They do **not** limit agents within a permitted host. A client may query/send to any qualifying agent on that host. This is intentionally explicit and suitable only when that host-wide trust is acceptable. Tokens are revoked per client ID; active requests retain the grant received at admission.

## Request/response contract

POST `/v1/request`, `Content-Type: application/json`. Central requests require `Authorization: Bearer <token>`. Success: `{ "ok": true, "data": ... }`. Errors: `{ "ok": false, "error": { "code": ..., "message": ... } }`. CLI prints `data` on stdout, error JSON on stderr. `/health` and all administrative/destructive endpoints do not exist.

```json
{"op":"agents","host":"all"}
```

Operations:

| op | fields | result |
| --- | --- | --- |
| status | host (name/all) | per-host connection state + fetchedAt |
| agents | host (name/all) | paginated snapshots, host labels, partial errors |
| workspaces | host (name/all) | paginated workspace descriptors, partial errors |
| send | explicit host, agent ID, prompt, optional interrupt | accepted or unknown, message requestId |
| activity | explicit host, agent ID, optional tail 0–200 | a fresh timeline page; tail 0 gives empty entries |
| wait | explicit host, agent ID, optional timeout 1–600 seconds | official SDK completion result or timeout |

Requests reject unknown fields/invalid limits. Query defaults use `host: all` in the CLI; the API requires `host`. IDs are passed exactly—there is no fuzzy agent/name lookup. Archived/nonexistent targets are rejected. `wait` on an idle agent returns immediately; it is not a promise that a new turn will start, and is not correlated to a particular send. Another external turn could begin before a wait is observed.

Queries independently isolate offline/failing hosts. `partial: true` preserves successful host results and labels failures with sanitized error codes. A status query itself can succeed while showing offline hosts; callers must inspect their states. There is no stale cached result masquerading as fresh data.

Limits: request body 256 KiB, prompt 65536 characters, 64 active requests/listener, 8 active requests/authenticated client, at most 32 long waits/listener (reserving capacity for short operations), 60 authenticated requests/minute/client, and 600 failed-auth responses/minute/source before failures become 429. Successful authentication is never rejected by the failed-source bucket, so invalid-token floods through a shared localhost proxy cannot consume valid clients' quota. Forwarded headers are not trusted to spoof IPs. This is not a substitute for network/proxy-level denial-of-service protection. Disconnecting does not let a client evade outstanding-operation accounting. Rate windows reset on restart. Headers/body have bounded receive time. Waits are bounded to 600 seconds. Queries/actions use one shared deadline across pagination and agent refresh/submission. Query collection is capped at 10000 aggregate entries/12 MiB across selected hosts; exceeding that budget returns explicit per-host RESULT_LIMIT failures. Server and CLI responses are capped at 16 MiB. Repeated pagination cursors and excessive page counts fail explicitly.

## Delivery and busy behavior

The service holds a per-host/agent in-flight send guard across refresh and dispatch. A public send timeout does not release the active guard while the SDK submission remains pending. A durable submission marker is written before dispatch and cleared only after confirmed acceptance. SDK timeout/disconnect/rejection leaves it unresolved even after the SDK promise settles; subsequent sends fail SEND_UNCERTAIN across reloads/restarts. Unless `interrupt: true`, it refreshes the target and requires `idle`. Default submission explicitly uses `steer` to avoid the SDK's otherwise implicit interruption. This is **not** an atomic daemon-side idle-only check: another client can start a turn between refresh and submission. SDK 0.11.1 provides no atomic idle-only/queue option, so a concurrent external turn can receive the prompt as a steer. Explicit interrupt may stop current work; use only with permission.

The official send response is awaited. `status: accepted` means the daemon accepted the message, not that the agent finished. A timeout/disconnect/submission exception yields `status: unknown, retrySafe: false`; CLI uses exit 2. A client-side network failure also says outcome may be unknown. There is no automatic retry or exactly-once claim. Generated `requestId` is passed as the SDK message ID and can help manual correlation in activity. The durable guard is an uncertainty/safety marker, not a deduplication ledger or exactly-once guarantee.

A failed preflight/busy check never dispatches a prompt. Uncertain sends must be investigated with `activity`, agent status and the destination operator before any manual resubmission. An idle snapshot alone cannot prove an earlier message will not take effect. If the SDK later confirms acceptance, its marker is automatically cleared. Otherwise, an operator must stop the Bridge and use local `admin clear-send HOST --agent ID --request-id UUID --confirm-reconciled` only after establishing that another send is safe. Guards contain host/agent/message IDs and timestamps, never prompts. They are not automatically discarded by restart. SDK errors do not provide a reliable typed rejection/uncertainty distinction, so quarantine is deliberately conservative, including rejected submissions. Reload/restart while a send is in flight can also create uncertainty. `wait` observes the target's completion status, including error/timeout; callers must inspect its result. The Bridge never automatically forwards replies or initiates further dialogues.

## Scope of testing

Tests use the real official SDK against controlled WebSocket daemons, including TLS + official Relay E2EE channels, controlled HTTP/HTTPS endpoints and CLI processes. They verify transport recovery, authentication/authorization/revocation, certificate validation, secret permissions, query failure isolation and submission semantics without causing real agent work. An optional real daemon test is read-only. Actual hosted Relay routing, public TLS deployment and cross-machine send/wait require protected credentials and explicit operator-selected targets.
