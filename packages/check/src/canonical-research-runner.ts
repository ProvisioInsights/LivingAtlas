import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CanonicalEvidencePayloadSchema,
  CanonicalFactPayloadSchema,
  CanonicalRelationshipPayloadSchema,
  CanonicalResearchConnectorKindSchema,
  CanonicalResearchResultPayloadSchema,
  CanonicalReviewItemPayloadSchema,
  EdgeStatusSchema,
  EndpointTypeSchema,
  EvidenceStanceSchema,
  FactPredicateSchema,
  FactValueSchema,
  IsoTimestampSchema,
  MixedPrecisionDateSchema,
  ObjectIdSchema,
  PredicateSchema,
  Sha256HashSchema,
  canonicalPayloadObjectId,
  type CanonicalEvidencePayload,
  type CanonicalFactPayload,
  type CanonicalRelationshipPayload,
  type CanonicalResearchConnectorKind,
  type CanonicalResearchResultPayload,
  type CanonicalReviewItemPayload
} from "@living-atlas/contracts";
import {
  canonicalResearchEvidenceId,
  canonicalResearchMutationFingerprint,
  canonicalResearchResultId,
  canonicalResearchRunId,
  summarizeResearchRecommendation,
  type CanonicalResearchProposal,
  type ResearchRecommendationReasonCode
} from "@living-atlas/graph-service";

const boundedIdentifier = z.string().min(1).max(512);
const boundedText = z.string().min(1).max(8_192);

const ResearchFactIntentSchema = z.object({
  kind: z.literal("fact"),
  subject_entity_id: ObjectIdSchema,
  predicate: FactPredicateSchema,
  value: FactValueSchema,
  valid_from: MixedPrecisionDateSchema.optional(),
  valid_to: MixedPrecisionDateSchema.optional()
}).strict();

const ResearchRelationshipIntentSchema = z.object({
  kind: z.literal("relationship"),
  source_entity_id: ObjectIdSchema,
  source_type: EndpointTypeSchema,
  target_entity_id: ObjectIdSchema,
  target_type: EndpointTypeSchema,
  predicate: PredicateSchema,
  valid_from: MixedPrecisionDateSchema,
  valid_to: MixedPrecisionDateSchema.optional(),
  status: EdgeStatusSchema.optional()
}).strict();

const CanonicalResearchMutationIntentSchema = z.discriminatedUnion("kind", [
  ResearchFactIntentSchema,
  ResearchRelationshipIntentSchema
]);

const CanonicalResearchTransportResultSchema = z.object({
  upstream_identity: boundedIdentifier,
  locator: boundedText,
  independence_key: boundedIdentifier,
  content_hash: Sha256HashSchema,
  retrieved_at: IsoTimestampSchema,
  excerpt: z.string().max(4_096).optional(),
  snapshot_ref: ObjectIdSchema.optional(),
  stance: EvidenceStanceSchema,
  identity_state: z.enum(["resolved", "ambiguous"]),
  identity_confidence: z.object({
    band: z.enum(["high", "medium", "low"]),
    method: boundedIdentifier,
    rationale: boundedText.optional()
  }).strict(),
  relationship_basis: z.enum(["explicit", "inferred-sensitive"]).optional(),
  proposal: CanonicalResearchMutationIntentSchema
}).strict().superRefine((result, context) => {
  if (result.excerpt === undefined && result.snapshot_ref === undefined) {
    context.addIssue({
      code: "custom",
      path: ["excerpt"],
      message: "research evidence requires an excerpt or snapshot reference"
    });
  }
  if (result.proposal.kind === "fact" && result.relationship_basis !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["relationship_basis"],
      message: "relationship_basis is valid only for relationship proposals"
    });
  }
  if (result.proposal.kind === "relationship" && result.relationship_basis === undefined) {
    context.addIssue({
      code: "custom",
      path: ["relationship_basis"],
      message: "relationship proposals require relationship_basis"
    });
  }
});

export type CanonicalResearchMutationIntent = z.infer<typeof CanonicalResearchMutationIntentSchema>;
export type CanonicalResearchTransportResult = z.infer<typeof CanonicalResearchTransportResultSchema>;

export interface CanonicalResearchTransportRequest {
  run_id: string;
  candidate_id: string;
  source_unit_id: string;
  connector_kind: CanonicalResearchConnectorKind;
  algorithm_version: string;
  normalized_query: string;
  normalized_query_hash: string;
}

