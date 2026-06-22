type:: schema
status:: draft v4 - finalize with the edge registry in Phase 0.5
authority:: implementation-guide.md is authoritative for full semantics
created:: 2026-06-17

- **Namespace:** `schema/events` — the closed ontology for events, the append-only time spine. Events are instants; edges are spans (see `schema-edges.md`).
- **Rules:** only registry `kind` values are valid. The logical temporal event stream is append-only and immutable; a mistake is fixed by appending a compensating event (`correction`/`split` with `supersedes`), never by editing or deleting history. Generated mirrors such as `generated/events.jsonl` are rebuildable compatibility artifacts, not the runtime master. System-time values are always full machine timestamps (never mixed-precision / `~`).
- ## Event shape
	- Authored as a dated journal bullet tagged `#event`; the MCP maintains a derived `generated/events.jsonl` mirror (rebuildable, not a master).
	- Fields:
		- `subject` — the `[[wikilink]]` the event is about (required)
		- `kind::` — enum (required)
		- `occurred-on::` — world-time instant, mixed precision `2018-06-07` / `2018-06` / `2017` / `~2015` (required)
		- `occurred-until::` — only for multi-day occurrences (opt)
		- `recorded-at::` — system time, full timestamp, machine-written
		- `predicate::` / object — the edge this event forms/ends (opt; predicate must exist in `schema-edges.md`)
		- `source::` — provenance (required)
		- `detail::` — free text (opt)
		- `supersedes::` — **list** of event ids this corrects/splits (required when `kind` = correction | split)
- ## kind registry (closed)

	| kind | meaning | typically forms / changes |
	|---|---|---|
	| relationship-formed | a relationship begins | sets an edge `valid-from` (open span) |
	| stage-change | a relationship's lifecycle stage moves | sets edge `status` (e.g. pending -> active) |
	| role-change | a person's role/title changes | closes + opens `employed-by` / `founder-of` |
	| engagement | a discrete piece of work / meeting occurred | feeds an `engaged` / `customer-of` span (span end from era/explicit-end, never min+epsilon) |
	| org-change | acquisition / merger / rename | `acquired-by` / `merged-with`; flags the org's other open edges for review |
	| life-event | a personal/family occurrence (often sensitive) | context only; no edge |
	| contact | an interaction (call, email, text, meet) | feeds last-activity / dormancy |
	| observation | a logged fact/note not tied to one edge | context; may seed edges |
	| correction | fixes a previously recorded fact (same world-fact, wrong knowledge) | sets `superseded-at` on the affected edge; carries FULL replacement fields |
	| invalidate | a fact stopped being true | sets the edge's `valid-to` |
	| split | backdated correction of a sub-interval | supersedes the original; replacement edges tile the original `[from,to)` exactly (no gap/overlap) |
- ## Replay (deterministic)
	- Replay is ordered by `recorded-at` (system time, total order; ties by event id). World-time (`occurred-on`) is payload, never the replay order. `correction`/`split` events carry the complete replacement state (compensating events, not deltas), so replay is last-write-wins keyed by (subject, predicate, object).
- ## Enforcement
	- Unknown `kind` is rejected at the MCP write path and quarantined on batch ingest. A `predicate::`, if present, must exist in `schema-edges.md`. The edge-scoped audit hard-fails a `correction`/`split` event missing `supersedes::`, and a `split` whose replacements do not tile the original span exactly.
- ## Changelog
	- 2026-06-17 v4: added `split` kind + tiling invariant; `supersedes::` is a list; system-time is full-timestamp/lazy; deterministic replay rule; org-change flags related open edges.
	- 2026-06-17 v1: initial kind registry (superseded).
