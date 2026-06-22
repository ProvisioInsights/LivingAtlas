---
title: Temporal / typed edge model — build spec
status: draft v3
created: 2026-06-17
revised: 2026-06-17 (v3: time-field naming + state/event split + date precision locked)
owner: Living Atlas operator
applies-to: private markdown knowledge graph migration, local MCP, Living Atlas
---

> Integration status: this is design rationale, not the implementation
> authority. `implementation-guide.md` wins for temporal semantics, and
> `docs/architecture/knowledge-schema-runtime-integration.md` wins for how this
> model maps into the Living Atlas runtime. Older statements below that call the
> event log or markdown the source of truth are superseded by those documents.

# Temporal, typed edge model — build spec

## 0. Purpose

Turn the graph's links from an untyped bag of slugs into **typed, dated, attribute-bearing
edges with bitemporal time**, originally derived from Logseq markdown, so that "what
was true on date T", "what we knew on date T", and trend queries all become first-class.

Grounded in the Living Atlas architecture docs and research cross-check
(Graphiti/Zep, XTDB, SQL:2011, Neo4j, event sourcing).

## 1. Design decisions (settled)

1. **Edges are stored DIRECTED, traversed both ways.** One record per relationship in a
   canonical `src -> predicate -> dst` orientation; bidirectionality is a query/view concern.
2. **Typed spine + open detail bag.** Required spine (predicate, src, dst, validity,
   system-time, status, source) + open attribute bag for nuance. Property-graph model.
3. **Hard ontology (chosen 2026-06-17).** Closed predicate vocabulary with enforced domain/range,
   required attributes, and closed value enums. Unregistered or violating edges are rejected at the
   MCP write path and quarantined on batch ingest, never silently admitted or dropped. An alias map
   canonicalizes synonyms (`works-at` -> `employed-by`) so one relationship never appears under two
   predicates. Closed at any moment, but extensible by a deliberate, changelog-governed edit to
   `schema-edges.md`. Nuance goes in the attribute bag, never a new predicate. Canonical ontology:
   `schema-edges.md` + `schema-events.md`.
4. **Bitemporal.** Two clocks per edge: valid-time (world) + system-time (knowledge). Status is
   DERIVED, never hand-set.
5. **Superseded source-of-truth wording.** The original design treated the event
   log as source of truth and edges as replayed projection. In Living Atlas V1,
   temporal events are graph objects or audit/change records wrapped by the
   runtime architecture. Corrections still append compensating events and
   supersede/invalidate edges (never delete).
6. **Carry the prose fact + (later) an embedding on the edge** for fused keyword + semantic +
   graph-walk retrieval (Graphiti).
7. **Superseded storage wording.** The original design kept storage in Logseq
   markdown. In Living Atlas V1, markdown is migration input and
   human-readable compatibility format; runtime storage follows the Living
   Atlas runtime architecture. A columnar DB (DuckDB/Parquet) remains optional
   later.
8. **States are spans; occurrences are instants.** An edge represents a STATE and carries an
   interval (`valid-from` / `valid-to`); an event represents an OCCURRENCE and carries a single
   instant (`occurred-on`). A moment that creates a lasting state produces BOTH: an event at the
   instant, plus an edge whose `valid-from` equals that instant (intro on 2026-04-30 -> open
   "connects" span; acquisition closes 2018-06-07 -> open "acquired-by" span). This is the rule
   for deciding instant vs span; nothing is stored as a zero-length interval.
9. **Capture-all vs hard ontology (reconciled).** The hard ontology governs the TYPED EDGE
   projection only. The source layer (prose, journal events, raw bullets) still captures everything
   unfiltered; anything that does not fit the ontology stays as prose or sits in the edge quarantine
   until it is typed correctly or the ontology is extended. Nothing is lost; only promotion to a
   typed edge is gated.

## 2. Logical model (storage-agnostic)

The model below is the same whether a field lives as a Logseq block property today or a DB
column later. **Physical store now = markdown.**

### 2a. Edges as markdown block-properties (current substrate)

An edge is one block on the source page. The block's text is the human-readable fact (and the
in-content `[[wikilink]]` keeps native Logseq backlinks); the `key:: value` lines are the spine
and the open attribute bag. Synthetic example on `Alex Rivera.md`:

```
- advises [[Example Labs]] (formalized 2026-05-01)
  predicate:: advises
  valid-from:: 2026-05-01
  status:: active
  source:: synthetic fixture
- invests-in [[Example Labs]] — synthetic LOI, contingent
  predicate:: invests-in
  valid-from:: 2026-05-01
  status:: pending
  amount:: synthetic
  condition:: operator confirmed scope
  recorded-at:: 2026-05-01
  source:: synthetic fixture
```

