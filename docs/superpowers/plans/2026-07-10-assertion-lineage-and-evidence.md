# Assertion Lineage And Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #45's bitemporal canonical assertion projection, so facts and relationships retain contradictory evidence and can be queried by world-valid and system-known time.

**Architecture:** Keep canonical payload validation in `@living-atlas/contracts` and add a pure assertion projection in `@living-atlas/graph-service`. The projection consumes already-decrypted canonical fact/relationship payloads; it neither performs storage writes nor decrypts envelopes. `#47` will use this projection after it supplies the atomic mutation boundary.

**Tech Stack:** TypeScript ESM, Zod 4, Vitest, pnpm workspaces.

## Global Constraints

- Follow ADRs 0004, 0005, and 0009: append-only assertions, evidence links, and source-corpus sensitive content are canonical but default to encrypted `local-private` custody.
- New canonical code never emits `page`, `block`, `logseq-*`, or source-capsule payloads.
- Query code is pure, accepts decrypted canonical payloads only, and must not write graph storage, emit audit events, or call remote/hosted services.
- World time uses half-open intervals `[from, to)` and expands mixed-precision dates before comparison. `unknown` cannot prove a temporal match.
- A successor affects the current view only after its `recorded_at` is at or before `known_at` (or now when no `known_at` is supplied).
- Contradictory assertions without a supersession relationship coexist.
- Use synthetic fixtures only. Do not access a profile, local keyring, migration workspace, browser session, or hosted service.

---

### Task 1: Validate Canonical World-Time Intervals

**Files:**

- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`

**Interfaces:**

- Produces `CanonicalWorldTimeInterval`, `canonicalWorldTimeInterval(value)`, and `canonicalIntervalsOverlap(left, right)`.
- `canonicalWorldTimeInterval` expands a `MixedPrecisionDateSchema` value to `{ lower, upper, approximate }`; `unknown` returns `undefined`.
- Fact and relationship schemas reject a finite `valid_to` interval that ends at or before `valid_from`.

- [x] **Step 1: Write the failing tests**

Add to `packages/contracts/src/knowledge.test.ts`:

```ts
expect(canonicalWorldTimeInterval("2026")).toEqual({
  lower: "2026-01-01",
  upper: "2027-01-01",
  approximate: false
});
expect(canonicalWorldTimeInterval("~2026-02")).toEqual({
  lower: "2026-02-01",
  upper: "2026-03-01",
  approximate: true
});
expect(canonicalWorldTimeInterval("unknown")).toBeUndefined();
expect(canonicalIntervalsOverlap(
  canonicalWorldTimeInterval("2026")!,
  canonicalWorldTimeInterval("2026-06")!
)).toBe(true);
expect(CanonicalFactPayloadSchema.safeParse({
  ...fact,
  valid_from: "2026-06",
  valid_to: "2026-06"
}).success).toBe(false);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: FAIL because interval helpers are not exported and a zero-length fact interval is accepted.

- [x] **Step 3: Write the minimal implementation**

Add the following public interface near the time-bearing canonical payloads in `packages/contracts/src/knowledge.ts`:

```ts
export type CanonicalWorldTimeInterval = {
  lower: string;
  upper: string;
  approximate: boolean;
};

export function canonicalWorldTimeInterval(value: string): CanonicalWorldTimeInterval | undefined {
  if (value === "unknown") return undefined;
  const approximate = value.startsWith("~");
  const normalized = approximate ? value.slice(1) : value;
  if (/^\d{4}$/.test(normalized)) {
    const year = Number(normalized);
    return { lower: `${normalized}-01-01`, upper: `${year + 1}-01-01`, approximate };
  }
  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [year, month] = normalized.split("-").map(Number);
    const next = month === 12 ? [year + 1, 1] : [year, month + 1];
    return { lower: `${normalized}-01`, upper: `${next[0]}-${String(next[1]).padStart(2, "0")}-01`, approximate };
  }
  const date = new Date(`${normalized}T00:00:00.000Z`);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return { lower: normalized, upper: next.toISOString().slice(0, 10), approximate };
}

export function canonicalIntervalsOverlap(left: CanonicalWorldTimeInterval, right: CanonicalWorldTimeInterval): boolean {
  return left.lower < right.upper && right.lower < left.upper;
}
```

