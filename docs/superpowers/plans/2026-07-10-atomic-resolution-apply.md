# Atomic Resolution Apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement issue #47’s local-only `resolution_apply` command so one review candidate creates or updates its complete canonical result atomically and returns honest local, audit, and sync-queue custody states.

**Architecture:** Extend the existing encrypted `FileLocalGraphStore` snapshot with durable operation-group records. A transaction prevalidates every encrypted draft against one generation, atomically replaces the snapshot with all accepted objects and their derived sync changes, then lets the local MCP boundary derive audit and outbox work using the same operation id. Failed post-commit audit or outbox writes never roll back the local canonical commit; their receipt states become `reconciliation-required`.

**Tech Stack:** TypeScript ESM, Zod 4, Vitest, pnpm workspaces.

## Global Constraints

- Follow ADR 0006 exactly: one candidate commits completely or not at all; generic object/edge batches remain partial administrative tools and are not used for semantic resolution.
- Accept only canonical `atlas.*` payloads under their derived non-legacy runtime types; reject `page`, `block`, `logseq-*`, and source-capsule payloads.
- New source-corpus records, including sensitive facts and contact details, default to `local-private` and stay encrypted in the local store.
- The local operation record must preserve idempotency, accepted object ids, versions, generation, sync changes, and reconciliation state without plaintext payloads.
- No hosted transaction, deployment, real profile, original Logseq archive, or remote service is involved.

---

### Task 1: Add Durable Local Operation-Group Transactions

**Files:**

- Modify: `packages/local-graph-store/src/local-graph-store.ts`
- Modify: `packages/local-graph-store/src/local-graph-store.test.ts`

**Interfaces:**

- Produces `LocalGraphOperationRecord`, `LocalGraphTransactionWrite`, `LocalGraphTransactionResult`, and `FileLocalGraphStore.commitTransaction(input)`.
- A transaction takes `{ expected_generation, actor_id, operation_id, idempotency_key, recorded_at, writes }`; each write is a full create or update envelope/draft.
- A successful result contains all committed objects, their derived `SyncChangeEvent`s, one incremented generation, one journal sequence, and `persistence: "atomic-snapshot-operation"`.

- [x] **Step 1: Write failing transaction tests**

Add tests proving that a two-write transaction:

```ts
await expect(store.commitTransaction({
  expected_generation: 0,
  actor_id: fixtureLocalClientId,
  operation_id: "la_operation_resolution0001",
  idempotency_key: "la_idem_resolution0001",
  recorded_at: now,
  writes: [
    { kind: "create", object: firstDraft },
    { kind: "create", object: secondDraft }
  ]
})).resolves.toMatchObject({
  ok: true,
  generation: 1,
  objects: [expect.objectContaining({ object_id: firstDraft.object_id }), expect.objectContaining({ object_id: secondDraft.object_id })]
});
expect(store.listObjects().map((object) => object.object_id)).toEqual([firstDraft.object_id, secondDraft.object_id]);
```

Add a second test with a duplicate object id in the same transaction and assert
`{ ok: false, reason: "object-already-exists" }` and an unchanged generation and object list. Add a third test that retries the same idempotency key and receives the original committed result without another generation increment.

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/local-graph-store/src/local-graph-store.test.ts`

Expected: FAIL because `commitTransaction` does not exist.

- [x] **Step 3: Write the minimal transaction implementation**

Add strict Zod schemas and types for operation records. Add optional
`operation_records` to `LocalGraphSnapshotSchema` with default `[]`, and add it
to in-memory state and `snapshotFromState`. A record contains exactly:

```ts
{
  operation_id: OperationIdSchema,
  idempotency_key: z.string().min(1),
  actor_id: z.string().min(1),
  recorded_at: IsoTimestampSchema,
  generation: z.number().int().positive(),
  journal_sequence: z.number().int().positive(),
  objects: z.array(GraphObjectEnvelopeSchema).min(1),
  changes: z.array(SyncChangeEventSchema).min(1)
}
```

Inside `serializeMutation`, first return the stored result when an existing
operation record has the same idempotency key. Otherwise, convert every write
through `objectForPersistence`, validate all authority, existence, duplicate-id,
version, and tombstone constraints against a cloned pre-transaction map, and
derive every sync change before writing. Build one next state with generation
and journal sequence incremented once, append the operation record, and persist
the complete state with one `atomicWriteJson(snapshotPath, ...)`. Assign
`this.state` only after that write succeeds. Do not append any per-object journal
entry for this transaction.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/local-graph-store/src/local-graph-store.test.ts`

Expected: PASS; an invalid member produces no partial object, and a retry is
idempotent.

### Task 2: Define The Typed Canonical Resolution Request And Receipt

**Files:**

- Modify: `packages/local-mcp/src/local-graph.ts`
- Modify: `packages/local-mcp/src/local-graph.test.ts`

**Interfaces:**

