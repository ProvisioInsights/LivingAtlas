# ADR 0005: Bitemporal Assertion Lineage, Evidence, And Confidence

Status: Accepted for implementation planning
Date: 2026-07-09

## Context

Living Atlas needs to answer both when a fact was true in the world and when the
system believed it. The current edge contract has valid time but only one source
string and one `high`/`medium`/`low` confidence value. Operational audit and
change journals record mutations, but their retention and compaction rules are
not a safe knowledge-history contract.

Research-backed promotion also requires independent corroboration. URLs and
retrieval timestamps alone cannot prove independence or reproduce a decision
after a page changes.

## Decision

Canonical facts and relationships are append-only semantic assertions.
Correcting, retracting, invalidating, or reinstating knowledge creates a new
assertion record; it does not overwrite the old assertion's meaning.

Every fact and relationship assertion records:

- an opaque assertion id;
- subject, registered predicate, and typed value or target entity;
- world-valid interval using the existing mixed-precision and half-open time
  rules;
- a full machine `recorded_at` knowledge timestamp;
- a lineage action such as assert, correct, retract, invalidate, or reinstate;
- zero or more `supersedes` assertion ids;
- evidence links carrying `supports`, `refutes`, or `context` stance; and
- a structured confidence assessment.

The current assertion view is derived from the append-only lineage. A
`superseded_by` index may be materialized for query speed, but it is rebuildable.
Compacting runtime mutation journals must not remove assertion lineage.

Evidence records are immutable and local-private by default. They include:

- source kind and encrypted canonical locator;
- content hash and a bounded encrypted excerpt or snapshot reference;
- observed, published, and retrieved times when known;
- publisher or upstream-source identity and an independence-group key; and
- enough extraction metadata to reproduce why the evidence was linked.

Two URLs count as independent only when their evidence records have different
independence groups. A copy of the same press release or upstream record is one
source, regardless of how many sites repeat it.

Confidence is an assessment, not a property of an entity. It includes a band,
assessment kind, method or actor/model identifier, assessment time, evidence
references, and bounded rationale. Identity-match confidence, extraction
confidence, evidence reliability, and final assertion confidence remain
distinguishable.

Facts, relationships, and evidence each receive an object-level access class.
All new knowledge defaults to `local-private`. Public research does not
automatically make a derived assertion remote-readable. Any less-restrictive
classification is a separate explicit policy decision and audit event.

Queries expose `valid_at` and `known_at` independently and can include or exclude
disputed, retracted, or superseded assertions explicitly.

## Consequences

Positive:

- Contradictory evidence and assertions can coexist without destructive
  overwrite.
- Atlas can reconstruct knowledge history after journal compaction and restore.
- Automatic research decisions are reproducible and cannot double-count copied
  sources.
- Sensitive and public facts about the same entity no longer share one access
  boundary.

Negative:

- Current-state queries require a lineage-aware projection.
- Evidence capture needs strict size, privacy, and retention limits.
- Corrections create more objects than in-place field mutation.

## Rejected Alternatives

### Use The CRUD Audit Ledger As Knowledge History

Rejected because the audit ledger records system interaction, can be redacted or
aggregated, and has different retention rules from knowledge truth.

### Keep One Confidence Enum On Each Entity Or Edge

Rejected because it collapses distinct assessments and provides no reproducible
basis for a promotion decision.

### Store Only Live URLs As Evidence

Rejected because sources change, disappear, and repeat common upstream material.

## Verification

- Correct, retract, invalidate, and reinstate fixtures preserve every prior
  assertion and return correct `valid_at` and `known_at` views.
- The same queries return the same result after restart, graph-journal
  compaction, backup, and restore.
- Corroboration tests reject two URLs with one independence group.
- Remote-safe projections cannot reveal local-private assertions, evidence,
  excerpts, locators, or semantic metadata.
