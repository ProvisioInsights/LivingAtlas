# Production Canonical Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the encrypted Atlas-native graph the authoritative production knowledge store while retaining the legacy corpus and former profile as read-only rollback material.

**Architecture:** Promote a verified canonical export additively into the existing local authority through one guarded transaction, record a durable cutover receipt derived from real artifacts, and route ordinary clients through typed canonical APIs. Only after local decrypt/restart/backup/restore parity is proven may the existing two-phase outbox backfill place every encrypted object under Cloudflare custody.

**Tech Stack:** TypeScript 7, Zod, Vitest, encrypted `FileLocalGraphStore`, local MCP, canonical Atlas client, Cloudflare Worker/D1/R2/DO sync, macOS Keychain.

## Global Constraints

- Never modify or delete the source corpus, frozen source copy, prior isolated candidates, legacy production objects, or pre-cutover backup.
- Every canonical knowledge payload is `local-private`, encrypted at rest, and remotely visible only as ciphertext plus opaque metadata.
- One Atlas mutation boundary owns durable canonical writes; review and operator tooling submit typed intents and cannot write graph files directly.
- Production readiness is derived from persisted conversion, decrypt, restart, backup/restore, mutation, sync, and acceptance artifacts; callers cannot supply readiness booleans.
- Empty or source-system-only files are accounted for explicitly as non-meaningful source units and cannot masquerade as unresolved knowledge.
- Production promotion is additive, idempotent, generation-checked, authority-checked, manifest-checked, and fail-closed.
- Cloud backfill uses the existing stage then arm workflow; staging cannot sync, and arming remains a separate acknowledged mutation.
- Production backups are daily full backups until journal-differential chain restore exists; the automated writer receives only an asymmetric recovery public key.
- Logs and committed docs contain counts, hashes, reason codes, and opaque identifiers only—never plaintext knowledge, secrets, private source paths, or decrypted payloads.
- Ordinary Praxis/client paths use typed canonical entities, assertions, observations, relationships, provenance, timeline, and redirects; raw object CRUD remains an administrative recovery surface.

---

### Task 1: Preserve backup semantics and reject forged canonical exports

**Files:**
- Modify: `packages/check/src/backup-run.ts`
- Modify: `packages/check/src/backup-run.test.ts`
- Modify: `packages/atlas-client/src/local-canonical.ts`
- Modify: `packages/atlas-client/src/local-canonical.test.ts`

**Interfaces:**
- Consumes: `FileLocalGraphStore.materializedSnapshot()` and `CanonicalExport`.
- Produces: backup snapshots whose `plaintext_persistence` value is unchanged, and `importCanonical()` that recomputes every canonical payload hash before commit.

- [ ] **Step 1: Write failing backup and import tests**

```ts
expect(restored.plaintext_persistence).toBe(source.plaintext_persistence);
await expect(client.importCanonical({ ...request, exported: forgedHashExport }))
  .rejects.toThrow("canonical-import-content-hash-mismatch");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/check/src/backup-run.test.ts packages/atlas-client/src/local-canonical.test.ts`

Expected: the backup test reports `redacted` instead of `encrypted`; the forged-hash import succeeds or fails with the wrong reason.

- [ ] **Step 3: Preserve source snapshot mode and recompute hashes**

```ts
const source = JSON.parse(await readFile(join(graphDir, "snapshot.json"), "utf8"));
const snapshot = store.materializedSnapshot();
snapshot.plaintext_persistence = source.plaintext_persistence;

for (const record of exported.records) {
  if (canonicalPayloadHash(record.payload) !== record.content_hash) {
    throw new Error("canonical-import-content-hash-mismatch");
  }
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm vitest run packages/check/src/backup-run.test.ts packages/atlas-client/src/local-canonical.test.ts && pnpm typecheck`

Commit: `fix(canonical): preserve backup and import integrity`

---

### Task 2: Make resolution apply the authoritative semantic boundary

**Files:**
- Modify: `packages/contracts/src/knowledge.ts`
- Modify: `packages/contracts/src/knowledge.test.ts`
- Modify: `packages/graph-service/src/canonical-entity-resolution.ts`
- Modify: `packages/graph-service/src/canonical-entity-resolution.test.ts`
- Modify: `packages/local-mcp/src/audit.ts`
- Modify: `packages/local-mcp/src/local-graph.ts`
- Modify: `packages/local-mcp/src/local-graph.test.ts`

