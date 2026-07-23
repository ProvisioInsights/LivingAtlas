import { createHash } from "node:crypto";
import {
  CanonicalPayloadSchema,
  canonicalObjectTypeForPayload,
  canonicalPayloadObjectId,
  type CanonicalPayload,
  type CanonicalEvidencePayload,
  type CanonicalObservationPayload,
  type CanonicalParityRecordPayload,
  type CanonicalReviewItemPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";
import type { CanonicalPayloadDecryptor } from "@living-atlas/graph-service";
import { summarizeResearchRecommendation } from "@living-atlas/graph-service";
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

export type LocalReviewEvidenceSummary = {
  evidence_id: string;
  stance: "supports" | "refutes" | "context";
  source_label: "Owner source" | "LinkedIn" | "Public web" | "Organization source" | "Local corpus" | "Other source";
  retrieved_at: string;
  confidence: "high" | "medium" | "low" | "unassessed";
  private_detail: {
    locator: string;
    excerpt?: string;
    snapshot_ref?: string;
  };
};

export type LocalReviewCoverageBasis = "direct" | "unit-via-observation" | "source-context" | "uncovered";

export type LocalReviewDecisionSummary = {
  destination_object_id: string;
  destination_kind: "entity" | "fact" | "relationship" | "observation";
  label: string;
  parity: "covered" | "uncovered";
  coverage_basis: LocalReviewCoverageBasis;
  confidence: "high" | "medium" | "low" | "unassessed";
  evidence: LocalReviewEvidenceSummary[];
  rationale: string;
  editable: boolean;
};

export type LocalReviewGraphNode = {
  node_id: string;
  object_id: string;
  kind: "entity" | "fact" | "observation";
  label: string;
  entity_type?: CanonicalEntity["type"];
  style: "solid" | "dashed";
};

export type LocalReviewGraphEdge =
  | {
      edge_id: string;
      kind: "relationship";
      assertion_id: string;
      source_entity_id: string;
      target_entity_id: string;
      predicate: CanonicalRelationship["predicate"];
      style: "solid";
    }
  | {
      edge_id: string;
      kind: "fact";
      assertion_id: string;
      source_entity_id: string;
      target_node_id: string;
      predicate: CanonicalFact["predicate"];
      style: "solid";
    }
  | {
      edge_id: string;
      kind: "observation";
      assertion_id: string;
      source_entity_id?: string;
      target_node_id: string;
      predicate: "unresolved";
      style: "dashed";
    };

export type LocalReviewGraph = {
  nodes: LocalReviewGraphNode[];
  edges: LocalReviewGraphEdge[];
};

export type LocalReviewRecommendationRationale = {
  outcome: "auto-apply" | "owner-review" | "research";
  summary: string;
  reason_codes: string[];
  independence_group_count: number;
};

export type LocalReviewUnitMapping = {
  mapping_id: string;
  unit: SourceMeaningUnit;
  occurrence: number;
  unit_evidence_ids: string[];
  unit_evidence: CanonicalEvidencePayload[];
  observation_ids: string[];
  fact_ids: string[];
  relationship_ids: string[];
  entity_ids: string[];
  destination_records: LocalReviewDestinationRecord[];
  destination_summaries: LocalReviewDecisionSummary[];
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
  review_version: number;
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
  graph: LocalReviewGraph;
  decision_summaries: LocalReviewDecisionSummary[];
  recommendation_rationale: LocalReviewRecommendationRationale;
  source_context_mapping: {
    source_evidence_ids: string[];
    destination_records: LocalReviewDestinationRecord[];
    destination_summaries: LocalReviewDecisionSummary[];
  };
  unmapped_destination_ids: string[];
  resolution_mode: LocalReviewResolutionMode;
  resolution_mode_explanation: string;
  parity_ids: string[];
  parity_records: CanonicalParityRecordPayload[];
  source_accounting: SourceMeaningAccounting;
  missing_references: string[];
  context_unavailable: boolean;
  exact_source_encrypted: boolean;
  bulk_compatibility_key: `sha256:${string}`;
};

export type LocalReviewQueue = {
  owner_review: LocalReviewQueueItem[];
  research: LocalReviewQueueItem[];
  deferred: LocalReviewQueueItem[];
  automatic: LocalReviewQueueItem[];
};

export type LocalReviewDecisionAction = "keep" | "research" | "defer";

export type LocalReviewResolutionStore = {
  authority_id: string;
  generation: number;
  now: string;
  readObject(objectId: string): GraphObjectEnvelope | undefined;
};

export type LocalReviewDecisionPlan = {
  candidate_id: string;
  review_id: string;
  expected_generation: number;
  expected_review_version: number;
  action: LocalReviewDecisionAction;
  objects: unknown[];
};

function reviewResolutionDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * Build the same conservative canonical resolution drafts used by the local
 * review site, but without browser-specific presentation state. Praxis calls
 * this through the local MCP so a card decision and the Atlas review site
 * share one atomic `resolution_apply` boundary.
 */
export function buildLocalReviewDecisionPlan(input: {
  store: LocalReviewResolutionStore;
  item: LocalReviewQueueItem;
  action: LocalReviewDecisionAction;
}): LocalReviewDecisionPlan | undefined {
  const { item, store } = input;
  if (item.resolution_mode === "incomplete") return undefined;
  if (input.action === "keep" && !item.source_accounting.exact_source_preserved) return undefined;
  const reviewEnvelope = store.readObject(item.review_id);
  if (!reviewEnvelope) return undefined;

  const legacyObservations: CanonicalObservationPayload[] = input.action === "keep"
    && item.resolution_mode === "legacy"
    ? item.source_accounting.meaningful_units.map((unit, index) => ({
      schema: "atlas.observation:v1",
      assertion_id: `la_object_${reviewResolutionDigest(`source-unit:${item.candidate_id}:${index}:${unit.atlas_text}`)}`,
      statement: unit.atlas_text,
      candidate_entity_ids: [],
      resolution_state: "owner-review",
      recorded_at: store.now,
      evidence_refs: item.evidence_ids
    }))
    : [];
  const keptPayloads = legacyObservations.length > 0 ? legacyObservations : item.proposed_records;
  const keptIds = keptPayloads.map(canonicalPayloadObjectId);
  const review: CanonicalReviewItemPayload = {
    ...item.review_record,
    recommendation: input.action === "research" ? "research" : "owner-review",
    resolution_state: input.action === "keep"
      ? "resolved"
      : input.action === "research" ? "research" : "deferred-unknown",
    proposed_object_ids: input.action === "keep" ? keptIds : item.review_record.proposed_object_ids,
    ...(input.action === "research" ? {
      research_requested_at: store.now,
      research_requested_all: true
    } : {}),
    recorded_at: store.now
  };
  const keptObservationIds = new Set(keptPayloads.flatMap((payload) => (
    payload.schema === "atlas.observation:v1" ? [payload.assertion_id] : []
  )));
  const parityRecords: CanonicalPayload[] = item.parity_records.map((parity) => (
    input.action === "keep" && item.resolution_mode === "legacy"
      ? {
        ...parity,
        coverage_state: "represented",
        representation_kind: "observation",
        canonical_object_ids: [...keptObservationIds],
        recorded_at: store.now
      }
      : { ...parity, recorded_at: store.now }
  ));
  const payloads: CanonicalPayload[] = [...legacyObservations, review, ...parityRecords];
  const objects = payloads.map((payload) => {
    const objectId = canonicalPayloadObjectId(payload);
    const existing = store.readObject(objectId);
    const contentHash = `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}` as const;
    if (!existing) {
      return {
        schema_version: 1,
        authority_id: store.authority_id,
        object_id: objectId,
        object_type: canonicalObjectTypeForPayload(payload),
        version: 1,
        access_class: "local-private",
        encryption_class: "plaintext",
        created_at: store.now,
        updated_at: store.now,
        content_hash: contentHash,
        visible_metadata: {
          schema_namespace: "atlas/review-resolution",
          tombstone: false,
          size_class: "small",
          remote_indexable: false
        },
        payload: { kind: "plaintext-json", data: payload }
      };
    }
    return {
      ...existing,
      version: existing.version + 1,
      encryption_class: "plaintext",
      updated_at: store.now,
      content_hash: contentHash,
      payload: { kind: "plaintext-json", data: payload }
    };
  });
  return {
    candidate_id: item.candidate_id,
    review_id: item.review_id,
    expected_generation: store.generation,
    expected_review_version: reviewEnvelope.version,
    action: input.action,
    objects
  };
}

const DecryptableTypes = new Set<GraphObjectEnvelope["object_type"]>([
  "review", "evidence", "assertion", "edge", "entity", "manifest"
]);

const UnitEvidenceLocatorPattern = /:unit:(sha256:[a-f0-9]{64}):occurrence:(\d+):excerpt:(\d+)$/;
const DestinationKindOrder = new Map<LocalReviewDestinationRecord["record_type"], number>([
  ["entity", 0],
  ["fact", 1],
  ["relationship", 2],
  ["observation", 3]
]);

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

function assertionEntityIds(payload: CanonicalObservation | CanonicalFact | CanonicalRelationship): string[] {
  if (payload.schema === "atlas.observation:v1") return payload.candidate_entity_ids;
  if (payload.schema === "atlas.relationship:v2") return [payload.source_entity_id, payload.target_entity_id];
  return [
    payload.subject_entity_id,
    ...(payload.value.kind === "entity-ref" ? [payload.value.entity_id] : [])
  ];
}

function assertionReferencesEntity(
  payload: CanonicalObservation | CanonicalFact | CanonicalRelationship,
  entityId: string
): boolean {
  return assertionEntityIds(payload).includes(entityId);
}

function dedupeAndSortDestinations(
  destinations: LocalReviewDestinationRecord[],
  proposedOrderById?: Map<string, number>
): LocalReviewDestinationRecord[] {
  const byId = new Map(destinations.map((destination) => [destination.object_id, destination]));
  return [...byId.values()].sort((left, right) => (
    (DestinationKindOrder.get(left.record_type) ?? 99) - (DestinationKindOrder.get(right.record_type) ?? 99)
      || (left.record_type === "observation" && right.record_type === "observation"
        ? (proposedOrderById?.get(left.object_id) ?? Number.MAX_SAFE_INTEGER)
          - (proposedOrderById?.get(right.object_id) ?? Number.MAX_SAFE_INTEGER)
        : 0)
      || left.object_id.localeCompare(right.object_id)
  ));
}

function mappingId(candidateId: string, unitId: string, occurrence: number): string {
  return `mapping:${createHash("sha256").update(`${candidateId}:${unitId}:${occurrence}`).digest("hex").slice(0, 24)}`;
}

function sourceLabel(evidence: CanonicalEvidencePayload): LocalReviewEvidenceSummary["source_label"] {
  if (evidence.source_kind === "migration" || evidence.source_kind === "manual") return "Owner source";
  if (evidence.source_kind === "linkedin") return "LinkedIn";
  if (evidence.extraction_method === "canonical-research-organization-v1") return "Organization source";
  if (evidence.extraction_method === "canonical-research-local-corpus-v1") return "Local corpus";
  if (evidence.source_kind === "public-web") return "Public web";
  if (evidence.source_kind === "connector") return "Local corpus";
  return "Other source";
}

function factValueLabel(fact: CanonicalFact): string {
  if (fact.value.kind === "entity-ref") return "linked entity";
  if (fact.value.kind === "quantity") return `${fact.value.amount} ${fact.value.unit}`;
  return String(fact.value.value);
}

function destinationLabel(destination: LocalReviewDestinationRecord): string {
  if (destination.record_type === "entity") return `${destination.record.name} (${destination.record.type})`;
  if (destination.record_type === "observation") return destination.record.statement;
  if (destination.record_type === "fact") return `${destination.record.predicate}: ${factValueLabel(destination.record)}`;
  return destination.record.predicate.replaceAll("-", " ");
}

function linkedEvidence(
  destination: LocalReviewDestinationRecord,
  assertions: Array<CanonicalObservation | CanonicalFact | CanonicalRelationship>
): Array<{ evidence_id: string; stance: LocalReviewEvidenceSummary["stance"] }> {
  const records = destination.record_type === "entity"
    ? assertions.filter((assertion) => assertionReferencesEntity(assertion, destination.object_id))
    : [destination.record];
  const links = records.flatMap((record) => record.schema === "atlas.observation:v1"
    ? record.evidence_refs.map((evidence_id) => ({ evidence_id, stance: "supports" as const }))
    : record.evidence_links);
  return [...new Map(links.map((link) => [`${link.evidence_id}:${link.stance}`, link])).values()]
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id) || left.stance.localeCompare(right.stance));
}

