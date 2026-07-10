import {
  CanonicalPayloadSchema,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type CanonicalEvidencePayload,
  type CanonicalParityRecordPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import type { CanonicalPayloadDecryptor } from "@living-atlas/graph-service";
import {
  accountSourceMeaning,
  type SourceMeaningAccounting,
  type SourceMeaningKind,
  type SourceMeaningUnit
} from "@living-atlas/importer";

export { accountSourceMeaning } from "@living-atlas/importer";
export type { SourceMeaningAccounting, SourceMeaningKind, SourceMeaningUnit } from "@living-atlas/importer";

export type LocalReviewQueueItem = {
  review_id: string;
  candidate_id: string;
  review_record: CanonicalReviewItemPayload;
  recommendation: CanonicalReviewItemPayload["recommendation"];
  resolution_state: CanonicalReviewItemPayload["resolution_state"];
  research_requested: boolean;
  research_requested_all: boolean;
  research_requested_units: SourceMeaningUnit[];
  headline: string;
  proposal_label: string;
  proposed_object_ids: string[];
  proposed_records: CanonicalPayload[];
  evidence_ids: string[];
  evidence: CanonicalEvidencePayload[];
  source_context: CanonicalEvidencePayload[];
  parity_ids: string[];
  parity_records: CanonicalParityRecordPayload[];
  source_accounting: SourceMeaningAccounting;
  missing_references: string[];
  context_unavailable: boolean;
};

export type LocalReviewQueue = {
  owner_review: LocalReviewQueueItem[];
  research: LocalReviewQueueItem[];
  deferred: LocalReviewQueueItem[];
  automatic: LocalReviewQueueItem[];
};

const DecryptableTypes = new Set<GraphObjectEnvelope["object_type"]>([
  "review", "evidence", "assertion", "edge", "entity", "manifest"
]);

function meaningfulHeadline(
  observation: Extract<CanonicalPayload, { schema: "atlas.observation:v1" }> | undefined,
  sourceContext: CanonicalEvidencePayload[]
): string {
  if (observation && !observation.statement.startsWith("Imported source coverage ")) {
    return observation.statement;
  }
  const lines = sourceContext.flatMap((evidence) => evidence.excerpt?.split(/\r?\n/) ?? []);
  for (const key of ["title", "name", "description", "summary"]) {
    const value = lines
      .map((line) => new RegExp(`^${key}::\\s*(.+)$`, "i").exec(line.trim())?.[1]?.trim())
      .find(Boolean);
    if (value) return value;
  }
  const contextual = lines
    .filter((line) => !/^[A-Za-z0-9_-]+::/.test(line.trim()))
    .map((line) => line.trim().replace(/^[-#>*\s]+/, "").replaceAll("**", "").trim())
    .find((line) => line.length > 12 && !/^(context|notes?|details?)[:.]?$/i.test(line));
  return contextual ?? observation?.statement ?? sourceContext[0]?.excerpt ?? "Review candidate";
}

export async function projectLocalReviewQueue(input: {
  objects: GraphObjectEnvelope[];
  decryptPayload: CanonicalPayloadDecryptor;
}): Promise<LocalReviewQueue> {
  const payloads = new Map<string, CanonicalPayload>();
  for (const object of input.objects.filter((item) => DecryptableTypes.has(item.object_type) && !item.visible_metadata.tombstone)) {
    const payload = await input.decryptPayload(object);
    if (!payload) continue;
    const parsed = CanonicalPayloadSchema.safeParse(payload);
    if (parsed.success) payloads.set(canonicalPayloadObjectId(parsed.data), parsed.data);
  }
  const reviews = [...payloads.values()].filter((payload): payload is CanonicalReviewItemPayload => payload.schema === "atlas.review-item:v1");
  const itemFor = (review: CanonicalReviewItemPayload): LocalReviewQueueItem => {
    const proposed = review.proposed_object_ids;
    const evidenceIds = new Set<string>();
    for (const id of proposed) {
      const payload = payloads.get(id);
      if (payload?.schema === "atlas.observation:v1") payload.evidence_refs.forEach((evidence) => evidenceIds.add(evidence));
      if (payload?.schema === "atlas.fact:v1" || payload?.schema === "atlas.relationship:v2") payload.evidence_links.forEach((link) => evidenceIds.add(link.evidence_id));
    }
    const parityIds = [...payloads.values()]
      .filter((payload): payload is Extract<CanonicalPayload, { schema: "atlas.parity-record:v1" }> => payload.schema === "atlas.parity-record:v1" && review.source_coverage_keys.includes(payload.source_coverage_key))
      .map((payload) => payload.parity_id);
    const proposedRecords = proposed.flatMap((id) => {
      const payload = payloads.get(id);
      return payload ? [payload] : [];
    });
    const evidence = [...evidenceIds].flatMap((id) => {
      const payload = payloads.get(id);
      return payload?.schema === "atlas.evidence:v1" ? [payload] : [];
    });
    const parityRecords = [...payloads.values()].filter((payload): payload is CanonicalParityRecordPayload => payload.schema === "atlas.parity-record:v1" && parityIds.includes(payload.parity_id));
    const sourceContext = evidence.filter((item) => item.source_kind === "migration");
    const referenced = [...proposed, ...evidenceIds, ...parityIds];
    const observation = proposedRecords.find((payload) => payload.schema === "atlas.observation:v1");
    const sourceAccounting = accountSourceMeaning(sourceContext);
    const requestedUnitHashes = new Set(review.research_requested_unit_hashes ?? []);
    const researchRequestedUnits = sourceAccounting.meaningful_units.filter((unit) => requestedUnitHashes.has(unit.unit_id));
    return {
      review_id: review.review_id,
      candidate_id: review.candidate_id,
      review_record: review,
      recommendation: review.recommendation,
      resolution_state: review.resolution_state,
      research_requested: Boolean(review.research_requested_at) || Boolean(review.research_requested_all) || researchRequestedUnits.length > 0,
      research_requested_all: Boolean(review.research_requested_all),
      research_requested_units: researchRequestedUnits,
      headline: meaningfulHeadline(observation, sourceContext),
      proposal_label: observation ? "Observation" : "Atlas record",
      proposed_object_ids: proposed,
      proposed_records: proposedRecords,
      evidence_ids: [...evidenceIds].sort(),
      evidence,
      source_context: sourceContext,
      parity_ids: parityIds.sort(),
      parity_records: parityRecords,
      source_accounting: sourceAccounting,
      missing_references: referenced.filter((id) => !payloads.has(id)).sort(),
      context_unavailable: sourceContext.length === 0
    };
  };
  const items = reviews.map(itemFor).sort((left, right) => left.review_id.localeCompare(right.review_id));
  return {
    owner_review: items.filter((item) => item.resolution_state === "owner-review"),
    research: items.filter((item) => item.resolution_state === "research"),
    deferred: items.filter((item) => item.resolution_state === "deferred-unknown"),
    automatic: items.filter((item) => item.resolution_state === "auto-applied" || item.resolution_state === "resolved")
  };
}
