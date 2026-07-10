# Entity Resolution and Semantic Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide deterministic local projections for reversible entity redirects and semantic parity/cutover readiness from encrypted Atlas-native records.

**Architecture:** `atlas.entity-resolution:v1` records remain immutable; a graph-service projection derives redirects without rewriting entity, fact, or relationship records. A second projection reads only canonical parity, review, and observation payloads and reports coverage separately from open truth work. Both loaders receive decrypted envelopes only at the authenticated local boundary and ignore legacy payloads.

**Tech Stack:** TypeScript ESM, Zod 4, Vitest, encrypted `FileLocalGraphStore` synthetic fixtures.

## Global Constraints

- Do not create or persist `page`, `block`, `logseq-*`, or source-capsule canonical payloads.
- Do not delete entities or rewrite historical fact/relationship references during a merge or split.
- A merge redirect exists only while its immutable resolution is active; a split supersedes the merge and removes only that derived redirect.
- Sensitive identifiers, evidence, and source facts remain encrypted `local-private`; tests use synthetic content only.
- A represented parity unit must name existing canonical objects. Open research/owner-review/deferred items require a represented canonical observation.
- No profile, archive, deployment, push, or hosted operation is part of this plan.

---

### Task 1: Strengthen Immutable Entity-Resolution Records

**Files:**
- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`

**Interfaces:**
- Produces `CanonicalEntityResolutionPayloadSchema` invariants: `link` and `merge` require a canonical entity present in `candidate_entity_ids`; `split` requires at least one superseded resolution id.
- Keeps `atlas.entity-resolution:v1` as the existing canonical `review` envelope type.

- [x] **Step 1: Write failing schema tests**

```ts
expect(CanonicalEntityResolutionPayloadSchema.safeParse({
  ...merge,
  canonical_entity_id: "la_object_notacandidate0001"
}).success).toBe(false);
expect(CanonicalEntityResolutionPayloadSchema.safeParse({
  ...merge,
  decision: "split",
  canonical_entity_id: undefined,
  supersedes: []
}).success).toBe(false);
```

- [x] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: FAIL because the current schema accepts both invalid decisions.

- [x] **Step 3: Implement only the decision invariants**

Add a `superRefine` branch to `CanonicalEntityResolutionPayloadSchema`:

```ts
if ((resolution.decision === "link" || resolution.decision === "merge")
  && (!resolution.canonical_entity_id || !resolution.candidate_entity_ids.includes(resolution.canonical_entity_id))) {
  ctx.addIssue({ code: "custom", path: ["canonical_entity_id"], message: "link and merge canonical entities must be candidates" });
}
if (resolution.decision === "split" && resolution.supersedes.length === 0) {
  ctx.addIssue({ code: "custom", path: ["supersedes"], message: "split decisions must supersede one or more prior resolutions" });
}
```

- [x] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts`

Expected: PASS.

Commit: `git commit -m "Strengthen reversible entity resolution contracts (#46)"`

### Task 2: Derive Reversible Canonical Entity Redirects

**Files:**
- Create: `packages/graph-service/src/canonical-entity-resolution.ts`
- Create: `packages/graph-service/src/canonical-entity-resolution.test.ts`
- Modify: `packages/graph-service/src/index.ts`

**Interfaces:**
- Produces `projectCanonicalEntityResolutions(resolutions, { known_at? })`, returning `{ redirects, active_resolution_ids, superseded_resolution_ids, invalid_resolution_ids }`.
- Produces `resolveCanonicalEntityId(entityId, projection)`, returning `{ entity_id, canonical_entity_id, redirect_path }` without cycles.
- Produces `loadCanonicalEntityResolutionsFromObjects(objects, decryptPayload)` that decrypts only `object_type: "review"` envelopes and parses only `atlas.entity-resolution:v1` bodies.

- [x] **Step 1: Write failing projection tests**

```ts
const merged = resolution({ resolution_id: "la_object_merge0001", decision: "merge", candidate_entity_ids: [a, b], canonical_entity_id: a });
const split = resolution({ resolution_id: "la_object_split0001", decision: "split", candidate_entity_ids: [a, b], supersedes: [merged.resolution_id], recorded_at: later });
expect(resolveCanonicalEntityId(b, projectCanonicalEntityResolutions([merged]))).toMatchObject({ canonical_entity_id: a });
expect(resolveCanonicalEntityId(b, projectCanonicalEntityResolutions([merged, split]))).toMatchObject({ canonical_entity_id: b });
```

