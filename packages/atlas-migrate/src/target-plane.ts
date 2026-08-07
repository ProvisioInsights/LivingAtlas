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

/**
 * THE CONCEPT SCHEME A TOPIC NODE BELONGS TO.
 *
 * ADR 0023 says the topic node set IS Atlas's concept scheme, citing SKOS — but
 * SKOS is not one flat scheme. `skos:ConceptScheme` exists precisely so two
 * concepts can carry the same label without being duplicates: label uniqueness
 * is scoped PER SCHEME, never globally. Three schemes were being flattened into
 * one namespace here, and the label clash that follows from flattening them was
 * then read as a defect.
 *
 * A person IS an investor and a firm IS an investment firm. One word, two
 * concepts, two subjects of two different kinds of statement. Merging them would
 * force one word onto two things; keeping them apart with no way to say WHY they
 * differ leaves a duplicate nobody can distinguish from a real one. The scheme is
 * what says why.
 *
 * DERIVED FROM THE PRODUCING MECHANISM, never hand-authored. Each value below is
 * a function of which code path created the node, so the scheme cannot drift from
 * the vocabulary it names:
 *
 *   - `subject-matter` — a `topic` node the CORPUS holds. What `about` edges
 *     point at, and the owner's own vocabulary.
 *   - `occupation` — derived from a person's `job_title`.
 *   - `entity-kind` — minted from a retired subtype value. What `has-type`
 *     points at.
 *
 * CLOSED, with the reserved `other` this codebase gives every closed enum — and
 * the closure gate refuses to certify a topic that carries it. A fourth
 * mechanism that starts producing topics lands in `other` and fails, which is
 * the point: the alternative is an open string, where a new mechanism silently
 * invents a scheme and its labels stop colliding with anything. A vocabulary
 * whose schemes can be coined at the call site is not a controlled vocabulary.
 */
export const TopicSchemeValues = ["subject-matter", "occupation", "entity-kind", "other"] as const;
export const TopicSchemeSchema = z.enum(TopicSchemeValues);
export type TopicScheme = z.infer<typeof TopicSchemeSchema>;

const ProjectedRecordBaseSchema = z.object({
  idempotency_key: MigrationIdempotencyKeySchema,
  origin: z.literal(MigrationOrigin),
  recorded_at_fidelity: z.literal(MigrationRecordedAtFidelity),
  provenance: ProjectedProvenanceSchema
});

/**
 * One rule, applied to both record kinds that can carry a topic. Written once
 * because the two schemas are edited by different lanes and a rule stated twice
 * is a rule that ends up stated differently.
 */
function addTopicSchemeIssues(
  record: { entity_type: string; topic_scheme?: TopicScheme },
  ctx: z.RefinementCtx
): void {
  const isTopic = record.entity_type === "topic";
  if (isTopic && record.topic_scheme === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["topic_scheme"],
      message: "a topic node must name the concept scheme it belongs to; label uniqueness is scoped per scheme"
    });
  }
  if (!isTopic && record.topic_scheme !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["topic_scheme"],
      message: `${record.entity_type} is not a topic and belongs to no concept scheme`
    });
  }
}

export const ProjectedEntityRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("entity"),
  slot: EntitySlotSchema,
  entity_type: EndpointTypeSchema,
  // Present exactly when the type carries one, which today means `occurrence`
  // alone. Optional-and-unchecked would let a legacy `organization` keep its
  // retired `company` subtype through the projection and land in the canonical
  // plane as a classification nothing in the vocabulary defines.
  entity_subtype: EndpointSubtypeSchema.optional(),
  /**
   * Present exactly when the record IS a topic, checked below for the same
   * reason `entity_subtype` is: a scheme on a non-topic would name a vocabulary
   * that has no members of that type, and a topic without one is a concept in no
   * scheme — which is the flat namespace this field exists to end.
   */
  topic_scheme: TopicSchemeSchema.optional(),
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
  addTopicSchemeIssues(record, ctx);
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

/**
 * A ceiling, not a length rule. It sits an order of magnitude above the longest
 * block the shape measurement found, so on the corpus this was written for it
 * never fires; it exists so one pathological object cannot make the plan
 * unreviewable. A block over it is REFUSED by name and stays readable in the
 * frozen replica — the one thing this must never do is truncate, because a
 * truncated block is the only outcome that is both lossy and silent.
 */
const ProvisionalBlockTextMax = 65_536;

