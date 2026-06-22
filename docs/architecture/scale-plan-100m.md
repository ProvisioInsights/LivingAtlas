# 100M Scale Plan

Status: Draft  
Date: 2026-06-21

## Purpose

Plan Living Atlas for 100M graph objects from the start, even if v1 starts with
a much smaller personal graph.

The goal is to avoid a design that works for 1,000 markdown files but collapses
when the system grows into many devices, organizations, projects, and future
federation scale.

## Core Decision

Files/objects are the durable sync and recovery layer. They are not the query
engine.

```text
Durable object store
  stores graph objects, sensitive ciphertext envelopes, snapshots, segments

Append-only change log
  records mutations, tombstones, versions, and policy changes for sync

Compaction layer
  folds changes into immutable segments and current-state indexes

Query/index layer
  serves Atlas, MCP, search, graph traversal, audit, and replay
```

No production query path should require scanning all raw files or all raw
objects.

## Scale Targets

| Scale | Meaning | Required Architecture |
|---:|---|---|
| 100 | early fixture | plain files acceptable |
| 1,000 | small personal graph | simple local index acceptable |
| 100,000 | serious personal/org graph | sharded objects, local DB indexes, incremental sync |
| 1,000,000 | large graph | segmented storage, compaction, partitioned indexes |
| 100,000,000 | platform-scale graph | segment architecture, distributed/partitioned indexes, no raw scans |

V1 can run small, but every storage and API boundary should be compatible with
the 100M design.

## Object Model At Scale

Treat every durable entity as a graph object:

- node
- edge
- event
- file/blob
- attachment
- release
- audit event
- change event
- future policy grant/projection

Every object has:

- stable object id
- authority id
- object type
- access class
- encryption class
- version
- content hash
- segment id
- created/updated/deleted timestamps

The exact node/edge schema can evolve later. The scale envelope must exist
first.

## Storage Layout

### Cloudflare Custody

Cloudflare stores complete graph bytes:

```text
r2://living-atlas/
  manifests/
    a=<opaque-authority>/current.json
    a=<opaque-authority>/g=<generation_id>.json

  changes/
    a=<opaque-authority>/
      g=<generation>/
        seg=<id>.bin

  objects/
    a=<opaque-authority>/
      p=<hash-partition>/
        o=<object-id>.bin

  segments/
    a=<opaque-authority>/
      p=<partition-id>/
        s=<segment-id>.bin

  indexes/
    a=<opaque-authority>/
      g=<generation_id>/
        idx=<opaque-index-id>.bin
```

At small scale, some folders can be empty. The layout still points the system
toward segmented operation and avoids leaking titles, names, dates, or
semantically meaningful object types in Cloudflare-visible paths.

### Local Replica

Local storage mirrors the same logical structure but may use optimized local
databases:

```text
~/.living-atlas/
  objects/
  changes/
  segments/
  indexes/
    graph.sqlite
    search.sqlite
    audit.sqlite
    atlas.duckdb
  keyring/
  cache/
```

Local MCP and Atlas query indexes, not raw object files.

## Change Log

Every mutation appends a change event. Reads do not belong in the sync change
log; reads are audit/activity events.

```json
{
  "change_id": "chg_...",
  "operation": "create | update | delete | tombstone | restore | policy-change",
  "authority_id": "person:john",
  "object_id": "obj_...",
  "object_type": "node",
  "base_version": "v122",
  "new_version": "v123",
  "content_hash": "sha256:...",
  "access_class": "remote-safe | local-private | shareable | quarantine | release",
  "encryption_class": "remote-readable | sensitive-client-encrypted | release | local-only-index",
  "actor_id": "actor_...",
  "mcp_profile": "remote | local",
  "recorded_at": "2026-06-21T00:00:00Z"
}
```

Deletes are tombstones first. Compaction may later remove obsolete data under
policy.

## Segments And Compaction

At 100M, object-per-file alone is too expensive for listing, indexing, and
small-object overhead. Use immutable segments:

```text
change events -> hot object shards -> compacted immutable segments -> indexes
```

Segment rules:

- immutable once sealed
- content-addressed
- partitioned by authority, type, time, and hash range
- sensitive payloads encrypted at object level; segments may also be encrypted
  as containers
- mixed-access segments must not require remote-readable keys to unlock
  sensitive payloads
- accompanied by a segment manifest
- can be downloaded independently for local sync

Compaction jobs:

- fold small objects into larger segments
- apply tombstones
- build current-state indexes
- preserve audit/change history
- produce new generation manifests

## Indexes Required From Day One

Do not wait until scale pain to add indexes. Even v1 should use index contracts.

Required index families:

