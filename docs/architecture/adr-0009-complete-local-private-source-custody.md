# ADR 0009: Complete Local-Private Source Custody

Status: Accepted for implementation
Date: 2026-07-10

## Context

Living Atlas is replacing Logseq as the owner’s knowledge store. Excluding
sensitive personal facts or contact details from canonical migration would make
the resulting graph incomplete and would force the owner to keep a second,
legacy source of truth.

At the same time, source sensitivity must not make private material broadly
visible, remotely readable, or eligible for unrelated third-party collection.

## Decision

Every meaningful source-corpus unit is migrated into canonical Atlas custody.
Sensitive personal facts and contact details are in scope. They receive
`local-private` access classification by default and retain source/evidence
provenance, content coverage, and encryption under the local keyholding
boundary.

When a source unit can be represented without interpretation, the migration may
write a canonical entity, fact, relationship, occurrence, evidence, or review
record. When identity, structure, date, predicate, or truth remains uncertain,
the migration writes a bounded canonical unresolved observation and parity
record. It must not omit the source unit or invent certainty.

External research remains candidate-scoped. It may not bulk-collect social
profiles, scrape a social graph, or collect new contact details solely because
they are available. This boundary does not restrict migration of content already
present in the owner source corpus.

Sensitive canonical records remain accessible only through authenticated local
Atlas paths unless a separate explicit classification and audit decision changes
that access class. Public availability does not change a derived record from
`local-private`.

## Consequences

Positive:

- Atlas can become the complete private knowledge store instead of a selective
  shadow of the prior corpus.
- Sensitive data receives the same provenance, backup, restore, and parity
  guarantees as other knowledge.
- Ambiguity is visible and reviewable without withholding the underlying
  meaning.

Negative:

- The local review surface and backup/restore proofs must support sensitive
  payloads without exposing plaintext outside the local keyholding boundary.
- Migration fixtures must cover private local-only facts and contact details.

## Rejected Alternatives

### Exclude Sensitive Material From Migration

Rejected because it leaves Logseq as a required second source of truth and
violates semantic parity.

### Treat Sensitivity As Proof That a Claim Is Uncertain

Rejected because access classification and epistemic confidence are independent
properties. A sensitive but clearly stated source claim can be a local-private
canonical fact.

### Collect Any Additional Contact Data Found During Research

Rejected because source-corpus migration and third-party collection are separate
activities with different necessity and privacy boundaries.

## Verification

- Synthetic fixtures prove sensitive facts and contact details migrate as
  encrypted `local-private` records with provenance and parity coverage.
- Remote-safe and metadata projections cannot reveal their payload details.
- Backup and isolated restore reproduce their object ids, hashes, access
  classes, and parity counts without plaintext leakage.
- An uncertain sensitive source statement becomes a bounded unresolved
  observation rather than being omitted or fabricated.
