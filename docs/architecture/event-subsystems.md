# Event Subsystems

Status: Draft required before implementation  
Date: 2026-06-21

## Purpose

Separate four systems that were previously blurred together:

- sync change log
- durable audit ledger
- live activity stream
- operational observability

They share operation ids, but they have different retention, schemas, scale
requirements, and privacy rules.

## Overview

```text
MCP operation
  -> operation_id
  -> sync change log entry, if mutation
  -> audit ledger event, if security/provenance relevant
  -> live activity event, if useful for UI/replay
  -> operational event, if useful for service health/debugging
```

## 1. Sync Change Log

Purpose:

- data integrity
- versioning
- offline sync
- conflict detection
- compaction input

Contains:

- create/update/delete/tombstone/restore
- object id
- base version
- new version
- content hash
- access class
- encryption class
- actor id
- generation

Does not contain:

- high-volume reads
- UI animation-only paths
- sensitive plaintext

Retention:

- retained until all active clients pass a compaction watermark
- compacted into snapshots/segments
- old change segments can be replaced by snapshots for long-offline clients

## 2. Durable Audit Ledger

Purpose:

- security review
- provenance
- operator accountability
- replayable "who touched what"

Contains:

- remote reads
- denied/withheld access
- decrypt events
- releases
- policy changes
- key/device events
- user/client/capability configuration events
- local sensitive reads where configured
- sync health and conflict events

Privacy:

- audit events about sensitive objects are sensitive
- remote audit gets opaque/redacted records
- local audit can contain richer detail encrypted locally

Integrity:

- V1 uses append-only records plus periodic checkpoints
- high-scale tamper evidence should use Merkle checkpoints, not one global
  linear hash chain

## 3. Live Activity Stream

Purpose:

- near-live graph firing view
- operation inspector
- debugging agent behavior
- replay UI input

Contains:

- bounded graph-touch paths
- sampled/aggregated high-volume reads
- currently active operations
- sync pulses
- denied/withheld flashes

Retention:

- short-lived by default
- durable replay is reconstructed from audit/change indexes, not from the live
  stream alone

Scale rule:

- a query that touches 10,000 objects does not emit 10,000 UI pulses by default
- live stream emits bounded summaries plus drilldown samples

## 4. Operational Observability

Purpose:

- service health
- request debugging
- deployment readiness
- latency/error metrics
- trace correlation across Worker, sync agent, and MCP surfaces

Contains:

- route and method
- status and outcome
- duration
- bounded counters
- `trace_id`
- `operation_id`
- redacted reason codes

Does not contain:

- graph plaintext
- request query strings
- authorization tokens
- object titles
- private predicates or labels

Cloudflare Workers use structured JSON logs and Workers Observability logs and
traces. Operational records are not the security audit ledger and are not the
live graph activity stream; they are the service/runtime view needed to answer
"is it healthy, slow, failing, or being abused?"

## Shared Identifiers

All four systems share:

- `operation_id`
- `trace_id`

Graph-aware events also share some or all of:

- `actor_id`
- `mcp_profile`
- `authority_id`
- `object_id` or opaque object references
- `recorded_at`

This lets the operator click from a live pulse to an audit record to a change
event without making one event store serve every purpose.

## V1 Event Boundaries

V1 must implement:

- sync change log for every mutation
- durable audit for remote reads, denials, decrypts, releases, key events, and
  policy/configuration changes
- live activity stream as bounded summaries, not full animation of every object
- redacted operational Worker request events with trace/operation correlation

V1 may defer:

- full cinematic neuron animation
- global live activity across all objects
- compliance-grade Merkle proofs beyond checkpoints
- OpenTelemetry export
- Analytics Engine dashboards
- custom span trees around every D1/R2 operation
- long-term operational metric retention