export interface CanonicalResearchTransport {
  run(request: CanonicalResearchTransportRequest): Promise<readonly CanonicalResearchTransportResult[]>;
}

export type CanonicalResearchDraftIntent = {
  access_class: "local-private";
  payload:
    | CanonicalEvidencePayload
    | CanonicalResearchResultPayload
    | CanonicalFactPayload
    | CanonicalRelationshipPayload;
};

export type CanonicalResearchRecord = {
  result: CanonicalResearchResultPayload;
  evidence: CanonicalEvidencePayload;
  proposal: CanonicalFactPayload | CanonicalRelationshipPayload;
};

export type CanonicalResearchReasonCode =
  | ResearchRecommendationReasonCode
  | "transport-failed"
  | "invalid-transport-result"
  | "exact-replay";

export interface CanonicalResearchReceipt {
  schema: "living-atlas-canonical-research-receipt:v1";
  run_id: string;
  candidate_id: string;
  source_unit_id: string;
  connector_kind: CanonicalResearchConnectorKind;
  normalized_query_hash: string;
  recommendation: "auto-apply" | "owner-review" | "research";
  counts: { received: number; appended: number; replayed: number; rejected: number };
  independence_group_count: number;
  reason_codes: CanonicalResearchReasonCode[];
  draft_object_ids: string[];
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeCanonicalResearchQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function canonicalResearchNormalizedQueryHash(value: string): `sha256:${string}` {
  return sha256(normalizeCanonicalResearchQuery(value));
}

function connectorEvidenceKind(connector: CanonicalResearchConnectorKind): CanonicalEvidencePayload["source_kind"] {
  switch (connector) {
    case "public-web":
    case "organization":
      return "public-web";
    case "linkedin":
      return "linkedin";
    case "local-corpus":
      return "connector";
  }
}

function evidenceId(result: CanonicalResearchTransportResult): string {
  return canonicalResearchEvidenceId(result);
}

function evidencePayload(
  result: CanonicalResearchTransportResult,
  connector: CanonicalResearchConnectorKind
): CanonicalEvidencePayload {
  return CanonicalEvidencePayloadSchema.parse({
    schema: "atlas.evidence:v1",
    evidence_id: evidenceId(result),
    source_kind: connectorEvidenceKind(connector),
    locator: result.locator,
    content_hash: result.content_hash,
    retrieved_at: result.retrieved_at,
    independence_key: result.independence_key,
    ...(result.excerpt !== undefined ? { excerpt: result.excerpt } : {}),
    ...(result.snapshot_ref !== undefined ? { snapshot_ref: result.snapshot_ref } : {}),
    extraction_method: `canonical-research-${connector}-v1`
  });
}

function proposalPayload(
  intent: CanonicalResearchMutationIntent,
  evidenceLinks: Array<{ evidence_id: string; stance: CanonicalResearchResultPayload["stance"] }>,
  confidenceBand: "high" | "medium" | "low",
  recordedAt: string
): CanonicalResearchProposal {
  const evidenceRefs = [...new Set(evidenceLinks.map((link) => link.evidence_id))].sort();
  const links = [...evidenceLinks]
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id) || left.stance.localeCompare(right.stance));
  if (intent.kind === "fact") {
    const provisional = CanonicalFactPayloadSchema.parse({
      schema: "atlas.fact:v1",
      assertion_id: "la_object_researchproposalplaceholder0001",
      subject_entity_id: intent.subject_entity_id,
      predicate: intent.predicate,
      value: intent.value,
      ...(intent.valid_from ? { valid_from: intent.valid_from } : {}),
      ...(intent.valid_to ? { valid_to: intent.valid_to } : {}),
      recorded_at: recordedAt,
      lineage_action: "assert",
      supersedes: [],
      evidence_links: links,
      confidence: {
        band: confidenceBand,
        assessment_kind: "assertion",
        method: "canonical-research-v1",
        assessed_at: recordedAt,
        evidence_refs: evidenceRefs
      }
    });
    const fingerprint = canonicalResearchMutationFingerprint(provisional);
    return CanonicalFactPayloadSchema.parse({ ...provisional, assertion_id: fingerprint.proposed_object_id });
  }
  const provisional = CanonicalRelationshipPayloadSchema.parse({
    schema: "atlas.relationship:v2",
    assertion_id: "la_object_researchproposalplaceholder0001",
    edge_id: "la_edge_researchproposalplaceholder0001",
    source_entity_id: intent.source_entity_id,
    source_type: intent.source_type,
    target_entity_id: intent.target_entity_id,
    target_type: intent.target_type,
    predicate: intent.predicate,
    valid_from: intent.valid_from,
    ...(intent.valid_to ? { valid_to: intent.valid_to } : {}),
    status: intent.status ?? "active",
    attrs: {},
    recorded_at: recordedAt,
    lineage_action: "assert",
    supersedes: [],
    evidence_links: links,
    confidence: {
      band: confidenceBand,
      assessment_kind: "assertion",
      method: "canonical-research-v1",
      assessed_at: recordedAt,
      evidence_refs: evidenceRefs
    }
  });
  const fingerprint = canonicalResearchMutationFingerprint(provisional);
  return CanonicalRelationshipPayloadSchema.parse({
    ...provisional,
    assertion_id: fingerprint.proposed_object_id,
    edge_id: `la_edge_${fingerprint.proposed_mutation_hash.slice("sha256:".length, "sha256:".length + 24)}`
  });
}

