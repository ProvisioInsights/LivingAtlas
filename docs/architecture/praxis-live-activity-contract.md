# Praxis Live Activity Contract

Status: Draft shared contract  
Date: 2026-06-21

## Purpose

Praxis consumes Living Atlas live activity events for attention triggers and
graph visualization. This document mirrors the Praxis-side contract without
changing Living Atlas authority boundaries.

Living Atlas remains authoritative for:

- graph objects
- sync change log
- durable audit ledger
- access classes
- local-sensitive plaintext policy

Praxis consumes only the live activity projection and stores cursors, opaque
refs, summaries, and visual hints.

## Event Plane

This contract applies to the **live activity stream** described in
`event-subsystems.md`, not the sync change log or durable audit ledger.

The shared identifiers remain:

- `event_id`
- `operation_id`
- `trace_id`
- `cursor`
- `recorded_at`

## Minimum Event Shape

```json
{
  "event_id": "la_event_...",
  "operation_id": "la_operation_...",
  "trace_id": "la_trace_...",
  "cursor": "000000000123",
  "recorded_at": "2026-06-21T00:00:00Z",
  "plane": "local",
  "crud": "create",
  "policy_decision": "allow",
  "graph_touch": {
    "nodes": ["la_object_..."],
    "edges": ["la_object_..."],
    "objects": ["la_object_..."],
    "path": ["la_object_...", "la_object_...", "la_object_..."]
  },
  "visibility": {
    "mode": "metadata",
    "contains_sensitive": false,
    "redacted": true
  },
  "summary": "Created relationship",
  "visual": {
    "motion": "connect",
    "intensity": 0.8,
    "color_role": "created"
  }
}
```

## Privacy Rule

The event stream can show graph movement and connections without exposing
private plaintext.

Modes:

- `metadata`: movement, opaque refs, redacted labels
- `local_unlocked`: private labels only on trusted unlocked local devices
- `remote_safe`: approved projection only
- `presentation`: cinematic movement without sensitive content

Praxis must fail closed if it receives event detail above the current client
visibility mode.

## Early Integration

Until Living Atlas has a concrete live stream implementation, Praxis may use
synthetic events that match this shape.

Living Atlas implementation should later provide:

- cursor replay
- bounded live stream
- operation/audit correlation by `operation_id`
- redacted metadata mode

