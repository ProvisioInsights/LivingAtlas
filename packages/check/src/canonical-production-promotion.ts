import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

type CanonicalManifestEntry = {
  object_id: string;
  object_type: string;
  content_hash: `sha256:${string}`;
};

function record(value: unknown, error: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function count(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(error);
  return value;
}

function flag(value: unknown, error: string): boolean {
  if (typeof value !== "boolean") throw new Error(error);
  return value;
}

function readManifest(value: unknown): CanonicalManifestEntry[] {
  if (!Array.isArray(value)) throw new Error("canonical-manifest-malformed");
  const objectIds = new Set<string>();
  return value.map((entry) => {
    const parsed = record(entry, "canonical-manifest-malformed");
    const objectId = parsed.object_id;
    const objectType = parsed.object_type;
    const contentHash = parsed.content_hash;
    if (typeof objectId !== "string" || !/^la_object_[A-Za-z0-9_-]+$/.test(objectId)
      || typeof objectType !== "string" || !/^(entity|assertion|edge|evidence|review|manifest)$/.test(objectType)
      || typeof contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(contentHash)
      || objectIds.has(objectId)) {
      throw new Error("canonical-manifest-malformed");
    }
    objectIds.add(objectId);
    return { object_id: objectId, object_type: objectType, content_hash: contentHash as `sha256:${string}` };
  });
}

export async function readCanonicalCandidateCutoverReport(input: { candidate_dir: string }) {
  const [conversionRaw, manifestRaw, candidateProofRaw] = await Promise.all([
    readFile(join(input.candidate_dir, "conversion-report.json"), "utf8"),
    readFile(join(input.candidate_dir, "canonical-manifest.json"), "utf8"),
    readFile(join(input.candidate_dir, "candidate-proof.json"), "utf8").catch((error: unknown) => {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    })
  ]);
  let conversionJson: unknown;
  let manifestJson: unknown;
  try {
    conversionJson = JSON.parse(conversionRaw);
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    throw new Error("canonical-cutover-artifact-malformed");
  }
  const conversion = record(conversionJson, "canonical-cutover-artifact-malformed");
  const objects = record(conversion.objects, "canonical-cutover-artifact-malformed");
  const reviewQueue = record(conversion.review_queue, "canonical-cutover-artifact-malformed");
  const integrity = record(conversion.integrity, "canonical-cutover-artifact-malformed");
  const manifest = readManifest(manifestJson);
  const candidateObjectCount = count(objects.total, "canonical-cutover-artifact-malformed");
  if (candidateObjectCount !== manifest.length) throw new Error("candidate-manifest-count-mismatch");
  const conversionIntegrity = {
    unrepresented_meaningful_units: count(integrity.unrepresented_meaningful_units, "canonical-cutover-artifact-malformed"),
    reopened_manifest_mismatches: count(integrity.reopened_manifest_mismatches, "canonical-cutover-artifact-malformed")
  };
  const pendingReconciliation = count(reviewQueue.owner_review, "canonical-cutover-artifact-malformed")
    + count(reviewQueue.research, "canonical-cutover-artifact-malformed")
    + count(reviewQueue.incomplete, "canonical-cutover-artifact-malformed");
  let candidateProof: { decrypt_coverage_complete: boolean; restart_manifest_equal: boolean; mutation_idempotency_verified: boolean } | undefined;
  if (candidateProofRaw !== undefined) {
    try {
      const parsed = record(JSON.parse(candidateProofRaw), "canonical-candidate-proof-malformed");
      if (parsed.proof_schema !== "living-atlas-canonical-candidate-proof:v1" || parsed.plaintext_policy !== "counts-and-hashes-only") {
        throw new Error("canonical-candidate-proof-malformed");
      }
      candidateProof = {
        decrypt_coverage_complete: flag(parsed.decrypt_coverage_complete, "canonical-candidate-proof-malformed"),
        restart_manifest_equal: flag(parsed.restart_manifest_equal, "canonical-candidate-proof-malformed"),
        mutation_idempotency_verified: flag(parsed.mutation_idempotency_verified, "canonical-candidate-proof-malformed")
      };
    } catch (error) {
      if (error instanceof Error && error.message === "canonical-candidate-proof-malformed") throw error;
      throw new Error("canonical-candidate-proof-malformed");
    }
  }
  const canonicalManifestHash = `sha256:${createHash("sha256")
    .update(JSON.stringify([...manifest].sort((left, right) => left.object_id.localeCompare(right.object_id))))
    .digest("hex")}` as const;
  const blockers = [
    conversionIntegrity.unrepresented_meaningful_units > 0 && "meaningful-source-unrepresented",
    conversionIntegrity.reopened_manifest_mismatches > 0 && "reopen-manifest-mismatch",
    candidateProof === undefined && "decrypt-coverage-proof-missing",
    candidateProof?.decrypt_coverage_complete === false && "decrypt-coverage-mismatch",
    candidateProof?.restart_manifest_equal === false && "restart-manifest-mismatch",
    "backup-restore-proof-missing",
    "candidate-live-manifest-comparison-missing",
    candidateProof === undefined && "mutation-idempotency-proof-missing",
    candidateProof?.mutation_idempotency_verified === false && "mutation-idempotency-unverified",
    "owner-acceptance-required",
    pendingReconciliation > 0 && "pending-reconciliation"
  ].filter((blocker): blocker is string => Boolean(blocker));
  return {
    report_schema: "living-atlas-canonical-cutover-report:v1" as const,
    plaintext_policy: "counts-and-hashes-only" as const,
    candidate_object_count: candidateObjectCount,
    canonical_manifest_hash: canonicalManifestHash,
    conversion_integrity: conversionIntegrity,
    pending_reconciliation: pendingReconciliation,
    ready: false as const,
    blockers
  };
}

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
