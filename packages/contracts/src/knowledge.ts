import { z } from "zod";
import { AccessClassSchema, ObjectTypeSchema, type ObjectType } from "./classification";
import {
  AuthorityIdSchema,
  IsoTimestampSchema,
  ObjectIdSchema,
  Sha256HashSchema
} from "./ids";
import {
  EdgeStatusSchema,
  EndpointTypeSchema,
  ItemSubtypeSchema,
  LocationSubtypeSchema,
  MixedPrecisionDateSchema,
  OccurrenceSubtypeSchema,
  OfferingSubtypeSchema,
  OrganizationSubtypeSchema,
  PersonSubtypeSchema,
  PredicateSchema,
  ProjectSubtypeSchema,
  TopicSubtypeSchema,
  TemporalEdgeSchema
} from "./temporal";

const CanonicalSchemaNamespace = "atlas";
const AssertionIdSchema = ObjectIdSchema;
const BoundedTextSchema = z.string().min(1).max(8_192);
const BoundedIdentifierSchema = z.string().min(1).max(512);
const CandidateIdSchema = z.string().regex(/^la_candidate_[A-Za-z0-9_-]{8,}$/);
const CoverageKeySchema = z.string().regex(/^la_coverage_[A-Za-z0-9_-]{8,}$/);
const IdempotencyKeySchema = z.string().regex(/^la_idem_[A-Za-z0-9_-]{8,}$/);

const CanonicalEntityBaseSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.entity:v1`),
  entity_id: ObjectIdSchema,
  name: BoundedTextSchema,
  aliases: z.array(BoundedTextSchema).default([]),
  description: BoundedTextSchema.optional(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema
}).strict();

export const CanonicalEntityPayloadSchema = z.discriminatedUnion("type", [
  CanonicalEntityBaseSchema.extend({ type: z.literal("person"), subtype: PersonSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("organization"), subtype: OrganizationSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("project"), subtype: ProjectSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("location"), subtype: LocationSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("occurrence"), subtype: OccurrenceSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("topic"), subtype: TopicSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("offering"), subtype: OfferingSubtypeSchema }),
  CanonicalEntityBaseSchema.extend({ type: z.literal("item"), subtype: ItemSubtypeSchema })
]);
export type CanonicalEntityPayload = z.infer<typeof CanonicalEntityPayloadSchema>;

export const FactPredicateRegistry = {
  name: ["text"],
  alias: ["text"],
  description: ["text"],
  status: ["text"],
  homepage: ["uri"],
  "founded-on": ["date"],
  "acquired-on": ["date"],
  identifier: ["text"]
} as const;

export type FactPredicate = keyof typeof FactPredicateRegistry;
export const FactPredicateSchema = z.enum(Object.keys(FactPredicateRegistry) as [FactPredicate, ...FactPredicate[]]);

export const FactValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: BoundedTextSchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
  z.object({ kind: z.literal("date"), value: MixedPrecisionDateSchema }).strict(),
  z.object({ kind: z.literal("timestamp"), value: IsoTimestampSchema }).strict(),
  z.object({ kind: z.literal("uri"), value: z.string().url().max(2_048) }).strict(),
  z.object({ kind: z.literal("entity-ref"), entity_id: ObjectIdSchema }).strict(),
  z.object({ kind: z.literal("quantity"), amount: z.number().finite(), unit: BoundedIdentifierSchema }).strict()
]);
export type FactValue = z.infer<typeof FactValueSchema>;

export type CanonicalWorldTimeInterval = {
  lower: string;
  upper: string;
  approximate: boolean;
};

export function canonicalWorldTimeInterval(value: string): CanonicalWorldTimeInterval | undefined {
  const parsed = MixedPrecisionDateSchema.parse(value);
  if (parsed === "unknown") {
    return undefined;
  }

  const approximate = parsed.startsWith("~");
  const normalized = approximate ? parsed.slice(1) : parsed;
  if (/^\d{4}$/.test(normalized)) {
    const year = Number(normalized);
    return {
      lower: `${normalized}-01-01`,
      upper: `${year + 1}-01-01`,
      approximate
    };
  }

  if (/^\d{4}-\d{2}$/.test(normalized)) {
    const [yearText, monthText] = normalized.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const [nextYear, nextMonth] = month === 12 ? [year + 1, 1] : [year, month + 1];
    return {
      lower: `${normalized}-01`,
      upper: `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`,
      approximate
    };
  }

  const date = new Date(`${normalized}T00:00:00.000Z`);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    lower: normalized,
    upper: next.toISOString().slice(0, 10),
    approximate
  };
}

export function canonicalIntervalsOverlap(left: CanonicalWorldTimeInterval, right: CanonicalWorldTimeInterval): boolean {
  return left.lower < right.upper && right.lower < left.upper;
}

function validateCanonicalValidInterval(
  interval: { valid_from?: string; valid_to?: string },
  ctx: z.RefinementCtx
): void {
  if (!interval.valid_from || !interval.valid_to) {
    return;
  }
  const from = canonicalWorldTimeInterval(interval.valid_from);
  const to = canonicalWorldTimeInterval(interval.valid_to);
  if (from && to && from.lower >= to.lower) {
    ctx.addIssue({
      code: "custom",
      path: ["valid_to"],
      message: "valid_to must end after valid_from in a half-open interval"
    });
  }
}

export const AssertionLineageActionSchema = z.enum([
  "assert",
  "correct",
  "retract",
  "invalidate",
  "reinstate"
]);
export type AssertionLineageAction = z.infer<typeof AssertionLineageActionSchema>;

export const EvidenceStanceSchema = z.enum(["supports", "refutes", "context"]);
export const AssertionEvidenceLinkSchema = z.object({
  evidence_id: ObjectIdSchema,
  stance: EvidenceStanceSchema
}).strict();
export type AssertionEvidenceLink = z.infer<typeof AssertionEvidenceLinkSchema>;

export const ConfidenceAssessmentSchema = z.object({
  band: z.enum(["high", "medium", "low"]),
  assessment_kind: z.enum(["extraction", "identity", "source-reliability", "assertion"]),
  method: BoundedIdentifierSchema,
  assessed_at: IsoTimestampSchema,
  assessor: BoundedIdentifierSchema.optional(),
  evidence_refs: z.array(ObjectIdSchema).min(1),
  rationale: BoundedTextSchema.optional()
}).strict();
export type ConfidenceAssessment = z.infer<typeof ConfidenceAssessmentSchema>;

function validateAssertionLineage(
  lineage: { lineage_action: AssertionLineageAction; supersedes: string[] },
  ctx: z.RefinementCtx
): void {
  if (lineage.lineage_action !== "assert" && lineage.supersedes.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["supersedes"],
      message: "non-assert lineage actions must supersede one or more assertions"
    });
  }
}

const AssertionLineageSchema = z.object({
  recorded_at: IsoTimestampSchema,
  lineage_action: AssertionLineageActionSchema,
  supersedes: z.array(AssertionIdSchema).default([]),
  evidence_links: z.array(AssertionEvidenceLinkSchema).min(1),
  confidence: ConfidenceAssessmentSchema
}).strict();

export const CanonicalFactPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.fact:v1`),
  assertion_id: AssertionIdSchema,
  subject_entity_id: ObjectIdSchema,
  predicate: FactPredicateSchema,
  value: FactValueSchema,
  valid_from: MixedPrecisionDateSchema.optional(),
  valid_to: MixedPrecisionDateSchema.optional(),
  ...AssertionLineageSchema.shape
}).strict().superRefine((fact, ctx) => {
  validateAssertionLineage(fact, ctx);
  validateCanonicalValidInterval(fact, ctx);
  const allowedKinds = FactPredicateRegistry[fact.predicate];
  if (!(allowedKinds as readonly string[]).includes(fact.value.kind)) {
    ctx.addIssue({
      code: "custom",
      path: ["value", "kind"],
      message: `${fact.predicate} does not accept ${fact.value.kind} values`
    });
  }
});
export type CanonicalFactPayload = z.infer<typeof CanonicalFactPayloadSchema>;