| Index | Purpose |
|---|---|
| by-id | object lookup |
| by-type | nodes, edges, events, audit, releases |
| by-authority | personal/org/project partitioning |
| by-access-class | local-private, remote-safe, shareable, quarantine, release |
| by-time | timeline, sync, audit, replay |
| by-edge-src | graph traversal out |
| by-edge-dst | graph traversal in |
| by-change | version and conflict detection |
| full-text-local | local plaintext search |
| full-text-remote | remote-readable search only, if enabled |
| activity | live/replay graph firing |

Remote indexes must not contain sensitive plaintext. Local indexes can include
sensitive plaintext only if stored locally or encrypted with local keys.

Remote audit indexes must also be redacted for sensitive objects. They may store
opaque ids, coarse categories, operation ids, and timestamps, but not sensitive
titles, relationship labels, path names, snippets, embeddings, or exact denied
object names.

## Query Path

### Remote MCP Query

```text
remote MCP
  -> capability check
  -> remote-readable index
  -> fetch allowed objects/segments
  -> append activity/audit event
```

Remote MCP never scans all objects.

### Local MCP Query

```text
local MCP
  -> capability check
  -> local indexes
  -> decrypt sensitive objects as needed
  -> append activity/audit event
```

Local MCP can build richer indexes because it has access to local keys.

## Sync At 100M

Sync must be generation and segment based:

```text
1. Read current graph manifest.
2. Compare local generation/cursors.
3. Download missing change segments and object/graph segments.
4. Verify hashes.
5. Apply to local indexes.
6. Upload local changes as change segments.
7. Resolve conflicts through version vectors or explicit conflict records.
```

Do not sync by listing the entire object store.

Offline support is mandatory:

- local can advance while Cloudflare/network is unavailable
- Cloudflare can advance while a laptop is off
- each side records its own generation and queued changes
- reconnect compares cursors and exchanges missing change/object segments
- divergent edits become explicit conflict records
- conflict resolution is itself a change event
- long-offline clients use retained change segments when available, otherwise a
  bounded snapshot/segment catch-up path

## Full Sync Definition

"Remote and local stay in full sync" means:

- both have the same logical graph generation or know exactly which generation
  gap exists
- both have all object bytes they are responsible for storing
- sensitive data remains ciphertext remotely
- local can reconstruct plaintext for authorized sensitive objects
- indexes can be rebuilt from manifests + segments + change log
- conflicts are represented as first-class records

It does not mean every client keeps every hot index in memory.

## Live Activity At 100M

The "neurons firing" view cannot subscribe to all activity globally at 100M.
It needs scoped streams:

- current operation
- current actor
- current graph authority
- current workspace/project
- current visible subgraph
- recent time window

Activity events should be partitioned by:

- authority
- actor
- object id hash
- time
- access class

Replay queries use the activity/audit index, not a scan of the audit log.

High-volume reads must aggregate. A traversal that touches 10,000 candidates
should emit bounded activity summaries and sampled drilldown records, not
10,000 live UI pulses by default.

## Performance Budgets

Initial planning targets:

| Operation | Target |
|---|---:|
| object lookup by id | p95 < 50 ms local, < 200 ms remote |
| local indexed search, 100k objects | p95 < 500 ms |
| local indexed search, 1M objects | p95 < 1.5 s |
| remote allowed-object query | p95 < 750 ms for bounded result sets |
| visible-subgraph traversal | p95 < 1 s for bounded depth/result size |
| live activity event fanout | p95 < 250 ms to local UI |
| sync cursor check | p95 < 500 ms |
| incremental sync apply | proportional to changed segments, not graph size |

100M-object operations must be bounded by partition, index, and query limit.
Unbounded graph-wide interactive queries are not a v1 guarantee.

## Design Rules

- No feature may require scanning all files live.
- No feature may require listing all R2 objects live.
- No feature may require loading the full graph into browser memory.
- Every query must declare a scope, limit, and access class.
- Every index must be rebuildable from the durable log/segments.
- Every remote index must be provably free of sensitive plaintext.
- Every Cloudflare-visible path must pass the metadata leakage budget.
- Every mutation must append a change event before or atomically with materialized
  object update.
- Every delete starts as a tombstone.
- Compaction must be policy-aware.
- Compaction must publish watermarks so long-offline clients can catch up by
  snapshot when raw change history has expired.

## What This Means For Schema Work

Schema should start with the scale envelope, not predicates:

```text
object envelope
  -> authority
  -> access class
  -> encryption class
  -> version
  -> segment id
  -> change id
  -> content hash
  -> typed body
```

Only after that should node, edge, event, and file schemas be finalized.

## V1 Implementation Bias

Even if the first build only has 1,000 objects:

- use object ids, not paths, as identity
- append changes, do not mutate silently
- write tombstones, do not hard-delete directly
- generate manifests
- build local indexes
- keep query APIs index-shaped
- shard object paths
- keep compaction as an explicit future job

This keeps v1 simple without making 100M impossible.
