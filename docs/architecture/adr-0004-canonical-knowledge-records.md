# ADR 0004: Canonical Knowledge Records And Versioned Payloads

Status: Accepted for implementation planning
Date: 2026-07-09

## Context

Living Atlas must become the canonical knowledge service for Praxis without
carrying Logseq pages, blocks, or source capsules into the product model. The
runtime envelope can safely store and sync arbitrary encrypted payloads, but the
current knowledge contracts have no first-class scalar fact or evidence record.
Typed entities are also persisted through the legacy `page` object type and
`logseq-*` payload discriminants.

Keeping sourced attributes inside one mutable entity makes provenance,
classification, conflict handling, and independent synchronization operate at
the wrong granularity. Leaving canonical payloads as generic JSON also forces
Praxis and future consumers to understand importer-specific shapes.

## Decision

Living Atlas will keep the existing encrypted graph envelope and add a small,
versioned canonical knowledge layer in `@living-atlas/contracts`:

- `atlas.entity:v1` is the stable identity spine for a person, organization,
  project, location, occurrence, topic, offering, or item. It contains identity
  and display fields, not an accumulating bag of sourced facts.
- `atlas.fact:v1` is a first-class assertion about one entity. It contains a
  registered predicate, a discriminated typed value, valid-time fields when
  applicable, knowledge-time lineage, evidence links, and confidence.
- `atlas.observation:v1` is a bounded normalized statement used only when source
  meaning cannot yet be represented safely as a structured fact, relationship,
  or occurrence. It may reference candidate entities but does not invent a
  subject, predicate, date, or certainty. A later resolution supersedes it.
- `atlas.relationship:v2` extends the existing temporal-edge contract with the
  same knowledge-time, evidence, and confidence spine used by facts.
- `atlas.evidence:v1` describes the bounded source material used to support,
  refute, or contextualize an assertion.
- `atlas.entity-resolution:v1` records identity candidates, merge/split
  decisions, and canonical redirects.
- `atlas.review-item:v1` and `atlas.parity-record:v1` support migration and
  review operations without becoming user-facing knowledge concepts.

The runtime object type registry will add `entity`, `assertion`, `evidence`, and
`review`. Fact and observation payloads use the `assertion` type. Existing
`edge`, `event`, `manifest`, `audit`, `change`, `index`, and `config` types
remain. Legacy `page`, `block`, and importer payloads remain readable only as
migration input and are never emitted as new canonical records.

An observation is not a general-purpose note, document, page, or authoring
container. It is one bounded semantic statement with provenance, explicit
unresolved state, and the same privacy and lineage rules as other assertions.

Every canonical decrypted payload carries its own schema discriminator. The
envelope `schema_version` continues to version the storage envelope; it does not
stand in for a knowledge-payload version. For encrypted private objects, a
Cloudflare-visible namespace must remain absent or coarse enough that it does
not reveal entity type, predicate, person, project, or topic.

Praxis and other normal clients use typed entity, fact, relationship, timeline,
and resolution contracts through `@living-atlas/atlas-client`. Generic object
CRUD remains an administrative and infrastructure boundary.

Generated graph views, search indexes, preferred display labels, and resolved
redirect indexes are rebuildable projections. They are not independent sources
of truth.

## Consequences

Positive:

- Facts and unresolved observations with different provenance or privacy can
  coexist without being bundled into one entity.
- Independent facts synchronize and conflict independently.
- Praxis and other clients receive stable domain contracts rather than import
  payloads.
- Logseq concepts can be removed from the canonical graph without replacing
  them with a disguised note/page abstraction.

Negative:

- Endpoint fields that currently encode sourced facts need a controlled
  migration into fact or relationship objects.
- Readers must support legacy and canonical payloads during the migration
  window.
- Additional objects increase object counts, although they reduce mutation and
  conflict blast radius.

## Rejected Alternatives

### Add More Fields And Source Arrays To Entity Objects

Rejected because conflicting assertions, per-fact access classes, and
independent sync would still share one mutable object boundary.

### Keep `page` And `block` As Generic Internal Names

Rejected because downstream code already branches on those names and would
preserve the migration model as a hidden product contract.

### Adopt RDF, OWL, Or A New Graph Database

Rejected for this phase. Versioned Zod contracts inside the existing encrypted
object architecture provide the required semantics without a speculative
storage rewrite.

## Verification

- Canonical contract tests accept every supported record, including an
  unresolved observation with no invented entity, and reject unknown
  unversioned payloads.
- No newly written canonical object uses a `page`, `block`, `logseq-*`, or
  source-capsule payload kind.
- Canonical export and fresh import preserve ids, content hashes, access classes,
  assertion lineage, and evidence links.
- A remote metadata-leakage test proves private payload schema and semantic type
  are not exposed through visible metadata.
