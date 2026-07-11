import { createHash } from "node:crypto";
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

export type LocalReviewResolutionMode = "rich" | "legacy" | "incomplete";

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
  resolution_mode: LocalReviewResolutionMode;
  resolution_mode_explanation: string;
  parity_ids: string[];
  parity_records: CanonicalParityRecordPayload[];
  source_accounting: SourceMeaningAccounting;
  missing_references: string[];
  context_unavailable: boolean;
  bulk_compatibility_key: `sha256:${string}`;
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

function normalizedMutationKind(payload: CanonicalPayload): string {
  switch (payload.schema) {
    case "atlas.entity:v1":
      return `entity:${payload.type}:${payload.subtype ?? "unspecified"}`;
    case "atlas.fact:v1":
      return `fact:${payload.predicate}:${payload.value.kind}`;
    case "atlas.observation:v1":
      return "observation";
    case "atlas.relationship:v2":
      return `relationship:${payload.source_type}:${payload.predicate}:${payload.target_type}`;
    case "atlas.evidence:v1":
      return `evidence:${payload.source_kind}`;
    case "atlas.entity-resolution:v1":
      return `entity-resolution:${payload.decision}`;
    case "atlas.review-item:v1":
      return "review-decision";
    case "atlas.parity-record:v1":
      return `source-coverage:${payload.representation_kind ?? "unrepresented"}`;
  }
}

function payloadEvidenceStances(payload: CanonicalPayload): Array<{ evidence_id: string; stance: "supports" | "refutes" | "context" }> {
  if (payload.schema === "atlas.observation:v1") {
    return payload.evidence_refs.map((evidence_id) => ({ evidence_id, stance: "supports" }));
  }
  if (payload.schema === "atlas.fact:v1"
    || payload.schema === "atlas.relationship:v2"
    || payload.schema === "atlas.entity-resolution:v1") {
    return payload.evidence_links;
  }
  return [];
}

