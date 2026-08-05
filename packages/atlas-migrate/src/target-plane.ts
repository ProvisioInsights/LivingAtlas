import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AccessClassSchema,
  EdgeStatusSchema,
  EndpointSubtypeSchema,
  EndpointTypeSchema,
  IsoTimestampSchema,
  MixedPrecisionDateSchema,
  ObjectIdSchema,
  ObjectTypeSchema,
  PredicateSchema,
  Sha256HashSchema
} from "@living-atlas/contracts";

/**
 * Every assertion produced by this projector carries the same origin. A legacy
 * object predates the assertion contract entirely: nobody ever chose a belief
 * time for it, nobody attached evidence to it. Stamping the origin on the record
 * keeps a reader from later mistaking an import artifact for a curated claim —
 * the old store's central defect was that imported rows and authored rows were
 * indistinguishable once they landed in the same table.
 */
export const MigrationOrigin = "pre-contract-import" as const;

/**
 * recorded_at on an imported record is the time WE committed it, not the time the
 * belief was recorded in the world. The fidelity flag says so out loud so query
 * layers can widen or exclude imported rows instead of silently treating the
 * import timestamp as system time of record.
 */
export const MigrationRecordedAtFidelity = "import-artifact" as const;

export const ProjectorVersion = "atlas-migrate-projection:v1" as const;

/**
 * Idempotency keys are deterministic per source object so a re-run of apply
 * finds the original receipt instead of committing a second copy.
 */
export const MigrationIdempotencyKeySchema = z.string().regex(/^la_idem_[a-f0-9]{32}$/);
export type MigrationIdempotencyKey = z.infer<typeof MigrationIdempotencyKeySchema>;

/**
 * A slot is a PLAN-LOCAL placeholder for an entity, never an identity. Ids are
 * minted by the entity registry at commit; deriving an id from source content
 * would make the id a content hash, and two legacy objects that happened to
 * describe the same thing would silently collapse into one entity with no
 * resolution decision behind it. The plan therefore names slots, and the alias
 * ledger records which minted id each slot became.
 */
export const EntitySlotSchema = z.string().regex(/^slot_entity_[a-f0-9]{24}$/);
export type EntitySlot = z.infer<typeof EntitySlotSchema>;

/**
 * Legacy created_at/updated_at are provenance about the OLD store's bookkeeping.
 * They are not belief time and not system time of record in the new plane, so
 * they live in a provenance envelope that no query path treats as a time axis.
 */
export const LegacyProvenanceSchema = z
  .object({
    legacy_object_id: ObjectIdSchema,
    legacy_object_type: ObjectTypeSchema,
    legacy_version: z.number().int().nonnegative(),
    legacy_content_hash: Sha256HashSchema,
    legacy_access_class: AccessClassSchema,
    legacy_tombstone: z.boolean(),
    legacy_created_at: IsoTimestampSchema,
    legacy_updated_at: IsoTimestampSchema
  })
  .strict();
export type LegacyProvenance = z.infer<typeof LegacyProvenanceSchema>;

/**
 * World time carried across from a legacy edge is reported at the fidelity the
 * legacy value actually had. "unknown" is not a wildcard: a record whose world
 * time is unknown matches no interval query, and an approximate value must widen
 * rather than pretend to be a day.
 */
export const WorldTimeFidelitySchema = z.enum(["exact", "approximate", "unknown"]);
export type WorldTimeFidelity = z.infer<typeof WorldTimeFidelitySchema>;

export function worldTimeFidelity(value: string | undefined): WorldTimeFidelity {
  if (value === undefined || value === "unknown") {
    return "unknown";
  }
  return value.startsWith("~") ? "approximate" : "exact";
}

const ProjectedRecordBaseSchema = z.object({
  idempotency_key: MigrationIdempotencyKeySchema,
  origin: z.literal(MigrationOrigin),
  recorded_at_fidelity: z.literal(MigrationRecordedAtFidelity),
  provenance: LegacyProvenanceSchema
});

export const ProjectedEntityRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("entity"),
  slot: EntitySlotSchema,
  entity_type: EndpointTypeSchema,
  entity_subtype: EndpointSubtypeSchema,
  name: z.string().min(1).max(8_192),
  aliases: z.array(z.string().min(1).max(8_192)),
  description: z.string().min(1).max(8_192).optional()
}).strict();
export type ProjectedEntityRecord = z.infer<typeof ProjectedEntityRecordSchema>;