- Produces `LocalResolutionApplyInput`, `LocalResolutionReceipt`, and `localResolutionApply(context, input)`.
- Input carries authorization, operation id, idempotency key, candidate id, expected graph generation, expected review version, and complete plaintext canonical drafts.
- Receipt separates `local_commit: "committed" | "not-committed"`, `audit: "recorded" | "reconciliation-required"`, and `sync_queue: "queued" | "not-configured" | "reconciliation-required"`.

- [ ] **Step 1: Write the failing local MCP tests**

Build a synthetic local keyring/store context and an authenticated local client.
Create a request with an entity draft, fact draft, evidence draft, review-item
draft, and represented parity-record draft for one `la_candidate_...` id. Assert:

```ts
await expect(localResolutionApply(context, request)).resolves.toMatchObject({
  ok: true,
  result: {
    local_commit: "committed",
    audit: "recorded",
    sync_queue: "queued",
    committed_object_ids: expect.arrayContaining([
      entityDraft.object_id,
      factDraft.object_id,
      evidenceDraft.object_id,
      reviewDraft.object_id,
      parityDraft.object_id
    ])
  }
});
```

Add a second request whose parity record names an object absent from its mutation
set; assert `local_commit: "not-committed"` and no object-count change. Add a
third request with an outbox sink that throws; assert `local_commit: "committed"`
and `sync_queue: "reconciliation-required"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts`

Expected: FAIL because `localResolutionApply` does not exist.

- [ ] **Step 3: Write the minimal local resolution service**

Add a strict input schema that accepts only `PlaintextGraphObjectDraft`s whose
`payload.data` parses as `CanonicalWriteSchema`; require the envelope object type
to equal the derived canonical type and `access_class: "local-private"`. Require
one canonical review item whose `candidate_id` equals the request candidate and
whose resolution state is `resolved`, `auto-applied`, `research`,
`owner-review`, or `deferred-unknown`. Require every represented parity record
to name only object ids in the complete mutation set.

Authenticate and run create policy checks for every draft before calling
`context.graphStore.commitTransaction`. Derive a `create` write only when the
object id is absent; otherwise derive an `update` write, require
`draft.version === existing.version + 1`, and require the review-item draft’s
previous version to equal `expected_review_version`. Reject synthetic in-memory
contexts with `resolution-requires-durable-local-store`. After a committed
transaction, record one redacted `resolution_apply` audit decision. Attempt one
outbox enqueue per committed object using the same operation id/generation/
sequence. Catch audit or outbox failures independently and return the receipt
states instead of changing the local commit result.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/local-mcp/src/local-graph.test.ts packages/local-graph-store/src/local-graph-store.test.ts`

Expected: PASS; a candidate is all-or-nothing and post-commit custody failures
are reported honestly.

### Task 3: Expose `resolution_apply` Only Through Local MCP

**Files:**

- Modify: `packages/mcp-contract/src/index.ts`
- Modify: `packages/local-mcp/src/server.ts`
- Modify: `packages/local-mcp/src/server.test.ts`

**Interfaces:**

- Adds `resolution_apply` to `LivingAtlasMcpToolName` and its local-only metadata.
- `LocalMcpToolInputSchemas.resolution_apply` exposes the typed request without an authorization field; the server injects authorization internally.

- [ ] **Step 1: Write the failing server contract test**

Add assertions that `LivingAtlasMcpToolNames` and `LocalMcpToolInputSchemas` both
contain `resolution_apply`, its input schema has no `authorization` property,
and the graph-service adapter dispatches it to `localResolutionApply`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/local-mcp/src/server.test.ts packages/graph-service/src/index.test.ts`

Expected: FAIL because the tool name and route are absent.

- [ ] **Step 3: Write the minimal MCP wiring**

Add the name, public-safe description, and an object input schema with
`operation_id`, `idempotency_key`, `candidate_id`, `expected_generation`,
`expected_review_version`, and `objects`. In the local server adapter, dispatch
only the local-stdio command to `localResolutionApply`; do not add a remote HTTP
route or Cloudflare worker handler. Register one MCP tool with
`readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/local-mcp/src/server.test.ts packages/graph-service/src/index.test.ts`

Expected: PASS; generic batch tools remain separate from semantic resolution.

### Task 4: Verify, Track, And Commit #47

**Files:**

- Modify only the files in Tasks 1–3 and this plan if verification finds a real defect.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm vitest run packages/local-graph-store/src/local-graph-store.test.ts packages/local-mcp/src/local-graph.test.ts packages/local-mcp/src/server.test.ts packages/graph-service/src/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

Run: `pnpm check`

Expected: repository safety, typecheck, and all tests pass.

- [ ] **Step 3: Audit the resolution boundary**

Run:

```bash
rg -n 'object_batch|edge_batch|logseq-|object_type: "page"|object_type: "block"' packages/local-mcp/src/local-graph.ts packages/local-graph-store/src/local-graph-store.ts
```

Expected: `resolution_apply` does not call generic batch tools or write a legacy
canonical payload.

- [ ] **Step 4: Update tracker and commit locally**

Post public-safe test and scope evidence to #47 and #43, keep #47 In Progress
until #46/#48/#49 consume the operation record, and commit only this #47 slice.
Do not push, deploy, access a profile, or start identity-resolution behavior in
the same commit.
