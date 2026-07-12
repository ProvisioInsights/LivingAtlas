import { describe, expect, it } from "vitest";
import { applyCanonicalPromotion, buildCanonicalPromotionPlan, buildPromotionPlanFromArtifacts, createCanonicalPromotionReceipt, createCanonicalRollbackReceipt, preflightCanonicalPromotion, promoteCanonicalExport } from "./canonical-production-promotion";

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
});
