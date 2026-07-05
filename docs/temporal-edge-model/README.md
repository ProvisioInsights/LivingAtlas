# Temporal Edge Model

Status: Integrated knowledge-schema package  
Date: 2026-06-21

## Purpose

This folder contains the knowledge semantics for Living Atlas:

- typed edge ontology
- entity/endpoint schema
- event ontology
- occurrence and recurrence design
- bitemporal time semantics
- predicate registry
- migration rules from the existing Logseq/Obsidian-style graph

It is the authority for what graph facts mean.

It is not the authority for where graph data lives, how Cloudflare/local sync
works, which runtime can decrypt sensitive data, or which MCP can access which
objects. Those concerns are governed by the architecture docs under
`docs/architecture/`.

## Read Order

1. `implementation-guide.md`
2. `entity-temporal-schema-map.md`
3. `schema-properties.md`
4. `schema-edges.md`
5. `schema-events.md`

Historical rationale:

- `temporal-edge-model-SPEC.md`

`implementation-guide.md` wins where it differs from the SPEC.
The SPEC is design rationale, not the implementation contract.

## Integration Rule

Use this package as the knowledge layer:

```text
temporal edge/event semantics
  -> graph object body
  -> runtime envelope
  -> access class
  -> encryption class
  -> sync/audit/change systems
```

See `../architecture/knowledge-schema-runtime-integration.md` for the
bridge between this package and the Living Atlas runtime.

## Safe V1 Defaults

- Implemented temporal edge endpoints are `person`, `organization`, `project`,
  `location`, `occurrence`, `topic`, `offering`, and `item`.
- Use `occurrence`, not `event`, for graph happenings so knowledge happenings
  remain distinct from runtime audit/sync/change events.
- Broad `concept`, `source`, and `cluster` are not temporal edge endpoints.
  Sources remain provenance/storage metadata; concepts remain tags/indexes
  unless explicitly promoted to controlled `topic`; clusters remain derived
  views. Concrete documents, tickets, reservations, receipts, devices, rooms,
  seats, and deliverables use `item` when intentionally promoted.
- Dormancy threshold: 365 days.
- `comparable-to`: attribute, not predicate.
- Edge embeddings: deferred.

## Implementation Warning

Do not import or rewrite the real personal graph first.

Start with synthetic fixtures that exercise the temporal model and the privacy
model together. Real Logseq/Obsidian migration waits until policy, leakage,
sync, conflict, key, and audit tests pass.
