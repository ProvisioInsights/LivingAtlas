# Compaction And Retention

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

Define how append-only changes, tombstones, snapshots, audit records, and
long-offline clients coexist.

Without this contract, compaction can break sync catch-up or destroy audit
replay.

## Core Rule

Compaction never silently erases history needed by active clients or audit
policy.

Compaction produces:

- sealed object/graph segments
- current-state snapshots
- retained tombstone metadata
- compaction audit events
- watermarks for client catch-up

## Tombstones

Deletes first create tombstones.

Tombstone contains:

- object id
- object type
- authority id
- deleted version
- deletion time
- actor id
- access class
- content hash of deleted payload when safe
- retention/erasure policy

Tombstones are retained long enough for:

- offline clients to learn about deletions
- conflict detection
- audit/replay
- recovery where allowed

## Watermarks

Every client tracks a sync watermark:

- last generation seen
- last compacted snapshot applied
- pending segments
- client id/device id

Compaction must know the oldest supported watermark. If a client is older than
the retained change log, it must catch up through a bounded snapshot path rather
than raw log replay.

## Long-Offline Clients

When a client returns after logs were compacted:

1. Compare client generation with retained watermarks.
2. If changes are retained, replay missing change segments.
3. If changes are compacted, download a current snapshot/segment set.
4. Reconcile local queued changes against the snapshot.
5. Produce conflict records where needed.

Do not require downloading every historical change.

## Cryptographic Erasure

Cryptographic erasure means removing the ability to decrypt content, not merely
deleting a row.

For sensitive objects:

- tombstone first
- remove object from current indexes
- remove or destroy relevant DEK/key wrapping when erasure is approved
- preserve minimal tombstone metadata for sync/audit if policy allows

## Release Retention

Releases are remote-readable and security-sensitive.

V1 release expiry:

- release content is deleted or encrypted under an expired release key
- remote indexes drop expired release content
- expiry writes an audit/change event

Read-path date checks alone are not sufficient.

## Audit Retention

Audit records are graph-sensitive metadata.

V1:

- keep security-critical audit events
- redact remote audit for sensitive objects
- checkpoint integrity periodically

Later:

- Merkle proof/checkpoint verification
- policy-based archival

## Compaction Events

Every compaction job writes an audit event:

- source segments
- output segments
- watermark
- tombstone count
- erased object count
- authority
- policy applied
- operator/system actor

## Open Parameters

These must be configured before implementation:

- tombstone retention window
- long-offline client support window
- snapshot cadence
- release expiry default
- audit retention window
- compaction batch size