/**
 * A LOGSEQ OUTLINE BLOCK, CARRIED VERBATIM.
 *
 * Every key is the source's own key, spelled exactly as the legacy payload
 * spells it, so a later modelling pass diffs this against the frozen replica
 * without a mapping table in between. Renaming even one of them would make
 * "carried verbatim" a claim somebody has to verify by reading code.
 *
 * STRICT, and that is the lossless property made mechanical. A passthrough
 * would carry unmeasured keys too and read as MORE lossless, but it would also
 * mean the schema had stopped describing what the store holds — and the point of
 * carrying these now is that a later pass inherits something it can enumerate.
 * A payload that does not fit is refused as `unmeasured-block-shape`, counted,
 * and left readable in the frozen replica.
 *
 * `properties` is the one optional key. Logseq blocks routinely carry none, and
 * whether the importer materialised an empty map or omitted the key is not
 * something this lane measured; requiring it would refuse a large population for
 * a difference nobody has looked at. Absent in stays absent out — the record is
 * the payload, not a normalisation of it. OPEN in ADR 0029.
 *
 * `text` may be EMPTY. An empty bullet is a real node of the outline, and
 * `index` and `depth` only describe a tree if every node of it is present.
 */
export const ProvisionalBlockPayloadSchema = z
  .object({
    /** The importer's own discriminator, carried because verbatim means verbatim. */
    kind: z.string().min(1).max(512),
    source_path_ref: z.string().min(1).max(4_096),
    source_block_ref: z.string().min(1).max(4_096),
    /** Position among siblings. Zero is a real position, never an absence. */
    index: z.number().int().nonnegative(),
    /** Outline nesting. Zero is the top level, never an absence. */
    depth: z.number().int().nonnegative(),
    text: z.string().max(ProvisionalBlockTextMax),
    /**
     * MEASURED as an array of {key, value} string pairs — not a record. The
     * first rehearsal against a real corpus refused every one of its blocks as
     * `unmeasured-block-shape` because this field was written from a prose
     * description ("Logseq key:: value pairs") instead of a measurement: the
     * describer meant the concept and the schema heard an object. Empty for the
     * overwhelming majority of blocks, which is still a real, present value —
     * an importer that always writes the key is telling us the field exists.
     */
    properties: z.array(
      z
        .object({
          key: z.string().min(1).max(512),
          value: z.string().max(ProvisionalBlockTextMax)
        })
        .strict()
    )
  })
  .strict();
export type ProvisionalBlockPayload = z.infer<typeof ProvisionalBlockPayloadSchema>;

/**
 * A record the migration carries WITHOUT modelling it (ADR 0029).
 *
 * The owner chose to move the blocks now and decide their modelling later,
 * having been told the risk in as many words: an unmodelled record type tends to
 * stay unmodelled. So the deferral is structural rather than a promise —
 *
 *   - nothing is lost: every measured key is here, verbatim, under its own name;
 *   - nothing is published: this kind is declared in the migration package and
 *     appears in no released contract revision, because a shape published by
 *     accident is frozen by accident and released revisions cannot be edited;
 *   - nothing is silent: `UnmodelledRecordKinds` drives a count in the plan
 *     breakdown, a section in the plan report printed at zero, and a closure-gate
 *     finding on every run that carries one.
 *
 * It carries a full `LegacyProvenance` like every imported record, so the block
 * is traceable to the object it came from and the apply path counts its `seq`
 * within that object with no special case.
 *
 * IT NAMES NO ENTITY. The Logseq importer derived endpoints from blocks and
 * never stored the link, so there is no recorded edge from a block to the node
 * it produced. A field for one would have to be filled by inference — a content
 * hash, a title match — and inventing the link is exactly the identity decision
 * this migration is built not to make. The absence is the honest state.
 */
export const ProjectedProvisionalBlockRecordSchema = ProjectedRecordBaseSchema.extend({
  record_kind: z.literal("provisional-block"),
  /**
   * The namespace the shape was measured against. On the record rather than
   * implied by the kind, so a second namespace carried under the same kind later
   * is distinguishable in the store without re-reading the replica.
   */
  source_schema_namespace: z.string().min(1).max(512),
  block: ProvisionalBlockPayloadSchema
}).strict();
export type ProjectedProvisionalBlockRecord = z.infer<typeof ProjectedProvisionalBlockRecordSchema>;

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
  /** Present exactly when this is a topic — see `TopicSchemeValues`. */
  topic_scheme: TopicSchemeSchema.optional(),
  name: z.string().min(1).max(8_192),
  /** How many legacy nodes asked for this one node. Counted, never enumerated. */
  classified_node_count: z.number().int().positive()
})
  .strict()
  .superRefine(addTopicSchemeIssues);
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
  ProjectedMintedRelationshipRecordSchema,
  ProjectedProvisionalBlockRecordSchema
]);
export type ProjectedRecord = z.infer<typeof ProjectedRecordSchema>;
export type ProjectedRecordKind = ProjectedRecord["record_kind"];

