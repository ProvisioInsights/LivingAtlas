# ADR 0006: Atomic Review Resolution Commands And Honest Receipts

Status: Accepted for implementation planning
Date: 2026-07-09

## Context

Resolving one migration or research candidate may create or update an entity,
fact, relationship, evidence record, review record, and parity record. Existing
object and edge batches execute individual operations sequentially and can
partially succeed. Local sync-outbox enqueue also happens after the graph object
has committed, so an enqueue failure can make a durable local mutation appear to
have failed completely.

That behavior is acceptable for an explicitly partial administrative batch. It
is not safe for one semantic resolution decision.

## Decision

The Atlas mutation service will expose one typed `resolution_apply` command for
each review item. The command carries:

- a stable operation id and idempotency key;
- the candidate id and expected review-record version;
- the expected graph generation;
- the complete, schema-valid mutation set;
- the resulting coverage and resolution states; and
- the actor, recommendation, and evidence references needed for audit.

The service prevalidates the entire set, including referential integrity,
access-class rules, ontology rules, identity redirects, and parity coverage. It
then commits the set as one local graph transaction or one atomically replayable
write-ahead record. The review item cannot become resolved unless all canonical
knowledge changes and the parity record are part of that commit.

Audit and sync records use the same operation id and are idempotently derived
from the committed transaction. Recovery can reconstruct missing audit or outbox
entries from the durable operation record. A post-commit audit or outbox problem
does not change a committed result into a reported non-commit.

The receipt reports separate truth:

- `local_commit`: committed or not committed;
- `audit`: recorded or reconciliation required; and
- `sync_queue`: queued, not configured, or reconciliation required.

Bulk review is an orchestration of independent per-item resolution transactions.
It may report partial success across different candidates, but one candidate can
never be partially resolved. Retrying a bulk operation is safe because each item
has its own idempotency key.

Generic `object_batch` and `edge_batch` remain explicitly partial administrative
tools and must not be used to implement semantic review approval or entity merge.

## Consequences

Positive:

- A resolved review item always corresponds to a complete canonical result.
- Crash recovery and retry do not create duplicate or half-applied knowledge.
- Local custody and sync custody are reported honestly instead of being
  conflated.
- Bulk review stays bounded without requiring a graph-wide distributed
  transaction.

Negative:

- The local graph journal needs a transaction or operation-group record.
- Audit/outbox reconciliation becomes an explicit subsystem responsibility.
- Clients must handle a committed-local but reconciliation-required receipt.

## Rejected Alternatives

### Reuse Sequential Object And Edge Batches

Rejected because their intentional per-item failure semantics violate the
resolution invariant.

### Roll Back With Compensating Deletes

Rejected because crashes can interrupt compensation and because destructive
compensation obscures assertion lineage.

### Require One Transaction Across Local Storage And Cloudflare

Rejected as unnecessary and unavailable. The local semantic commit is atomic;
sync remains an idempotent custody transition with explicit status.

## Verification

- Failure injection at every write boundary produces either the complete
  resolution or no resolution for that candidate.
- Replaying the same idempotency key produces no duplicate objects, audit events,
  or outbox records.
- An outbox failure after local commit returns `local_commit=committed` and is
  repaired by reconciliation.
- Concurrent stale review or generation writes fail before any mutation is
  applied.
