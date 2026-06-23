# MCP Tools

Living Atlas exposes one canonical MCP tool catalog through both local and
remote ingress.

- Local ingress is stdio/local process delivery.
- Remote ingress is Cloudflare HTTP delivery.
- Tool names are the same in both places.
- Ingress, capability, access mode, and key custody determine what a tool can
  actually see or mutate.

The source of truth for exact JSON schemas is
`packages/mcp-contract/src/index.ts`.

## Access Modes

| Mode | Typical ingress | Sensitive plaintext | Notes |
|---|---|---|---|
| `remote-safe-only` | Remote HTTP | No | Default remote MCP mode. Can CRUD remote-readable graph data only. |
| `cloud-unlock-session` | Remote HTTP | Yes, only for that request/session | Requires normal auth plus an explicit unlock key/capability. The key is not stored by Cloudflare. |
| `local-keyholding-only` | Local stdio | Yes, if local policy allows | Local clients hold keys and can access the full authorized graph. |

Remote and local share names, but they do not share authority. A remote client
does not become local just because it calls the same tool name.

## Tool Catalog

| Tool | Kind | Mutates graph | Purpose |
|---|---|---:|---|
| `access_modes` | control | No | Describe the access modes available for the current request. |
| `activity_read` | audit | No | Read recent activity/audit events with remote-safe redaction. |
| `sensitive_decrypt` | keyholding | No | Decrypt a sensitive object only when current mode and policy allow it. |
| `status` | graph | No | Read object counts and reconciliation state for an authority. |
| `reconcile` | graph | No | Compare graph index state with committed sync state. |
| `object_list` | object | No | List graph object envelopes visible to the caller. |
| `object_read` | object | No | Read one graph object envelope by id. |
| `object_create` | object | Yes | Create one graph object idempotently. |
| `object_update` | object | Yes | Update one graph object with optional optimistic version guard. |
| `object_delete` | object | Yes | Tombstone one graph object with optional optimistic version guard. |
| `object_batch` | object | Yes | Run bounded object create/update/delete operations. |
| `search` | query | No | Deterministic text/metadata search. Vector search can replace the scorer later. |
| `traverse` | query | No | Traverse typed edge objects from a start object. |
| `timeline` | query | No | Query objects and edges by created, updated, valid, or event time. |
| `edge_create` | edge | Yes | Create a typed temporal edge as a graph object. |
| `edge_read` | edge | No | Read a typed temporal edge by `edge_id`. |
| `edge_update` | edge | Yes | Update a typed temporal edge with optional optimistic version guard. |
| `edge_delete` | edge | Yes | Tombstone a typed temporal edge. |
| `edge_batch` | edge | Yes | Run bounded edge create/update/delete operations. |
| `sync_status` | sync | No | Read sync cursor and counts for the authenticated authority. |
| `sync_pull` | sync | No | Read committed sync batch summaries after a generation. |
| `sync_envelopes` | sync | No | Read committed sync envelopes after a generation. Sensitive content stays ciphertext unless mode allows decrypt. |
| `usage_gate` | operations | No | Read observed usage and decide whether live testing should continue. |
| `usage_reconcile` | operations | No | Compare app-observed usage with provider-native inventory exposed through bindings. |

## Object CRUD

Object tools operate on graph object envelopes. The important client rules are:

- Use `object_create` for one object and `object_batch` for bounded bulk writes.
- Use `idempotency_key` on every remote mutation the client may retry.
- Use `expected_version` on updates/deletes when the client has a prior version.
- Delete means tombstone, not physical erase.
- Remote writes must stay within the caller's capability and access class.

`object_batch` accepts create, update, and delete items. A batch is scoped to one
`authority_id`; item-level authority overrides must match that authority.

## Edge CRUD

Edge tools operate on typed temporal edges stored as graph objects.

Required edge fields:

- `edge_id`
- `source_object_id`
- `source_type`
- `target_object_id`
- `target_type`
- `predicate`
- `valid_from`
- `source`

Supported endpoint types:

- `person`
- `organization`
- `project`
- `location`
- `occurrence`
- `topic`

Use `attrs.schedule.recurrence_set` for RFC 5545 recurrence lines. Do not use
legacy split recurrence field names at the top level of `attrs`.

## Batch Behavior

Batch tools reduce MCP/Worker request count. They do not make underlying
storage meters disappear.

| Ingress | Max items | Max payload |
|---|---:|---:|
| Remote HTTP | 10 | 1 MiB |
| Local stdio | 100 | 1 MiB |

Batch responses are per item:

- `requested_items`
- `accepted_items`
- `failed_items`
- `results[]`
- `usage_estimate.worker_requests_saved_vs_single_item`

If a batch-level `idempotency_key` is supplied, Living Atlas derives stable
child keys in the `la_idem_*` namespace. Per-item keys may also be supplied.

For Cloudflare deployments, batching primarily saves Worker/MCP request count.
D1 rows, R2 operations, KV keys, Queue messages, and Vectorize dimensions still
bill or count according to their own provider meters.

## Activity And Praxis

Praxis should treat Living Atlas as the knowledge service, not as the UI.

Recommended Praxis integration:

1. Use `sync_status` for coarse connection and convergence state.
2. Use `activity_read` for the live CRUD/activity stream.
3. Use `object_*` and `edge_*` for direct graph mutation.
4. Use `search`, `traverse`, and `timeline` for graph retrieval.
5. Use `usage_gate` before live Cloudflare test runs.

Activity entries are the right source for "neurons firing" views: reads,
creates, updates, deletes, sync movement, and replayable audit context.

## Production Data Updates

Production graph updates should not be migrated just because the MCP catalog
changed. The safe order is:

1. Deploy the new MCP contract and Worker/local code.
2. Run `usage_gate` and a tiny live MCP smoke.
3. Confirm Praxis or other clients use the canonical tool names.
4. Freeze broad writes from older clients.
5. Prefer local MCP durable writes for large/personal updates, then immediately
   drain the local sync outbox to Cloudflare in bounded batches.
6. Verify parity through `status`, `reconcile`, `sync_status`,
   `sync_envelopes`, and `activity_read`.
7. Resume normal writes.

For personal data, prefer small batches with explicit checkpoints over one large
migration. The migration should be restartable, idempotent, and auditable from
the activity stream.

When local and Cloudflare are both online, the side that mutates should start a
bidirectional push handshake immediately after commit. Local updates push local
outbox work toward Cloudflare; remote updates announce the new generation to
linked local replicas. A slow fixed-interval sync loop is only a
watchdog/recovery fallback, not the normal update path.

Clients must assume simultaneous CRUD can happen. Independent-object changes
should converge automatically. Same-object concurrent edits should create
conflict records, not overwrite either side.