Bitemporal correction stays in markdown too — invalidate, don't delete. The old block keeps a
`superseded-at`; a new block records the corrected fact (system-time fields are machine-written
by the MCP, not hand-edited):

```
- connects [[Example Contact]] (first recorded direction)
  predicate:: connects
  valid-from:: 2026-04-30
  recorded-at:: 2026-04-30
  superseded-at:: 2026-05-02
  note:: first recorded with reversed source/target; direction wrong
- connects [[Example Contact]] (corrected)
  predicate:: connects
  valid-from:: 2026-04-30
  recorded-at:: 2026-05-02
  source:: 5/2 correction
```

Simple edges that need no attributes can stay as plain frontmatter (`org:: [[Example Labs]]`); only
promote to a block when dates/attributes/bitemporality matter. Do this on hubs first, not all
a whole private corpus.

### 2b. Events as journal bullets (+ optional events.jsonl mirror)

Authored events stay as dated journal bullets (already how the graph works); tag them so the MCP
can lift them into the structured log:

```
- [[Alex Rivera]] formally agreed to advise [[Example Labs]] #event
  kind:: relationship-formed
  occurred-on:: 2026-05-01
```

The MCP maintains an append-only `generated/events.jsonl` as the structured, replayable mirror
(one JSON object per line — plain text, git-diffable, "something similar" to md). Fields:
`event_id, recorded_at, occurred_on, subject, predicate, object, kind, detail, source, supersedes`.

### 2c. Field reference (and the optional later DB schema)

The same fields, expressed as SQL for the day a columnar store is warranted:

```sql
CREATE TABLE predicates (
  predicate TEXT PRIMARY KEY, category TEXT, symmetric BOOLEAN DEFAULT FALSE,
  inverse_label TEXT, governed BOOLEAN DEFAULT TRUE, definition TEXT);

CREATE TABLE edges (
  edge_id TEXT PRIMARY KEY, src TEXT, predicate TEXT, dst TEXT,
  valid_from DATE, valid_to DATE,            -- world time; NULL valid_to = open
  recorded_at TIMESTAMP, superseded_at TIMESTAMP,  -- knowledge time; NULL = current
  status TEXT, confidence TEXT, source TEXT,
  fact TEXT, embedding FLOAT[], attrs JSON);

CREATE TABLE events (
  event_id TEXT PRIMARY KEY, recorded_at TIMESTAMP, occurred_on DATE,
  subject TEXT, predicate TEXT, object TEXT, kind TEXT, detail TEXT,
  source TEXT, supersedes TEXT);
```

For **symmetric** predicates, normalize endpoint order so reciprocal facts dedupe.

### 2d. Time conventions (LOCKED 2026-06-17)

Naming reference:

| where | world time (valid) | knowledge time (system) |
|---|---|---|
| edge (a state / span) | `valid-from` / `valid-to` | `recorded-at` / `superseded-at` |
| event (an occurrence / instant) | `occurred-on` (+ `occurred-until` only if multi-day) | `recorded-at` |

- **Open vs unknown endpoints:** an absent `valid-to` means "ongoing / until further notice";
  an absent `valid-from` means "start unknown." Never write a placeholder date to mean ongoing
  or unknown. A `superseded-at` that is absent means "current belief."
- **Mixed-precision dates (chosen):** a date field accepts a full ISO date (`2018-06-07`), a
  year-month (`2018-06`), or a year (`2017`); prefix `~` for approximate/circa (`~2015`). The MCP
  infers precision from the string: a year is treated as that year's span, `~` flags low
  confidence. Use this for backfilled era facts (for example, a synthetic long-running employment roster) instead of leaving
  `valid-from` null. Example: `valid-from:: ~2015` or `valid-from:: 2017`.

## 3. Predicate vocabulary v1 (refine before locking)

| predicate | category | symmetric | inverse_label |
|---|---|---|---|
| employed-by | employment | no | employs |
| reports-to | employment | no | manages |
| ceo-of / leads | employment | no | led-by |
| founded | employment | no | founded-by |
| advises | advisory | no | advised-by |
| advises-on | advisory | no | — |
| invests-in | capital | no | funded-by |
| acquired-by | structural | no | acquired |
| customer-of / engaged | customer | no | vendor-to |
| introduced-by | network | no | introduced |
| intro-path-to | network | no | — |
| connects | network | **yes** | — |
| board-member-of | governance | no | board-includes |
| spouse / sibling / co-founder | personal | **yes** | — |
| mentor-of | personal | no | mentored-by |