In the fact and relationship `superRefine` functions, parse non-`unknown`
`valid_from` / `valid_to` values with `canonicalWorldTimeInterval`; add a custom
issue at `valid_to` unless `from.lower < to.lower`. Do not reject an open-ended
interval or an `unknown` bound.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: PASS with interval expansion and invalid finite interval coverage.

### Task 2: Add A Pure Bitemporal Assertion Projection

**Files:**

- Create: `packages/graph-service/src/canonical-assertions.ts`
- Create: `packages/graph-service/src/canonical-assertions.test.ts`
- Modify: `packages/graph-service/src/index.ts`

**Interfaces:**

- Produces `CanonicalAssertion`, `CanonicalAssertionQuery`, `CanonicalAssertionProjection`, and `projectCanonicalAssertions(assertions, query)`.
- A `CanonicalAssertion` is `CanonicalFactPayload | CanonicalRelationshipPayload`.
- `CanonicalAssertionQuery` accepts optional `valid_at`, `known_at`, `include_superseded`, `include_retracted`, and `include_invalidated`.
- Projection returns `{ assertions, superseded_assertion_ids }`, ordered by `recorded_at` then assertion id.

- [x] **Step 1: Write the failing tests**

Create `packages/graph-service/src/canonical-assertions.test.ts` with fixtures
for a fact assertion, its later correction, an unrelated contradictory fact, and
a retraction. Test the public behavior:

```ts
expect(projectCanonicalAssertions([original, correction, contradiction], {
  valid_at: "2026-06",
  known_at: "2026-07-01T00:00:00.000Z"
}).assertions.map((item) => item.assertion_id)).toEqual([
  correction.assertion_id,
  contradiction.assertion_id
]);

expect(projectCanonicalAssertions([original, correction], {
  known_at: "2026-06-15T00:00:00.000Z"
}).assertions.map((item) => item.assertion_id)).toEqual([original.assertion_id]);

expect(projectCanonicalAssertions([retracted], {
  include_retracted: true
}).assertions).toEqual([retracted]);

expect(projectCanonicalAssertions([unknownDatedFact], {
  valid_at: "2026"
}).assertions).toEqual([]);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/graph-service/src/canonical-assertions.test.ts`

Expected: FAIL because the projection module does not exist.

- [x] **Step 3: Write the minimal implementation**

Create `packages/graph-service/src/canonical-assertions.ts` with this public
shape:

```ts
import {
  canonicalIntervalsOverlap,
  canonicalWorldTimeInterval,
  type CanonicalFactPayload,
  type CanonicalRelationshipPayload
} from "@living-atlas/contracts";

export type CanonicalAssertion = CanonicalFactPayload | CanonicalRelationshipPayload;
export type CanonicalAssertionQuery = {
  valid_at?: string;
  known_at?: string;
  include_superseded?: boolean;
  include_retracted?: boolean;
  include_invalidated?: boolean;
};
export type CanonicalAssertionProjection = {
  assertions: CanonicalAssertion[];
  superseded_assertion_ids: string[];
};
```

Implement the projection in this order:

1. Parse `valid_at` to an interval when supplied. Assertions with no
   `valid_from` are timeless and match; assertions with `unknown` world time do
   not match a temporal query; a finite assertion interval matches only when it
   overlaps the query interval.
2. Limit input to assertions whose `recorded_at <= known_at` when `known_at` is
   supplied. With no `known_at`, use all supplied assertions.