function evidenceRuleDescriptor(proposedRecords: CanonicalPayload[], evidence: CanonicalEvidencePayload[]) {
  const stancesByEvidence = new Map<string, Set<"supports" | "refutes" | "context">>();
  for (const link of proposedRecords.flatMap(payloadEvidenceStances)) {
    const stances = stancesByEvidence.get(link.evidence_id) ?? new Set();
    stances.add(link.stance);
    stancesByEvidence.set(link.evidence_id, stances);
  }
  const ownerEvidence = evidence.filter((item) => item.source_kind === "migration" || item.source_kind === "manual");
  const thirdPartyEvidence = evidence.filter((item) => item.source_kind !== "migration" && item.source_kind !== "manual");
  const evidenceForRule = thirdPartyEvidence.length > 0 ? thirdPartyEvidence : ownerEvidence;
  const stances = new Set(evidenceForRule.flatMap((item) => [...(stancesByEvidence.get(item.evidence_id) ?? [])]));
  const groups = new Map<string, CanonicalEvidencePayload[]>();
  for (const item of evidenceForRule) {
    const group = groups.get(item.independence_key) ?? [];
    group.push(item);
    groups.set(item.independence_key, group);
  }
  const normalizedGroups = [...groups.values()].map((group) => ({
    source_kinds: [...new Set(group.map((item) => item.source_kind))].sort(),
    stances: [...new Set(group.flatMap((item) => [...(stancesByEvidence.get(item.evidence_id) ?? [])]))].sort(),
    evidence_count: group.length
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const linkedinGroups = normalizedGroups.filter((group) => group.source_kinds.includes("linkedin"));
  const independentNonLinkedinGroups = normalizedGroups.filter((group) => !group.source_kinds.includes("linkedin"));
  const kind = evidenceForRule.length > 0 && stances.size === 0 ? "confidence-only-unlinked"
    : stances.has("refutes") ? "conflicting"
    : stances.size > 0 && !stances.has("supports") ? "context-only"
      : thirdPartyEvidence.length === 0 ? (ownerEvidence.length > 0 ? "owner-source" : "no-evidence")
        : linkedinGroups.length > 0
          ? (independentNonLinkedinGroups.length > 0 ? "linkedin-plus-independent" : "linkedin-only")
          : normalizedGroups.length >= 2 ? "two-independent-public-groups" : "one-public-group";
  return {
    kind,
    owner_source_present: ownerEvidence.length > 0,
    independence_group_count: normalizedGroups.length,
    groups: normalizedGroups
  };
}

function bulkCompatibilityKey(input: {
  proposedRecords: CanonicalPayload[];
  parityRecords: CanonicalParityRecordPayload[];
  evidence: CanonicalEvidencePayload[];
  sourceAccounting: SourceMeaningAccounting;
  resolutionMode: LocalReviewResolutionMode;
}): `sha256:${string}` {
  const descriptor = {
    payload_schemas: input.proposedRecords.map((payload) => payload.schema).sort(),
    normalized_mutation_kinds: [
      ...input.proposedRecords.map(normalizedMutationKind),
      ...(input.resolutionMode === "legacy"
        ? input.sourceAccounting.meaningful_units.map((unit) => `create:observation:${unit.kind}`)
        : []),
      "update:review-decision",
      ...input.parityRecords.map((parity) => `update:source-coverage:${parity.representation_kind ?? "unrepresented"}`)
    ].sort(),
    evidence_rule: evidenceRuleDescriptor(input.proposedRecords, input.evidence),
    source_preservation_mode: `${input.sourceAccounting.exact_source_preserved ? "exact" : "unavailable"}:${input.resolutionMode}`,
    edit_requirement: input.resolutionMode === "rich" ? "observation-edit-optional"
      : input.resolutionMode === "legacy" ? "source-unit-edit-optional"
        : "repair-required",
    merge_requirement: input.proposedRecords.some((payload) => (
      payload.schema === "atlas.entity-resolution:v1" && payload.decision === "merge"
    )) ? "required" : "none"
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")}`;
}

function reviewResolutionMode(input: {
  proposedObjectIds: string[];
  proposedRecords: CanonicalPayload[];
  parityRecords: CanonicalParityRecordPayload[];
  sourceAccounting: SourceMeaningAccounting;
  unitMappings: LocalReviewUnitMapping[];
}): { mode: LocalReviewResolutionMode; explanation: string } {
  const proposedObservations = input.proposedRecords.filter((payload): payload is CanonicalObservation => (
    payload.schema === "atlas.observation:v1"
  ));
  const proposedObservationIds = new Set(proposedObservations.map((payload) => payload.assertion_id));
  const parityObservationIds = new Set(input.parityRecords.flatMap((parity) => parity.canonical_object_ids));
  const proposedComplete = input.proposedRecords.length === input.proposedObjectIds.length;
  const observationParityShapeValid = input.parityRecords.length > 0
    && input.parityRecords.every((parity) => (
      parity.coverage_state === "represented"
      && parity.representation_kind === "observation"
      && parity.canonical_object_ids.length > 0
      && parity.canonical_object_ids.every((id) => proposedObservationIds.has(id))
    ))
    && proposedObservations.length > 0
    && proposedObservations.every((observation) => parityObservationIds.has(observation.assertion_id));

  if (!input.sourceAccounting.exact_source_preserved) {
    return { mode: "incomplete", explanation: "Lossless canonical source evidence is unavailable, so Preserve and Edit are blocked." };
  }
  if (!proposedComplete) {
    return { mode: "incomplete", explanation: "One or more proposed canonical records are unavailable, so Preserve and Edit are blocked." };
  }
  if (!observationParityShapeValid) {
    return { mode: "incomplete", explanation: "Every parity record must be represented observation parity backed only by proposed observations." };
  }

  const hasCanonicalUnitEvidence = input.unitMappings.some((mapping) => mapping.unit_evidence_ids.length > 0);
  if (hasCanonicalUnitEvidence) {
    const unitsComplete = input.sourceAccounting.meaningful_units.length > 0
      && input.unitMappings.length === input.sourceAccounting.meaningful_units.length
      && input.unitMappings.every((mapping) => mapping.unit_evidence_ids.length > 0 && mapping.observation_ids.length > 0);
    if (!unitsComplete) {
      return { mode: "incomplete", explanation: "Not every source unit has canonical unit evidence and a mapped parity observation." };
    }
    const mappedObservationIds = new Set(input.unitMappings.flatMap((mapping) => mapping.observation_ids));
    if (proposedObservations.some((observation) => !mappedObservationIds.has(observation.assertion_id))
      || input.parityRecords.some((parity) => parity.canonical_object_ids.some((id) => !mappedObservationIds.has(id)))) {
      return { mode: "incomplete", explanation: "Observation parity is not wholly covered by mapped proposed source-unit observations." };
    }
    return { mode: "rich", explanation: "Every source unit maps to canonical evidence and observation-only parity; observation-ID editing is available." };
  }

  if (input.proposedRecords.length === 1 && proposedObservations.length === 1) {
    return { mode: "legacy", explanation: "This legacy one-placeholder candidate will expand into provenance-linked observations when preserved." };
  }
  return { mode: "incomplete", explanation: "This candidate is neither a complete canonical mapping nor a supported legacy placeholder." };
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
      if (payload?.schema === "atlas.fact:v1" || payload?.schema === "atlas.relationship:v2") {
        payload.evidence_links.forEach((link) => evidenceIds.add(link.evidence_id));
        payload.confidence.evidence_refs.forEach((evidence) => evidenceIds.add(evidence));
      }
      if (payload?.schema === "atlas.entity-resolution:v1") {
        payload.evidence_links.forEach((link) => evidenceIds.add(link.evidence_id));
        payload.confidence.evidence_refs.forEach((evidence) => evidenceIds.add(evidence));
      }
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
    const resolutionMode = reviewResolutionMode({
      proposedObjectIds: proposed,
      proposedRecords,
      parityRecords,
      sourceAccounting,
      unitMappings
    });
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
      resolution_mode: resolutionMode.mode,
      resolution_mode_explanation: resolutionMode.explanation,
      parity_ids: parityIds.sort(),
      parity_records: parityRecords,
      source_accounting: sourceAccounting,
      missing_references: referenced.filter((id) => !payloads.has(id)).sort(),
      context_unavailable: sourceContext.length === 0,
      bulk_compatibility_key: bulkCompatibilityKey({
        proposedRecords,
        parityRecords,
        evidence,
        sourceAccounting,
        resolutionMode: resolutionMode.mode
      })
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
