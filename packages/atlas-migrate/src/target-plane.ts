import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AccessClassSchema,
  EdgeStatusSchema,
  EndpointSubtypeSchema,
  EndpointTypeSchema,
  endpointTypeCarriesSubtype,
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
  // Present exactly when the type carries one, which today means `occurrence`
  // alone. Optional-and-unchecked would let a legacy `organization` keep its
  // retired `company` subtype through the projection and land in the canonical
  // plane as a classification nothing in the vocabulary defines.
  entity_subtype: EndpointSubtypeSchema.optional(),
  name: z.string().min(1).max(8_192),
  aliases: z.array(z.string().min(1).max(8_192)),
  description: z.string().min(1).max(8_192).optional()
}).strict().superRefine((record, ctx) => {
  const carries = endpointTypeCarriesSubtype(record.entity_type);
  if (carries && record.entity_subtype === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["entity_subtype"],
      message: `${record.entity_type} carries a subtype and this projection supplies none`
    });
  }
  if (!carries && record.entity_subtype !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["entity_subtype"],
      message: `${record.entity_type} carries no subtype; classify it with a has-type edge to a topic node`
    });
  }
});
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

/**
 * Why a record exists that no legacy object does.
 *
 * The legacy store held a classification as a STRING in a subtype slot. The
 * ratified vocabulary holds it as an edge to a node, so the node has to come
 * from somewhere -- and it does not come from any one legacy object, because
 * every organization that said `airline` is asking for the same node.
 *
 * The basis is recorded rather than left implicit so a reader of the new plane
 * can tell a minted node from an imported one without diffing against the old
 * store. A topic node that looked imported would carry the authority of a thing
 * somebody wrote down, which nobody did.
 */
export const MintedBasisSchema = z
  .object({
    kind: z.literal("retired-subtype-value"),
    /** The legacy value, verbatim after case folding. Never a prettified label. */
    legacy_value: z.string().min(1).max(512)
  })
  .strict();
export type MintedBasis = z.infer<typeof MintedBasisSchema>;

const MintedRecordBaseSchema = z.object({
  idempotency_key: MigrationIdempotencyKeySchema,
  origin: z.literal(MigrationOrigin),
  recorded_at_fidelity: z.literal(MigrationRecordedAtFidelity),
  minted_basis: MintedBasisSchema
});

/**
 * A node this migration creates because the ratified vocabulary needs one and
 * the legacy store had none.
 *
 * It carries NO `provenance`, and that absence is load-bearing: every other
 * projected record can name the legacy object it came from, and this one
 * genuinely cannot. Filling the field with the first contributor's id would
 * make an arbitrary choice look like a recorded fact -- and would make the node
 * disappear from the plane if that one legacy object were ever re-examined.
 */
export const ProjectedMintedEntityRecordSchema = MintedRecordBaseSchema.extend({
  record_kind: z.literal("minted-entity"),
  slot: EntitySlotSchema,
  // Only `topic` is minted today. Left as the full enum because the ratified
  // table also mints organizations for venues, and a literal here would have to
  // be widened by whoever lands that -- at which point the widening is invisible.
  entity_type: EndpointTypeSchema,
  name: z.string().min(1).max(8_192),
  /** How many legacy nodes asked for this one node. Counted, never enumerated. */
  classified_node_count: z.number().int().positive()
}).strict();
export type ProjectedMintedEntityRecord = z.infer<typeof ProjectedMintedEntityRecordSchema>;

/**
 * The `has-type` edge that carries a retired subtype forward.
 *
 * Unlike the minted node, this one HAS a legacy provenance: the classification
 * was written down, on that node, in its subtype slot. What it does not have is
 * a `legacy_edge_id`, because the legacy store never held an edge here -- so the
 * field is absent rather than invented.
 *
 * `valid_from` is `unknown`. A subtype string carried no time, and stamping the
 * import date would assert that the organization became an airline on the day we
 * ran the migration.
 */