/**
 * Record kinds this migration carries across without having modelled them.
 *
 * ONE DECLARATION, read by the breakdown, the plan report and the closure gate,
 * so a second provisional kind added later is counted by all three without
 * anybody remembering to. A deferral that has to be re-listed in three files is
 * a deferral that goes uncounted in at least one of them.
 *
 * The set is also the boundary a durable adapter must respect: a record whose
 * kind is in here MUST NOT be written into a published contract shape. The
 * whole reason it is unpublished is that its shape is expected to change, and a
 * released revision cannot be edited once it ships.
 */
export const UnmodelledRecordKinds = new Set<ProjectedRecordKind>(["provisional-block"]);

export function isUnmodelledRecord(record: ProjectedRecord): boolean {
  return UnmodelledRecordKinds.has(record.record_kind);
}

export function isProvisionalBlockRecord(record: ProjectedRecord): record is ProjectedProvisionalBlockRecord {
  return record.record_kind === "provisional-block";
}

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
 * Whether this record was projected FROM a legacy object — the question the
 * closure gate asks to decide who must claim it.
 *
 * There are two independent ways to fail it and the gate must treat them
 * identically: a minted entity carries no `provenance` field at all, and a
 * derived node carries one whose variant is `derived`. Both were created by the
 * migration rather than read out of the legacy store, so both must be claimed by
 * NO source outcome. Asking only one of the two questions -- as each lane did
 * alone, because each had met only its own kind -- lets the other kind through
 * the gate unexamined.
 *
 * A minted RELATIONSHIP passes: the `has-type` edge was written down, in one
 * legacy node's subtype slot, and that node's outcome does claim it.
 */
export function isProjectedFromLegacyObject(record: ProjectedRecord): boolean {
  return hasLegacyProvenance(record) && isLegacyObjectProvenance(record.provenance);
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
 * The slot a minted topic occupies, keyed by the SCHEME and the value rather
 * than by any legacy object.
 *
 * This is what makes minting idempotent, and it is the one place a content-
 * derived key is correct: a topic node's whole identity IS its word within its
 * vocabulary. Two runs over the same corpus, and nine organizations inside one
 * run, all resolve to this slot -- which is the difference between one
 * controlled vocabulary and nine unrelated nodes that happen to share a
 * spelling.
 *
 * THE SCHEME IS PART OF THE SEED, not a discriminator the caller folds into the
 * value. Label uniqueness is scoped per scheme, so an occupation and an entity
 * kind spelled the same are two concepts and must land on two slots; a key that
 * saw only the word would give them one, and the difference would be invisible
 * at the call site. Schemes are a closed kebab-case enum, so the `:` separator
 * cannot be ambiguous even for a value that contains one.
 *
 * The `minted-topic` discriminator is in the seed so a minted slot can never
 * collide with the slot of a legacy object whose id happened to be the value.
 */
export function mintedTopicSlot(authorityId: string, scheme: TopicScheme, topicValue: string): EntitySlot {
  return `slot_entity_${hex(`${ProjectorVersion}:${authorityId}:minted-topic:${scheme}:${topicValue}`, 24)}`;
}

/**
 * Scheme-scoped for the same reason the slot is, and it matters more here: two
 * schemes minting one word with one idempotency key would have the second
 * commit replay the first, so one of the two concepts would silently never
 * reach the plane.
 */
export function mintedTopicIdempotencyKey(
  authorityId: string,
  scheme: TopicScheme,
  topicValue: string
): MigrationIdempotencyKey {
  return `la_idem_${hex([ProjectorVersion, authorityId, "minted-topic", scheme, topicValue].join("\n"), 32)}`;
}

/**
 * One key per (classified node, topic) pair. Keyed by both because a node may
 * legitimately carry several classifications, and keying by the node alone
 * would make the second `has-type` edge look like a replay of the first.
 */
/**
 * Keyed by the classified ENTITY's slot, not by the legacy object alone.
 *
 * A split venue is two entities produced from one legacy row and both are
 * classified by the same word, so an object-level key would hand the location's
 * has-type edge and the organization's the same idempotency key -- and the
 * second would be silently dropped as a replay of the first.
 */
export function mintedClassificationIdempotencyKey(
  authorityId: string,
  legacyObjectId: string,
  sourceSlot: EntitySlot,
  topicValue: string
): MigrationIdempotencyKey {
  return `la_idem_${hex(
    [ProjectorVersion, authorityId, "minted-classification", legacyObjectId, sourceSlot, topicValue].join("\n"),
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