**Interfaces:**
- Consumes: `CanonicalWriteSchema`, current graph objects, `LocalResolutionApplyInput`.
- Produces: `validateCanonicalMutationSet()` and a receipt whose audit/outbox records share `operation_id` and `idempotency_key`.

- [ ] **Step 1: Write failing invariant tests**

```ts
expect(await apply(missingEvidenceReference)).toMatchObject({ ok: false, reason: "resolution-missing-reference" });
expect(await apply(competingActiveMerge)).toMatchObject({ ok: false, reason: "resolution-conflict" });
expect(await apply(mismatchedCoverage)).toMatchObject({ ok: false, reason: "resolution-parity-mismatch" });
expect(audit.operation_id).toBe(request.operation_id);
expect(outbox.idempotency_key).toBe(request.idempotency_key);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts packages/local-mcp/src/local-graph.test.ts`

- [ ] **Step 3: Implement complete reference and redirect validation**

Validate exactly one matching review, identical review/parity coverage sets, proposed-object existence, evidence/entity/lineage references, one active canonical redirect per entity, and no redirect cycles before committing. Add actor, evidence stance, operation, and idempotency fields to durable records.

- [ ] **Step 4: Make retries idempotent across graph, audit, and outbox**

```ts
const prior = graphStore.operationRecordForIdempotency(input.idempotency_key);
if (prior) return reconcileResolutionReceipt(prior, auditSink, outboxSink);
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/contracts/src/knowledge.test.ts packages/graph-service/src/canonical-entity-resolution.test.ts packages/local-mcp/src/local-graph.test.ts && pnpm typecheck`

Commit: `feat(canonical): enforce semantic mutation invariants`

---

### Task 3: Complete typed canonical reads and artifact-derived readiness

**Files:**
- Modify: `packages/atlas-client/src/local-canonical.ts`
- Modify: `packages/atlas-client/src/local-canonical.test.ts`
- Modify: `packages/graph-service/src/canonical-parity.ts`
- Modify: `packages/graph-service/src/canonical-parity.test.ts`
- Create: `packages/check/src/canonical-cutover-readiness.ts`
- Create: `packages/check/src/canonical-cutover-readiness.test.ts`

**Interfaces:**
- Produces: `entityGet`, `assertionsForEntity`, `observationsForEntity`, `relationshipsForEntity`, `provenanceForAssertion`, `timelineForEntity`, `resolveEntityId`, and `deriveCanonicalCutoverReadiness(artifacts)`.

- [ ] **Step 1: Write failing typed-read and forged-readiness tests**

```ts
expect(await client.resolveEntityId(mergedId)).toBe(canonicalId);
expect((await client.assertionsForEntity(mergedId)).every(x => x.subject_entity_id === canonicalId)).toBe(true);
expect(() => deriveCanonicalCutoverReadiness({ ...artifacts, decryptProof: undefined }))
  .toThrow("cutover-proof-missing");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/atlas-client/src/local-canonical.test.ts packages/graph-service/src/canonical-parity.test.ts packages/check/src/canonical-cutover-readiness.test.ts`

- [ ] **Step 3: Implement redirect-aware typed projections and proof-derived gates**

Cutover readiness must verify signed/digested artifact schemas for conversion integrity, canonical decrypt coverage, restart manifest equality, backup/restore manifest equality, mutation/idempotency proof, zero pending reconciliation, explicit accounting for zero-meaning source files, and owner acceptance.

- [ ] **Step 4: Verify GREEN and commit**

Run: `pnpm vitest run packages/atlas-client/src/local-canonical.test.ts packages/graph-service/src/canonical-parity.test.ts packages/check/src/canonical-cutover-readiness.test.ts && pnpm typecheck`

Commit: `feat(canonical): derive typed cutover readiness`

---

### Task 4: Add guarded operator commands for conversion, review, promotion, and rollback

**Files:**
- Modify: `package.json`
- Modify: `packages/check/src/canonical-isolated-copy-runner.ts`
- Create: `packages/check/src/canonical-production-promotion.ts`
- Create: `packages/check/src/canonical-production-promotion.test.ts`
- Modify: `packages/local-review-site/package.json`
- Create: `packages/local-review-site/src/cli.ts`
- Modify: `docs/getting-started.md`
- Modify: `README.md`

