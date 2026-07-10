# Atlas-Native Parity and Resolution Design

## Status

Accepted for implementation planning.

## Governing Decisions

This design is governed by:

- `docs/architecture/adr-0004-canonical-knowledge-records.md`
- `docs/architecture/adr-0005-assertion-lineage-and-evidence.md`
- `docs/architecture/adr-0006-atomic-resolution-commands.md`
- `docs/architecture/adr-0007-evidence-backed-entity-resolution.md`
- `docs/architecture/adr-0008-semantic-parity-and-cutover.md`
- `docs/architecture/adr-0009-complete-local-private-source-custody.md`

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
- **Review:** a private local workflow for unresolved conversion or research
  decisions.

`page`, `block`, `note`, `source capsule`, `tombstone`, and `Logseq` are
implementation or migration terms. They must not appear in the normal Atlas or
Praxis experience.

## Decisions

1. Atlas is headless in daily use, with only private administration, recovery,
   and migration-review surfaces. Praxis owns the everyday UI.
2. One Atlas mutation service owns every durable create, update, and delete.
   Praxis and the review site submit typed intents; neither writes graph storage
   directly. Resolving one review item is one atomic semantic transaction.
3. Parity is semantic, not verbatim. Formatting and exact Markdown wording need
   not survive, but every meaningful fact, distinction, condition, date,
   relationship, and contextual assertion must have an Atlas-native
   representation.
4. Temporary source context exists only in a local encrypted migration workspace.
   It is not part of the canonical graph and may be retired only after parity,
   recovery, and cutover gates pass.
5. A rejected interpretation never discards meaning. The source unit remains
   unrepresented until a canonical fact, relationship, occurrence, normalized
   text assertion, or unresolved observation preserves its meaning.
6. The review surface runs locally on this Mac. It is not hosted and it stores no
   authoritative state outside Atlas.
7. Migration preserves every meaningful source-corpus statement, including
   sensitive personal facts and contact details, as encrypted `local-private`
   Atlas knowledge with provenance and parity coverage. Sensitivity never makes
   source material ineligible for migration. When its structure or truth is
   uncertain, Atlas stores a bounded unresolved observation rather than guessing
   or dropping it.
8. Entities are stable identity spines. Sourced attributes, confidence,
   provenance, and privacy live on first-class facts or relationships rather
   than accumulating inside one mutable entity object.
9. Entity merge and split decisions are evidence-backed, durable, reversible,
   and never delete historical entity ids or silently rewrite references.
10. Parity coverage and truth resolution are separate. Cutover requires all
    source meaning to be represented, but it does not require Atlas to invent an
    answer to a genuinely unknowable ambiguity.

## Existing Building Blocks

The implementation must extend, rather than replace:

- `@living-atlas/graph-service` for one ingress-independent mutation boundary.
- `@living-atlas/local-graph-store` for encrypted local durability, versioning,
  and append-only mutation journal.
- `@living-atlas/local-mcp` for local authenticated CRUD and audit events.
- `@living-atlas/importer` and existing Logseq review packets for source
  discovery and initial candidates.
- `@living-atlas/contracts` as the owner of versioned canonical entity, fact,
  observation, relationship, evidence, identity-resolution, review, and parity
  schemas.
- `@living-atlas/atlas-client` for Praxis consumption.

The existing temporal endpoint and edge schemas are the starting point, not the
complete canonical contract. The importer’s `page`, `block`, `source-capsule`,
`logseq-endpoint`, and `logseq-temporal-edge` payloads are migration input only.
New canonical writes never emit them.

## Architecture

