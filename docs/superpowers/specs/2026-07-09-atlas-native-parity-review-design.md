# Atlas-Native Parity and Resolution Design

## Status

Proposed for implementation review.

## Goal

Make Living Atlas the canonical private knowledge service for Praxis. Convert the
existing Logseq-derived corpus into Atlas-native entities, facts, temporal
relationships, occurrences, and provenance without losing meaningful content.
Praxis remains the everyday experience. Atlas exposes the durable local service,
review workflow, policy enforcement, audit history, and recovery tooling.

## Product Language

The user-facing model is deliberately small:

- **Entities:** people, organizations, projects, locations, offerings, items,
  topics, and occurrences.
- **Facts and relationships:** typed, dated assertions about those entities.
- **Provenance:** why Atlas believes a fact, available on demand rather than as
  the primary surface.
- **Review:** a temporary local workflow for unresolved conversion or research
  decisions.

`page`, `block`, `note`, `source capsule`, `tombstone`, and `Logseq` are
implementation or migration terms. They must not appear in the normal Atlas or
Praxis experience.

## Decisions

1. Atlas is headless in daily use, with only private administration, recovery,
   and migration-review surfaces. Praxis owns the everyday UI.
2. One Atlas mutation service owns every durable create, update, and delete.
   Praxis and the review site submit typed intents; neither writes graph storage
   directly.
3. Parity is semantic, not verbatim. Formatting and exact Markdown wording need
   not survive, but every meaningful fact, distinction, condition, date,
   relationship, and contextual assertion must have an Atlas-native
   representation.
4. Temporary source context exists only in a local encrypted migration workspace.
   It is not part of the canonical graph and may be retired only after parity,
   recovery, and cutover gates pass.
5. A rejected interpretation never discards meaning. The item remains unresolved
   until an accepted normalized Atlas representation exists.
6. The review surface runs locally on this Mac. It is not hosted and it stores no
   authoritative state outside Atlas.
7. Research may use the owner’s logged-in LinkedIn session and public web pages
   for queue candidates. Automatic collection is limited to public professional
   facts and explicit relationships. Contact details, sensitive personal data,
   and inferred relationships remain held for review.

## Existing Building Blocks

The implementation must extend, rather than replace:

- `@living-atlas/graph-service` for one ingress-independent mutation boundary.
- `@living-atlas/local-graph-store` for encrypted local durability, versioning,
  and append-only mutation journal.
- `@living-atlas/local-mcp` for local authenticated CRUD and audit events.
- `@living-atlas/importer` and existing Logseq review packets for source
  discovery and initial candidates.
- `@living-atlas/contracts` temporal endpoint and relationship schemas.
- `@living-atlas/atlas-client` for Praxis consumption.

The existing importer’s `page`, `block`, and `source-capsule` objects are
migration input only. They are not the target canonical product model.

## Architecture

```text
temporary local migration workspace
  source context + surrounding context + coverage manifest
                 |
                 v
Atlas resolution service
  normalizes candidate -> validates schema -> finds corroboration
                 |                         |
          automatic decision          research task / owner review
                 |                         |
                 +-------------> Atlas mutation service
                                           |
                                           v
canonical encrypted Atlas graph
  entities + facts + edges + occurrences + provenance
                                           |
                                           v
Praxis experience and local admin/recovery surfaces
```

### Resolution Service

The resolution service is a new Atlas-local component. It accepts temporary
migration candidates and produces a durable review item with:

- a stable candidate id and source-unit coverage key;
- the original context and bounded surrounding context, encrypted locally;
- one or more proposed Atlas mutations;
- a recommendation state: `auto-apply`, `research`, `owner-review`, or
  `unresolved`;
- evidence records with source URL, retrieval time, evidence type, confidence,
  and field/relationship supported;
- the final decision and mutation/audit references when resolved.

It must be idempotent: rerunning the same conversion or research pass does not
create duplicate entities, edges, review items, or audit events.

