# Central end-to-end encryption (0.3)

The central process is an opaque broker. It has no Paseo connection files, daemon passwords, E2EE private keys or plaintext business API. Each host runs one local Bridge endpoint owning only that host. Endpoints dial the central HTTPS origin over WSS. CLI requests are encrypted before HTTP transport and replies, activity and SSE are decrypted only on the requesting machine. The endpoint invokes the existing Unix-socket REST API and pinned Paseo SDK locally.

## Trust and provisioning

Each machine generates an X25519 private key locally; raw 32-byte standard base64 is stored in an owner-only file. The same machine key has separate request/response derived keys and may identify its CLI and endpoint. Never send the private key to the broker, GitHub, another host or an agent message. Client configuration pins each endpoint public key. Endpoint peer configuration maps SHA-256(raw public key) hex fingerprints to client public keys and operation grants. TLS tokens independently constrain admission at the broker; endpoint public-key grants independently constrain decryption and local operations.

Provision public keys through an independent authenticated channel, such as SSH or an exact Git commit whose SSH signature verifies against an already trusted signing key. The signed tree must bind the named host, X25519 public key and E2EE v1 client/endpoint purpose. `deploy/keys/<host>.pub` records this public provisioning contract; it is not fetched dynamically by clients. Verify exact commit signatures before installing pins. GitHub's verified badge alone is insufficient. Replacing a pin is an explicit local administrative action. Private files, peers and pins require current-user ownership, regular files, no symlinks and mode 0600; directories should be 0700.

The broker can see host, client fingerprint, operation, request ID, expiry, sizes and timing. It can block traffic, revoke transport admission or return invalid ciphertext. It cannot read prompts, agent IDs, workspaces, activity or replies, forge a different pinned client's encrypted requests, or silently downgrade transport. Compromising an endpoint or an authorized client compromises that endpoint's accessible content. Static X25519 does **not** provide forward secrecy: a later private-key compromise can expose previously captured traffic for that key's peer relationships. Rotate compromised keys and replace pins explicitly.

## Wire contract

Business requests use `POST /api/v1/e2ee/requests` with the scoped bearer token and JSON packet. Endpoint registration uses `GET /api/v1/e2ee/connect/<host>` WebSocket upgrade, with the configured endpoint client's scoped bearer token. Ordinary central REST business routes return HTTP 426 `ENCRYPTION_REQUIRED`. Anonymous OpenAPI/Redoc remain available and describe the logical REST API that encrypted clients reconstruct. Existing command names remain unchanged.

A packet is `{v:1,host,client,id,expires,op,kind,seq,nonce,data}`. `client` is SHA-256(raw client public key) as lowercase hex. `id` is a fresh UUIDv4, `expires` is epoch milliseconds (client uses now + 90 seconds; endpoint requires future and at most 120 seconds). `op` is a normal operation or `observe-activity`, which requires both wait and activity grants. `nonce` is standard base64 of independent random 12 bytes. `data` is standard base64 of AES-256-GCM ciphertext followed by its 16-byte tag.

X25519 shared secret is expanded by HKDF-SHA256, salt UTF-8 request ID, info `paseo-bridge-e2ee-v1/request` or `paseo-bridge-e2ee-v1/response`, output 32 bytes. AEAD additional data is UTF-8 JSON array `[1,host,client,id,expires,op,kind,seq]` with no whitespace. Direction separation, independently random nonces and authenticated routing/frame metadata prevent cross-direction or cross-target substitution.

Request `kind=request,seq=0` encrypts `{method,path,body,lastEventId}`; body is standard base64 of original bytes. The endpoint strictly matches the decrypted route, checks its local host, compares the computed operation and enforces every peer permission, including activity observation's dual scope. It writes the request claim durably **before** any local HTTP call. Duplicate, expired, malformed or unauthorized requests never reach Paseo. A replay ledger survives restarts and compacts expired entries atomically. Exactly one endpoint instance must own each private key, local socket and replay ledger; do not duplicate the key into another endpoint/state directory.

The broker sends `{"type":"request","packet":...}` to the host connection. Responses use `{"type":"response","packet":...}`. HTTP responses are `application/x-ndjson`, one encrypted packet per line. Headers `kind=headers,seq=0` encrypt `{status,contentType}`. Chunks `kind=chunk` encrypt `{data:base64(original response bytes)}`, each at most 32768 decoded bytes. The end packet encrypts `{frames:<end seq>,bytes:<total decoded chunk bytes>}`. Clients require exact metadata and contiguous sequence numbers. JSON is buffered until authenticated end; truncation, wrong pins, missing end, duplicates, reorder and tampering fail. SSE chunks are authenticated before delivery; an authenticated terminal event may be used before caller cancellation, while unexpected stream loss is an error, not a successful send. Outer cancellation only cancels observation/transport, never replays a message.

`host=all` discovery is performed on pinned hosts independently and aggregated locally, with explicit partial errors. The central broker never aggregates decrypted results. Requests are at most 512 KiB encoded; decoded responses are at most 16 MiB, encoded stream budget 32 MiB, 64 active broker requests and 8 per transport client. Endpoint limits are 32 total/8 per pinned peer. Broker and endpoint queues are bounded; slow readers are disconnected. Endpoint and client keys never enter server output or logs.

## Configuration

Central server config uses `hosts:{}` plus `central` and `broker.endpointClients`; see `examples/bridge.central.json`. The central process refuses former configurations with daemon connections. Deploy a local endpoint on every target host using `examples/bridge.endpoint.json`. Each endpoint owns one local daemon connection; a direct localhost credential file may be referenced in its protected connection JSON without copying the daemon home.

Client E2EE JSON (shared by TypeScript and Go):

```json
{"version":1,"keyFile":"/protected/e2ee.key","hosts":{"aspen":"BASE64_RAW_X25519_PUBLIC_KEY","birch":"BASE64_RAW_X25519_PUBLIC_KEY"}}
```

TypeScript central profiles add `e2eeFile` pointing at that JSON. aicli configuration adds `e2ee_file` (or `PASEO_BRIDGE_E2EE_FILE`). Endpoint peers JSON:

```json
{"CLIENT_PUBLIC_KEY_SHA256_HEX":{"publicKey":"BASE64_RAW_X25519_PUBLIC_KEY","operations":["status","agents","workspaces","send","activity","wait"]}}
```

Upgrade endpoints and pinned client configurations before central cutover, then publish the broker image and upgrade both CLIs. During cutover old clients fail closed; do not retain a plaintext fallback. Stop old endpoint owners before upgrading. Keep backups of configuration and previous binaries. Endpoint replay and submission guards are retained; restarting or rolling back must never clear unresolved sends. The central chart projects only token digests, never daemon connection material or private keys. Unused provider backups require separate retirement authorization and are not mounted in the central runtime.

Verify negative crypto/frame/permission/replay tests, a Node-to-Go test, exact deployed image/CLI revisions and actual cross-host markers in both directions. Accepted messages and an idle agent are insufficient; confirm the matching assistant reply in authenticated activity. Do not use real credentials as test payloads.
