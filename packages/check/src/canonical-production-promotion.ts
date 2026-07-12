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