function destinationConfidence(destination: LocalReviewDestinationRecord): LocalReviewDecisionSummary["confidence"] {
  return destination.record_type === "fact" || destination.record_type === "relationship"
    ? destination.record.confidence.band
    : "unassessed";
}

function coverageRationale(basis: LocalReviewCoverageBasis): string {
  if (basis === "direct") return "This destination is directly named by the recorded source coverage.";
  if (basis === "unit-via-observation") return "This destination shares the exact source fragment with a directly covered observation.";
  if (basis === "source-context") return "This destination is supported by the complete source context rather than one fragment.";
  return "No exact source fragment or complete-source coverage currently accounts for this destination.";
}

function decisionSummary(input: {
  destination: LocalReviewDestinationRecord;
  assertions: Array<CanonicalObservation | CanonicalFact | CanonicalRelationship>;
  evidenceById: Map<string, CanonicalEvidencePayload>;
  scopedEvidenceIds?: Set<string>;
  coverageBasis: LocalReviewCoverageBasis;
}): LocalReviewDecisionSummary {
  const confidence = destinationConfidence(input.destination);
  const evidence = linkedEvidence(input.destination, input.assertions).flatMap((link) => {
    const record = input.evidenceById.get(link.evidence_id);
    if (!record) return [];
    if (input.scopedEvidenceIds
      && record.source_kind === "migration"
      && !input.scopedEvidenceIds.has(link.evidence_id)) return [];
    return [{
      evidence_id: record.evidence_id,
      stance: link.stance,
      source_label: sourceLabel(record),
      retrieved_at: record.retrieved_at,
      confidence,
      private_detail: {
        locator: record.locator,
        ...(record.excerpt !== undefined ? { excerpt: record.excerpt } : {}),
        ...(record.snapshot_ref !== undefined ? { snapshot_ref: record.snapshot_ref } : {})
      }
    }];
  });
  return {
    destination_object_id: input.destination.object_id,
    destination_kind: input.destination.record_type,
    label: destinationLabel(input.destination),
    parity: input.coverageBasis === "uncovered" ? "uncovered" : "covered",
    coverage_basis: input.coverageBasis,
    confidence,
    evidence,
    rationale: coverageRationale(input.coverageBasis),
    editable: input.destination.record_type === "observation"
  };
}

