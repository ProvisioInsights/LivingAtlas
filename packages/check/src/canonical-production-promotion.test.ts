import { describe, expect, it } from "vitest";
import { buildCanonicalPromotionPlan, preflightCanonicalPromotion } from "./canonical-production-promotion";

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
});