```text
temporary local migration workspace
  source context + surrounding context + coverage manifest
                 |
                 v
Atlas resolution service
  normalizes candidate -> validates schema -> resolves identity -> finds corroboration
                 |                         |
          automatic decision          research task / owner review
                 |                         |
                 +-------------> Atlas mutation service
                                           |
                                           v
canonical encrypted Atlas graph
  entities + facts + observations + edges + occurrences + evidence + resolution lineage
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
- a recommendation state: `auto-apply`, `research`, or `owner-review`;
- a coverage state, representation kind, and resolution state;
- evidence records with encrypted locator, content hash, retrieval time,
  publisher/upstream identity, independence group, evidence type, and bounded
  excerpt or snapshot reference;
- evidence links that state whether each record supports, refutes, or only
  contextualizes a proposed assertion;
- structured confidence assessments that distinguish extraction, identity,
  evidence, and final assertion confidence;
- the final decision and mutation/audit references when resolved.

It must be idempotent: rerunning the same conversion or research pass does not
create duplicate entities, facts, observations, relationships, evidence,
review items, or audit events.

### Atomic Resolution

Each review decision is submitted through one `resolution_apply` command with a
stable operation id, idempotency key, expected graph generation, expected review
version, and complete mutation set. The service validates every entity, fact,
observation, relationship, evidence, review, and parity change before committing
any of them.

The result reports local commit, durable audit, and sync-queue state separately.
A sync or outbox problem after local commit is reconciliation-required, not a
false report that the local mutation never happened.

Bulk review submits independent atomic commands per review item. It may report
partial success across separate candidates, but one candidate can never be
partially resolved.

### Recommendation Rules

Deterministic conversion of owner-source material may create a schema-valid,
encrypted `local-private` fact, relationship, evidence record, or unresolved
observation without owner interaction when it preserves source meaning without
guessing. Third-party research may automatically add a public professional fact
or explicit relationship only when it requires both:

1. a schema-valid proposed Atlas mutation; and
2. either two independent public sources, or a LinkedIn profile plus an
   independent organization, project, or public-web source.

Source independence is determined by evidence independence-group keys, not URL
count. Copies of the same press release or upstream record count once.

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

Merge creates an evidence-backed entity-resolution record and a rebuildable
canonical redirect. It does not delete either entity or rewrite historical
references. A later split supersedes the merge decision.

Bulk actions are allowed only when selected items share an identical normalized
mutation template and evidence rule. The site must show the selected count,
the exact resulting mutations, and the source/evidence groups before a batch is
submitted. Bulk delete is not an action.

### Research Connectors

Research runs only for an existing review candidate. It may use the owner’s
signed-in LinkedIn session and public web pages. It stores only the minimum
facts necessary to support the candidate and their provenance; it does not
collect whole profiles or scrape a social graph. Contact details already present
in the owner source migrate with their meaning and provenance, but research does
not collect additional contact details merely because they are available.

The evidence workspace stores a content hash and bounded encrypted excerpt or
snapshot sufficient to reproduce the decision if the source later changes.
Evidence and research-derived facts default to `local-private`; public
availability alone never promotes an access class.

Each research result records whether it supports, conflicts with, or is
insufficient for the proposed mutation. Failed or unavailable research is a
normal `research` outcome, not a reason to alter the candidate or source
coverage record.

## Canonical Data Model

The canonical graph contains only these product-level knowledge
representations:

- `atlas.entity:v1` stable identity records using the existing endpoint types;
- `atlas.fact:v1` first-class structured assertions;
- `atlas.observation:v1` bounded normalized statements for source meaning that
  cannot yet be structured without guessing;
- `atlas.relationship:v2` typed temporal relationships using the existing
  predicate registry plus knowledge-time and evidence lineage;
- occurrence objects and temporal events where appropriate;
- `atlas.evidence:v1` immutable bounded evidence records;
- `atlas.entity-resolution:v1` immutable identity decisions; and
- bounded operational review, parity, audit, and change records.

Facts, observations, and relationships are append-only semantic assertions.
Corrections, retractions, invalidations, and reinstatements create new
assertions with lineage links instead of overwriting the prior meaning. Queries
expose world valid time (`valid_at`) and system knowledge time (`known_at`)
independently.

An observation is not a note or page. It is one bounded, provenance-linked
statement with explicit unresolved state. Resolving it creates structured
knowledge that supersedes the observation without deleting its history.

Each canonical decrypted payload has a versioned schema discriminator. The
storage envelope version remains separate. Canonical private payload type and
semantic details must not leak through Cloudflare-visible metadata.

Temporary migration context and raw source material are stored in the encrypted
local migration workspace, keyed by opaque identifiers. Canonical graph
objects reference provenance by opaque ids and normalized summaries, not by
Logseq paths, pages, or blocks.

Praxis and other ordinary clients use typed entity, fact, observation,
relationship, timeline, provenance, and resolution APIs through
`@living-atlas/atlas-client`. Raw object CRUD is reserved for administration and
infrastructure.

## Parity and Cutover Gates

The cutover is blocked until all of these are true:

1. Every source coverage unit has `coverage_state=represented` with canonical
   object ids and provenance.
2. There are zero partially applied or failed resolution transactions.
3. Every open `research`, `owner-review`, or `deferred-unknown` item references
   a canonical unresolved observation and no longer depends on temporary source
   storage.
4. Every canonical object decrypts with the active local keyring.
5. Canonical mutation CRUD, restart persistence, idempotency, and audit tests
   pass against a copy of the real profile.
6. A full encrypted backup restores into an isolated copy with the same
   canonical parity manifest, resolution counts, ids, content hashes, and
   object/relationship counts.
7. No active canonical object uses a legacy page/block/Logseq payload or depends
   on a temporary migration object.
8. The owner accepts the final parity and open-resolution report.

Only after those gates pass may the temporary migration workspace be removed.
The existing Logseq archive remains untouched until this user-approved cutover;
it is not modified by the migration process.

## Non-Goals

- Rebuilding Praxis in this repository.
- Hosting the review site or placing private review data in a third-party
  database.
- Bulk social-profile collection.
- Omitting, downgrading, or withholding sensitive source-corpus facts or
  contact details from encrypted local-private canonical custody.
- Physically deleting the existing personal profile or original Logseq archive
  during implementation.
- Replacing the current encrypted object store with RDF, OWL, or a new graph
  database.
- Making embeddings, generated indexes, or resolved display projections a
  canonical source of truth.

## Acceptance Criteria

- No new canonical object uses a page, block, `logseq-*`, or source-capsule
  payload kind.
- Every migration source unit is represented by a parity record and canonical
  knowledge object before cutover; unresolved truth is preserved explicitly
  rather than guessed or dropped.
- Sensitive source-corpus facts and contact details are represented as encrypted
  local-private canonical knowledge with provenance; they are never excluded
  from parity solely because of their sensitivity.
- Contradictory assertions can coexist, and correction lineage returns correct
  `valid_at` and `known_at` results after restart, compaction, backup, and
  restore.
- Research-backed automatic mutations are reproducible, provenance-linked,
  independence-aware, idempotent, audited, and local-private by default.
- Failure injection at every resolution boundary produces either one complete
  candidate resolution or no candidate resolution.
- Merge and split preserve all entity ids, facts, and relationship references.
- The local review site supports individual and safeguarded bulk resolution.
- The owner-facing queue contains only `owner-review` items; research and
  automatic decisions are separately inspectable.
- Canonical export and fresh import preserve ids, content hashes, access classes,
  assertion lineage, and evidence links.
- A full end-to-end run happens against an isolated copy, never the live owner
  profile, before any cutover action.