const BlockerSummary: Record<string, string> = {
  "typed-projection-ambiguous-entity": "More than one existing node could represent the same thing.",
  "typed-projection-missing-edge-endpoint": "A relationship is missing one of its endpoints.",
  "typed-projection-endpoint-type-mismatch": "A relationship endpoint has a different type than expected.",
  "typed-projection-ambiguous-edge-endpoint": "A relationship endpoint could refer to more than one node.",
  "typed-projection-duplicate-edge": "A duplicate relationship may already exist.",
  "typed-projection-other-edge-omission": "A relationship could not be placed safely."
};

const ResearchReasonSummary: Record<string, string> = {
  "qualifies-two-independent-public": "Two independent public sources support the proposed knowledge.",
  "qualifies-linkedin-plus-independent": "LinkedIn and an independent public source support the proposed knowledge.",
  "insufficient-evidence": "More independent evidence is needed before this can be applied automatically.",
  "evidence-conflict": "The available sources disagree.",
  "identity-ambiguous": "The available evidence does not identify one person or organization with enough certainty.",
  "proposal-conflict": "The sources support different proposed knowledge.",
  "unsupported-predicate": "This kind of proposed knowledge needs owner review.",
  "contact-detail-prohibited": "Researched contact details always require owner review.",
  "sensitive-relationship": "A sensitive inferred relationship always requires owner review."
};

