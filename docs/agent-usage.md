# Agent usage

Use `paseo-bridge`, not a new temporary direct Paseo connection on every invocation. The resident service owns connection lifecycle. Select `--profile local` or `--profile central` explicitly when comparing deployments; neither silently falls back to the other.

1. Query `status --host all`; inspect each host's state. Query `workspaces --host HOST` and `agents --host HOST`; select the exact host and exact agent ID based on operator intent. A workspace is context for selection, not a message destination.
2. Obtain permission for the specific prompt/destination. Write prompt content to an appropriately protected file. Do not put credentials or secrets in the prompt.
3. `send --host HOST --agent ID --prompt-file FILE`. Busy is an error: wait or report it; never add `--interrupt` automatically. Do not send to `all`.
4. If accepted, optionally `wait --host HOST --agent ID --timeout 120`, then `activity --host HOST --agent ID --tail 20`. A wait does not bind to a particular request ID; verify the expected content/marker in activity. Wait uses SSE by default with read-only reconnects within one total deadline. Explicit `--wait-mode poll` selects snapshot polling; neither mode retries prompts or falls back on forbidden/authentication errors. The state result's lastMessage is null; reading replies requires activity permission.
5. If send is unknown or the client connection fails, **do not automatically retry**. Check activity and coordinate with the operator. A timeout does not prove a prompt was not accepted. An unresolved submission blocks further sends with SEND_UNCERTAIN across restarts; ask the operator to reconcile it. Do not clear guards yourself, restart to bypass them, or treat idle as proof of non-delivery.
6. Present the reply to the user. Do not autonomously forward it to another agent, initiate recursive conversation, or invent subsequent work.

Exit codes: 0 = successful API operation/accepted send; 1 = invalid request/error; 2 = partial query, uncertain send, or wait timeout. `status` can exit 0 with disconnected hosts, and a completed agent can have an error result; inspect JSON fields rather than relying only on the process exit code. JSON stdout is machine-readable; errors go to stderr. No prompt/credential content appears in Bridge logs.

Example:

```sh
paseo-bridge --profile central agents --host aspen --json
paseo-bridge --profile central send --host aspen --agent EXACT_ID --prompt-file /protected/request.txt
paseo-bridge --profile central wait --host aspen --agent EXACT_ID --timeout 120
paseo-bridge --profile central activity --host aspen --agent EXACT_ID --tail 20
```

Central tokens may authorize only selected hosts/operations. `all` queries show only hosts permitted to that token. Do not work around a forbidden response by switching to a more privileged local profile. Ask the operator for the appropriate access or perform only the permitted operation.