**Interfaces:**
- Produces commands: `canonical:convert-isolated`, `canonical:review`, `canonical:cutover-report`, `canonical:promote-production`, and `canonical:verify-production`.

- [ ] **Step 1: Write failing promotion safety tests**

```ts
await expect(preflight({ candidateAuthority: "a", liveAuthority: "b" })).rejects.toThrow("authority-mismatch");
await expect(preflight({ backupManifestMatch: false })).rejects.toThrow("backup-proof-missing");
await expect(promoteTwice()).resolves.toMatchObject({ idempotent: true });
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/check/src/canonical-production-promotion.test.ts packages/check/src/canonical-isolated-copy-runner.test.ts packages/local-review-site/src/server.test.ts`

- [ ] **Step 3: Implement dry-run by default and explicit promotion acknowledgement**

The live mutation path requires `LIVING_ATLAS_CANONICAL_PROMOTION_ACK=promote-verified-canonical-candidate`, an empty live outbox, a current-generation match, a complete backup/restore proof, matching authority and canonical manifest, and a non-live candidate path. Commit the entire candidate in one graph transaction and persist a private counts-and-hashes-only receipt beside the live replica.

- [ ] **Step 4: Add loopback review launcher and documented rollback**

The review CLI binds only to `127.0.0.1`, authenticates with a fresh local token, reads the live canonical graph through the typed client, and never hosts private review state. Rollback stops clients and restores the verified pre-cutover backup into a new directory; it never overwrites the current profile in place.

- [ ] **Step 5: Verify GREEN and commit**

Run: `pnpm vitest run packages/check/src/canonical-production-promotion.test.ts packages/check/src/canonical-isolated-copy-runner.test.ts packages/local-review-site/src/server.test.ts && pnpm check`

Commit: `feat(canonical): add guarded production promotion`

---

### Task 5: Promote and prove the production authority

**Execution dependency:** Steps 1–2 may run after Task 4, but Steps 3–6 are blocked until Task 6 has completed and its production restore drill is green.

**Files:**
- Runtime artifacts only under the private LivingAtlas application-support directory and private deploy overlay.
- No source-corpus or personal graph content is committed.

- [ ] **Step 1: Rebuild the isolated candidate from the frozen source copy**

Run `npm run canonical:convert-isolated` with private paths, stable authority/path-redaction identity, and the isolated-copy acknowledgement. Require zero missing references, zero unrepresented meaningful units, zero reopen mismatches, and encrypted-at-rest storage.

- [ ] **Step 2: Prove isolated backup/restore and typed reads**

Create a full encrypted backup, restore to a new empty directory, and require canonical ID/hash manifest equality, decrypt coverage equality, redirect equality, and review-count equality.

- [ ] **Step 3: Back up and promote production additively**

Stop the local sync agent, require an empty outbox, create and restore-verify a pre-cutover full backup, run production promotion once, reopen the store, and require the cutover report to be ready before writing the production acceptance receipt.

- [ ] **Step 4: Verify local authority behavior**

Run typed entity/assertion/relationship/provenance/timeline queries, canonical create/update/idempotent retry, restart persistence, and local MCP status against the production profile. Legacy objects remain present only for rollback/admin recovery and are excluded from typed ordinary reads.

- [ ] **Step 5: Stage and drain complete encrypted cloud custody**

Run the usage gate, stage the full live snapshot through `real-data:backfill-outbox`, inspect counts, separately arm it after lifecycle verification, and drain one bounded generation at a time. Require zero pending/failed outbox records and a local cursor equal to the deployed remote generation.

- [ ] **Step 6: Final verification and merge**

Run `pnpm check`, focused production/cutover suites, provenance verification, live authenticated health/usage/ops reports, canonical decrypt coverage, and a final fresh backup/restore manifest comparison. Merge `codex/local-first-mvp` into local `main` only after every gate is green; do not delete rollback material.

---

### Task 6: Make disaster recovery independently recoverable and immutable

