# Knowledge Schema Runtime Integration

Status: Accepted for V1 planning  
Date: 2026-06-21

## Purpose

Integrate the two Living Atlas tracks into one implementation plan:

- Runtime architecture: storage, sync, encryption, MCP, policy, audit, and
  Cloudflare/local materialization.
- Canonical knowledge model: entities, facts, temporal relationships,
  occurrences, evidence, identity resolution, bitemporal time, and source
  migration.

These are hand in hand. The runtime is not useful without a real knowledge
model; the knowledge model is not safe or scalable without the runtime
architecture.

## Authority Rule

When documents conflict:

| Concern | Governing Docs |
|---|---|
| where data lives | runtime architecture docs |
| who can access/decrypt data | security/key/MCP docs |
| sync, conflicts, compaction | runtime architecture docs |
| object envelopes and manifests | runtime architecture docs |
| predicates, endpoint types, edge/event meaning | temporal-edge docs |
| valid-time/system-time semantics | temporal-edge docs |
| Logseq migration decode maps | temporal-edge docs |
| canonical entity/fact/evidence payloads | ADR 0004 and ADR 0005 |
| entity merge/split semantics | ADR 0007 |
| parity and cutover semantics | ADR 0008 |

`implementation-guide.md` wins over
`temporal-edge-model-SPEC.md` where the temporal-edge package differs.
ADRs 0004 through 0008 supersede both for canonical payload boundaries,
assertion/evidence lineage, atomic resolution, entity resolution, and parity
cutover. The temporal-edge guide continues to govern predicate direction,
endpoint types, mixed-precision world time, and half-open interval semantics.

## Unified Architecture

```text
Canonical knowledge semantics
  entities, facts, relationships, evidence, dates, migration rules
  -> versioned graph object bodies

Runtime architecture
  envelopes, access classes, encryption, sync, MCP, audit
  -> graph object custody and access

Living Atlas V1
  one logical graph
  Cloudflare complete byte custody
  complete local replica
  remote-readable CRUD through Cloudflare MCP
  sensitive plaintext through local/keyholding clients only
```

## Mapping Entities And Facts To Runtime Objects

Every canonical entity, fact, and bounded observation is stored in the existing
runtime envelope. Entities use `object_type = entity`; facts and observations
use `object_type = assertion`. Their encrypted payloads use the versioned
schemas defined by ADR 0004.

An entity is a stable identity spine. Sourced values that may change, conflict,
carry different provenance, or require different access rules are fact objects,
not additional mutable entity fields.

Each fact is an append-only assertion with world-valid time, machine knowledge
time, structured confidence, evidence links, and supersession lineage. The
runtime change log records custody and mutation ordering; it is not the only
record of knowledge history.

When source meaning cannot be safely structured without inventing an entity or
fact, an `atlas.observation:v1` assertion preserves one bounded normalized
statement and its provenance. It is not a general note/page container and is
superseded when later resolution produces structured knowledge.

## Mapping Temporal Edges To Runtime Objects

Every temporal edge becomes a graph object with two layers:

### Runtime Envelope

Owned by the runtime architecture:

- `object_id`
- `authority_id`
- `object_type = edge`
- `access_class`
- `encryption_class`
- `base_version`
- `new_version`
- `content_hash`
- `change_id`
- `created_at`
- `updated_at`

### Knowledge Body

Owned by the knowledge model:

- `src`
- `predicate`
- `dst`
- `valid-from`
- `valid-to`
- derived `status`
- `recorded-at`
- lineage action and `supersedes`
- evidence links and structured confidence
- open attributes such as `amount`, `role`, `condition`, `scope`, `note`

Knowledge time and assertion lineage belong in the canonical relationship body.
Operational audit/change systems record who performed the mutation and how it
moved through custody, but graph-journal compaction must not erase the knowledge
lineage.

## Mapping Evidence And Identity Resolution

Evidence uses `object_type = evidence` and is immutable, encrypted, and
`local-private` by default. It contains bounded source material, content hashes,
retrieval times, upstream independence groups, and extraction metadata.