function recommendationRationale(
  review: CanonicalReviewItemPayload,
  proposedRecords: CanonicalPayload[]
): LocalReviewRecommendationRationale {
  const results = proposedRecords.filter((payload): payload is Extract<CanonicalPayload, { schema: "atlas.research-result:v1" }> => (
    payload.schema === "atlas.research-result:v1"
  ));
  const proposals = proposedRecords.filter((payload): payload is CanonicalFact | CanonicalRelationship => (
    payload.schema === "atlas.fact:v1" || payload.schema === "atlas.relationship:v2"
  ));
  const summaries = proposals.flatMap((proposal) => {
    const proposalResults = results.filter((result) => result.proposed_object_id === canonicalPayloadObjectId(proposal));
    if (proposalResults.length === 0) return [];
    return [summarizeResearchRecommendation({
      proposal,
      proposed_mutation_hash: proposalResults[0]!.proposed_mutation_hash,
      identity_state: proposalResults.some((result) => result.identity_state === "ambiguous") ? "ambiguous" : "resolved",
      ...(proposal.schema === "atlas.relationship:v2"
        ? { relationship_basis: proposalResults.every((result) => result.relationship_basis === "explicit")
            ? "explicit" as const
            : "inferred-sensitive" as const }
        : {}),
      results: proposalResults
    })];
  });
  if (summaries.length > 0) {
    const outcome = summaries.some((summary) => summary.recommendation === "owner-review") ? "owner-review"
      : summaries.some((summary) => summary.recommendation === "research") ? "research"
        : "auto-apply";
    const reasonCodes = [...new Set(summaries.flatMap((summary) => summary.reason_codes))].sort();
    return {
      outcome,
      summary: reasonCodes.map((code) => ResearchReasonSummary[code] ?? "Additional review is required.").join(" "),
      reason_codes: reasonCodes,
      independence_group_count: new Set(results.map((result) => result.independence_key)).size
    };
  }
  const blockers = [...(review.auto_apply_blockers ?? [])].sort();
  if (blockers.length > 0) {
    return {
      outcome: "owner-review",
      summary: blockers.map((blocker) => BlockerSummary[blocker]).join(" "),
      reason_codes: blockers,
      independence_group_count: 0
    };
  }
  return {
    outcome: review.recommendation,
    summary: review.recommendation === "auto-apply"
      ? "The recorded source coverage supports applying this without another decision."
      : review.recommendation === "research"
        ? "More evidence or identity context may make this easier to place."
        : "Your judgment is needed to confirm how this source should be kept.",
    reason_codes: [],
    independence_group_count: 0
  };
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
    case "atlas.research-result:v1":
      return `research-result:${payload.connector_kind}:${payload.stance}`;
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
  unmappedDestinationIds: string[];
  missingReferences: string[];
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
    return { mode: "incomplete", explanation: "The exact source copy is unavailable, so Keep and Edit are blocked." };
  }
  if (!proposedComplete) {
    return { mode: "incomplete", explanation: "One or more proposed destinations are unavailable, so Keep and Edit are blocked." };
  }
  if (input.missingReferences.length > 0) {
    return { mode: "incomplete", explanation: "One or more referenced items are unavailable, so the destination mapping is incomplete." };
  }
  if (!observationParityShapeValid) {
    return { mode: "incomplete", explanation: "The recorded source coverage does not match the proposed observations." };
  }
  if (input.unmappedDestinationIds.length > 0) {
    return { mode: "incomplete", explanation: "One or more proposed destinations are not tied to an exact source fragment or the complete source." };
  }

  const hasCanonicalUnitEvidence = input.unitMappings.some((mapping) => mapping.unit_evidence_ids.length > 0);
  if (hasCanonicalUnitEvidence) {
    const unitsComplete = input.sourceAccounting.meaningful_units.length > 0
      && input.unitMappings.length === input.sourceAccounting.meaningful_units.length
      && input.unitMappings.every((mapping) => mapping.unit_evidence_ids.length > 0 && mapping.observation_ids.length > 0);
    if (!unitsComplete) {
      return { mode: "incomplete", explanation: "Not every source fragment has evidence and a mapped observation." };
    }
    const mappedObservationIds = new Set(input.unitMappings.flatMap((mapping) => mapping.observation_ids));
    if (proposedObservations.some((observation) => !mappedObservationIds.has(observation.assertion_id))
      || input.parityRecords.some((parity) => parity.canonical_object_ids.some((id) => !mappedObservationIds.has(id)))) {
      return { mode: "incomplete", explanation: "The recorded source coverage is not wholly accounted for by the mapped source fragments." };
    }
    return { mode: "rich", explanation: "Every source fragment maps to evidence and a destination; observation editing is available." };
  }

  if (input.proposedRecords.length === 1 && proposedObservations.length === 1) {
    return { mode: "legacy", explanation: "This source has one general destination that can expand into one sourced observation per extracted item." };
  }
  return { mode: "incomplete", explanation: "This source does not yet have a complete supported destination mapping." };
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
  candidateIds?: readonly string[];
}): Promise<LocalReviewQueue> {
  const envelopesById = new Map(input.objects.map((object) => [object.object_id, object]));
  const payloads = new Map<string, CanonicalPayload>();
  for (const object of input.objects.filter((item) => DecryptableTypes.has(item.object_type) && !item.visible_metadata.tombstone)) {
    const payload = await input.decryptPayload(object);
    if (!payload) continue;
    const parsed = CanonicalPayloadSchema.safeParse(payload);
    if (parsed.success) payloads.set(canonicalPayloadObjectId(parsed.data), parsed.data);
  }
  const requestedCandidates = input.candidateIds ? new Set(input.candidateIds) : undefined;
  const reviews = [...payloads.values()].filter((payload): payload is CanonicalReviewItemPayload => (
    payload.schema === "atlas.review-item:v1"
      && (!requestedCandidates || requestedCandidates.has(payload.candidate_id))
  ));
  const itemFor = (review: CanonicalReviewItemPayload): LocalReviewQueueItem => {
    const proposed = review.proposed_object_ids;
    const proposedOrderById = new Map(proposed.map((id, index) => [id, index]));
    const declaredSourceEvidenceIds = new Set<string>(review.source_evidence_ids ?? []);
    const evidenceIds = new Set<string>(declaredSourceEvidenceIds);
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
      if (payload?.schema === "atlas.research-result:v1") {
        evidenceIds.add(payload.evidence_id);
        payload.identity_confidence.evidence_refs.forEach((evidence) => evidenceIds.add(evidence));
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
      declaredSourceEvidenceIds.has(item.evidence_id)
      && item.source_kind === "migration"
      && item.extraction_method === "canonical-markdown-lossless-v1"
    )));
    const observation = proposedRecords.find((payload) => payload.schema === "atlas.observation:v1");
    const sourceAccounting = accountSourceMeaning(sourceContext);
    const parityObservationIds = new Set(parityRecords.flatMap((parity) => (
      parity.representation_kind === "observation" ? parity.canonical_object_ids : []
    )));
    const representedParityIds = new Set(parityRecords.flatMap((parity) => (
      parity.coverage_state === "represented" ? parity.canonical_object_ids : []
    )));
    const canonicalDestinations: LocalReviewAssertionDestination[] = [];
    for (const payload of proposedRecords) {
      if (payload.schema === "atlas.observation:v1") canonicalDestinations.push(observationDestination(payload));
      if (payload.schema === "atlas.fact:v1") canonicalDestinations.push(factDestination(payload));
      if (payload.schema === "atlas.relationship:v2") canonicalDestinations.push(relationshipDestination(payload));
    }
    canonicalDestinations.splice(0, canonicalDestinations.length, ...dedupeAndSortDestinations(
      canonicalDestinations,
      proposedOrderById
    ) as LocalReviewAssertionDestination[]);
    const canonicalAssertions = canonicalDestinations.map((destination) => destination.record);
    const evidenceById = new Map(evidence.map((item) => [item.evidence_id, item]));
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
      const assertionDestinations = canonicalDestinations.filter((destination) => {
        return recordEvidenceIds(destination.record).some((id) => matchingEvidenceIds.has(id));
      });
      const entityIds = [...new Set(assertionDestinations.flatMap((destination) => assertionEntityIds(destination.record)))].sort();
      const entityDestinations = entityIds.flatMap((id) => {
        const payload = payloads.get(id);
        return payload?.schema === "atlas.entity:v1" ? [entityDestination(payload)] : [];
      });
      const destinations = dedupeAndSortDestinations(
        [...entityDestinations, ...assertionDestinations],
        proposedOrderById
      );
      const representedObservationPresent = assertionDestinations.some((destination) => (
        destination.record_type === "observation" && parityObservationIds.has(destination.object_id)
      ));
      return {
        mapping_id: mappingId(review.candidate_id, unit.unit_id, occurrence),
        unit,
        occurrence,
        unit_evidence_ids: matchingEvidence.map((item) => item.evidence_id),
        unit_evidence: matchingEvidence,
        observation_ids: destinations.filter((item) => item.record_type === "observation").map((item) => item.object_id),
        fact_ids: destinations.filter((item) => item.record_type === "fact").map((item) => item.object_id),
        relationship_ids: destinations.filter((item) => item.record_type === "relationship").map((item) => item.object_id),
        entity_ids: entityIds,
        destination_records: destinations,
        destination_summaries: destinations.map((destination) => decisionSummary({
          destination,
          assertions: assertionDestinations.map((item) => item.record),
          evidenceById,
          scopedEvidenceIds: matchingEvidenceIds,
          coverageBasis: representedParityIds.has(destination.object_id)
            ? "direct"
            : representedObservationPresent ? "unit-via-observation" : "uncovered"
        }))
      };
    });
    const graphObservations = proposedRecords.filter((payload): payload is CanonicalObservation => payload.schema === "atlas.observation:v1");
    const graphFacts = proposedRecords.filter((payload): payload is CanonicalFact => payload.schema === "atlas.fact:v1");
    const graphRelationships = proposedRecords.filter((payload): payload is CanonicalRelationship => payload.schema === "atlas.relationship:v2");
    const graphEntityIds = new Set<string>([
      ...proposedRecords.flatMap((payload) => payload.schema === "atlas.entity:v1" ? [payload.entity_id] : []),
      ...graphObservations.flatMap((payload) => payload.candidate_entity_ids),
      ...graphFacts.flatMap((payload) => [
        payload.subject_entity_id,
        ...(payload.value.kind === "entity-ref" ? [payload.value.entity_id] : [])
      ]),
      ...graphRelationships.flatMap((payload) => [payload.source_entity_id, payload.target_entity_id])
    ]);
    const graphEntities: CanonicalEntity[] = [...graphEntityIds].sort().flatMap((id) => {
      const payload = payloads.get(id);
      return payload?.schema === "atlas.entity:v1" ? [payload] : [];
    });
    const destinationGraph: LocalReviewDestinationGraph = {
      source_evidence_ids: sourceContext.map((item) => item.evidence_id),
      entities: graphEntities.map(entityDestination),
      observations: graphObservations.map(observationDestination).sort((left, right) => left.object_id.localeCompare(right.object_id)),
      facts: graphFacts.map(factDestination).sort((left, right) => left.object_id.localeCompare(right.object_id)),
      relationships: graphRelationships.map(relationshipDestination).sort((left, right) => left.object_id.localeCompare(right.object_id))
    };
    const sourceEvidenceIds = new Set(sourceContext.map((item) => item.evidence_id));
    const sourceContextAssertions = canonicalDestinations.filter((destination) => {
      const recordEvidence = recordEvidenceIds(destination.record);
      return recordEvidence.some((id) => sourceEvidenceIds.has(id))
        && recordEvidence.every((id) => {
          if (sourceEvidenceIds.has(id)) return true;
          const linked = evidenceById.get(id);
          return linked !== undefined && linked.extraction_method !== "canonical-source-unit-v1";
        });
    });
    const sourceContextEntityIds = [...new Set(sourceContextAssertions.flatMap((destination) => (
      assertionEntityIds(destination.record)
    )))].sort();
    const sourceContextDestinations = dedupeAndSortDestinations([
      ...sourceContextEntityIds.flatMap((id) => {
        const payload = payloads.get(id);
        return payload?.schema === "atlas.entity:v1" ? [entityDestination(payload)] : [];
      }),
      ...sourceContextAssertions
    ], proposedOrderById);
    const allDestinations = dedupeAndSortDestinations([
      ...destinationGraph.entities,
      ...destinationGraph.facts,
      ...destinationGraph.relationships,
      ...destinationGraph.observations
    ], proposedOrderById);
    const unitMappedIds = new Set(unitMappings.flatMap((mapping) => (
      mapping.destination_records.map((destination) => destination.object_id)
    )));
    const sourceMappedIds = new Set(sourceContextDestinations.map((destination) => destination.object_id));
    const unmappedDestinationIds = allDestinations
      .filter((destination) => !unitMappedIds.has(destination.object_id) && !sourceMappedIds.has(destination.object_id))
      .map((destination) => destination.object_id);
    const sourceContextCovered = sourceContextAssertions.some((destination) => (
      destination.record_type === "observation" && parityObservationIds.has(destination.object_id)
    )) || graphObservations.some((observationRecord) => (
      parityObservationIds.has(observationRecord.assertion_id)
      && recordEvidenceIds(observationRecord).some((id) => sourceEvidenceIds.has(id))
    ));
    const basisForDestination = (destination: LocalReviewDestinationRecord): LocalReviewCoverageBasis => {
      if (representedParityIds.has(destination.object_id)) return "direct";
      if (unitMappings.some((mapping) => mapping.destination_records.some((record) => record.object_id === destination.object_id)
        && mapping.observation_ids.some((id) => parityObservationIds.has(id)))) {
        return "unit-via-observation";
      }
      if (sourceMappedIds.has(destination.object_id) && sourceContextCovered) return "source-context";
      return "uncovered";
    };
    const decisionSummaries = allDestinations.map((destination) => decisionSummary({
      destination,
      assertions: canonicalAssertions,
      evidenceById,
      coverageBasis: basisForDestination(destination)
    }));
    const graph: LocalReviewGraph = {
      nodes: [
        ...graphEntities.map((entity): LocalReviewGraphNode => ({
          node_id: entity.entity_id,
          object_id: entity.entity_id,
          kind: "entity",
          label: entity.name,
          entity_type: entity.type,
          style: "solid"
        })),
        ...graphFacts.map((fact): LocalReviewGraphNode => ({
          node_id: `fact:${fact.assertion_id}`,
          object_id: fact.assertion_id,
          kind: "fact",
          label: factValueLabel(fact),
          style: "solid"
        })),
        ...graphObservations.map((observationRecord): LocalReviewGraphNode => ({
          node_id: `observation:${observationRecord.assertion_id}`,
          object_id: observationRecord.assertion_id,
          kind: "observation",
          label: observationRecord.statement,
          style: "dashed"
        }))
      ].sort((left, right) => left.kind.localeCompare(right.kind) || left.node_id.localeCompare(right.node_id)),
      edges: [
        ...graphRelationships.map((relationship): LocalReviewGraphEdge => ({
          edge_id: relationship.edge_id,
          kind: "relationship",
          assertion_id: relationship.assertion_id,
          source_entity_id: relationship.source_entity_id,
          target_entity_id: relationship.target_entity_id,
          predicate: relationship.predicate,
          style: "solid"
        })),
        ...graphFacts.map((fact): LocalReviewGraphEdge => ({
          edge_id: `fact:${fact.assertion_id}`,
          kind: "fact",
          assertion_id: fact.assertion_id,
          source_entity_id: fact.subject_entity_id,
          target_node_id: `fact:${fact.assertion_id}`,
          predicate: fact.predicate,
          style: "solid"
        })),
        ...graphObservations.flatMap((observationRecord): LocalReviewGraphEdge[] => (
          observationRecord.candidate_entity_ids.length > 0
            ? observationRecord.candidate_entity_ids.map((entityId) => ({
                edge_id: `observation:${observationRecord.assertion_id}:${entityId}`,
                kind: "observation" as const,
                assertion_id: observationRecord.assertion_id,
                source_entity_id: entityId,
                target_node_id: `observation:${observationRecord.assertion_id}`,
                predicate: "unresolved" as const,
                style: "dashed" as const
              }))
            : [{
                edge_id: `observation:${observationRecord.assertion_id}:standalone`,
                kind: "observation",
                assertion_id: observationRecord.assertion_id,
                target_node_id: `observation:${observationRecord.assertion_id}`,
                predicate: "unresolved",
                style: "dashed"
              }]
        ))
      ].sort((left, right) => left.kind.localeCompare(right.kind) || left.edge_id.localeCompare(right.edge_id))
    };
    const referenced = [
      ...proposed,
      ...evidenceIds,
      ...parityIds,
      ...parityRecords.flatMap((parity) => parity.canonical_object_ids),
      ...graphEntityIds
    ];
    const missingReferences = referenced.filter((id) => !payloads.has(id)).sort();
    const resolutionMode = reviewResolutionMode({
      proposedObjectIds: proposed,
      proposedRecords,
      parityRecords,
      sourceAccounting,
      unitMappings,
      unmappedDestinationIds,
      missingReferences
    });
    const requestedUnitHashes = new Set(review.research_requested_unit_hashes ?? []);
    const researchRequestedUnits = sourceAccounting.meaningful_units.filter((unit) => requestedUnitHashes.has(unit.unit_id));
    return {
      review_id: review.review_id,
      review_version: envelopesById.get(review.review_id)?.version ?? 0,
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
      graph,
      decision_summaries: decisionSummaries,
      recommendation_rationale: recommendationRationale(review, proposedRecords),
      source_context_mapping: {
        source_evidence_ids: [...sourceEvidenceIds].sort(),
        destination_records: sourceContextDestinations,
        destination_summaries: sourceContextDestinations.map((destination) => decisionSummary({
          destination,
          assertions: sourceContextAssertions.map((item) => item.record),
          evidenceById,
          scopedEvidenceIds: sourceEvidenceIds,
          coverageBasis: basisForDestination(destination)
        }))
      },
      unmapped_destination_ids: unmappedDestinationIds,
      resolution_mode: resolutionMode.mode,
      resolution_mode_explanation: resolutionMode.explanation,
      parity_ids: parityIds.sort(),
      parity_records: parityRecords,
      source_accounting: sourceAccounting,
      missing_references: missingReferences,
      context_unavailable: sourceContext.length === 0,
      exact_source_encrypted: sourceContext.length > 0 && sourceContext.every((evidence) => (
        envelopesById.get(evidence.evidence_id)?.encryption_class === "client-encrypted"
      )),
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
