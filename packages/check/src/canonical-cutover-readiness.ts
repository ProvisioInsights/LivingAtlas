export type CanonicalCutoverArtifacts = {
  conversion_integrity: {
    unrepresented_meaningful_units: number;
    reopened_manifest_mismatches: number;
  };
  decrypt_coverage?: { equal: boolean };
  restart_manifest_equal: boolean;
  backup_restore_manifest_equal: boolean;
  mutation_idempotency_verified: boolean;
  pending_reconciliation: number;
  owner_accepted: boolean;
};

export function deriveCanonicalCutoverReadiness(artifacts: CanonicalCutoverArtifacts) {
  if (!artifacts.decrypt_coverage) throw new Error("cutover-proof-missing");
  const blockers = [
    artifacts.conversion_integrity.unrepresented_meaningful_units > 0 && "meaningful-source-unrepresented",
    artifacts.conversion_integrity.reopened_manifest_mismatches > 0 && "reopen-manifest-mismatch",
    !artifacts.decrypt_coverage.equal && "decrypt-coverage-mismatch",
    !artifacts.restart_manifest_equal && "restart-manifest-mismatch",
    !artifacts.backup_restore_manifest_equal && "backup-restore-manifest-mismatch",
    !artifacts.mutation_idempotency_verified && "mutation-idempotency-unverified",
    artifacts.pending_reconciliation > 0 && "pending-reconciliation",
    !artifacts.owner_accepted && "owner-acceptance-required"
  ].filter((value): value is string => Boolean(value));
  return { ready: blockers.length === 0, blockers };
}
