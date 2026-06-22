# Temporal Edge Model

Status: Integrated knowledge-schema package  
Date: 2026-06-21

## Purpose

This folder contains the knowledge semantics for Living Atlas:

- typed edge ontology
- event ontology
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
2. `schema-properties.md`
3. `schema-edges.md`
4. `schema-events.md`

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

- `event` as edge endpoint: defer to V1.1.
- Dormancy threshold: 365 days.
- `comparable-to`: attribute, not predicate.
- Edge embeddings: deferred.

## Implementation Warning

Do not import or rewrite the real personal graph first.

Start with synthetic fixtures that exercise the temporal model and the privacy
model together. Real Logseq/Obsidian migration waits until policy, leakage,
sync, conflict, key, and audit tests pass.
