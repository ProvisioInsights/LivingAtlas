import type { CanonicalExport } from "@living-atlas/contracts";
import type { LocalCanonicalAtlasClient } from "@living-atlas/atlas-client";
import { deriveCanonicalCutoverReadiness } from "./canonical-cutover-readiness";

export type CanonicalPromotionPreflight = {
  candidate_isolated: boolean;
  candidate_authority_id: string;
  live_authority_id: string;
  canonical_manifest_equal: boolean;
  backup_restore_manifest_equal: boolean;
  pending_outbox: number;
  readiness: { ready: boolean; blockers: string[] };
};

export type CanonicalPromotionPlanInput = CanonicalPromotionPreflight & {
  candidate_object_count: number;
};

export type CanonicalPromotionArtifactInput = {
  candidate_isolated: boolean;
  candidate_authority_id: string;
  live_authority_id: string;
  canonical_manifest_object_count: number;
  canonical_manifest_equal: boolean;
  conversion_integrity: { unrepresented_meaningful_units: number; reopened_manifest_mismatches: number };
  decrypt_coverage_equal: boolean;
  restart_manifest_equal: boolean;
  backup_restore_manifest_equal: boolean;
  mutation_idempotency_verified: boolean;
  pending_reconciliation: number;
  owner_accepted: boolean;
  pending_outbox: number;
};

export function preflightCanonicalPromotion(input: CanonicalPromotionPreflight) {
  if (!input.candidate_isolated) throw new Error("candidate-not-isolated");
  if (input.candidate_authority_id !== input.live_authority_id) throw new Error("authority-mismatch");
  if (!input.canonical_manifest_equal || !input.backup_restore_manifest_equal) {
    throw new Error("backup-proof-missing");
  }
  if (input.pending_outbox !== 0) throw new Error("outbox-not-empty");
  if (!input.readiness.ready) throw new Error(`cutover-not-ready:${input.readiness.blockers.join(",")}`);
  return { ready: true as const };
}

export function buildCanonicalPromotionPlan(input: CanonicalPromotionPlanInput) {
  preflightCanonicalPromotion(input);
  if (!Number.isSafeInteger(input.candidate_object_count) || input.candidate_object_count < 1) {
    throw new Error("candidate-object-count-invalid");
  }
  return {
    mode: "dry-run" as const,
    object_count: input.candidate_object_count,
    authority_id: input.candidate_authority_id
  };
}

export function buildPromotionPlanFromArtifacts(input: CanonicalPromotionArtifactInput) {
  const readiness = deriveCanonicalCutoverReadiness({
    conversion_integrity: input.conversion_integrity,
    decrypt_coverage: { equal: input.decrypt_coverage_equal },
    restart_manifest_equal: input.restart_manifest_equal,
    backup_restore_manifest_equal: input.backup_restore_manifest_equal,
    mutation_idempotency_verified: input.mutation_idempotency_verified,
    pending_reconciliation: input.pending_reconciliation,
    owner_accepted: input.owner_accepted
  });
  return buildCanonicalPromotionPlan({
    candidate_isolated: input.candidate_isolated,
    candidate_authority_id: input.candidate_authority_id,
    live_authority_id: input.live_authority_id,
    canonical_manifest_equal: input.canonical_manifest_equal,
    backup_restore_manifest_equal: input.backup_restore_manifest_equal,
    pending_outbox: input.pending_outbox,
    readiness,
    candidate_object_count: input.canonical_manifest_object_count
  });
}

export async function applyCanonicalPromotion(input: {
  plan: ReturnType<typeof buildCanonicalPromotionPlan>;
  acknowledgement?: string;
  apply: () => Promise<void>;
}) {
  if (input.acknowledgement !== "promote-verified-canonical-candidate") {
    throw new Error("promotion-acknowledgement-required");
  }
  await input.apply();
  return { applied: true as const, object_count: input.plan.object_count };
}

export function createCanonicalPromotionReceipt(input: {
  plan: ReturnType<typeof buildCanonicalPromotionPlan>;
  live_generation_before: number;
  live_generation_after: number;
  canonical_manifest_hash: `sha256:${string}`;
}) {
  if (!Number.isSafeInteger(input.live_generation_before) || !Number.isSafeInteger(input.live_generation_after)
    || input.live_generation_after < input.live_generation_before) {
    throw new Error("promotion-generation-invalid");
  }
  return {
    schema: "living-atlas-canonical-promotion-receipt:v1" as const,
    authority_id: input.plan.authority_id,
    object_count: input.plan.object_count,
    live_generation_before: input.live_generation_before,
    live_generation_after: input.live_generation_after,
    canonical_manifest_hash: input.canonical_manifest_hash
  };
}

export function createCanonicalRollbackReceipt(input: {
  authority_id: string;
  backup_id: string;
  restored_generation: number;
  canonical_manifest_hash: `sha256:${string}`;
}) {
  if (!input.backup_id.startsWith("la_backup_") || !Number.isSafeInteger(input.restored_generation) || input.restored_generation < 0) {
    throw new Error("rollback-proof-invalid");
  }
  return {
    schema: "living-atlas-canonical-rollback-receipt:v1" as const,
    authority_id: input.authority_id,
    backup_id: input.backup_id,
    restored_generation: input.restored_generation,
    canonical_manifest_hash: input.canonical_manifest_hash
  };
}

export async function promoteCanonicalExport(input: {
  plan: ReturnType<typeof buildCanonicalPromotionPlan>;
  acknowledgement?: string;
  client: Pick<LocalCanonicalAtlasClient, "importCanonical">;
  exported: CanonicalExport;
  expected_generation: number;
  actor_id: string;
  operation_id: string;
  idempotency_key: string;
}) {
  let generation: number | undefined;
  await applyCanonicalPromotion({
    plan: input.plan,
    acknowledgement: input.acknowledgement,
    apply: async () => {
      const result = await input.client.importCanonical({
        exported: input.exported,
        expected_generation: input.expected_generation,
        actor_id: input.actor_id,
        operation_id: input.operation_id,
        idempotency_key: input.idempotency_key
      });
      if (!result.ok) throw new Error(`promotion-transaction-failed:${result.reason}`);
      generation = result.generation;
    }
  });
  return { applied: true as const, object_count: input.plan.object_count, generation: generation! };
}
