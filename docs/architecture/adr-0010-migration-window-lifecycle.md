# ADR 0010: Migration-Window Authority Lifecycle

Status: Accepted for implementation
Date: 2026-07-18

## Context

ADR-0003 makes the graph an append-only CRUD ledger: applied research and review
records are immutable, and corrections are expected to arrive as new superseding
assertions rather than in-place edits. That guarantee is load-bearing for three
properties the system depends on — an inspectable audit trail, content-hash /
evidence provenance, and host-blind sync generation integrity.

Two situations do not fit a permanently-immutable model:

1. **Finalizing the initial corpus.** Under ADR-0009 Living Atlas is replacing
   Logseq as the complete source of custody, and the owner wants Logseq retired
   as soon as possible (ADR-0008 cutover). Until go-live the graph is still being
   *assembled* — dates back-filled, mis-parsed nodes removed, geography modeled,
   directions corrected. Enforcing live-mode immutability on a corpus that is not
   yet live is premature: there is no operational history worth an audit trail
   during initial shaping, and routing every fix back through the soon-to-be-deleted
   Logseq source defeats the retirement.

2. **Post-live bulk refactors.** Even after go-live, occasional mass corrections
   and schema refactors are legitimate (e.g. re-modeling location hierarchy across
   thousands of edges). Doing these one record at a time via superseding assertions
   is impractical and floods the ledger with thousands of unrelated events.

A raw "turn immutability off" flag is the wrong answer: it suspends the guarantees
precisely when the most changes are being made, and it can be left on. What is
needed is a way to make in-place mutation possible that is itself bounded,
explicit, and audited — so integrity is preserved *at the migration granularity*.

## Decision

Model the authority as a small one-way-per-window **lifecycle state machine** with
two states, `live` and `migrating`, and treat setup and refactor as the same
mechanism — a **migration window**.

- **`live` (default):** append-only immutability from ADR-0003 is enforced.
  Single-record corrections use superseding assertions.
- **`migrating`:** a bounded window is open; per-record immutability is suspended so
  in-place mutation of research/review records is allowed. Reserved for initial
  corpus finalization and deliberate bulk refactors.

Initial data shaping is simply **migration #0**; every later mass-correction rides
the identical rails. Per-record supersede remains the *live* single-correction path
and is out of scope for this ADR.

### Migration window ceremony

1. **Open** — `openMigrationWindow({ reason, actor_id })` records a `MigrationWindow`
   (`migration_id`, `reason`, `opened_by`, `opened_at`, `base_generation`) and moves
   the authority to `migrating`. It is explicit and privileged; a second open while
   one is already open is rejected (`migration-window-already-open`). The window
   persists across store reload.
2. **Mutate** — while the window is open the MCP mutation guard suspends per-record
   append-only immutability. Object mutations still bump generation normally, so the
   window's span is captured by `base_generation → current generation`.
   Corrections may be applied in place or by a generational transform (below).
3. **Validate** — the owner runs the existing verification gates (decrypt-coverage,
   semantic parity, no-dangling) before closing.
4. **Seal** — `sealMigrationWindow({ actor_id })` returns the authority to `live`
   (restoring immutability) and appends a durable `SealedMigrationRecord`
   (the window plus `sealed_at` and `sealed_generation`) to an audited migration
   history. Sealing while `live` is rejected (`no-open-migration-window`).

The migration history answers "when and why did these N records change?" at the
window granularity, which is the correct resolution for a bulk operation.

### In-place vs generational transform

Both are permitted inside a window. For large or schema-level refactors, prefer a
**generational rebuild** — read the current generation, apply the transform, emit a
corrected generation, validate it off to the side, then swap — because it is atomic,
rollback-safe (the prior generation is retained), and testable before it goes live.
A generational rebuild is structurally the same as the Logseq importer with the
current graph as its source instead of Logseq. In-place mutation is appropriate for
smaller corrections.

## Consequences

- The append-only guarantee becomes a function of lifecycle state rather than
  always-on. In `live` (the normal case) nothing changes versus ADR-0003.
- Initial corpus finalization no longer requires re-importing from the source being
  retired; corrections are applied directly to Atlas inside migration #0, then sealed.
- Bulk refactors are possible forever without a permanent escape hatch and without
  bypassing audit: every window is opened deliberately and closed with a manifest.
- Sync should stay paused (local-only) for the duration of a window and resume at the
  seal, which is the first authoritative generation for that window. This aligns with
  the existing staged go-live push.
- A `live` authority must not sit in `migrating` silently; long-open windows should
  surface a warning (follow-up).

## Rejected Alternatives

### Raw "immutability off" toggle

Rejected. It suspends audit, provenance, and sync integrity with no bound and can be
left on — removing the safety during the highest-change period. The migration window
gives the same editing capability while remaining explicit, bounded, and audited.

### Keep Logseq as the correction authority

Rejected per ADR-0009 and the owner's decision to retire Logseq. Routing corrections
through a source that is being deleted preserves a second source of truth and blocks
the sunset.

### Supersede-only, no migration window

Rejected for setup and bulk work. Superseding assertions are the right tool for a
single live correction, but they are impractical for initial shaping and for
mass-corrections, where they bloat the ledger with thousands of unrelated events.

## Implementation

- `packages/local-graph-store`: `AuthorityLifecycle` / `MigrationWindow` /
  `SealedMigrationRecord` schemas persisted in the snapshot; `FileLocalGraphStore`
  gains `openMigrationWindow`, `sealMigrationWindow`, and `migrationHistory`;
  `status().lifecycle` exposes the current state.
- `packages/local-mcp`: `isImmutableResearchRecord` short-circuits to non-immutable
  while `status().lifecycle.state === "migrating"` (`migrationWindowOpen`).

## Verification

- `local-graph-store.migration-window.test.ts` — lifecycle defaults to `live`; open
  moves to `migrating` with a recorded window; seal returns to `live` with a sealed
  record; double-open and seal-while-live are rejected; the window and the sealed
  migration history persist across reload.
- `local-graph.test.ts` — a research record that is `research-record-immutable` while
  `live` becomes correctable through the generic MCP update path while a migration
  window is open, and the object version advances.