3. Build superseded ids only from remaining, known assertions. Unless
   `include_superseded` is true, remove assertions whose id appears in another
   remaining assertion’s `supersedes` array.
4. Keep current `assert`, `correct`, and `reinstate` records. Unless
   `include_retracted` or `include_invalidated` is true, remove current
   `retract` or `invalidate` records after they have affected the supersession
   calculation. This leaves a corrected current assertion visible while making
   retraction/invalidation history explicit on demand.
5. Sort returned assertions by `recorded_at` ascending, then `assertion_id`.

Export the module from `packages/graph-service/src/index.ts` with:

```ts
export * from "./canonical-assertions";
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/graph-service/src/canonical-assertions.test.ts packages/contracts/src/knowledge.test.ts`

Expected: PASS; the current view respects both time axes and contradictory
assertions remain independent.

### Task 3: Verify Assertion Projections Through Local Durability

**Files:**

- Modify: `packages/graph-service/src/canonical-assertions.ts`
- Modify: `packages/local-graph-store/src/local-graph-store.test.ts`
- Modify: `packages/graph-service/src/canonical-assertions.test.ts`

**Interfaces:**

- Consumes `FileLocalGraphStore.materializedSnapshot()` and
  `projectCanonicalAssertions`.
- Proves an append-only assertion sequence returns the same projection after
  reopen and `compact()`.

- [x] **Step 1: Write the encrypted local-durability integration test**

Add a synthetic encrypted-local fixture to
`packages/graph-service/src/canonical-assertions.test.ts` that persists two
canonical assertion envelopes with an original assertion and correction. Reopen
the store, pass the reopened envelopes through the new helper and fixture
decryption callback, call the projection with those payloads, compact, reopen
again, and assert the current assertion ids remain identical before and after
compaction.

Use this assertion form:

```ts
expect(afterCompact.assertions.map((item) => item.assertion_id)).toEqual(
  beforeCompact.assertions.map((item) => item.assertion_id)
);
expect(afterCompact.superseded_assertion_ids).toEqual(beforeCompact.superseded_assertion_ids);
```

- [x] **Step 2: Run the integration test**

Run: `pnpm vitest run packages/graph-service/src/canonical-assertions.test.ts`

Expected: PASS. This test composes the new assertion loader with the existing
encrypted store and compact/reopen behavior; it does not require a new
production method.

- [x] **Step 3: Verify encrypted persistence stays opaque**

Assert the serialized local-store files contain the local-keyring encryption
algorithm but do not contain either synthetic assertion value. Do not add a
second store, plaintext persistence mode, generic query index, or mutation
command. The store continues to own durable encrypted envelopes and journal
replay.

- [x] **Step 4: Run the focused durability verification**

Run: `pnpm vitest run packages/local-graph-store/src/local-graph-store.test.ts packages/graph-service/src/canonical-assertions.test.ts`

Expected: PASS and no decrypted fixture text is written to disk.

### Task 4: Verify, Track, And Commit #45

**Files:**

- Modify only the files listed in Tasks 1–3 and this plan if verification finds a real defect.

- [x] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-assertions.test.ts packages/local-graph-store/src/local-graph-store.test.ts
```

Expected: PASS.

- [x] **Step 2: Run full verification**

Run: `pnpm check`

Expected: repository safety, typecheck, and the complete Vitest suite pass.

- [x] **Step 3: Audit the canonical boundary**

Run:

```bash
rg -n 'logseq-|object_type: "page"|object_type: "block"' packages/graph-service/src/canonical-assertions.ts packages/contracts/src/knowledge.ts
```

Expected: no canonical writer/read-model legacy payload dependency.

- [x] **Step 4: Update tracker and commit locally**

Post public-safe scope and command evidence to #45 and #43, keep #45 In
Progress until the downstream persistence/typed-client gates are integrated,
and commit only this #45 slice. Do not push, deploy, access a real profile, or
start #47 implementation in the same commit.
