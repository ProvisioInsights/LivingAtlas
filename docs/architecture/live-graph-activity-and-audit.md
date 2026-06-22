# Live Graph Activity And Audit

Status: Draft  
Date: 2026-06-21

## Purpose

Living Atlas must show how the knowledge graph is being accessed and changed in
near real time, while preserving a repeatable audit trail. The visual target is
the "neurons firing" effect: when a query, traversal, write, sync, or release
touches the graph, the operator can see which nodes and edges lit up and why.

This is not only visual polish. It is part of trust, debugging, provenance, and
access control.

## Core Requirement

Every meaningful graph operation should produce the right events in the right
subsystem:

```text
Sync change log       -> mutation/version record for sync and conflicts
Durable audit event   -> repeatable security/provenance record
Live activity event   -> near-real-time UI/inspection signal
```

The same operation id links them. See `event-subsystems.md` for retention and
schema boundaries.

## Layered View

```mermaid
flowchart TB
  classDef cloud fill:#dbeafe,stroke:#2563eb,color:#111827
  classDef local fill:#dcfce7,stroke:#16a34a,color:#111827
  classDef activity fill:#fef3c7,stroke:#d97706,color:#111827
  classDef graph fill:#f8fafc,stroke:#475569,color:#111827
  classDef ui fill:#f3e8ff,stroke:#7e22ce,color:#111827

  subgraph Ingress["Ingress"]
    Remote["Remote CRUD/query"]:::cloud
    Local["Local CRUD/query"]:::local
  end

  subgraph Policy["Policy + Graph Execution"]
    Capability["Capability check"]:::graph
    Traversal["Graph traversal / read / write"]:::graph
    Change["Change log append"]:::graph
  end

  subgraph Activity["Activity Event Fabric"]
    Live["Live activity stream\nlow-latency, bounded retention"]:::activity
    Audit["Durable audit ledger\nappend-only, replayable"]:::activity
    Correlator["operation_id / trace_id\nlinks live + durable"]:::activity
  end

  subgraph UI["Living Atlas"]
    Fire["Near-live firing view\nnodes, edges, paths light up"]:::ui
    Replay["Replay mode\nreconstruct prior activity"]:::ui
    Inspect["Inspector\nwho, what, why, policy, CRUD diff"]:::ui
  end

  Remote --> Capability
  Local --> Capability
  Capability --> Traversal
  Traversal --> Change
  Traversal --> Live
  Change --> Audit
  Live --> Correlator
  Audit --> Correlator
  Correlator --> Fire
  Correlator --> Replay
  Correlator --> Inspect
```

## What Must Light Up

The live view should show:

- nodes read
- edges traversed
- files or objects opened
- search result candidates
- final returned context
- writes created
- updates applied
- deletes/tombstones
- sync pushes and pulls
- remote-denied sensitive objects
- releases/projections created
- future federated graph boundaries crossed, after V1

The operator should be able to see both:

- the attempted path: what the operation tried to touch
- the allowed path: what policy actually allowed

## CRUD Event Types

Minimum event types:

| Event | Meaning | Live UI | Durable Audit |
|---|---|---:|---:|
| `create` | object created | yes | yes |
| `read` | object returned or inspected | yes | yes for remote/security-sensitive, sampled/aggregated for local if desired |
| `search` | search executed | yes | yes |
| `traverse` | graph path followed | yes | yes |
| `update` | object changed | yes | yes |
| `delete` | object deleted/tombstoned | yes | yes |
| `sync-push` | local/remote change pushed | yes | yes |
| `sync-pull` | local/remote change pulled | yes | yes |
| `decrypt` | sensitive object decrypted locally | yes local-only | yes local-only |
| `policy-allow` | access granted | optional | yes |
| `policy-deny` | access denied/withheld | yes | yes |
| `release` | local output published remotely | yes | yes |
| `federate` | future projection/grant crosses authority boundary | later | later |

## Event Shape

Every graph activity event should include enough structure to animate and audit
the operation without leaking sensitive plaintext into the wrong plane.