export const ObservationResolutionStateSchema = z.enum(["research", "owner-review", "deferred-unknown"]);
export const CanonicalObservationPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.observation:v1`),
  assertion_id: AssertionIdSchema,
  statement: BoundedTextSchema,
  candidate_entity_ids: z.array(ObjectIdSchema).default([]),
  resolution_state: ObservationResolutionStateSchema,
  recorded_at: IsoTimestampSchema,
  evidence_refs: z.array(ObjectIdSchema).min(1)
}).strict();
export type CanonicalObservationPayload = z.infer<typeof CanonicalObservationPayloadSchema>;

export const CanonicalRelationshipPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.relationship:v2`),
  assertion_id: AssertionIdSchema,
  edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
  source_entity_id: ObjectIdSchema,
  source_type: EndpointTypeSchema,
  target_entity_id: ObjectIdSchema,
  target_type: EndpointTypeSchema,
  predicate: PredicateSchema,
  valid_from: MixedPrecisionDateSchema,
  valid_to: MixedPrecisionDateSchema.optional(),
  status: EdgeStatusSchema.default("active"),
  attrs: z.record(z.string(), z.unknown()).default({}),
  ...AssertionLineageSchema.shape
}).strict().superRefine((relationship, ctx) => {
  validateAssertionLineage(relationship, ctx);
  validateCanonicalValidInterval(relationship, ctx);
  const temporalEdge = TemporalEdgeSchema.safeParse({
    edge_id: relationship.edge_id,
    source_object_id: relationship.source_entity_id,
    source_type: relationship.source_type,
    target_object_id: relationship.target_entity_id,
    target_type: relationship.target_type,
    predicate: relationship.predicate,
    valid_from: relationship.valid_from,
    ...(relationship.valid_to ? { valid_to: relationship.valid_to } : {}),
    status: relationship.status,
    confidence: relationship.confidence.band,
    source: "canonical",
    attrs: relationship.attrs
  });

  if (!temporalEdge.success) {
    for (const issue of temporalEdge.error.issues) {
      ctx.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message
      });
    }
  }
});
export type CanonicalRelationshipPayload = z.infer<typeof CanonicalRelationshipPayloadSchema>;

export const CanonicalEvidencePayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.evidence:v1`),
  evidence_id: ObjectIdSchema,
  source_kind: z.enum(["migration", "public-web", "linkedin", "connector", "manual", "other"]),
  locator: BoundedTextSchema,
  content_hash: Sha256HashSchema,
  observed_at: IsoTimestampSchema.optional(),
  published_at: IsoTimestampSchema.optional(),
  retrieved_at: IsoTimestampSchema,
  publisher: BoundedIdentifierSchema.optional(),
  independence_key: BoundedIdentifierSchema,
  excerpt: z.string().min(1).max(4_096).optional(),
  snapshot_ref: ObjectIdSchema.optional(),
  extraction_method: BoundedIdentifierSchema.optional()
}).strict().superRefine((evidence, ctx) => {
  if (!evidence.excerpt && !evidence.snapshot_ref) {
    ctx.addIssue({
      code: "custom",
      path: ["excerpt"],
      message: "evidence must include a bounded excerpt or encrypted snapshot reference"
    });
  }
});
export type CanonicalEvidencePayload = z.infer<typeof CanonicalEvidencePayloadSchema>;

export const EntityResolutionDecisionSchema = z.enum(["link", "merge", "split", "defer", "reject"]);
export const CanonicalEntityResolutionPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.entity-resolution:v1`),
  resolution_id: ObjectIdSchema,
  observed_identifiers: z.array(BoundedIdentifierSchema).min(1),
  candidate_entity_ids: z.array(ObjectIdSchema).min(1),
  decision: EntityResolutionDecisionSchema,
  canonical_entity_id: ObjectIdSchema.optional(),
  evidence_refs: z.array(ObjectIdSchema).min(1),
  confidence: ConfidenceAssessmentSchema,
  recorded_at: IsoTimestampSchema,
  supersedes: z.array(ObjectIdSchema).default([])
}).strict().superRefine((resolution, ctx) => {
  if ((resolution.decision === "link" || resolution.decision === "merge") && !resolution.canonical_entity_id) {
    ctx.addIssue({
      code: "custom",
      path: ["canonical_entity_id"],
      message: `${resolution.decision} decisions require a canonical entity id`
    });
  }
  if ((resolution.decision === "link" || resolution.decision === "merge")
    && resolution.canonical_entity_id
    && !resolution.candidate_entity_ids.includes(resolution.canonical_entity_id)) {
    ctx.addIssue({
      code: "custom",
      path: ["canonical_entity_id"],
      message: `${resolution.decision} canonical entity id must be one of the candidates`
    });
  }
  if (resolution.decision === "split" && resolution.supersedes.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["supersedes"],
      message: "split decisions must supersede one or more prior resolutions"
    });
  }
});
export type CanonicalEntityResolutionPayload = z.infer<typeof CanonicalEntityResolutionPayloadSchema>;

