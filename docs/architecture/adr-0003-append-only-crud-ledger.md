# ADR 0003: Append-Only CRUD Ledger

Status: Accepted for V1 planning  
Date: 2026-06-21

## Context

The operator wants to see when create, read, update, and delete operations occur
on the knowledge graph. Existing local MCP behavior already records write
activity, write intents, and checkpoints. The next system must generalize this
to reads, remote access, sync, policy decisions, and derived projection changes.

## Decision

Living Atlas will maintain a durable audit ledger for security and provenance.
It records reads, writes, deletes, sync-relevant security events,
classification, policy decisions, decrypts, key/device events, releases, and
export.

Mutation ordering for sync lives in the sync change log. Near-live UI animation
lives in the live activity stream. These systems share operation ids but are not
one database.

The ledger is not a secondary source of truth for note content. It is the
evidence trail of interactions with the graph.

## Event Shape

```json
{
  "event_id": "evt_...",
  "recorded_at": "2026-06-21T00:00:00Z",
  "operation": "read",
  "actor": {
    "kind": "remote_provider",
    "id": "remote-ai-client",
    "client_id": "..."
  },
  "device_id": "trusted-device-id",
  "scope": "remote-safe",
  "object": {
    "kind": "chunk",
    "id": "opaque_chunk_id",
    "source_ref": "opaque_source_id"
  },
  "policy": {
    "decision": "allow",
    "rule": "remote-safe"
  },
  "tool_call_id": "...",
  "request_id": "...",
  "before_hash": null,
  "after_hash": null,
  "event_hash": "...",
  "checkpoint_id": "chk_..."
}
```

## Required Events

- `create`
- `read`
- `search`
- `query`
- `update`
- `delete`
- `archive`
- `redact`
- `supersede`
- `classify`
- `sync-push`
- `sync-pull`
- `decrypt`
- `export`
- `policy-allow`
- `policy-deny`
- `quarantine`

## Storage

V1 should maintain:

- Local append-only JSONL ledger outside the graph root.
- Optional daily journal summary inside the graph for human visibility.
- Append-only records plus periodic integrity checkpoints for tamper evidence.
- Checkpoint references for write recovery.

Remote ledgers should avoid sensitive plaintext. They can store opaque object
IDs, actor IDs, provider IDs, policy names, and request IDs.

At high volume, read events may be aggregated or sampled for local non-sensitive
activity, but remote reads, denials, decrypts, releases, key/device events, and
policy changes remain security-relevant audit events.

## Consequences

Positive:

- The operator can audit remote reads, not just writes.
- Agent actions become reviewable.
- Policy denials become visible.
- Reconstructing "what touched this fact" becomes possible.

Negative:

- Read logging can be high-volume.
- Ledger storage may itself reveal sensitive access patterns.
- UI filtering is required so the ledger is useful, not noisy.

## Open Questions

- Should local reads by the operator be sampled or fully logged?
- Should read events store result counts only or object IDs?
- Should the ledger be mirrored into encrypted cloud storage?
- Should a remote read notification be immediate, batched, or configurable?
