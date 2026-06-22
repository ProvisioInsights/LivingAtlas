# Knowledge Schema Runtime Integration

Status: Accepted for V1 planning  
Date: 2026-06-21

## Purpose

Integrate the two Living Atlas tracks into one implementation plan:

- Runtime architecture: storage, sync, encryption, MCP, policy, audit, and
  Cloudflare/local materialization.
- Temporal-edge knowledge model: graph semantics, edge/event ontology,
  bitemporal time, and Logseq/Obsidian migration.

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

`implementation-guide.md` wins over
`temporal-edge-model-SPEC.md` where the temporal-edge package differs.

## Unified Architecture

```text
Temporal-edge semantics
  predicates, events, dates, migration rules
  -> graph object bodies

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
- `source`
- open attributes such as `amount`, `role`, `condition`, `scope`, `note`

System/knowledge time such as `recorded-at` and `superseded-at` belongs in the
event/audit/change systems, not human-edited markdown.

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

Temporal edges and events are subject to the same access rules as all graph
objects:

| Schema Object | Default Access | Notes |
|---|---|---|
| personal/family edge | `local-private` | remote MCP sees no plaintext |
| sensitive life event | `local-private` | local/keyholding only |
| normal project/org edge | `local-private` unless classified | explicit promotion required |
| approved working-context edge | `remote-safe` | remote MCP can read/CRUD |
| release object | `release` | remote-readable until expiry/revocation |
| invalid/unmapped migration record | `quarantine` | review before use |

The predicate registry does not by itself make an edge remote-readable.

## Markdown Compatibility

The original temporal-edge package treated markdown as the source of truth for
the existing Logseq workflow. In Living Atlas V1, markdown is compatibility and
migration input, not the only runtime authority.

V1 implementation should support:

- importing Logseq/Obsidian-style markdown
- exporting readable markdown
- preserving `## Edges` sections where useful
- generating typed edge/event objects from markdown
- writing back to markdown only through explicit local/keyholding workflows

Cloudflare does not get sensitive plaintext merely because a markdown file
contains a typed edge.

## Safe Defaults For Open Temporal Decisions

The V1 defaults are:

1. `event` as edge endpoint: defer to V1.1.
2. Dormancy threshold: 365 days without `contact` or `engagement`.
3. `comparable-to`: attribute, not predicate.
4. Embeddings on edges: deferred.

## First Implementation Slice

Implement schema and runtime together on synthetic fixtures:

1. Synthetic temporal graph with people, orgs, locations, family/personal
   sensitivity, `founded-year`, suffix-hack examples, and mixed-precision
   dates.
2. Object envelope validator for edge/event objects.
3. Predicate/event registry validator.
4. Access-class policy evaluator.
5. Local-private leakage tests against remote-readable output.
6. Metadata/path leakage scanner.
7. Local MCP and remote MCP skeletons using the same edge/event object contract.

Do not run the real Logseq migration until synthetic tests pass.

## What To Defer

- Full Logseq migration over real pages.
- Event endpoints such as `attended` or `spoke-at`.
- Edge embeddings.
- Organization tenancy and federation.
- Remote semantic CRUD over sensitive plaintext.

## Acceptance Criteria

V1 schema/runtime integration is ready when:

- temporal edge/event fixtures serialize into runtime object envelopes
- invalid predicates are rejected before write
- direction-flipping aliases are rejected or echoed explicitly
- mixed-precision date comparisons produce deterministic results
- local-private edge/event objects never appear in remote-readable output
- Cloudflare-visible paths and manifests contain no sensitive titles/names/dates
- audit/change/live events can reference edge/event objects by opaque id