function confidenceRank(value: "high" | "medium" | "low"): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function lowestConfidence(values: readonly ("high" | "medium" | "low")[]): "high" | "medium" | "low" {
  return values.reduce((lowest, value) => confidenceRank(value) < confidenceRank(lowest) ? value : lowest, "high");
}

function validatePriorRecord(value: CanonicalResearchRecord): CanonicalResearchRecord {
  const result = CanonicalResearchResultPayloadSchema.parse(value.result);
  const evidence = CanonicalEvidencePayloadSchema.parse(value.evidence);
  const proposal = value.proposal.schema === "atlas.fact:v1"
    ? CanonicalFactPayloadSchema.parse(value.proposal)
    : CanonicalRelationshipPayloadSchema.parse(value.proposal);
  const fingerprint = canonicalResearchMutationFingerprint(proposal);
  const expectedRunId = canonicalResearchRunId({
    candidate_id: result.candidate_id,
    source_unit_id: result.source_unit_id,
    connector_kind: result.connector_kind,
    normalized_query_hash: result.normalized_query_hash,
    algorithm_version: result.algorithm_version
  });
  const expectedResultId = canonicalResearchResultId({
    run_id: result.run_id,
    evidence_id: result.evidence_id,
    proposed_mutation_hash: result.proposed_mutation_hash
  });
  const evidenceLinks = proposal.evidence_links;
  if (result.run_id !== expectedRunId
    || (proposal.schema === "atlas.fact:v1" && result.relationship_basis !== undefined)
    || (proposal.schema === "atlas.relationship:v2" && result.relationship_basis === undefined)
    || (proposal.schema === "atlas.relationship:v2"
      && proposal.edge_id !== `la_edge_${fingerprint.proposed_mutation_hash.slice("sha256:".length, "sha256:".length + 24)}`)
    || (proposal.schema === "atlas.relationship:v2" && Object.keys(proposal.attrs).length > 0)
    || result.research_result_id !== expectedResultId
    || result.evidence_id !== evidence.evidence_id
    || evidence.evidence_id !== canonicalResearchEvidenceId({
      upstream_identity: result.upstream_identity,
      locator: evidence.locator,
      content_hash: evidence.content_hash
    })
    || result.evidence_content_hash !== evidence.content_hash
    || result.retrieved_at !== evidence.retrieved_at
    || result.independence_key !== evidence.independence_key
    || result.proposed_object_id !== canonicalPayloadObjectId(proposal)
    || result.proposed_object_id !== fingerprint.proposed_object_id
    || result.proposed_mutation_hash !== fingerprint.proposed_mutation_hash
    || !result.identity_confidence.evidence_refs.includes(evidence.evidence_id)
    || !proposal.confidence.evidence_refs.includes(evidence.evidence_id)
    || !evidenceLinks.some((link) => link.evidence_id === evidence.evidence_id && link.stance === result.stance)
    || evidence.source_kind !== connectorEvidenceKind(result.connector_kind)
    || evidence.extraction_method !== `canonical-research-${result.connector_kind}-v1`
    || (evidence.excerpt !== undefined && sha256(evidence.excerpt) !== evidence.content_hash)) {
    throw new Error("prior research record is inconsistent");
  }
  return { result, evidence, proposal };
}

