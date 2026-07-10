import {
  CanonicalObservationPayloadSchema,
  CanonicalParityRecordPayloadSchema,
  CanonicalReviewItemPayloadSchema,
  type CanonicalObservationPayload,
  type CanonicalParityRecordPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import type { CanonicalPayloadDecryptor } from "./canonical-assertions";

export type CanonicalParityInputs = {
  parity_records: CanonicalParityRecordPayload[];
  reviews: CanonicalReviewItemPayload[];
  observations: CanonicalObservationPayload[];
  canonical_object_ids: Set<string>;
  operational_gates?: Partial<CanonicalCutoverOperationalGates>;
};

export type CanonicalCutoverOperationalGates = {
  resolution_transactions_verified: boolean;
  canonical_integrity_verified: boolean;
  no_legacy_dependencies_verified: boolean;
  idempotency_verified: boolean;
  restart_verified: boolean;
  backup_restore_verified: boolean;
  manifest_comparison_verified: boolean;
  owner_accepted: boolean;
};

export type CanonicalParityReport = {
  totals: { coverage: number; represented: number; unrepresented: number };
  represented_coverage_keys: string[];
  unrepresented_coverage_keys: string[];
  open_review_ids: string[];
  blockers: Array<
    "open-review-missing-coverage"
    | "open-review-without-observation"
    | "represented-coverage-missing-object"
    | "unrepresented-coverage"
  >;
  semantic_parity_ready: boolean;
  cutover_blockers: string[];
  cutover_ready: boolean;
};

const OpenResolutionStates = new Set<CanonicalReviewItemPayload["resolution_state"]>([
  "research", "owner-review", "deferred-unknown"
]);
const CanonicalObjectTypes = new Set<GraphObjectEnvelope["object_type"]>([
  "entity", "assertion", "edge", "evidence", "review", "manifest"
]);
const CutoverGateReasons: Record<keyof CanonicalCutoverOperationalGates, string> = {
  resolution_transactions_verified: "resolution-transactions-unverified",
  canonical_integrity_verified: "canonical-integrity-unverified",
  no_legacy_dependencies_verified: "legacy-dependencies-unverified",
  idempotency_verified: "idempotency-unverified",
  restart_verified: "restart-unverified",
  backup_restore_verified: "backup-restore-unverified",
  manifest_comparison_verified: "manifest-comparison-unverified",
  owner_accepted: "owner-acceptance-required"
};

export function projectCanonicalParity(input: CanonicalParityInputs): CanonicalParityReport {
  const blockers = new Set<CanonicalParityReport["blockers"][number]>();
  const represented = input.parity_records.filter((record) => record.coverage_state === "represented");
  const unrepresented = input.parity_records.filter((record) => record.coverage_state === "unrepresented");
  const representedKeys = new Set<string>();
  for (const record of represented) {
    if (record.canonical_object_ids.some((id) => !input.canonical_object_ids.has(id))) {
      blockers.add("represented-coverage-missing-object");
      continue;
    }
    representedKeys.add(record.source_coverage_key);
  }
  if (unrepresented.length > 0) blockers.add("unrepresented-coverage");

  const observationIds = new Set(input.observations.map((observation) => observation.assertion_id));
  const openReviews = input.reviews.filter((review) => OpenResolutionStates.has(review.resolution_state));
  for (const review of openReviews) {
    if (review.source_coverage_keys.some((key) => !representedKeys.has(key))) {
      blockers.add("open-review-missing-coverage");
    }
    if (!review.proposed_object_ids.some((id) => observationIds.has(id))) {
      blockers.add("open-review-without-observation");
    }
  }

  const semantic_parity_ready = blockers.size === 0;
  const gates: CanonicalCutoverOperationalGates = {
    resolution_transactions_verified: false,
    canonical_integrity_verified: false,
    no_legacy_dependencies_verified: false,
    idempotency_verified: false,
    restart_verified: false,
    backup_restore_verified: false,
    manifest_comparison_verified: false,
    owner_accepted: false,
    ...input.operational_gates
  };
  const cutover_blockers = [
    ...blockers,
    ...Object.entries(gates)
      .filter(([, verified]) => !verified)
      .map(([gate]) => CutoverGateReasons[gate as keyof CanonicalCutoverOperationalGates])
  ].sort();

  return {
    totals: { coverage: input.parity_records.length, represented: represented.length, unrepresented: unrepresented.length },
    represented_coverage_keys: [...representedKeys].sort(),
    unrepresented_coverage_keys: unrepresented.map((record) => record.source_coverage_key).sort(),
    open_review_ids: openReviews.map((review) => review.review_id).sort(),
    blockers: [...blockers].sort(),
    semantic_parity_ready,
    cutover_blockers,
    cutover_ready: cutover_blockers.length === 0
  };
}

export async function loadCanonicalParityInputsFromObjects(
  objects: GraphObjectEnvelope[],
  decryptPayload: CanonicalPayloadDecryptor
): Promise<CanonicalParityInputs> {
  const parity_records: CanonicalParityRecordPayload[] = [];
  const reviews: CanonicalReviewItemPayload[] = [];
  const observations: CanonicalObservationPayload[] = [];
  const canonical_object_ids = new Set(
    objects.filter((object) => CanonicalObjectTypes.has(object.object_type) && !object.visible_metadata.tombstone)
      .map((object) => object.object_id)
  );
  const decryptable = objects
    .filter((object) => object.object_type === "manifest" || object.object_type === "review" || object.object_type === "assertion")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.object_id.localeCompare(right.object_id));
  for (const object of decryptable) {
    const payload = await decryptPayload(object);
    if (!payload) continue;
    if (object.object_type === "manifest") {
      const parity = CanonicalParityRecordPayloadSchema.safeParse(payload);
      if (parity.success) parity_records.push(parity.data);
      continue;
    }
    if (object.object_type === "review") {
      const review = CanonicalReviewItemPayloadSchema.safeParse(payload);
      if (review.success) reviews.push(review.data);
      continue;
    }
    const observation = CanonicalObservationPayloadSchema.safeParse(payload);
    if (observation.success) observations.push(observation.data);
  }
  return { parity_records, reviews, observations, canonical_object_ids };
}