Governance (HARD): the registry is closed; only listed predicates are valid. A new predicate
requires a definition + domain/range entry in `schema-edges.md` plus a changelog line before any
edge may use it. Synonyms are canonicalized via the alias map, never admitted as new predicates.
Unregistered or domain/range-violating edges are rejected at the MCP write path and quarantined on
batch ingest. Canonical ontology now lives in `schema-edges.md` (this table is a summary).

## 4. Derivation rules (markdown -> in-memory model -> JSON sidecar)

- **Edges** from frontmatter properties (`org::`, `employer-current/historical::`,
  `acquired-by::`, `reports-to::`, `candidate::`) and the new block-property edges (§2a).
- **Validity:** `valid-from` from `since::`/`start-date::`/forming event; `valid-to` from
  `end-date::`/ending event; NULL = ongoing.
- **Events** from tagged journal bullets + contact-log lines (§2b).
- **Corrections (invalidate-not-delete):** on a contradicting edge, the MCP stamps the old
  block's `superseded-at` and writes the new block; appends a `kind:: correction` event.
- **Backfill discipline:** historical/out-of-order facts must set `valid-from` explicitly
  (do not infer from ingest time) — the XTDB user-managed valid-time lesson; matters for the
  synthetic era backfill, which is where Graphiti's auto-backfill is documented as weak.

## 5. "As of T" without a database

The MCP already parses the whole graph into memory and answers `graph_index.json` queries in
Python. As-of queries are the same in-memory filters over the parsed edges/events — at ~4k edges
and a few thousand events this is instant, no engine needed:

- valid as-of `T_world`: `valid_from <= T AND (valid_to IS NULL OR valid_to > T)`
- knowledge as-of `T_known`: `recorded_at <= T AND (superseded_at IS NULL OR superseded_at > T)`
- bitemporal: both; trend: bucket events/edges by period.
- undirected/reverse: union forward rows with reversed rows using `inverse_label`; symmetric
  predicates already dedupe via normalized endpoint order.

## 6. Build sequence

**Phase 0 — synthetic first (supersedes the original real-data spike).**
Build synthetic block-property edge and event fixtures that cover the same
temporal cases without touching real graph files. A small script parses them in
memory and runs the as-of / trend queries from §5. No DB, no production code,
fully reversible.

**Phase 1 — the MCP (make it live; the engine).**
Port the old `mcp-server/logseq_mcp.py` discipline into the new local MCP:
parse block-property edges + tagged events where markdown compatibility is
enabled, emit rebuildable compatibility projections when needed, and write
corrections through the authenticated local write path. Predicate and endpoint
vocab live in `schema-properties.md`, `schema-edges.md`, and
`schema-events.md`. Reads stay backward-compatible where migration requires
it.

**Phase 2 — Living Atlas (the viewer; the payoff).**
Point the Atlas adapter (`server/graph-index.mjs`) at the new sidecars and upgrade its existing
"timeline replay" into the bitemporal scrubber + edge-record panel from the mockup. Read-only,
additive.

**Phase 3 — database (LATER, optional, only if needed).**
If query volume/complexity or Atlas performance demands it, add a `graph build --duckdb` step
that folds the same fields (§2c) into a columnar store. Because edges/events are a derived
projection of the markdown, this is a rebuild, not a migration — nothing gets re-authored.

## 7. Historical open decisions

These are retained from the original v3 rationale. V1 decisions are resolved in
`implementation-guide.md` and
`docs/architecture/knowledge-schema-runtime-integration.md`.

- Edge-block placement: resolved to reserved `## Edges` for markdown
  compatibility.
- System-time bookkeeping: runtime event/audit/change systems, not
  human-edited markdown.
- Embeddings on edges: deferred.
- Historical valid-time backfill: synthetic fixtures first, then controlled
  migration.

## 8. Cross-check sources (2026-06-17)
- Zep/Graphiti temporal KG paper — https://arxiv.org/abs/2501.13956
- Graphiti edge timestamps + invalidation — https://help.getzep.com/graphiti/core-concepts/custom-entity-and-edge-types
- XTDB time model — https://docs.xtdb.com/about/time-in-xtdb.html
- SQL:2011 temporal — https://en.wikipedia.org/wiki/SQL:2011
- Neo4j relationship modeling — https://graphacademy.neo4j.com/courses/modeling-fundamentals/3-defining-relationships/1-defining-relationships/
- Event sourcing (Fowler) — https://martinfowler.com/eaaDev/EventSourcing.html
- Graph-based agent memory survey (Feb 2026) — https://arxiv.org/pdf/2602.05665
