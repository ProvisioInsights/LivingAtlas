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

type CanonicalEntity = Extract<CanonicalPayload, { schema: "atlas.entity:v1" }>;
type CanonicalObservation = Extract<CanonicalPayload, { schema: "atlas.observation:v1" }>;
type CanonicalFact = Extract<CanonicalPayload, { schema: "atlas.fact:v1" }>;
type CanonicalRelationship = Extract<CanonicalPayload, { schema: "atlas.relationship:v2" }>;

export type LocalReviewEntityDestination = { object_id: string; record_type: "entity"; record: CanonicalEntity };
export type LocalReviewObservationDestination = { object_id: string; record_type: "observation"; record: CanonicalObservation };
export type LocalReviewFactDestination = { object_id: string; record_type: "fact"; record: CanonicalFact };
export type LocalReviewRelationshipDestination = { object_id: string; record_type: "relationship"; record: CanonicalRelationship };
export type LocalReviewAssertionDestination =
  | LocalReviewObservationDestination
  | LocalReviewFactDestination
  | LocalReviewRelationshipDestination;
export type LocalReviewDestinationRecord = LocalReviewEntityDestination | LocalReviewAssertionDestination;

export type LocalReviewUnitMapping = {
  unit: SourceMeaningUnit;
  occurrence: number;
  unit_evidence_ids: string[];
  unit_evidence: CanonicalEvidencePayload[];
  observation_ids: string[];
  fact_ids: string[];
  relationship_ids: string[];
  destination_records: LocalReviewAssertionDestination[];
};

export type LocalReviewDestinationGraph = {
  source_evidence_ids: string[];
  entities: LocalReviewEntityDestination[];
  observations: LocalReviewObservationDestination[];
  facts: LocalReviewFactDestination[];
  relationships: LocalReviewRelationshipDestination[];
};

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
  unit_mappings: LocalReviewUnitMapping[];
  destination_graph: LocalReviewDestinationGraph;
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

const UnitEvidenceLocatorPattern = /:unit:(sha256:[a-f0-9]{64}):occurrence:(\d+):excerpt:(\d+)$/;

function locatorExcerptIndex(evidence: CanonicalEvidencePayload): number {
  const match = /:excerpt:(\d+)$/.exec(evidence.locator);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function sortEvidenceChunks(evidence: CanonicalEvidencePayload[]): CanonicalEvidencePayload[] {
  return [...evidence].sort((left, right) => locatorExcerptIndex(left) - locatorExcerptIndex(right)
    || left.evidence_id.localeCompare(right.evidence_id));
}

function entityDestination(payload: CanonicalEntity): LocalReviewEntityDestination {
  return { object_id: payload.entity_id, record_type: "entity", record: payload };
}

function observationDestination(payload: CanonicalObservation): LocalReviewObservationDestination {
  return { object_id: payload.assertion_id, record_type: "observation", record: payload };
}

function factDestination(payload: CanonicalFact): LocalReviewFactDestination {
  return { object_id: payload.assertion_id, record_type: "fact", record: payload };
}

function relationshipDestination(payload: CanonicalRelationship): LocalReviewRelationshipDestination {
  return { object_id: payload.assertion_id, record_type: "relationship", record: payload };
}

function recordEvidenceIds(payload: CanonicalObservation | CanonicalFact | CanonicalRelationship): string[] {
  return payload.schema === "atlas.observation:v1"
    ? payload.evidence_refs
    : payload.evidence_links.map((link) => link.evidence_id);
}

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
    const sourceContext = sortEvidenceChunks(evidence.filter((item) => (
      item.source_kind === "migration" && item.extraction_method === "canonical-markdown-lossless-v1"
    )));
    const observation = proposedRecords.find((payload) => payload.schema === "atlas.observation:v1");
    const sourceAccounting = accountSourceMeaning(sourceContext);
    const parityObservationIds = new Set(parityRecords.flatMap((parity) => (
      parity.representation_kind === "observation" ? parity.canonical_object_ids : []
    )));
    const canonicalDestinations: LocalReviewAssertionDestination[] = [];
    for (const payload of proposedRecords) {
      if (payload.schema === "atlas.observation:v1") canonicalDestinations.push(observationDestination(payload));
      if (payload.schema === "atlas.fact:v1") canonicalDestinations.push(factDestination(payload));
      if (payload.schema === "atlas.relationship:v2") canonicalDestinations.push(relationshipDestination(payload));
    }
    const unitEvidence = evidence.filter((item) => item.source_kind === "migration"
      && item.extraction_method === "canonical-source-unit-v1");
    const occurrenceByUnitId = new Map<string, number>();
    const unitMappings: LocalReviewUnitMapping[] = sourceAccounting.meaningful_units.map((unit) => {
      const occurrence = (occurrenceByUnitId.get(unit.unit_id) ?? 0) + 1;
      occurrenceByUnitId.set(unit.unit_id, occurrence);
      const matchingEvidence = sortEvidenceChunks(unitEvidence.filter((item) => {
        const match = UnitEvidenceLocatorPattern.exec(item.locator);
        return match?.[1] === unit.unit_id && Number(match[2]) === occurrence;
      }));
      const matchingEvidenceIds = new Set(matchingEvidence.map((item) => item.evidence_id));
      const destinations = canonicalDestinations.filter((destination) => {
        if (destination.record_type === "observation" && !parityObservationIds.has(destination.object_id)) return false;
        return recordEvidenceIds(destination.record).some((id) => matchingEvidenceIds.has(id));
      });
      return {
        unit,
        occurrence,
        unit_evidence_ids: matchingEvidence.map((item) => item.evidence_id),
        unit_evidence: matchingEvidence,
        observation_ids: destinations.filter((item) => item.record_type === "observation").map((item) => item.object_id),
        fact_ids: destinations.filter((item) => item.record_type === "fact").map((item) => item.object_id),
        relationship_ids: destinations.filter((item) => item.record_type === "relationship").map((item) => item.object_id),
        destination_records: destinations
      };
    });
    const graphObservations = proposedRecords.filter((payload): payload is CanonicalObservation => payload.schema === "atlas.observation:v1");
    const graphFacts = proposedRecords.filter((payload): payload is CanonicalFact => payload.schema === "atlas.fact:v1");
    const graphRelationships = proposedRecords.filter((payload): payload is CanonicalRelationship => payload.schema === "atlas.relationship:v2");
    const graphEntityIds = new Set<string>([
      ...proposedRecords.flatMap((payload) => payload.schema === "atlas.entity:v1" ? [payload.entity_id] : []),
      ...graphObservations.flatMap((payload) => payload.candidate_entity_ids),
      ...graphFacts.map((payload) => payload.subject_entity_id),
      ...graphRelationships.flatMap((payload) => [payload.source_entity_id, payload.target_entity_id])
    ]);
    const graphEntities: CanonicalEntity[] = [...graphEntityIds].flatMap((id) => {
      const payload = payloads.get(id);
      return payload?.schema === "atlas.entity:v1" ? [payload] : [];
    });
    const destinationGraph: LocalReviewDestinationGraph = {
      source_evidence_ids: sourceContext.map((item) => item.evidence_id),
      entities: graphEntities.map(entityDestination),
      observations: graphObservations.map(observationDestination),
      facts: graphFacts.map(factDestination),
      relationships: graphRelationships.map(relationshipDestination)
    };
    const referenced = [
      ...proposed,
      ...evidenceIds,
      ...parityIds,
      ...parityRecords.flatMap((parity) => parity.canonical_object_ids),
      ...graphEntityIds
    ];
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
      unit_mappings: unitMappings,
      destination_graph: destinationGraph,
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