Add a chained-merge fixture (`c -> b`, then `b -> a`) and assert `c` resolves to `a`; add a malformed cycle fixture and assert it is listed in `invalid_resolution_ids`, never loops. Add a loader fixture containing a legacy `page` envelope whose decryptor throws if called and assert only the encrypted resolution is loaded.

- [x] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/graph-service/src/canonical-entity-resolution.test.ts`

Expected: FAIL because the projection module does not exist.

- [x] **Step 3: Implement the pure projection and narrow loader**

Sort decisions by `recorded_at`, then `resolution_id`. Maintain direct redirects by active merge resolution id; on a split, remove redirects created by every superseded merge. Resolve chains with a `Set` of visited ids; reject a merge whose direct edge would make its canonical target reach one of its redirected candidates. Do not mutate input records or use the object store.

```ts
const resolution = CanonicalEntityResolutionPayloadSchema.safeParse(payload);
if (resolution.success) resolutions.push(resolution.data);
```

Export the module from `packages/graph-service/src/index.ts`.

- [x] **Step 4: Verify encrypted durability and commit**

Run: `pnpm vitest run packages/graph-service/src/canonical-entity-resolution.test.ts packages/graph-service/src/canonical-assertions.test.ts`

Expected: PASS, including encrypted reopen/compaction proof with no plaintext fixture in snapshot/journal.

Commit: `git commit -m "Add reversible canonical entity redirects (#46)"`

### Task 3: Report Semantic Parity and Cutover Blockers

**Files:**
- Create: `packages/graph-service/src/canonical-parity.ts`
- Create: `packages/graph-service/src/canonical-parity.test.ts`
- Modify: `packages/graph-service/src/index.ts`

**Interfaces:**
- Produces `projectCanonicalParity({ parity_records, reviews, observations, canonical_object_ids })`.
- Returns `{ totals, represented_coverage_keys, unrepresented_coverage_keys, open_review_ids, blockers, cutover_ready }`, where blockers are stable public-safe reason codes.
- Produces `loadCanonicalParityInputsFromObjects(objects, decryptPayload)` that reads only `manifest`, `review`, and `assertion` canonical envelopes.

- [x] **Step 1: Write failing parity tests**

```ts
const report = projectCanonicalParity({
  parity_records: [representedFact, unrepresented],
  reviews: [ownerReview],
  observations: [observation],
  canonical_object_ids: new Set([factId, observationId])
});
expect(report.totals).toMatchObject({ represented: 1, unrepresented: 1 });
expect(report.cutover_ready).toBe(false);
expect(report.blockers).toContain("unrepresented-coverage");
```

Add a second fixture where an `owner-review` item names a represented observation and every coverage key is represented; assert no open-review blocker. Add failures for a parity record naming a missing canonical id and an open review without an observation. Add a legacy envelope that must not be decrypted by the loader.

- [x] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/graph-service/src/canonical-parity.test.ts`

Expected: FAIL because the parity projection module does not exist.

- [x] **Step 3: Implement the report without migration-source dependencies**

Build maps by coverage key and canonical object id. A parity record is valid only when `coverage_state === "represented"` and all named object ids are in `canonical_object_ids`. For `research`, `owner-review`, and `deferred-unknown`, require at least one proposed id in `observations`; otherwise add `open-review-without-observation`. Never report raw payload text, locators, or source context.

- [x] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/graph-service/src/canonical-parity.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts`

Expected: PASS.

Commit: `git commit -m "Add canonical parity cutover reporting (#48)"`

### Task 4: Verify, Track, and Commit #46/#48

**Files:**
- Modify only the task files and this plan if verification reveals a real issue.

- [x] **Step 1: Run focused proof**

Run:

```bash
pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-assertions.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts packages/graph-service/src/canonical-parity.test.ts
```

Expected: PASS.

- [x] **Step 2: Run repository gate and legacy audit**

Run:

```bash
rg -n 'object_type: "page"|object_type: "block"|logseq-|source-capsule' packages/graph-service/src/canonical-entity-resolution.ts packages/graph-service/src/canonical-parity.ts
pnpm check
```

Expected: no legacy write path; repository safety, typecheck, and all tests pass.

- [ ] **Step 3: Track and commit locally**

Post public-safe evidence to #46, #48, and #43; keep them In Progress until typed export/import and the local review app consume their projections. Commit locally only. Do not push, deploy, access a profile, or run a migration corpus.
