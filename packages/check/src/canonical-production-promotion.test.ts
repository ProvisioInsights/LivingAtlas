import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyCanonicalPromotion, buildCanonicalPromotionPlan, buildPromotionPlanFromArtifacts, createCanonicalPromotionReceipt, createCanonicalRollbackReceipt, preflightCanonicalPromotion, promoteCanonicalExport, readCanonicalCandidateCutoverReport } from "./canonical-production-promotion";

describe("canonical production promotion", () => {
  it("rejects a candidate whose authority differs from the local authority", () => {
    expect(() => preflightCanonicalPromotion({
      candidate_isolated: true,
      candidate_authority_id: "la_authority_candidate0001",
      live_authority_id: "la_authority_live0001",
      canonical_manifest_equal: true,
      backup_restore_manifest_equal: true,
      pending_outbox: 0,
      readiness: { ready: true, blockers: [] }
    })).toThrow("authority-mismatch");
  });

  it("produces a counts-only dry-run plan after preflight", () => {
    expect(buildCanonicalPromotionPlan({
      candidate_isolated: true,
      candidate_authority_id: "la_authority_live0001",
      live_authority_id: "la_authority_live0001",
      canonical_manifest_equal: true,
      backup_restore_manifest_equal: true,
      pending_outbox: 0,
      readiness: { ready: true, blockers: [] },
      candidate_object_count: 42
    })).toEqual({ mode: "dry-run", object_count: 42, authority_id: "la_authority_live0001" });
  });

  it("requires the explicit acknowledgement before invoking the promotion writer", async () => {
    let calls = 0;
    const plan = { mode: "dry-run" as const, object_count: 42, authority_id: "la_authority_live0001" };
    await expect(applyCanonicalPromotion({ plan, acknowledgement: "wrong", apply: async () => { calls += 1; } }))
      .rejects.toThrow("promotion-acknowledgement-required");
    expect(calls).toBe(0);
    await expect(applyCanonicalPromotion({ plan, acknowledgement: "promote-verified-canonical-candidate", apply: async () => { calls += 1; } }))
      .resolves.toEqual({ applied: true, object_count: 42 });
    expect(calls).toBe(1);
  });

  it("records only promotion proof metadata", () => {
    expect(createCanonicalPromotionReceipt({
      plan: { mode: "dry-run", object_count: 42, authority_id: "la_authority_live0001" },
      live_generation_before: 7,
      live_generation_after: 8,
      canonical_manifest_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })).toEqual({
      schema: "living-atlas-canonical-promotion-receipt:v1",
      authority_id: "la_authority_live0001",
      object_count: 42,
      live_generation_before: 7,
      live_generation_after: 8,
      canonical_manifest_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
  });

  it("records rollback as a restore target rather than an in-place overwrite", () => {
    expect(createCanonicalRollbackReceipt({
      authority_id: "la_authority_live0001",
      backup_id: "la_backup_000001",
      restored_generation: 7,
      canonical_manifest_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    })).toEqual({
      schema: "living-atlas-canonical-rollback-receipt:v1",
      authority_id: "la_authority_live0001",
      backup_id: "la_backup_000001",
      restored_generation: 7,
      canonical_manifest_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
  });

  it("promotes through the canonical client transaction only after acknowledgement", async () => {
    const plan = { mode: "dry-run" as const, object_count: 42, authority_id: "la_authority_live0001" };
    let imported = false;
    const result = await promoteCanonicalExport({
      plan,
      acknowledgement: "promote-verified-canonical-candidate",
      client: { importCanonical: async () => { imported = true; return { ok: true, generation: 8 }; } } as never,
      exported: {} as never,
      expected_generation: 7,
      actor_id: "la_client_promotion0001",
      operation_id: "la_operation_promotion0001",
      idempotency_key: "la_idem_promotion0001"
    });
    expect(imported).toBe(true);
    expect(result).toEqual({ applied: true, object_count: 42, generation: 8 });
  });

  it("derives the dry-run plan from complete candidate proof artifacts", () => {
    expect(buildPromotionPlanFromArtifacts({
      candidate_isolated: true,
      candidate_authority_id: "la_authority_live0001",
      live_authority_id: "la_authority_live0001",
      canonical_manifest_object_count: 42,
      canonical_manifest_equal: true,
      conversion_integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 },
      decrypt_coverage_equal: true,
      restart_manifest_equal: true,
      backup_restore_manifest_equal: true,
      mutation_idempotency_verified: true,
      pending_reconciliation: 0,
      owner_accepted: true,
      pending_outbox: 0
    })).toEqual({ mode: "dry-run", object_count: 42, authority_id: "la_authority_live0001" });
  });

  it("rejects artifacts without a candidate-to-live canonical manifest match", () => {
    expect(() => buildPromotionPlanFromArtifacts({
      candidate_isolated: true,
      candidate_authority_id: "la_authority_live0001",
      live_authority_id: "la_authority_live0001",
      canonical_manifest_object_count: 42,
      canonical_manifest_equal: false,
      conversion_integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 },
      decrypt_coverage_equal: true,
      restart_manifest_equal: true,
      backup_restore_manifest_equal: true,
      mutation_idempotency_verified: true,
      pending_reconciliation: 0,
      owner_accepted: true,
      pending_outbox: 0
    })).toThrow("backup-proof-missing");
  });

  it("reports a persisted candidate as not ready when promotion proof artifacts are absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-cutover-report-"));
    try {
      await writeFile(join(directory, "conversion-report.json"), JSON.stringify({
        objects: { total: 2 },
        review_queue: { owner_review: 1, research: 0, automatic: 1, incomplete: 0 },
        integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 }
      }));
      await writeFile(join(directory, "canonical-manifest.json"), JSON.stringify([
        { object_id: "la_object_cutoverreport0001", object_type: "entity", content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { object_id: "la_object_cutoverreport0002", object_type: "assertion", content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
      ]));

      await expect(readCanonicalCandidateCutoverReport({ candidate_dir: directory })).resolves.toEqual({
        report_schema: "living-atlas-canonical-cutover-report:v1",
        plaintext_policy: "counts-and-hashes-only",
        candidate_object_count: 2,
        canonical_manifest_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        conversion_integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 },
        pending_reconciliation: 1,
        ready: false,
        blockers: [
          "decrypt-coverage-proof-missing",
          "backup-restore-proof-missing",
          "candidate-live-manifest-comparison-missing",
          "mutation-idempotency-proof-missing",
          "owner-acceptance-required",
          "pending-reconciliation"
        ]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses persisted candidate decrypt and idempotency proof without clearing unrelated gates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-cutover-proof-"));
    try {
      await writeFile(join(directory, "conversion-report.json"), JSON.stringify({
        objects: { total: 1 }, review_queue: { owner_review: 0, research: 0, automatic: 1, incomplete: 0 },
        integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 }
      }));
      await writeFile(join(directory, "canonical-manifest.json"), JSON.stringify([
        { object_id: "la_object_cutoverproof0001", object_type: "entity", content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
      ]));
      await writeFile(join(directory, "candidate-proof.json"), JSON.stringify({
        proof_schema: "living-atlas-canonical-candidate-proof:v1", plaintext_policy: "counts-and-hashes-only",
        decrypt_coverage_complete: true, restart_manifest_equal: true, mutation_idempotency_verified: true
      }));

      await expect(readCanonicalCandidateCutoverReport({ candidate_dir: directory })).resolves.toMatchObject({
        ready: false,
        blockers: ["backup-restore-proof-missing", "candidate-live-manifest-comparison-missing", "owner-acceptance-required"]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
