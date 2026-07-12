# Rich Canonical First-Pass Conversion Implementation Plan

> **For Codex:** Execute this plan with the repository test-first workflow. Keep the source snapshot and every prior isolated copy read-only.

**Goal:** Convert every meaningful unit in the frozen Logseq working copy into a reviewable Atlas-native graph while preserving exact source evidence and refusing ambiguous identity or relationship inference.

**Architecture:** Extend the canonical Markdown migration, not the legacy page/block store. A shared source-meaning extractor produces stable units. Every unit receives a provenance-linked observation for parity; deterministic endpoint fields become canonical facts, current explicit typed semantics become canonical relationships, and exact unique wiki references become observation candidate links. A fresh encrypted isolated copy receives the result and a counts-only integrity report. The review site renders the actual proposed objects and preserves typed projections when the owner resolves a candidate.

**Tech Stack:** TypeScript 7, Zod, Vitest, encrypted local graph store, canonical Atlas client, local review site.

---

### Task 1: Make source-unit extraction reusable and stable

**Files:**
- Create: `packages/importer/src/source-meaning.ts`
- Create: `packages/importer/src/source-meaning.test.ts`
- Modify: `packages/importer/src/index.ts`
- Modify: `packages/local-review-site/src/review-projection.ts`
- Modify: `packages/local-review-site/package.json`

**Steps:**
1. Move the existing source-accounting behavior into the importer as a pure function with stable unit hashes.
2. Add synthetic tests proving exact source reconstruction remains separate from knowledge cleanup, editorial/source-system exclusions are explicit, wiki references remain available for resolution, and long units can be represented without truncation.
3. Make the review projection consume the shared implementation so import and review cannot disagree about unit boundaries.
4. Run `pnpm vitest run packages/importer/src/source-meaning.test.ts packages/local-review-site/src/review-projection.test.ts`.

### Task 2: Produce complete observations plus deterministic typed projections

**Files:**
- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`
- Modify: `packages/importer/src/canonical-markdown-migration.ts`
- Modify: `packages/importer/src/canonical-markdown-migration.test.ts`

**Steps:**
1. Add only the fact predicates required by measured direct contact/interaction fields: `phone`, `email`, `address`, `birth-date`, and `last-contacted`, with constrained existing value kinds.
2. Write failing synthetic migration tests for: one observation per meaningful unit; primary-entity binding by exact source provenance; exact unique wiki-reference candidate links; ambiguous/unmatched references left unresolved; supported facts linked to unit evidence; explicit relationships linked to existing endpoints; and parity backed only by complete observations.
3. Build a unique typed-title/alias index from the existing semantic extractor. Refuse collisions and fuzzy matches.
4. Emit bounded unit evidence, one or more bounded observations for each unit, and candidate entity IDs containing only the proven primary entity and exact unique references.
5. Emit schema-valid facts only when a typed subject and parseable value exist. Preserve the labeled text as observations regardless.
6. Emit the current explicit typed relationships only when both endpoints exist. Link them to the most specific matching unit evidence, falling back to the lossless file evidence.
7. Keep every review unresolved for owner inspection: typed sources go to owner review; untyped sources remain research.
8. Run `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/importer/src/canonical-markdown-migration.test.ts`.

### Task 3: Make the review site show and preserve the real destination graph

**Files:**
- Modify: `packages/local-review-site/src/review-projection.ts`
- Modify: `packages/local-review-site/src/review-projection.test.ts`
- Modify: `packages/local-review-site/src/app.js`
- Modify: `packages/local-review-site/src/server.ts`
- Modify: `packages/local-review-site/src/server.test.ts`
- Modify: `packages/local-review-site/src/styles.css`

**Steps:**
1. Add failing synthetic tests that map each source unit to the canonical observation/fact/relationship IDs supported by its unit evidence and parity record.
2. Render actual destination record types and IDs per source fragment, plus a compact mini graph of source, entities, facts, relationships, and unresolved observations.
3. Change Preserve/Edit so a rich candidate keeps typed projections and edits only its unit observations. Retain the legacy observation-expansion fallback for old copies.
4. Prove research remains a durable queue and no action implies immediate external research.
5. Run `pnpm vitest run packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts`.

### Task 4: Persist a private conversion manifest and integrity report

**Files:**
- Modify: `packages/check/src/canonical-isolated-copy-runner.ts`
- Modify: `packages/check/src/canonical-isolated-copy-runner.test.ts`

**Steps:**
1. Add failing tests for counts by canonical schema, zero missing evidence/entity/review/parity references, zero unrepresented meaningful units, and stable object-hash manifest generation.
2. Write `conversion-report.json` (counts only) and `canonical-manifest.json` (opaque object IDs and hashes) inside the isolated-copy directory after a successful import.
3. Reopen the encrypted store and compare the manifest before reporting success.
4. Run `pnpm vitest run packages/check/src/canonical-isolated-copy-runner.test.ts`.

### Task 5: Build and verify the v4 isolated review copy

**Files:**
- No repository data files. Output only under the approved local isolated-copy root.

**Steps:**
1. Run the focused canonical, importer, store, mutation, and review suites.
2. Run `pnpm check`.
3. Hash the frozen source-working corpus without modifying it.
4. Create a new empty `atlas-output-v4/.atlas-isolated-copy` with a new local keyring service while retaining the established identity/path-redaction secret needed for stable entity IDs.
5. Run the canonical isolated-copy conversion once.
6. Verify source counts, exact evidence coverage, schema validity, referential integrity, per-unit parity, encrypted-at-rest storage, restart/reopen manifest equality, and a backup/restore comparison.
7. Leave v3 running until all checks pass; then restart only the local review server against v4.
8. Report the typed/unresolved counts and the exact remaining owner/research review queues. Do not delete source, retire legacy artifacts, sync cloud state, or declare cutover.

