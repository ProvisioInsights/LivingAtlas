# Review And Research Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce owner review to genuine identity, conflict, and interpretation decisions while making every remaining decision compact, evidence-backed, reversible, and safe to apply individually or in bulk.

**Architecture:** Treat exact source preservation as a deterministic canonical mutation, not an owner truth judgment. Candidate-scoped research produces bounded local-private evidence and can auto-apply only through the existing atomic `resolution_apply` boundary after an independence-aware evidence gate. The local review site remains a loopback Atlas client and renders source-to-destination mappings, actual graph topology, evidence, and concise decision previews without becoming a second database.

**Tech Stack:** TypeScript 7, Zod, Vitest, encrypted `FileLocalGraphStore`, local MCP, vanilla local review UI, browser-client QA.

## Global Constraints

- Never modify or delete the source corpus, frozen source copy, prior isolated candidates, legacy production objects, or pre-cutover backup.
- Every canonical knowledge payload is `local-private`, encrypted at rest, and remotely visible only as ciphertext plus opaque metadata.
- One Atlas mutation boundary owns durable canonical writes; review, research, and operator tooling submit typed intents and cannot write graph files directly.
- Exact source preservation does not assert that the source statement is true; it records what the owner source says with provenance.
- Public research runs only for an existing candidate and stores bounded evidence, not whole profiles, social graphs, or newly discovered contact details.
- Automatic third-party mutations require either two independent public evidence groups or LinkedIn plus an independent organization, project, or public-web group; syndicated copies count once.
- Conflicting, identity-ambiguous, inferred-sensitive-relationship, or unsupported-predicate results remain reviewable and are never silently applied.
- Logs, committed fixtures, screenshots, and GitHub contain only synthetic content, counts, hashes, reason codes, and opaque identifiers.
- Bulk review may be partial across candidates but never within one candidate; it is allowed only for an identical mutation-template and evidence-rule group whose exact effects were previewed.

---

### Task 1: Remove The Unsafe Raw Batch Path And Gate Real Bulk Decisions

**Files:**
- Modify: `packages/local-mcp/src/local-graph.ts`
- Modify: `packages/local-mcp/src/local-graph.test.ts`
- Modify: `packages/local-review-site/src/review-projection.ts`
- Modify: `packages/local-review-site/src/review-projection.test.ts`
- Modify: `packages/local-review-site/src/server.ts`
- Modify: `packages/local-review-site/src/server.test.ts`
- Modify: `packages/local-review-site/src/app.js`
- Modify: `packages/local-review-site/src/index.html`
- Modify: `packages/local-review-site/src/styles.css`

**Interfaces:**
- Produces: `bulk_compatibility_key`, `bulk_preview_token`, and `POST /api/review/bulk/preview` followed by version-bound `POST /api/review/bulk/decision`.
- Removes: private unused `localResolutionApplyBatch` and undocumented `/api/review/bulk/apply`.

- [ ] **Step 1: Write failing projection and server tests**

```ts
expect(left.bulk_compatibility_key).not.toBe(right.bulk_compatibility_key);
expect(await preview([left, right])).toMatchObject({ ok: false, reason: "heterogeneous-bulk-selection" });
expect(await apply({ ...previewed, review_versions: stale })).toMatchObject({ ok: false, reason: "bulk-preview-stale" });
expect(graphStore.status().generation).toBe(beforeGeneration);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts`

- [ ] **Step 3: Implement the minimal compatibility and preview boundary**

Derive the compatibility key from sorted payload schemas, normalized mutation kinds, evidence-rule kind, source-preservation mode, and edit/merge requirements. The preview response contains counts, exact object mutation summaries, evidence independence groups, candidate IDs, current review versions, and a SHA-256 token over that normalized payload. Apply recomputes the token and rejects any changed version, candidate, mutation, or evidence group before the first per-candidate call.

- [ ] **Step 4: Replace native confirmation with a compact preview panel**

