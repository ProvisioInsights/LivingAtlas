# ADR 0007: Evidence-Backed Entity Resolution And Reversible Merges

Status: Accepted for implementation planning
Date: 2026-07-09

## Context

Logseq migration, connectors, Praxis capture, and public professional research
can produce several names, handles, accounts, or records that may refer to the
same person or organization. The review design allows merging with an existing
entity, but the current entity schema has no durable resolution, redirect, merge,
or split contract.

A destructive merge can orphan relationships or make a mistaken identity match
impossible to explain and reverse.

## Decision

Living Atlas will use this identity pipeline:

```text
observed identifier
  -> source/evidence record
  -> entity-resolution candidate
  -> explicit resolution decision
  -> canonical entity reference
```

Names, handles, URLs, provider ids, email addresses, and other identifiers are
observations with provenance. They are not themselves proof that two entities
are identical. Sensitive identifiers remain encrypted and local-private unless
explicitly classified otherwise.

An `atlas.entity-resolution:v1` record contains the observed identifiers,
candidate entity ids, supporting and conflicting evidence, confidence
assessment, decision, actor, recorded time, and any superseded resolution ids.
No merge is automatic unless a separate documented rule has schema-valid,
high-confidence evidence and is explicitly authorized for that identifier type.

A merge keeps every entity id durable. The selected canonical entity becomes
the query target through a derived redirect index; the other entity is not
physically deleted and existing facts or relationships are not rewritten merely
to hide the duplicate. New writes resolve the redirect and target the canonical
entity.

A mistaken merge is reversed by a new split resolution that supersedes the merge
and updates the derived redirect view. The original evidence, decision, entity
ids, facts, and relationships remain inspectable.

Merge and split decisions use the atomic resolution command from ADR 0006.

## Consequences

Positive:

- Identity decisions are explainable and reversible.
- Existing graph references survive merge and split operations.
- Import, connectors, research, and Praxis capture share one identity boundary.
- Atlas avoids silently combining different people with similar names or shared
  accounts.

Negative:

- Queries must resolve canonical redirects.
- Duplicate entities remain in historical storage even when hidden from normal
  views.
- Some identity decisions remain in review when evidence is insufficient.

## Rejected Alternatives

### Rewrite Every Reference And Delete The Duplicate

Rejected because partial failure can orphan data and a mistaken merge becomes
destructive.

### Treat Matching Names Or Profile URLs As Identity

Rejected because names are not unique and identifiers can be recycled, shared,
or incorrectly attributed.

### Let AI Prompts Decide Merges Without A Durable Record

Rejected because identity policy must be enforced and audited in Atlas, not left
to model behavior.

## Verification

- Merge preserves all pre-existing fact and relationship references.
- Normal reads resolve both ids to the selected canonical entity without
  deleting either historical entity.
- Split restores separate entity views without reconstructing deleted data.
- Duplicate retries do not create redirect cycles or multiple active decisions.
- Access tests prove sensitive identifiers and resolution evidence stay outside
  remote-safe projections.