Identity decisions use the versioned entity-resolution body from ADR 0007. A
merge creates a durable resolution and a rebuildable redirect; it does not
delete historical entity ids or rewrite every existing graph reference.

## Mapping Events To Runtime Objects

Every temporal event becomes either:

- an event graph object, when it is part of the knowledge graph, or
- an audit/change event, when it is part of system provenance.

Temporal-event body fields:

- `subject`
- `kind`
- `occurred-on`
- `occurred-until`
- optional `predicate` and `object`
- `source`
- `detail`
- `supersedes`

Runtime fields still wrap it:

- object id
- access class
- encryption class
- authority id
- version
- content hash
- change id

## Access Classes Apply To Schema Objects

Facts, temporal relationships, events, and evidence are subject to the same
access rules as all graph objects:

| Schema Object | Default Access | Notes |
|---|---|---|
| personal/family edge | `local-private` | remote MCP sees no plaintext |
| sensitive life event | `local-private` | local/keyholding only |
| normal project/org edge | `local-private` unless classified | explicit promotion required |
| fact assertion | `local-private` | classified independently from its entity |
| evidence record | `local-private` | public availability does not imply remote readability |
| approved working-context edge | `remote-safe` | remote MCP can read/CRUD |
| release object | `release` | remote-readable until expiry/revocation |
| invalid/unmapped migration record | `quarantine` | review before use |

The predicate registry does not by itself make an edge remote-readable.

## Source Migration Boundary

The original temporal-edge package treated markdown as the source of truth for
the existing Logseq workflow. In Living Atlas, Logseq/Obsidian markdown, pages,
blocks, and source capsules are migration inputs only. They do not remain a
canonical authoring or runtime model.

Migration tooling may parse source markdown and produce temporary encrypted
review context. Only versioned Atlas entity, fact, relationship, occurrence,
evidence, identity-resolution, review, and parity records cross the canonical
write boundary. Canonical export uses those versioned contracts; any readable
markdown export is a derived, non-authoritative projection.

## Safe Defaults For Open Temporal Decisions

The V1 defaults are:

1. `event` as edge endpoint: defer to V1.1.
2. Dormancy threshold: 365 days without `contact` or `engagement`.
3. `comparable-to`: attribute, not predicate.
4. Embeddings on edges: deferred.

## First Implementation Slice

Implement schema and runtime together on synthetic fixtures:

1. Synthetic canonical graph with entities, facts, unresolved observations,
   relationships, occurrences, evidence, contradictory claims, identity
   merge/split, personal sensitivity, and mixed-precision dates.
2. Object envelope and versioned-payload validators for canonical objects.
3. Predicate/event registry validator.
4. Access-class policy evaluator.
5. Local-private leakage tests against remote-readable output.
6. Metadata/path leakage scanner.
7. Typed local client graph access and remote MCP remote-readable graph access
   using the same canonical contracts.
8. Atomic review-resolution and parity coverage tests.

Do not write canonical changes to the live personal profile until synthetic and
copied-profile tests pass.

## What To Defer

- Event endpoints such as `attended` or `spoke-at`.
- Edge embeddings.
- Organization tenancy and federation.
- Remote semantic CRUD over sensitive plaintext.
- Physical deletion of the original Logseq archive.

## Acceptance Criteria

V1 schema/runtime integration is ready when:

- entity/fact/relationship/evidence fixtures serialize into versioned runtime
  object envelopes
- invalid predicates are rejected before write
- direction-flipping aliases are rejected or echoed explicitly
- mixed-precision date comparisons produce deterministic results
- local-private fact/relationship/evidence objects never appear in
  remote-readable output
- Cloudflare-visible paths and manifests contain no sensitive titles/names/dates
- audit/change/live events can reference canonical objects by opaque id
- append-only assertion lineage survives graph-journal compaction and restore
- canonical exports and parity manifests contain no page/block/Logseq payloads
