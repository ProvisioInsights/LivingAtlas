import { describe, expect, it } from "vitest";
import { deriveCanonicalCutoverReadiness } from "./canonical-cutover-readiness";

describe("canonical cutover readiness", () => {
  it("fails closed when a required proof artifact is absent", () => {
    expect(() => deriveCanonicalCutoverReadiness({
      conversion_integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 },
      restart_manifest_equal: true,
      backup_restore_manifest_equal: true,
      mutation_idempotency_verified: true,
      pending_reconciliation: 0,
      owner_accepted: true
    })).toThrow("cutover-proof-missing");
  });

  it("requires every persisted proof before reporting ready", () => {
    expect(deriveCanonicalCutoverReadiness({
      conversion_integrity: { unrepresented_meaningful_units: 0, reopened_manifest_mismatches: 0 },
      decrypt_coverage: { equal: true },
      restart_manifest_equal: true,
      backup_restore_manifest_equal: true,
      mutation_idempotency_verified: true,
      pending_reconciliation: 0,
      owner_accepted: true
    })).toEqual({ ready: true, blockers: [] });
  });
});
