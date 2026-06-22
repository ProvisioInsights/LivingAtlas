# CRUD Observability

## Purpose

Living Atlas must let the operator see when knowledge is created, read,
updated, deleted, archived, redacted, synced, exported, classified, or denied.

Visibility is part of the product, not just debug logging.

## What Counts As CRUD

### Create

- New page.
- New block.
- New journal entry.
- New edge.
- New event.
- New attachment.
- New generated chunk.
- New remote-readable object.
- New release object.

### Read

- Page read.
- Block read.
- Search result returned.
- Graph traversal returned.
- Atlas panel loaded source detail.
- Remote provider retrieved a snippet.
- Remote provider queried remote-readable data or a release object.
- Sync agent decrypted local object.

### Update

- File edit.
- Property edit.
- Edge superseded.
- Event correction appended.
- Policy label changed.
- Derived index rebuilt.
- Release regenerated.

### Delete

- Page archived.
- Block removed.
- Attachment removed.
- Edge invalidated.
- Event superseded.
- Remote object tombstoned.
- Key revoked.
- Release expired.

## Event Sources

- Local MCP.
- Remote MCP.
- File watcher.
- Sync agent.
- Praxis UI/client.
- CLI importer.
- Browser/mail/calendar capture tools.
- Manual filesystem edits detected after the fact.

## Ledger Layers

### Low-Level Ledger

Append-only JSONL, machine-readable, outside graph root.

Purpose:

- Durable event capture.
- Append-only records with periodic integrity checkpoints.
- Recovery metadata.
- Testable audit trail.

### Human Activity Feed Projection

Rendered by Praxis or another authorized consumer from Atlas event streams.

Purpose:

- What changed recently?
- Which agent touched this?
- What did a remote provider read?
- What was blocked?

### Daily Journal Summary

Optional summarized bullets written to local journal.

Purpose:

- Human memory and lightweight review.
- Not the sole audit source.

## Ledger Event Fields

Required:

- `event_id`
- `recorded_at`
- `operation`
- `actor_kind`
- `actor_id`
- `client_id`
- `device_id`
- `mcp_profile`
- `object_kind`
- `object_id`
- `object_label`
- `policy_decision`
- `policy_rule`
- `request_id`
- `event_hash`
- `checkpoint_id`

Optional:

- `tool_call_id`
- `source_path_hash`
- `before_hash`
- `after_hash`
- `result_count`
- `checkpoint_commit`
- `sync_generation`
- `release_id`
- `denial_reason`

## Privacy of the Ledger

The ledger can leak sensitive patterns. Store plaintext detail locally only.

Remote ledger records should use opaque IDs and coarse event categories unless
the relevant content is classified as remote-safe.

## Headless Consumer Requirements

Atlas must emit and expose enough bounded, redacted stream data for Praxis to
build:

- Recent activity feed.
- Per-object history.
- Remote access feed.
- Denied access feed.
- Policy changes feed.
- Diff links for writes where possible.
- Recovery links for checkpointed writes.

The emitted fields must let consumers distinguish:

- Human action.
- Local agent action.
- Remote provider action.
- Automated sync/index action.
- Manual file edit detected by watcher.

## Validation

Tests must prove:

- Read operations emit events.
- Denied reads emit events.
- Writes emit before/after hashes.
- Delete/archive emits tombstone event.
- Ledger checkpoint verification detects tampering or missing segments.
- Remote event payloads do not include private plaintext.