```json
{
  "event_id": "evt_...",
  "operation_id": "op_...",
  "trace_id": "trace_...",
  "recorded_at": "2026-06-21T00:00:00Z",
  "plane": "remote | local | sync | future-federation",
  "actor": {
    "kind": "remote_ai | local_ai | user | sync | system",
    "id": "opaque_actor_id"
  },
  "mcp": {
    "profile": "remote | local",
    "tool": "search"
  },
  "crud": "read",
  "policy": {
    "decision": "allow | deny | partial | ciphertext-only",
    "rule": "remote-readable"
  },
  "graph_touch": {
    "nodes": ["node_opaque_1"],
    "edges": ["edge_opaque_1"],
    "objects": ["obj_opaque_1"],
    "path": ["node_opaque_1", "edge_opaque_1", "node_opaque_2"]
  },
  "change": {
    "before_hash": null,
    "after_hash": null,
    "version": "v123"
  },
  "visibility": {
    "remote_safe": true,
    "contains_sensitive": false,
    "redacted": false
  }
}
```

Sensitive local-only event detail can be stored in the local audit ledger while
remote audit only receives opaque/redacted identifiers.

## Near-Live Stream vs Durable Audit

### Live Activity Stream

Purpose:

- animate graph activity
- show active query paths
- help operator understand what an agent is touching
- give a "brain firing" experience

Properties:

- low latency
- bounded retention
- may aggregate high-volume local reads
- should avoid private plaintext in remote plane
- emits bounded summaries for large traversals instead of one pulse per object

### Durable Audit Ledger

Purpose:

- repeat exactly what happened
- answer who/what/when/why/how
- support rollback/recovery
- support security review
- support replay mode

Properties:

- append-only
- queryable by operation id, actor, object, time, MCP profile, policy decision
- includes CRUD diffs or hashes
- includes sync and conflict events
- stores local-sensitive details only locally or encrypted

### Sync Change Log

Purpose:

- converge Cloudflare and local materializations
- detect conflicts
- provide compaction input
- preserve mutation/version order

Properties:

- mutation-only
- generation/cursor aware
- contains content hashes and versions, not read traffic
- retained according to compaction watermarks

## Replay Requirements

Replay must be able to reconstruct:

- which nodes and edges were touched
- which paths were traversed
- which data was returned
- which writes changed the graph
- what was denied
- what synced between Cloudflare and local
- what release made sensitive-origin content remote-readable

Replay should support:

- by operation
- by actor
- by time window
- by object
- by graph authority
- by remote vs local plane

## Visual Semantics

Suggested colors:

- blue: remote/Cloudflare-accessible activity
- green: local trusted activity
- red: sensitive encrypted/local-decrypt-only activity
- amber: audit, sync, policy, conflict
- purple: AI/provider/client actor
- gray: withheld, denied, or redacted path

Suggested animation:

- pulse node on read
- sweep edge on traversal
- glow node/edge on returned context
- flash outline on write/update
- fade to tombstone marker on delete
- dashed pulse on denied/withheld object
- amber ripple on sync
- split path when conflict is detected

## Product Surfaces

Living Atlas should include:

- **Live Activity**: near-real-time graph firing view.
- **Operation Inspector**: selected operation with actor, MCP, policy, objects,
  path, returned context, and CRUD effects.
- **Replay Timeline**: scrub prior activity.
- **CRUD Ledger**: table view of create/read/update/delete/sync/release events.
- **Sync Health**: local and Cloudflare convergence state.
- **Sensitive Touches**: local-only view showing decrypt/read activity for
  sensitive objects.
- **Remote Access**: remote reads, remote writes, denied sensitive touches, and
  releases.

## Architecture Rule

Do not bolt this on later as logging. Event emission is part of the graph
runtime:

```text
MCP tool call
  -> capability check
  -> graph execution
  -> live activity event
  -> change/audit event
  -> sync
  -> replayable UI
```

If an operation cannot be observed and replayed, it is not production-grade for
Living Atlas.
