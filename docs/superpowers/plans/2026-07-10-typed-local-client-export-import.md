# Typed Local Atlas Client and Canonical Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed local Atlas client that reads encrypted canonical records and atomically exports/imports canonical data without a remote transport or second database.

**Architecture:** The new client adapts `FileLocalGraphStore` and a caller-supplied local decryptor. Export decrypts only canonical envelopes into the existing `CanonicalExport` contract; fresh import validates that export and uses one local transaction to recreate all records. It never reads a legacy envelope or calls HTTP/MCP.

**Tech Stack:** TypeScript ESM, Zod 4, Vitest, `FileLocalGraphStore`, local keyring.

## Global Constraints

- Export/import only versioned `atlas.*` payloads under canonical envelope types.
- Preserve record id, authority, version, content hash, access class, and canonical payload exactly.
- Reject conflicting target objects before any import write; no partial import.
- Local decryptors and plaintext stay inside the caller’s authenticated local process.
- No remote transport, Cloudflare API, profile/archive access, deploy, or push.

---

### Task 1: Write a Typed Local Canonical Client Contract

**Files:**
- Create: `packages/atlas-client/src/local-canonical.ts`
- Create: `packages/atlas-client/src/local-canonical.test.ts`
- Modify: `packages/atlas-client/src/index.ts`

**Interfaces:**
- Produces `createLocalCanonicalAtlasClient({ graphStore, decryptPayload, now? })`.
- The returned client provides `exportCanonical({ exported_at? })` and `importCanonical({ exported, expected_generation, actor_id, operation_id, idempotency_key, recorded_at? })`.

- [ ] **Step 1: Write the failing round-trip test**

Create an encrypted source store containing synthetic entity, evidence, fact, review, and parity records. Export it, import into an empty encrypted target store, reopen the target, then export again.

```ts
expect(targetExport).toEqual(sourceExport);
expect(JSON.stringify(await readFile(join(targetDir, "snapshot.json"), "utf8"))).not.toContain("Synthetic local canonical export");
```

Add a second request with one target object pre-created and assert `object-already-exists`, unchanged generation, and no imported sibling object.

- [ ] **Step 2: Verify the tests fail**

Run: `pnpm vitest run packages/atlas-client/src/local-canonical.test.ts`

Expected: FAIL because the local canonical client module does not exist.

- [ ] **Step 3: Implement the narrow local client**

For export, enumerate active store objects of canonical runtime types, decrypt each, parse `{ object_type, payload }` through `CanonicalWriteSchema`, require envelope id equals `canonicalPayloadObjectId(payload)`, and produce `parseCanonicalExport({ ... })` records sorted by object id. A canonical runtime envelope whose decrypted body is not canonical must throw `canonical-export-invalid-object`; legacy envelopes are excluded.

For import, call `parseCanonicalExport`, require the export authority equals `graphStore.status().authority_id`, turn each record into a `PlaintextGraphObjectDraft` with the record’s exact id/type/version/access/content hash and local timestamps, and submit all-create writes to `commitTransaction`. Return its atomic result unchanged.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run packages/atlas-client/src/local-canonical.test.ts packages/contracts/src/knowledge.test.ts`

Expected: PASS.

Commit: `git commit -m "Add typed local canonical export and import (#49)"`

### Task 2: Verify #49 and Track It

**Files:**
- Modify: this plan only if verification finds a real defect.

- [ ] **Step 1: Run the local-only boundary audit and full gate**

```bash
rg -n 'fetch\(|remoteMcp|logseq-|object_type: "page"|object_type: "block"' packages/atlas-client/src/local-canonical.ts
pnpm check
```

Expected: no remote/legacy path in the local client; repository gate passes.

- [ ] **Step 2: Track and commit locally**

Post public-safe scope and test evidence to #49 and #43, keep #49 In Progress until the review app consumes it, and commit locally only.
