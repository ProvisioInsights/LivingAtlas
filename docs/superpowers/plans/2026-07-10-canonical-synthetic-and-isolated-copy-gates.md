# Canonical Synthetic and Isolated-Copy Gate Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the Atlas-native pipeline end to end with synthetic canonical data before running it once against an isolated encrypted copy of the owner corpus.

**Architecture:** A synthetic fixture creates only encrypted `atlas.*` entity, evidence, assertion/observation, review, parity, and resolution records through the local transaction path. It then proves projections, review queue, canonical export/import, restart/compaction, backup/restore, and no-legacy-write behavior. A separate isolated-copy runner is enabled only by explicit paths and an acknowledgement; it opens a copy and never the configured live profile/archive.

## Global Constraints

- The synthetic fixture contains no `page`, `block`, `logseq-*`, or source-capsule object/payload.
- Every fixture record is `local-private` and encrypted at rest.
- The test must prove idempotent retry and no partial candidate mutation.
- Backup/restore compares canonical export, ids, semantic payload hashes, parity report, and resolution projection—not only object count.
- The isolated-copy runner must reject any source path equal to configured live profile/archive paths and must require an explicit acknowledgement.
- Do not run the isolated-copy runner until every synthetic gate is green; do not deploy, push, or modify the original archive.

---

### Task 1: Canonical Synthetic MVP Proof

**Files:**
- Create: `packages/check/src/canonical-local-mvp-proof.test.ts`

- [ ] Write a failing test that builds a complete canonical owner-review candidate plus a resolved candidate, uses `localResolutionApply`, checks transaction idempotency/no partial writes, projects assertions/entity redirects/parity/review queue, reopens and compacts, exports/imports to a fresh encrypted store, backs up/restores it, and asserts every export/parity/redirect tuple is identical.
- [ ] Run `pnpm vitest run packages/check/src/canonical-local-mvp-proof.test.ts` and verify it fails before implementation.
- [ ] Implement fixture helpers using only canonical payload schemas and local-keyring storage.
- [ ] Run the proof and commit `Add canonical synthetic MVP proof (#43)`.

### Task 2: Isolated-Copy Safety Runner

**Files:**
- Create: `packages/check/src/canonical-isolated-copy-runner.ts`
- Create: `packages/check/src/canonical-isolated-copy-runner.test.ts`

- [ ] Write a failing test that rejects missing acknowledgement, non-copy marker, and a path equal to a configured live path.
- [ ] Implement a runner that takes only `--copy-dir`, `--source-dir`, and a literal acknowledgement, creates an encrypted local target below the copy directory, and writes a local report without touching source bytes.
- [ ] Run tests and commit `Gate canonical isolated-copy migration (#43)`.

### Task 3: Verify and Hand Off

- [ ] Run the focused proof, all `pnpm check`, and legacy scan.
- [ ] Update #43 and #18 with public-safe evidence; do not run isolated-copy until all proof conditions are green.