**Files:**
- Modify: `packages/backup/src/cloud/r2-objectlock.ts`
- Modify: `packages/backup/src/cloud/r2-objectlock.test.ts`
- Modify: `packages/backup/src/escrow.ts`
- Modify: `packages/backup/src/escrow.test.ts`
- Modify: `packages/check/src/backup-run.ts`
- Modify: `packages/check/src/backup-run.test.ts`
- Modify: `packages/check/src/backup-restore.ts`
- Modify: `packages/check/src/backup-restore.test.ts`
- Modify in the private deploy overlay: `terraform/main.tf`
- Modify in the private deploy overlay: `terraform/variables.tf`
- Modify in the private deploy overlay: `terraform/outputs.tf`
- Create in the private deploy overlay: `scripts/install-local-backup-agent.sh`
- Create in the private deploy overlay: `scripts/run-local-backup-agent.sh`
- Modify in the private deploy overlay: `RUNBOOK.md`

**Interfaces:**
- Consumes: Cloudflare R2 bucket-lock REST verification, ordinary S3-compatible object reads/writes, a recovery X25519 public key, and Keychain-resolved production keyring passphrase.
- Produces: a self-sufficient encrypted recovery bundle, bucket-lock-verified remote full backups, read-only remote restore, and an hourly LaunchAgent that creates at most one daily full backup.

- [ ] **Step 1: Write failing provider-contract and recovery tests**

```ts
expect(putRequest).not.toHaveProperty("ObjectLockMode");
expect(lockRule.retentionDays).toBeGreaterThanOrEqual(90);
expect(() => createRecoveryBundle({ recoveryPublicKey: undefined })).toThrow("recovery-public-key-required");
expect(restored.keyringPassphrase).toBe("synthetic-passphrase");
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run packages/backup/src/cloud/r2-objectlock.test.ts packages/backup/src/escrow.test.ts packages/check/src/backup-run.test.ts packages/check/src/backup-restore.test.ts`

Expected: the current adapter emits unsupported AWS Object Lock fields, the writer requires a symmetric master, and restore cannot recover the keyring passphrase.

- [ ] **Step 3: Implement bucket-lock-aware remote storage**

Use ordinary conditional object writes plus read-back SHA-256 verification. Verify a whole-bucket or matching-prefix Cloudflare lock rule before and after writes; fail closed if its retention age is shorter than the requested retention. Do not send `x-amz-object-lock-*` headers or call per-object retention APIs.

- [ ] **Step 4: Implement asymmetric self-sufficient recovery bundles**

```ts
type RecoveryBundleV2 = {
  schema: "living-atlas-recovery-bundle:v2";
  authority_id: string;
  sealed_keyring_json: string;
  keyring_passphrase: string;
  keyring_sha256: `sha256:${string}`;
};
```

Seal this bundle to an X25519 recovery public key. The automated writer reads only that public key and the current keyring passphrase; the private recovery key is required only by the interactive restore command. Restore writes the sealed keyring, installs the recovered passphrase into an explicitly named new Keychain service, and runs full decrypt coverage before reporting success.

- [ ] **Step 5: Provision a dedicated unbound locked backup bucket**

Add `living-atlas-personal-prod-backups` with `prevent_destroy = true`, no Worker binding or public domain, and a 90-day whole-bucket `cloudflare_r2_bucket_lock`. Do not add lifecycle deletion until repeated restore drills pass, and then keep deletion strictly later than the lock window.

- [ ] **Step 6: Ship full-only scheduling and remote restore discovery**

Replace serial-only IDs with timestamp-plus-random IDs, expose explicit `full-only` mode, resolve writer credentials and public recovery key from Keychain, and install an hourly LaunchAgent whose runner creates at most one full backup per 24 hours. Remote restore lists and verifies manifests through a separate read-only credential.

- [ ] **Step 7: Verify GREEN, run a restore drill, and commit each repository**

Run the focused suites and `pnpm check`; run Terraform format/validate/plan; apply through the private provenance guardrails; create one production full backup; verify remote hashes and the active lock; restore into a new empty directory; recover the keyring/passphrase; and require canonical manifest, generation, object counts, restart parity, and full decrypt coverage to match before enabling the LaunchAgent.

Commits:
- LivingAtlas: `feat(backup): make production recovery self sufficient`
- LivingAtlas-Deploy: `feat(backup): provision locked production recovery`