Show only `Keep`, `Research`, or `Defer` when every selected item is compatible. List exact destination kinds and evidence groups, not internal object IDs. Heterogeneous selection remains selected and explains how to narrow it.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts && pnpm typecheck`

Commit: `fix(review): gate bulk decisions by exact effects`

---

### Task 2: Auto-Apply Exact Owner-Source Preservation

**Files:**
- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`
- Modify: `packages/importer/src/canonical-markdown-migration.ts`
- Modify: `packages/importer/src/canonical-markdown-migration.test.ts`
- Modify: `packages/local-mcp/src/local-graph.ts`
- Modify: `packages/local-mcp/src/local-graph.test.ts`
- Create: `packages/local-review-site/src/review-auto-apply.ts`
- Create: `packages/local-review-site/src/review-auto-apply.test.ts`
- Modify: `packages/local-review-site/src/server.ts`
- Modify: `packages/check/src/canonical-isolated-copy-runner.ts`
- Modify: `packages/check/src/canonical-isolated-copy-runner.test.ts`

**Interfaces:**
- Produces: `planExactPreservation(queue)` and `applyExactPreservation(context, plan, acknowledgement)` with a counts-and-hashes-only receipt.
- Adds: explicit `meaning_state="non-meaningful"` while retaining `coverage_state="unrepresented"` and an empty canonical-object set for a source whose meaning accounting is empty.

- [ ] **Step 1: Write failing safety and idempotency tests**

```ts
expect(plan.auto_apply).toContain(completeRichCandidate.candidate_id);
expect(plan.manual).toContain(identityConflictCandidate.candidate_id);
expect(plan.auto_apply).not.toContain(incompleteCandidate.candidate_id);
expect(secondApply).toMatchObject({ committed: 0, idempotent: plan.auto_apply.length });
expect(receipt).not.toHaveProperty("source_text");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/importer/src/canonical-markdown-migration.test.ts packages/local-mcp/src/local-graph.test.ts packages/local-review-site/src/review-auto-apply.test.ts packages/check/src/canonical-isolated-copy-runner.test.ts`

- [ ] **Step 3: Implement deterministic selection**

Auto-apply only when the candidate has exact encrypted source preservation, at least one meaningful unit, complete proposed records and references, represented parity for every unit, no typed omission affecting the candidate, no merge/edit intent, and no conflicting evidence. The operation updates the review to `recommendation="auto-apply"` and `resolution_state="auto-applied"`; it does not rewrite any assertion or entity.

For zero-meaning sources, have the importer retain unrepresented parity with an explicit non-meaningful marker and allow an auto-applied review only when source accounting proves there is nothing semantic to represent. `resolution_apply` must reject unrepresented parity for every meaningful source and must reject a non-meaningful marker when the same candidate names any canonical representation.

- [ ] **Step 4: Apply through `localResolutionApply` only**

Use stable per-candidate operation/idempotency keys and the current review version. A failure records a counts-only candidate outcome and continues; no graph file is written directly.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/importer/src/canonical-markdown-migration.test.ts packages/local-mcp/src/local-graph.test.ts packages/local-review-site/src/review-auto-apply.test.ts packages/check/src/canonical-isolated-copy-runner.test.ts && pnpm check`

Commit: `feat(review): auto-apply exact source preservation`

---

### Task 3: Add Canonical Research Results And Independence Evaluation

**Files:**
- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`
- Create: `packages/graph-service/src/canonical-recommendation.ts`
- Create: `packages/graph-service/src/canonical-recommendation.test.ts`
- Create: `packages/check/src/canonical-research-runner.ts`
- Create: `packages/check/src/canonical-research-runner.test.ts`

**Interfaces:**
- Produces: `evaluateResearchRecommendation(input): "auto-apply" | "owner-review" | "research"` and an injected `runCanonicalResearchCandidate()` with no default network transport.

- [ ] **Step 1: Write failing evidence-rule tests**

```ts
expect(evaluate(twoIndependentPublicSources)).toBe("auto-apply");
expect(evaluate(linkedInPlusIndependentOrganization)).toBe("auto-apply");
expect(evaluate(twoSyndicatedCopies)).toBe("research");
expect(evaluate(withRefutingEvidence)).toBe("owner-review");
expect(evaluate(identityAmbiguous)).toBe("owner-review");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-recommendation.test.ts packages/check/src/canonical-research-runner.test.ts`