export const ProjectedMintedRelationshipRecordSchema = MintedRecordBaseSchema.extend({
  record_kind: z.literal("minted-relationship"),
  provenance: LegacyProvenanceSchema,
  source_slot: EntitySlotSchema,
  source_type: EndpointTypeSchema,
  target_slot: EntitySlotSchema,
  target_type: EndpointTypeSchema,
  predicate: PredicateSchema,
  valid_from: MixedPrecisionDateSchema,
  valid_from_fidelity: WorldTimeFidelitySchema,
  status: EdgeStatusSchema
}).strict();
export type ProjectedMintedRelationshipRecord = z.infer<typeof ProjectedMintedRelationshipRecordSchema>;

export const ProjectedRecordSchema = z.discriminatedUnion("record_kind", [
  ProjectedEntityRecordSchema,
  ProjectedRelationshipRecordSchema,
  ProjectedRetractionRecordSchema,
  ProjectedAbsenceRecordSchema,
  ProjectedMintedEntityRecordSchema,
  ProjectedMintedRelationshipRecordSchema
]);
export type ProjectedRecord = z.infer<typeof ProjectedRecordSchema>;
export type ProjectedRecordKind = ProjectedRecord["record_kind"];

/**
 * Records that name a legacy object. Written as a guard rather than as an
 * inline `"provenance" in record` so the two record kinds that legitimately
 * have no provenance cannot be reached through it by accident.
 */
export function hasLegacyProvenance(
  record: ProjectedRecord
): record is Exclude<ProjectedRecord, ProjectedMintedEntityRecord> {
  return record.record_kind !== "minted-entity";
}

export function isMintedEntityRecord(record: ProjectedRecord): record is ProjectedMintedEntityRecord {
  return record.record_kind === "minted-entity";
}

export function isMintedRelationshipRecord(record: ProjectedRecord): record is ProjectedMintedRelationshipRecord {
  return record.record_kind === "minted-relationship";
}

/**
 * Every record that puts an entity slot into the plane, minted or imported.
 * The closure gate resolves relationship endpoints against this, and a gate that
 * knew only about imported entities would call every `has-type` edge dangling.
 */
export function slotMintedBy(record: ProjectedRecord): EntitySlot | undefined {
  if (record.record_kind === "entity" || record.record_kind === "minted-entity") {
    return record.slot;
  }
  return undefined;
}

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
 * The slot a minted topic occupies, keyed by the VALUE rather than by any
 * legacy object.
 *
 * This is what makes minting idempotent, and it is the one place a content-
 * derived key is correct: the topic node's whole identity IS the word. Two runs
 * over the same corpus, and nine organizations inside one run, all resolve to
 * this slot -- which is the difference between one controlled vocabulary and
 * nine unrelated nodes that happen to share a spelling.
 *
 * The `minted-topic` discriminator is in the seed so a minted slot can never
 * collide with the slot of a legacy object whose id happened to be the value.
 */
export function mintedTopicSlot(authorityId: string, topicValue: string): EntitySlot {
  return `slot_entity_${hex(`${ProjectorVersion}:${authorityId}:minted-topic:${topicValue}`, 24)}`;
}

export function mintedTopicIdempotencyKey(authorityId: string, topicValue: string): MigrationIdempotencyKey {
  return `la_idem_${hex([ProjectorVersion, authorityId, "minted-topic", topicValue].join("\n"), 32)}`;
}

/**
 * One key per (classified node, topic) pair. Keyed by both because a node may
 * legitimately carry several classifications, and keying by the node alone
 * would make the second `has-type` edge look like a replay of the first.
 */
export function mintedClassificationIdempotencyKey(
  authorityId: string,
  legacyObjectId: string,
  topicValue: string
): MigrationIdempotencyKey {
  return `la_idem_${hex(
    [ProjectorVersion, authorityId, "minted-classification", legacyObjectId, topicValue].join("\n"),
    32
  )}`;
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