export const ReviewRecommendationSchema = z.enum(["auto-apply", "research", "owner-review"]);
export const ReviewResolutionStateSchema = z.enum([
  "pending",
  "auto-applied",
  "resolved",
  "research",
  "owner-review",
  "deferred-unknown"
]);
export const CanonicalReviewItemPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.review-item:v1`),
  review_id: ObjectIdSchema,
  candidate_id: CandidateIdSchema,
  source_coverage_keys: z.array(CoverageKeySchema).min(1),
  recommendation: ReviewRecommendationSchema,
  resolution_state: ReviewResolutionStateSchema,
  proposed_object_ids: z.array(ObjectIdSchema).default([]),
  research_requested_at: IsoTimestampSchema.optional(),
  research_requested_all: z.boolean().optional(),
  research_requested_unit_hashes: z.array(Sha256HashSchema).optional(),
  recorded_at: IsoTimestampSchema
}).strict();
export type CanonicalReviewItemPayload = z.infer<typeof CanonicalReviewItemPayloadSchema>;

export const ParityCoverageStateSchema = z.enum(["unrepresented", "represented"]);
export const ParityRepresentationKindSchema = z.enum(["fact", "relationship", "occurrence", "observation"]);
export const CanonicalParityRecordPayloadSchema = z.object({
  schema: z.literal(`${CanonicalSchemaNamespace}.parity-record:v1`),
  parity_id: ObjectIdSchema,
  source_coverage_key: CoverageKeySchema,
  coverage_state: ParityCoverageStateSchema,
  representation_kind: ParityRepresentationKindSchema.optional(),
  canonical_object_ids: z.array(ObjectIdSchema).default([]),
  idempotency_key: IdempotencyKeySchema,
  recorded_at: IsoTimestampSchema
}).strict().superRefine((record, ctx) => {
  if (record.coverage_state === "represented" && record.canonical_object_ids.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["canonical_object_ids"],
      message: "represented coverage requires canonical object ids"
    });
  }
  if (record.coverage_state === "represented" && !record.representation_kind) {
    ctx.addIssue({
      code: "custom",
      path: ["representation_kind"],
      message: "represented coverage requires a representation kind"
    });
  }
  if (record.coverage_state === "unrepresented" && record.canonical_object_ids.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["canonical_object_ids"],
      message: "unrepresented coverage cannot name canonical objects"
    });
  }
});
export type CanonicalParityRecordPayload = z.infer<typeof CanonicalParityRecordPayloadSchema>;

export const CanonicalPayloadSchema = z.union([
  CanonicalEntityPayloadSchema,
  CanonicalFactPayloadSchema,
  CanonicalObservationPayloadSchema,
  CanonicalRelationshipPayloadSchema,
  CanonicalEvidencePayloadSchema,
  CanonicalEntityResolutionPayloadSchema,
  CanonicalReviewItemPayloadSchema,
  CanonicalParityRecordPayloadSchema
]);
export type CanonicalPayload = z.infer<typeof CanonicalPayloadSchema>;

type CanonicalObjectType = Extract<ObjectType, "entity" | "assertion" | "edge" | "evidence" | "review" | "manifest">;

export function canonicalObjectTypeForPayload(payload: CanonicalPayload): CanonicalObjectType {
  switch (payload.schema) {
    case "atlas.entity:v1":
      return "entity";
    case "atlas.fact:v1":
    case "atlas.observation:v1":
      return "assertion";
    case "atlas.relationship:v2":
      return "edge";
    case "atlas.evidence:v1":
      return "evidence";
    case "atlas.entity-resolution:v1":
    case "atlas.review-item:v1":
      return "review";
    case "atlas.parity-record:v1":
      return "manifest";
  }
}

export const CanonicalWriteSchema = z.object({
  object_type: ObjectTypeSchema.optional(),
  payload: CanonicalPayloadSchema
}).strict().superRefine((write, ctx) => {
  const expectedObjectType = canonicalObjectTypeForPayload(write.payload);
  if (write.object_type && write.object_type !== expectedObjectType) {
    ctx.addIssue({
      code: "custom",
      path: ["object_type"],
      message: `${write.payload.schema} must use ${expectedObjectType} object_type`
    });
  }
}).transform((write) => ({
  object_type: canonicalObjectTypeForPayload(write.payload),
  payload: write.payload
}));
export type CanonicalWrite = z.infer<typeof CanonicalWriteSchema>;

export function canonicalPayloadObjectId(payload: CanonicalPayload): string {
  switch (payload.schema) {
    case "atlas.entity:v1":
      return payload.entity_id;
    case "atlas.fact:v1":
    case "atlas.observation:v1":
    case "atlas.relationship:v2":
      return payload.assertion_id;
    case "atlas.evidence:v1":
      return payload.evidence_id;
    case "atlas.entity-resolution:v1":
      return payload.resolution_id;
    case "atlas.review-item:v1":
      return payload.review_id;
    case "atlas.parity-record:v1":
      return payload.parity_id;
  }
}

export const CanonicalExportRecordSchema = z.object({
  authority_id: AuthorityIdSchema,
  object_id: ObjectIdSchema,
  object_type: ObjectTypeSchema,
  version: z.number().int().nonnegative(),
  access_class: AccessClassSchema,
  content_hash: Sha256HashSchema,
  payload: CanonicalPayloadSchema
}).strict().superRefine((record, ctx) => {
  const expectedObjectType = canonicalObjectTypeForPayload(record.payload);
  if (record.object_type !== expectedObjectType) {
    ctx.addIssue({
      code: "custom",
      path: ["object_type"],
      message: `${record.payload.schema} must export as ${expectedObjectType}`
    });
  }
  if (record.object_id !== canonicalPayloadObjectId(record.payload)) {
    ctx.addIssue({
      code: "custom",
      path: ["object_id"],
      message: "canonical export object_id must match its payload id"
    });
  }
});
export type CanonicalExportRecord = z.infer<typeof CanonicalExportRecordSchema>;

export const CanonicalExportSchema = z.object({
  export_schema: z.literal("living-atlas-canonical-export:v1"),
  plaintext_policy: z.literal("local-keyholding-canonical-export"),
  authority_id: AuthorityIdSchema,
  exported_at: IsoTimestampSchema,
  records: z.array(CanonicalExportRecordSchema)
}).strict().superRefine((exported, ctx) => {
  for (const [index, record] of exported.records.entries()) {
    if (record.authority_id !== exported.authority_id) {
      ctx.addIssue({
        code: "custom",
        path: ["records", index, "authority_id"],
        message: "canonical export records must share the export authority"
      });
    }
  }
});
export type CanonicalExport = z.infer<typeof CanonicalExportSchema>;

export function parseCanonicalExport(input: unknown): CanonicalExport {
  return CanonicalExportSchema.parse(input);
}