- [ ] **Step 3: Implement bounded research records**

Each result records candidate/unit IDs, normalized query hash, connector kind (`public-web`, `linkedin`, `organization`, or `local-corpus`), upstream identity, independence key, content hash, retrieval time, bounded excerpt or encrypted snapshot reference, stance, identity confidence, and proposed canonical mutation hash. Do not add researched phone, email, address, or inferred personal relationships.

- [ ] **Step 4: Implement deterministic run and proposal IDs**

Derive run IDs from candidate + unit + connector + normalized query + algorithm version; evidence IDs from upstream identity + locator + content hash; proposal IDs from normalized canonical mutations. Exact reruns return the prior result, while changed evidence creates a new append-only result.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-recommendation.test.ts packages/check/src/canonical-research-runner.test.ts && pnpm typecheck`

Commit: `feat(research): add provenance-bound candidate research`

---

### Task 4: Enforce Research Evidence At The Mutation Boundary

**Files:**
- Modify: `packages/local-mcp/src/local-graph.ts`
- Modify: `packages/local-mcp/src/local-graph.test.ts`
- Modify: `packages/local-mcp/src/audit.ts`

**Interfaces:**
- Consumes: research-result records and canonical evidence from Task 3.
- Produces: fail-closed third-party `auto-apply` validation and redacted research audit events.

- [ ] **Step 1: Write failing bypass and retry tests**

```ts
expect(await apply(singlePublicSourceAutoApply)).toMatchObject({ ok: false, reason: "research-evidence-insufficient" });
expect(await apply(twoIndependentSources)).toMatchObject({ ok: true });
expect(await apply(conflictingSources)).toMatchObject({ ok: false, reason: "research-evidence-conflict" });
expect(retry.result.generation).toBe(first.result.generation);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts`

- [ ] **Step 3: Validate before commit and audit remote reads**

Require research auto-applied facts/relationships to reference the qualifying result and evidence set. Audit connector, outcome, independence-group count, operation ID, and idempotency key without URL, excerpt, query text, or personal payload.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts && pnpm check`

Commit: `fix(research): enforce independent evidence on apply`

---

### Task 5: Make Source Coverage, Evidence, And Graph Topology Legible

**Files:**
- Modify: `packages/local-review-site/src/review-projection.ts`
- Modify: `packages/local-review-site/src/review-projection.test.ts`
- Modify: `packages/local-review-site/src/app.js`
- Modify: `packages/local-review-site/src/server.test.ts`
- Modify: `packages/local-review-site/src/index.html`
- Modify: `packages/local-review-site/src/styles.css`

**Interfaces:**
- Produces: exact source-to-every-destination mappings, actual entity/fact/relationship adjacency, per-destination evidence summaries, and recommendation rationale.

- [ ] **Step 1: Write failing projection and copy tests**

```ts
expect(item.unit_mappings.every(mapping => mapping.destination_records.length > 0)).toBe(true);
expect(item.graph.edges[0]).toMatchObject({ source_entity_id, target_entity_id, predicate });
expect(item.decision_summaries[0]).toMatchObject({ parity: "covered", confidence: "high" });
expect(normalView).not.toMatch(/canonical|parity|legacy|Codex/i);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts`

- [ ] **Step 3: Project real mappings and topology**

Entities map to the exact units whose typed endpoint evidence created them. Facts attach to their subjects; relationships connect their actual endpoints; observations remain dashed unresolved assertions. Source context stays outside the graph. Evidence is summarized by stance, source label, retrieval date, and confidence; private locators and excerpts appear only in the selected local detail.

- [ ] **Step 4: Render the compact decision surface**