export const ProjectedRelationshipRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("relationship"),
  legacy_edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
  source_slot: EntitySlotSchema,
  source_type: EndpointTypeSchema,
  target_slot: EntitySlotSchema,
  target_type: EndpointTypeSchema,
  predicate: PredicateSchema,
  valid_from: MixedPrecisionDateSchema,
  valid_to: MixedPrecisionDateSchema.optional(),
  valid_from_fidelity: WorldTimeFidelitySchema,
  valid_to_fidelity: WorldTimeFidelitySchema,
  status: EdgeStatusSchema,
  attrs: z.record(z.string(), z.unknown())
}).strict();
export type ProjectedRelationshipRecord = z.infer<typeof ProjectedRelationshipRecordSchema>;

/**
 * A legacy tombstone that we can still read is projected as the pre-deletion
 * record PLUS a retraction of it. Dropping the pair and importing nothing would
 * turn a recorded deletion into an absence of history, which is the one thing an
 * append-only plane must never do.
 */
export const ProjectedRetractionRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("retraction"),
  retracts_idempotency_key: MigrationIdempotencyKeySchema,
  retraction_basis: z.literal("legacy-tombstone")
}).strict();
export type ProjectedRetractionRecord = z.infer<typeof ProjectedRetractionRecordSchema>;

export const AbsenceKindSchema = z.enum(["unrecoverable-ciphertext", "redaction-stub"]);
export type AbsenceKind = z.infer<typeof AbsenceKindSchema>;

/**
 * An absence record reports that an object existed and did not come across. It
 * never invents the content it could not carry. "Unrecoverable" and "withheld"
 * are different facts about the same hole and are kept apart: one is data loss
 * to repair, the other is a policy decision to review.
 */
export const ProjectedAbsenceRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("absence"),
  absence_kind: AbsenceKindSchema,
  detail: z.string().min(1).max(512)
}).strict();
export type ProjectedAbsenceRecord = z.infer<typeof ProjectedAbsenceRecordSchema>;

export const ProjectedRecordSchema = z.discriminatedUnion("record_kind", [
  ProjectedEntityRecordSchema,
  ProjectedRelationshipRecordSchema,
  ProjectedRetractionRecordSchema,
  ProjectedAbsenceRecordSchema
]);
export type ProjectedRecord = z.infer<typeof ProjectedRecordSchema>;
export type ProjectedRecordKind = ProjectedRecord["record_kind"];

/**
 * Record kinds that would express an identity JUDGEMENT rather than a mechanical
 * redirect. A mechanical migration must never write one: deciding that two
 * legacy ids are the same entity is a resolution decision that needs evidence,
 * and the old importer's habit of quietly merging on title match is exactly the
 * failure the alias ledger replaces.
 */
export const ResolutionBearingRecordKinds = new Set<string>(["entity-resolution"]);

export function isEntityRecord(record: ProjectedRecord): record is ProjectedEntityRecord {
  return record.record_kind === "entity";
}

export function isRelationshipRecord(record: ProjectedRecord): record is ProjectedRelationshipRecord {
  return record.record_kind === "relationship";
}

export function isRetractionRecord(record: ProjectedRecord): record is ProjectedRetractionRecord {
  return record.record_kind === "retraction";
}

function hex(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function entitySlotForLegacyObject(authorityId: string, legacyObjectId: string): EntitySlot {
  return `slot_entity_${hex(`${ProjectorVersion}:${authorityId}:${legacyObjectId}`, 24)}`;
}

/**
 * The key deliberately excludes the legacy version. A replica re-read at a later
 * version must land on the SAME key, otherwise re-projecting a source that moved
 * would mint a second entity for one legacy object — the duplicate-on-reimport
 * defect the alias ledger exists to prevent. The version is kept in provenance,
 * where it is evidence rather than identity.
 */
export function projectionIdempotencyKey(input: {
  authority_id: string;
  legacy_object_id: string;
  record_kind: ProjectedRecordKind;
  ordinal: number;
}): MigrationIdempotencyKey {
  const seed = [
    ProjectorVersion,
    input.authority_id,
    input.legacy_object_id,
    input.record_kind,
    String(input.ordinal)
  ].join("\n");
  return `la_idem_${hex(seed, 32)}`;
}

/**
 * Key order must not change the digest. A consumer that round-trips a plan
 * through its own serializer would otherwise get a different hash for identical
 * content, and a review anchor that drifts for cosmetic reasons is one people
 * learn to ignore.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * An integrity anchor for review, not an unforgeable seal: it catches a plan that
 * drifted between the dry run and the commit, which is the mistake that actually
 * happens when a plan file is edited by hand to "just fix one thing".
 */
export function canonicalDigest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}