### Recommendation Rules

Only a public professional fact or explicit relationship may be applied without
owner interaction. It requires both:

1. a schema-valid proposed Atlas mutation; and
2. either two independent public sources, or a LinkedIn profile plus an
   independent organization, project, or public-web source.

Existing canonical Atlas facts count as corroboration only when their
provenance is independent of the candidate being resolved. A recommendation
that does not meet this rule remains in `research` or `owner-review`; it is
never silently promoted.

Automatic changes are durable Atlas mutations and include provenance and audit
links. They appear in a reviewable audit/sample view but not in the owner’s
main queue.

### Local Review Site

The local Sites application is an Atlas client, not a second database. For each
item it shows:

- source context and nearby context;
- proposed entities, facts, relationships, or occurrences;
- supporting and conflicting evidence with links and dates;
- the recommendation, confidence, and why it was made;
- current parity status and any dependent items.

Allowed actions are approve, edit then approve, merge with an existing entity,
send to research, defer, and reject an interpretation. An item is only marked
resolved after the service records an Atlas-native representation that covers
its meaning.

Bulk actions are allowed only when selected items share an identical normalized
mutation template and evidence rule. The site must show the selected count,
the exact resulting mutations, and the source/evidence groups before a batch is
submitted. Bulk delete is not an action.

### Research Connectors

Research runs only for an existing review candidate. It may use the owner’s
signed-in LinkedIn session and public web pages. It stores only the minimum
facts necessary to support the candidate and their provenance; it does not
collect whole profiles, scrape a social graph, or import contact details.

Each research result records whether it supports, conflicts with, or is
insufficient for the proposed mutation. Failed or unavailable research is a
normal `research` outcome, not a reason to alter the candidate or source
coverage record.

## Canonical Data Model

The canonical graph contains only these product-level representations:

- endpoint entities using the existing temporal endpoint schema;
- typed temporal edge objects using the existing predicate registry;
- occurrence objects and temporal events where appropriate;
- provenance references attached to facts and relationships;
- bounded operational audit and review-resolution records.

Temporary migration context and raw source material are stored in the encrypted
local migration workspace, keyed by opaque identifiers. Canonical graph
objects reference provenance by opaque ids and normalized summaries, not by
Logseq paths, pages, or blocks.

## Parity and Cutover Gates

The cutover is blocked until all of these are true:

1. Every source coverage unit has an accepted Atlas-native representation.
2. There are zero `unresolved`, `research`, or `owner-review` items.
3. Every canonical object decrypts with the active local keyring.
4. Canonical mutation CRUD, restart persistence, idempotency, and audit tests
   pass against a copy of the real profile.
5. A full encrypted backup restores into an isolated copy with the same
   canonical parity manifest and object/relationship counts.
6. No active canonical object depends on a temporary migration object.
7. The owner accepts the final parity report.

Only after those gates pass may the temporary migration workspace be removed.
The existing Logseq archive remains untouched until this user-approved cutover;
it is not modified by the migration process.

## Non-Goals

- Rebuilding Praxis in this repository.
- Hosting the review site or placing private review data in a third-party
  database.
- Bulk social-profile collection.
- Auto-applying sensitive personal facts, contact details, or inferred
  relationships.
- Physically deleting the existing personal profile or original Logseq archive
  during implementation.

## Acceptance Criteria

- The canonical graph has no visible Logseq page/block/source-capsule concepts.
- Every migration source unit is represented by a parity record and reaches an
  accepted canonical result before cutover.
- Research-backed automatic mutations are reproducible, provenance-linked,
  idempotent, and audited.
- The local review site supports individual and safeguarded bulk resolution.
- The owner-facing queue contains only `owner-review` items; research and
  automatic decisions are separately inspectable.
- A full end-to-end run happens against a copied profile, never the live
  `personal-prod` profile, before any cutover action.