Default to Review when owner work exists. Keep the untouched source visibly anchored, show each extracted item beside its destination, and synchronize hover/focus highlights and connector lines. Use plain language: `Context explains why. Nodes are people, organizations, projects, places, or events. Lines show relationships.` Normal buttons are `Keep`, `Edit`, `Merge`, `Research`, and `Later`; IDs stay under Technical details.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts && pnpm typecheck`

Commit: `feat(review): show exact source-to-graph coverage`

---

### Task 6: Add Typed Edits And Reversible Merge Decisions

**Files:**
- Modify: `packages/local-review-site/src/review-projection.ts`
- Modify: `packages/local-review-site/src/review-projection.test.ts`
- Modify: `packages/local-review-site/src/server.ts`
- Modify: `packages/local-review-site/src/server.test.ts`
- Modify: `packages/local-review-site/src/app.js`
- Modify: `packages/local-review-site/src/styles.css`

**Interfaces:**
- Produces: schema-bounded entity/fact/relationship edit intents and an evidence-backed merge intent targeting an existing canonical entity.

- [ ] **Step 1: Write failing atomic edit and merge tests**

```ts
expect(await editFact).toCreateSuccessor({ supersedes: [originalFactId] });
expect(await editRelationship).toCreateSuccessor({ supersedes: [originalRelationshipId] });
expect(await merge).toPreserveEntities([candidateId, canonicalId]);
expect(resolveEntityId(candidateId)).toBe(canonicalId);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts`

- [ ] **Step 3: Implement bounded edit intents**

Allow only schema fields already supported by the canonical contracts. Changing fact or relationship meaning creates a successor assertion with explicit lineage; it never mutates history in place. Show the before/after mini graph before submission.

- [ ] **Step 4: Implement merge target and impact preview**

Only same-type active entities are eligible. Require supporting evidence and identity confidence, show affected facts/relationships, and submit one `atlas.entity-resolution:v1` merge through `resolution_apply`. Never delete either ID or bulk-rewrite references.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/local-review-site/src/review-projection.test.ts packages/local-review-site/src/server.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts && pnpm check`

Commit: `feat(review): add reversible edits and merges`

---

### Task 7: Browser QA And Private Isolated-Copy Reduction

**Files:**
- Private runtime artifacts only for the isolated copy and counts-only receipts.
- No personal source or research content is committed.

**Interfaces:**
- Consumes: the new loopback review launcher from the production-cutover plan, the frozen working copy, and private research packets.
- Produces: a new versioned isolated candidate, counts-only research/auto-apply report, and screenshots outside the repository.

- [ ] **Step 1: Verify synthetic browser flows**

Use 1440×900, 1024×768, 390×844, and 640 CSS px/200% zoom. Prove page identity, nonblank rendering, no framework overlay, console health, source-to-destination hover/focus, graph/evidence display, batch preview, edit, merge, research, defer, and partial-result recovery.

- [ ] **Step 2: Refresh the disposable working copy and record the delta**

Run the existing read-only-source refresh script. Require live-source before/after manifests to match and write the working-copy delta manifest. Never write to the live source or frozen baseline.

- [ ] **Step 3: Build a fresh encrypted candidate**

Use a new empty destination, the stable authority/path identity, and a newly sealed private keyring. Require zero missing references, zero unrepresented meaningful units, zero reopen mismatches, and exact full-source ledger equality.

- [ ] **Step 4: Auto-apply exact preservation, then run bounded research**

Run Task 2 in dry-run mode, inspect counts, apply with acknowledgement, and re-run idempotently. Run candidate-scoped public research; use signed-in LinkedIn only when the browser connection is available. Automatically apply only results meeting Task 3/4 evidence rules; everything else remains Research or Review with a succinct recommendation.

- [ ] **Step 5: Prove backup/restore and final queue counts**

Restore into a new empty directory and require encrypted snapshot, keyring, canonical manifest, review counts, redirect map, typed reads, and CRUD/idempotency receipts to match. Produce counts-only totals for automatic, research, review, later, and incomplete lanes.

- [ ] **Step 6: Commit counts-only documentation if needed**

Do not commit private paths, names, source text, excerpts, URLs, or identifiers. Runtime evidence remains in the private application-support directory.