function replaySignature(record: CanonicalResearchRecord): string {
  return stableJson({
    result: {
      run_id: record.result.run_id,
      candidate_id: record.result.candidate_id,
      source_unit_id: record.result.source_unit_id,
      algorithm_version: record.result.algorithm_version,
      normalized_query_hash: record.result.normalized_query_hash,
      connector_kind: record.result.connector_kind,
      upstream_identity: record.result.upstream_identity,
      independence_key: record.result.independence_key,
      evidence_id: record.result.evidence_id,
      evidence_content_hash: record.result.evidence_content_hash,
      retrieved_at: record.result.retrieved_at,
      stance: record.result.stance,
      identity_state: record.result.identity_state,
      identity_confidence: {
        band: record.result.identity_confidence.band,
        method: record.result.identity_confidence.method,
        evidence_refs: record.result.identity_confidence.evidence_refs,
        ...(record.result.identity_confidence.rationale
          ? { rationale: record.result.identity_confidence.rationale }
          : {})
      },
      proposed_object_id: record.result.proposed_object_id,
      proposed_mutation_hash: record.result.proposed_mutation_hash,
      ...(record.result.relationship_basis
        ? { relationship_basis: record.result.relationship_basis }
        : {})
    },
    evidence: record.evidence,
    proposal: canonicalResearchMutationFingerprint(record.proposal)
  });
}

