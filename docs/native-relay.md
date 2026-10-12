# Native encrypted central proxy (v2)

The CLI opens a fresh encrypted native Paseo Relay connection for each command through the central WSS proxy. No additional process runs on ASPEN/BIRCH. The center cannot decrypt application frames or daemon passwords. HTTPS authenticates the center; a protected locally pinned daemon key authenticates the destination only after an encrypted `server_info` response. Plaintext `e2ee_ready` is not authentication.

Native Relay admits owner-level access, including terminals and file writes. Only fully trusted management clients may use this mode. The proxy rejects any token missing one of the six Bridge operations; query-only tokens cannot even obtain the native directory. Host grants remain enforced at admission and periodically during active connections. Existing per-operation ACLs apply only to legacy modes.

## Configuration

The server retains `central`, `socket`, `stateDir`, and its authentication registry. Set `hosts: {}`, remove `broker`/`endpoint`, and add:

```json
{"nativeRelay":{"hosts":{"aspen":{"serverId":"existing-server-id","url":"wss://relay.example.com/ws?role=client&serverId=existing-server-id&v=2"}}}}
```

Only routing belongs here. **Never place a daemon pairing public key, pair URL, password, or local credential in central config, directory, Git, or logs.** In the native protocol the daemon public key together with its route is an owner pairing capability, despite being named a public key. Upstream routes allow only `/ws` with unique `role=client`, matching `serverId`, and optional `v=2`; headers and subprotocols from the client are not forwarded.

Create a current-user-owned, mode-0600 client file selected using the existing `e2eeFile` / `PASEO_BRIDGE_E2EE_FILE` setting:

```json
{"version":2,"stateDir":"/protected/existing/state","hosts":{"aspen":{"serverId":"existing-server-id","daemonPublicKeyB64":"PROTECTED_EXISTING_PAIRING_CAPABILITY"}}}
```

If the daemon requires a password, add `passwordFile` pointing to a protected local file. Passwords travel only inside the encrypted hello. Provision pins from the local authenticated daemon or an already authenticated encrypted management channel; never learn or replace them from the central directory. The native directory returns server IDs only and cannot change client pins. Keep token/authentication values unchanged and preserve the state directory and unresolved `submissions` files.

## Migration and verification

1. Back up current client configuration with mode 0600. Stage version-2 pins on both trusted clients using the existing authenticated encrypted channel.
2. Publish and verify new server/CLI artifacts. Deploy route-only proxy config; preserve old provider credentials and state without mounting daemon capabilities in the center.
3. Update client binaries and atomically select the staged v2 file. Ordinary commands require no extra flags. Verify both hosts, restricted-token refusal, and actual bidirectional assistant replies in isolated acceptance sessions.
4. Only after acceptance, stop and disable the old Bridge endpoint services. Repeat checks to prove operation without those processes. Do not restart or modify Paseo.

Legacy v1 configuration is retained for a coordinated rollback; restoring it also requires the old broker and endpoints. Never automatically retry an uncertain send. Node and Go clients exclusively create and fsync durable per-target guards before dispatch, use unique native message IDs, and clear only confirmed acceptance. Existing unresolved records remain blocking.

The Go CLI implements native SSE output by bounded local read-only polling at two-second intervals; it does not run a listener or background service. The Node `wait` uses the SDK's read-only observation. Neither reconnects a send automatically.

## Limits

The proxy sees host routing, timing, lengths and bearer authentication. It can deny service, but cannot derive a fresh daemon channel from the forwarded ephemeral client handshake. Pairing-capability protection is essential; possession grants owner access directly through native Relay.

Native Paseo encryption does not provide generic replay/order protection or forward secrecy. Native message receipts and durable client guards reduce accidental duplicate sends, not arbitrary replay by a malicious transport. Migration does not revoke capabilities previously held by old centers, historical backups, or existing paired clients. Revoking those requires a separately coordinated daemon key/password rotation and re-pairing. Directory listing does not establish model/task compatibility.
