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
import { DerivedNodeOriginSchema, EdgeDerivationSchema } from "./legacy-endpoint.js";

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
 * Provenance for a node the migration MINTED rather than projected.
 *
 * A topic node for `restaurant` exists because forty legacy objects carried that
 * word; a provider organization exists because a hundred segments named it. There
 * is no single legacy object behind either, and handing one of them the
 * provenance of the first contributor — the shortcut that fits the existing
 * schema without changing it — would attach that object's `legacy_version` and
 * `legacy_content_hash` to a node it does not describe. An auditor following
 * those fields would be sent to one arbitrary segment to explain a node shared by
 * all of them.
 *
 * So a minted node says what it actually is: a distinct VALUE, the attribute that
 * carried it, and how many legacy objects named it. The count is an aggregate and
 * never the ids, so this stays a summary rather than a second index of the corpus.
 */
export const DerivedProvenanceSchema = z
  .object({
    derived_from: DerivedNodeOriginSchema,
    legacy_attribute: z.string().min(1),
    /** The distinct value, which is also the minted node's name. */
    legacy_value: z.string().min(1).max(8_192),
    source_object_count: z.number().int().positive()
  })
  .strict();
export type DerivedProvenance = z.infer<typeof DerivedProvenanceSchema>;

/**
 * The two variants are structurally disjoint — neither carries a key the other
 * accepts, and both are strict — so a plain union discriminates cleanly without a
 * tag field that would have to be kept honest by hand.
 */
export const ProjectedProvenanceSchema = z.union([LegacyProvenanceSchema, DerivedProvenanceSchema]);
export type ProjectedProvenance = z.infer<typeof ProjectedProvenanceSchema>;

export function isLegacyObjectProvenance(provenance: ProjectedProvenance): provenance is LegacyProvenance {
  return "legacy_object_id" in provenance;
}

/**
 * The legacy object a record was projected from, or undefined when the migration
 * minted it. Callers that need to group by source object must handle the absence
 * rather than assume one: a minted node belongs to no single source.
 */
export function legacyObjectIdOf(record: { provenance: ProjectedProvenance }): string | undefined {
  return isLegacyObjectProvenance(record.provenance) ? record.provenance.legacy_object_id : undefined;
}

/**
 * Grouping key for anything that must be counted per source, most importantly the
 * per-source `seq` counter in apply. Minted nodes group by the value they were
 * minted for, so two nodes minted from the same attribute value stay one group.
 */
export function provenanceGroupKey(provenance: ProjectedProvenance): string {
  return isLegacyObjectProvenance(provenance)
    ? provenance.legacy_object_id
    : `derived:${provenance.legacy_attribute}=${provenance.legacy_value}`;
}

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
  provenance: ProjectedProvenanceSchema
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
  description: z.string().min(1).max(8_192).optional(),
  /**
   * Endpoint attributes that survived deduplication and belong to THIS node.
   *
   * Deliberately not a passthrough of the legacy payload: an attribute is carried
   * only if the vocabulary still has a place for it, and every attribute that
   * became an edge is absent here. A record that kept both would state one fact
   * twice in two mechanisms, and the two would eventually disagree.
   */
  attrs: z.record(z.string(), z.unknown())
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
  legacy_edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/).optional(),
  /**
   * The legacy attribute this edge was computed from, when no legacy edge exists.
   * A classification that used to be a subtype string has no edge row behind it,
   * so an auditor needs the attribute name to find the fact it came from.
   */
  derivation: EdgeDerivationSchema.optional(),
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
})
  .strict()
  .superRefine((record, ctx) => {
    // Exactly one, never both and never neither. An edge carrying both would
    // claim a source row it did not come from; an edge carrying neither is
    // unauditable, and unauditable edges are what the old importer produced in
    // bulk. Making it a schema rule means no code path can emit one by omission.
    const carried = record.legacy_edge_id !== undefined;
    const derived = record.derivation !== undefined;
    if (carried === derived) {
      ctx.addIssue({
        code: "custom",
        path: ["derivation"],
        message: carried
          ? "a relationship carries a legacy_edge_id or a derivation, never both"
          : "a relationship must name either the legacy edge it came from or the attribute it was derived from"
      });
    }
  });
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

/**
 * One legacy object can become more than one entity — the venue split makes a
 * restaurant into a location AND an organization — so the slot is qualified by an
 * ordinal. Ordinal 0 keeps the original seed EXACTLY, byte for byte, so every
 * object that does not split lands on the slot it already had and a re-plan of an
 * unchanged source produces an unchanged plan.
 */
export function entitySlotForLegacyObject(
  authorityId: string,
  legacyObjectId: string,
  ordinal = 0
): EntitySlot {
  const seed =
    ordinal === 0
      ? `${ProjectorVersion}:${authorityId}:${legacyObjectId}`
      : `${ProjectorVersion}:${authorityId}:${legacyObjectId}:${ordinal}`;
  return `slot_entity_${hex(seed, 24)}`;
}

/**
 * The slot for a node minted from a distinct attribute VALUE rather than from a
 * legacy object. Keyed by the value, which is what makes it shared: every legacy
 * object naming `restaurant` resolves to the same topic slot, so the plan mints
 * one node instead of one per mention.
 */
export function derivedEntitySlot(authorityId: string, attribute: string, value: string): EntitySlot {
  return `slot_entity_${hex(`${ProjectorVersion}:${authorityId}:derived:${attribute}:${value}`, 24)}`;
}

/**
 * Idempotency key for a minted node. It excludes the count of contributing
 * objects on purpose: importing a further batch that names `restaurant` twenty
 * more times must REPLAY the existing topic node, not commit a second one because
 * its population grew.
 */
export function derivedIdempotencyKey(input: {
  authority_id: string;
  attribute: string;
  value: string;
  record_kind: ProjectedRecordKind;
}): MigrationIdempotencyKey {
  const seed = [
    ProjectorVersion,
    input.authority_id,
    "derived",
    input.attribute,
    input.value,
    input.record_kind
  ].join("\n");
  return `la_idem_${hex(seed, 32)}`;
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