function overallRecommendation(values: readonly ("auto-apply" | "owner-review" | "research")[]): "auto-apply" | "owner-review" | "research" {
  if (values.includes("owner-review")) return "owner-review";
  if (values.length === 0 || values.includes("research")) return "research";
  return "auto-apply";
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function receipt(input: {
  runId: string;
  review: CanonicalReviewItemPayload;
  sourceUnitId: string;
  connector: CanonicalResearchConnectorKind;
  queryHash: string;
  recommendation: "auto-apply" | "owner-review" | "research";
  received: number;
  appended: number;
  replayed: number;
  rejected: number;
  independenceGroupCount: number;
  reasonCodes: CanonicalResearchReasonCode[];
  draftIntents: CanonicalResearchDraftIntent[];
}): CanonicalResearchReceipt {
  return {
    schema: "living-atlas-canonical-research-receipt:v1",
    run_id: input.runId,
    candidate_id: input.review.candidate_id,
    source_unit_id: input.sourceUnitId,
    connector_kind: input.connector,
    normalized_query_hash: input.queryHash,
    recommendation: input.recommendation,
    counts: {
      received: input.received,
      appended: input.appended,
      replayed: input.replayed,
      rejected: input.rejected
    },
    independence_group_count: input.independenceGroupCount,
    reason_codes: uniqueSorted(input.reasonCodes),
    draft_object_ids: uniqueSorted(input.draftIntents.map((intent) => canonicalPayloadObjectId(intent.payload)))
  };
}

export async function runCanonicalResearchCandidate(input: {
  review_item: CanonicalReviewItemPayload;
  source_unit_id: string;
  connector_kind: CanonicalResearchConnectorKind;
  algorithm_version: string;
  query: string;
  normalized_query_hash: string;
  transport: CanonicalResearchTransport;
  now: () => string;
  prior_records: readonly CanonicalResearchRecord[];
}): Promise<{
  run_id: string;
  recommendation: "auto-apply" | "owner-review" | "research";
  records: readonly CanonicalResearchRecord[];
  draft_intents: readonly CanonicalResearchDraftIntent[];
  receipt: CanonicalResearchReceipt;
}> {
  const parsedReview = CanonicalReviewItemPayloadSchema.safeParse(input.review_item);
  if (!parsedReview.success) throw new Error("research review item is invalid");
  const review = parsedReview.data;
  const parsedUnitId = Sha256HashSchema.safeParse(input.source_unit_id);
  if (!parsedUnitId.success
    || (!review.research_requested_all && !review.research_requested_unit_hashes?.includes(parsedUnitId.data))) {
    throw new Error("source unit is not authorized");
  }
  const parsedConnector = CanonicalResearchConnectorKindSchema.safeParse(input.connector_kind);
  if (!parsedConnector.success) throw new Error("research connector is invalid");
  const parsedAlgorithmVersion = boundedIdentifier.safeParse(input.algorithm_version);
  if (!parsedAlgorithmVersion.success) throw new Error("research algorithm version is invalid");
  if (typeof input.query !== "string" || input.query.trim().length === 0) throw new Error("research query is invalid");
  const normalizedQuery = normalizeCanonicalResearchQuery(input.query);
  const normalizedQueryHash = canonicalResearchNormalizedQueryHash(input.query);
  if (input.normalized_query_hash !== normalizedQueryHash) throw new Error("normalized query hash mismatch");
  if (!Array.isArray(input.prior_records)) throw new Error("prior record snapshot is required");
  if (!input.transport || typeof input.transport.run !== "function") throw new Error("research transport is required");
  if (typeof input.now !== "function") throw new Error("research clock is required");
  const recordedAt = IsoTimestampSchema.parse(input.now());
  let priorRecords: CanonicalResearchRecord[];
  try {
    priorRecords = input.prior_records.map(validatePriorRecord);
  } catch {
    throw new Error("prior research record is invalid");
  }
  if (priorRecords.some((record) => (
    record.result.candidate_id !== review.candidate_id || record.result.source_unit_id !== parsedUnitId.data
  ))) throw new Error("prior research record scope mismatch");
  const priorByResultId = new Map<string, CanonicalResearchRecord>();
  const priorEvidenceById = new Map<string, CanonicalEvidencePayload>();
  for (const record of priorRecords) {
    if (priorByResultId.has(record.result.research_result_id)) {
      throw new Error("prior research record is invalid");
    }
    priorByResultId.set(record.result.research_result_id, record);
    const existingEvidence = priorEvidenceById.get(record.evidence.evidence_id);
    if (existingEvidence && stableJson(existingEvidence) !== stableJson(record.evidence)) {
      throw new Error("prior research record is invalid");
    }
    priorEvidenceById.set(record.evidence.evidence_id, record.evidence);
  }

  const runId = canonicalResearchRunId({
    candidate_id: review.candidate_id,
    source_unit_id: parsedUnitId.data,
    connector_kind: parsedConnector.data,
    normalized_query_hash: normalizedQueryHash,
    algorithm_version: parsedAlgorithmVersion.data
  });
  const request: CanonicalResearchTransportRequest = {
    run_id: runId,
    candidate_id: review.candidate_id,
    source_unit_id: parsedUnitId.data,
    connector_kind: parsedConnector.data,
    algorithm_version: parsedAlgorithmVersion.data,
    normalized_query: normalizedQuery,
    normalized_query_hash: normalizedQueryHash
  };

  let rawResults: readonly CanonicalResearchTransportResult[];
  try {
    rawResults = await input.transport.run(request);
    if (!Array.isArray(rawResults)) throw new Error("invalid result set");
  } catch {
    const outputReceipt = receipt({
      runId,
      review,
      sourceUnitId: parsedUnitId.data,
      connector: parsedConnector.data,
      queryHash: normalizedQueryHash,
      recommendation: "research",
      received: 0,
      appended: 0,
      replayed: 0,
      rejected: 0,
      independenceGroupCount: new Set(priorRecords.map((record) => record.result.independence_key)).size,
      reasonCodes: ["transport-failed"],
      draftIntents: []
    });
    return { run_id: runId, recommendation: "research", records: priorRecords, draft_intents: [], receipt: outputReceipt };
  }

  const rejectedReasons: CanonicalResearchReasonCode[] = [];
  const parsedResults: CanonicalResearchTransportResult[] = [];
  for (const raw of rawResults as readonly unknown[]) {
    const parsed = CanonicalResearchTransportResultSchema.safeParse(raw);
    if (!parsed.success) {
      rejectedReasons.push("invalid-transport-result");
      continue;
    }
    if (parsed.data.excerpt !== undefined && sha256(parsed.data.excerpt) !== parsed.data.content_hash) {
      rejectedReasons.push("invalid-transport-result");
      continue;
    }
    if (parsed.data.proposal.kind === "fact"
      && (parsed.data.proposal.predicate === "phone"
        || parsed.data.proposal.predicate === "email"
        || parsed.data.proposal.predicate === "address")) {
      rejectedReasons.push("contact-detail-prohibited");
      continue;
    }
    if (parsed.data.proposal.kind === "relationship" && parsed.data.relationship_basis === "inferred-sensitive") {
      rejectedReasons.push("sensitive-relationship");
      continue;
    }
    parsedResults.push(parsed.data);
  }

  type CurrentSeed = {
    transport: CanonicalResearchTransportResult;
    evidence: CanonicalEvidencePayload;
    proposal: CanonicalResearchProposal;
    fingerprint: ReturnType<typeof canonicalResearchMutationFingerprint>;
  };
  const rawSeeds: CurrentSeed[] = [];
  for (const transportResult of parsedResults) {
    try {
      const evidence = evidencePayload(transportResult, parsedConnector.data);
      const proposal = proposalPayload(
        transportResult.proposal,
        [{ evidence_id: evidence.evidence_id, stance: transportResult.stance }],
        transportResult.identity_confidence.band,
        recordedAt
      );
      rawSeeds.push({
        transport: transportResult,
        evidence,
        proposal,
        fingerprint: canonicalResearchMutationFingerprint(proposal)
      });
    } catch {
      rejectedReasons.push("invalid-transport-result");
    }
  }
  const resultIdForSeed = (seed: CurrentSeed) => canonicalResearchResultId({
    run_id: runId,
    evidence_id: seed.evidence.evidence_id,
    proposed_mutation_hash: seed.fingerprint.proposed_mutation_hash
  });
  const seedSignature = (seed: CurrentSeed): string => stableJson({
    transport: seed.transport,
    fingerprint: seed.fingerprint
  });
  const seedsByEvidenceId = new Map<string, CurrentSeed[]>();
  let deterministicCollision = false;
  for (const seed of rawSeeds) {
    const group = seedsByEvidenceId.get(seed.evidence.evidence_id) ?? [];
    group.push(seed);
    seedsByEvidenceId.set(seed.evidence.evidence_id, group);
  }
  const evidenceConsistentSeeds: CurrentSeed[] = [];
  for (const [id, seeds] of seedsByEvidenceId) {
    const signatures = new Set(seeds.map((seed) => stableJson(seed.evidence)));
    const priorEvidence = priorEvidenceById.get(id);
    const conflictsWithPrior = priorEvidence !== undefined
      && [...signatures].some((signature) => signature !== stableJson(priorEvidence));
    if (signatures.size > 1 || conflictsWithPrior) {
      deterministicCollision = true;
      rejectedReasons.push(...seeds.map(() => "invalid-transport-result" as const));
    } else {
      evidenceConsistentSeeds.push(...seeds);
    }
  }
  const seedsByResultId = new Map<string, CurrentSeed[]>();
  for (const seed of evidenceConsistentSeeds) {
    const id = resultIdForSeed(seed);
    const group = seedsByResultId.get(id) ?? [];
    group.push(seed);
    seedsByResultId.set(id, group);
  }
  const seedByResultId = new Map<string, CurrentSeed>();
  let duplicateReplays = 0;
  for (const [resultId, seeds] of seedsByResultId) {
    const signatures = new Set(seeds.map(seedSignature));
    if (signatures.size === 1) {
      seedByResultId.set(resultId, seeds[0]!);
      duplicateReplays += seeds.length - 1;
    } else {
      deterministicCollision = true;
      rejectedReasons.push(...seeds.map(() => "invalid-transport-result" as const));
    }
  }
  const seedReplaySignature = (seed: CurrentSeed): string => stableJson({
    result: {
      run_id: runId,
      candidate_id: review.candidate_id,
      source_unit_id: parsedUnitId.data,
      algorithm_version: parsedAlgorithmVersion.data,
      normalized_query_hash: normalizedQueryHash,
      connector_kind: parsedConnector.data,
      upstream_identity: seed.transport.upstream_identity,
      independence_key: seed.transport.independence_key,
      evidence_id: seed.evidence.evidence_id,
      evidence_content_hash: seed.evidence.content_hash,
      retrieved_at: seed.transport.retrieved_at,
      stance: seed.transport.stance,
      identity_state: seed.transport.identity_state,
      identity_confidence: {
        band: seed.transport.identity_confidence.band,
        method: seed.transport.identity_confidence.method,
        evidence_refs: [seed.evidence.evidence_id],
        ...(seed.transport.identity_confidence.rationale
          ? { rationale: seed.transport.identity_confidence.rationale }
          : {})
      },
      proposed_object_id: seed.fingerprint.proposed_object_id,
      proposed_mutation_hash: seed.fingerprint.proposed_mutation_hash,
      ...(seed.transport.relationship_basis
        ? { relationship_basis: seed.transport.relationship_basis }
        : {})
    },
    evidence: seed.evidence,
    proposal: seed.fingerprint
  });
  let priorReplays = 0;
  const currentSeeds = [...seedByResultId.entries()].flatMap(([resultId, seed]) => {
    const prior = priorByResultId.get(resultId);
    if (!prior) return [seed];
    if (seedReplaySignature(seed) === replaySignature(prior)) {
      priorReplays += 1;
    } else {
      deterministicCollision = true;
      rejectedReasons.push("invalid-transport-result");
    }
    return [];
  });

  const groupKeys = uniqueSorted([
    ...priorRecords.map((record) => record.result.proposed_mutation_hash),
    ...currentSeeds.map((seed) => seed.fingerprint.proposed_mutation_hash)
  ]);
  const proposalByHash = new Map<string, CanonicalResearchProposal>();
  for (const groupKey of groupKeys) {
    const priorGroup = priorRecords.filter((record) => record.result.proposed_mutation_hash === groupKey);
    const currentGroup = currentSeeds.filter((seed) => seed.fingerprint.proposed_mutation_hash === groupKey);
    const baseProposal = currentGroup[0]?.proposal ?? priorGroup[0]?.proposal;
    if (!baseProposal) continue;
    const links = [
      ...priorGroup.map((record) => ({ evidence_id: record.evidence.evidence_id, stance: record.result.stance })),
      ...currentGroup.map((seed) => ({ evidence_id: seed.evidence.evidence_id, stance: seed.transport.stance }))
    ];
    const uniqueLinks = [...new Map(links.map((link) => [`${link.evidence_id}:${link.stance}`, link])).values()];
    const confidence = lowestConfidence([
      ...priorGroup.map((record) => record.result.identity_confidence.band),
      ...currentGroup.map((seed) => seed.transport.identity_confidence.band)
    ]);
    const intent: CanonicalResearchMutationIntent = baseProposal.schema === "atlas.fact:v1"
      ? {
          kind: "fact",
          subject_entity_id: baseProposal.subject_entity_id,
          predicate: baseProposal.predicate,
          value: baseProposal.value,
          ...(baseProposal.valid_from ? { valid_from: baseProposal.valid_from } : {}),
          ...(baseProposal.valid_to ? { valid_to: baseProposal.valid_to } : {})
        }
      : {
          kind: "relationship",
          source_entity_id: baseProposal.source_entity_id,
          source_type: baseProposal.source_type,
          target_entity_id: baseProposal.target_entity_id,
          target_type: baseProposal.target_type,
          predicate: baseProposal.predicate,
          valid_from: baseProposal.valid_from,
          ...(baseProposal.valid_to ? { valid_to: baseProposal.valid_to } : {}),
          status: baseProposal.status
        };
    proposalByHash.set(groupKey, proposalPayload(intent, uniqueLinks, confidence, recordedAt));
  }

  const retainedRecords = new Map(priorRecords.map((record) => [record.result.research_result_id, record]));
  const newRecords: CanonicalResearchRecord[] = [];
  const currentByResultId = new Map<string, CanonicalResearchRecord>();
  let replayed = duplicateReplays + priorReplays;
  for (const seed of currentSeeds) {
    const proposal = proposalByHash.get(seed.fingerprint.proposed_mutation_hash)!;
    const resultId = resultIdForSeed(seed);
    const result = CanonicalResearchResultPayloadSchema.parse({
      schema: "atlas.research-result:v1",
      research_result_id: resultId,
      run_id: runId,
      candidate_id: review.candidate_id,
      source_unit_id: parsedUnitId.data,
      algorithm_version: parsedAlgorithmVersion.data,
      normalized_query_hash: normalizedQueryHash,
      connector_kind: parsedConnector.data,
      upstream_identity: seed.transport.upstream_identity,
      independence_key: seed.transport.independence_key,
      evidence_id: seed.evidence.evidence_id,
      evidence_content_hash: seed.evidence.content_hash,
      retrieved_at: seed.transport.retrieved_at,
      stance: seed.transport.stance,
      identity_state: seed.transport.identity_state,
      identity_confidence: {
        band: seed.transport.identity_confidence.band,
        assessment_kind: "identity",
        method: seed.transport.identity_confidence.method,
        assessed_at: recordedAt,
        evidence_refs: [seed.evidence.evidence_id],
        ...(seed.transport.identity_confidence.rationale
          ? { rationale: seed.transport.identity_confidence.rationale }
          : {})
      },
      proposed_object_id: seed.fingerprint.proposed_object_id,
      proposed_mutation_hash: seed.fingerprint.proposed_mutation_hash,
      ...(seed.transport.relationship_basis
        ? { relationship_basis: seed.transport.relationship_basis }
        : {}),
      recorded_at: recordedAt
    });
    const record = { result, evidence: seed.evidence, proposal };
    const duplicate = currentByResultId.get(resultId);
    if (duplicate) {
      if (replaySignature(duplicate) !== replaySignature(record)) {
        rejectedReasons.push("invalid-transport-result");
      } else {
        replayed += 1;
      }
      continue;
    }
    currentByResultId.set(resultId, record);
    const prior = priorByResultId.get(resultId);
    if (prior) {
      if (replaySignature(prior) !== replaySignature(record)) {
        rejectedReasons.push("invalid-transport-result");
        continue;
      }
      retainedRecords.set(resultId, prior);
      replayed += 1;
      continue;
    }
    retainedRecords.set(resultId, record);
    newRecords.push(record);
  }

  const records = [...retainedRecords.values()]
    .sort((left, right) => left.result.research_result_id.localeCompare(right.result.research_result_id));
  const groupSummaries = groupKeys.flatMap((groupKey) => {
    const groupRecords = records.filter((record) => record.result.proposed_mutation_hash === groupKey);
    const proposal = proposalByHash.get(groupKey) ?? groupRecords[0]?.proposal;
    if (!proposal || groupRecords.length === 0) return [];
    const identityState = groupRecords.some((record) => record.result.identity_state === "ambiguous")
      ? "ambiguous" as const
      : "resolved" as const;
    const relationshipBasis = groupRecords.some((record) => record.result.relationship_basis === "inferred-sensitive")
      ? "inferred-sensitive" as const
      : "explicit" as const;
    return [summarizeResearchRecommendation({
      proposal,
      ...canonicalResearchMutationFingerprint(proposal),
      identity_state: identityState,
      ...(proposal.schema === "atlas.relationship:v2" ? { relationship_basis: relationshipBasis } : {}),
      results: groupRecords.map((record) => record.result)
    })];
  });
  const evaluatedRecommendation = overallRecommendation(groupSummaries.map((summary) => summary.recommendation));
  const proposalConflict = groupSummaries.length > 1;
  const rejectedOwnerDecision = rejectedReasons.some((reason) => (
    reason === "contact-detail-prohibited" || reason === "sensitive-relationship"
  ));
  const recommendation = proposalConflict
    || deterministicCollision
    || rejectedOwnerDecision
    || (rejectedReasons.includes("invalid-transport-result") && evaluatedRecommendation === "auto-apply")
    ? "owner-review"
    : evaluatedRecommendation;
  const reasonCodes: CanonicalResearchReasonCode[] = [
    ...groupSummaries.flatMap((summary) => summary.reason_codes),
    ...(proposalConflict ? ["proposal-conflict" as const] : []),
    ...rejectedReasons,
    ...(replayed > 0 ? ["exact-replay" as const] : []),
    ...(groupSummaries.length === 0 && rejectedReasons.length === 0 ? ["insufficient-evidence" as const] : [])
  ];

  const existingEvidenceIds = new Set(priorRecords.map((record) => record.evidence.evidence_id));
  const draftIntents: CanonicalResearchDraftIntent[] = [];
  for (const record of newRecords) {
    if (!existingEvidenceIds.has(record.evidence.evidence_id)) {
      draftIntents.push({ access_class: "local-private", payload: record.evidence });
      existingEvidenceIds.add(record.evidence.evidence_id);
    }
    draftIntents.push({ access_class: "local-private", payload: record.result });
  }
  for (const groupKey of uniqueSorted(newRecords.map((record) => record.result.proposed_mutation_hash))) {
    const proposal = proposalByHash.get(groupKey);
    if (proposal) draftIntents.push({ access_class: "local-private", payload: proposal });
  }
  draftIntents.sort((left, right) => canonicalPayloadObjectId(left.payload).localeCompare(canonicalPayloadObjectId(right.payload))
    || left.payload.schema.localeCompare(right.payload.schema));

  const outputReceipt = receipt({
    runId,
    review,
    sourceUnitId: parsedUnitId.data,
    connector: parsedConnector.data,
    queryHash: normalizedQueryHash,
    recommendation,
    received: rawResults.length,
    appended: newRecords.length,
    replayed,
    rejected: rejectedReasons.length,
    independenceGroupCount: new Set(records.map((record) => record.result.independence_key)).size,
    reasonCodes,
    draftIntents
  });
  return { run_id: runId, recommendation, records, draft_intents: draftIntents, receipt: outputReceipt };
}
