import { z } from "zod";
import { ProvenanceSchema, SensitivitySchema } from "./assertion.js";
import { EntityIdSchema } from "./ids.js";
import { RecordedAtSchema } from "./time.js";

/**
 * An entity is a thing the graph makes claims ABOUT, and its id is the only
 * durable handle a consumer ever holds. Everything in this module exists to
 * protect one property: `entity_id` is minted once and is never a function of
 * anything that can change.
 *
 * This is the defect that made the old store unusable as a long-term reference.
 * A block's id was `sha256(sourcePathRef : lineIndex : text)`, so fixing a typo
 * minted a new id and inserting one bullet re-identified every block below it —
 * 51,811 of 65,091 objects. Content, position, file path, and encoding are
 * therefore OBSERVATIONS about an entity (see `SourceObservationSchema`), never
 * inputs to its identity. An observation may change freely; the id may not move.
 */

/**
 * Reserved `other` at v1, per the repo-wide convention: adding a member to an
 * output enum breaks a strict consumer, so without an escape hatch Atlas could
 * never name a new kind of thing without a major version.
 *
 * `type_label` carries the human name for an `other`. A 2031 type therefore
 * arrives at a 2026 consumer as `other` plus a label it can display, rather
 * than as an unrecognised token it might branch on by accident.
 */
export const EntityTypeSchema = z.enum([
  "person",
  "organization",
  "place",
  "concept",
  "source-document",
  "event",
  "other"
]);

export type EntityType = z.infer<typeof EntityTypeSchema>;

/**
 * New content is local-private unless something classifies it otherwise, and an
 * entity is the most identifying record in the graph — it holds the names.
 *
 * `rank` orders tiers so a consumer compares rather than string-matches;
 * `open` is 0. `withheld` stays false here because withholding is a decision a
 * projection makes per reader, not a property the registry can know.
 */
export const DEFAULT_ENTITY_SENSITIVITY = {
  tier: "local-private",
  rank: 10,
  withheld: false
} as const;

/**
 * A registered entity.
 *
 * Note what is NOT here: any notion of "redirected" or "merged away". A status
 * field would be a second place the redirect state is written, and a second
 * place can disagree with the alias ledger — the disagreement then resolves in
 * favour of whichever one the reader happened to trust. The ledger is the only
 * redirect authority, and `resolve()` is the only way to ask.
 */
export const EntitySchema = z
  .object({
    /** Frozen literal, so a record is self-describing when logged or replayed. */
    record_schema: z.literal("atlas.entity:v1"),

    entity_id: EntityIdSchema,

    type: EntityTypeSchema,
    /** Required when `type` is `other`, forbidden otherwise. */
    type_label: z.string().min(1).optional(),

    /**
     * Names are OBSERVATIONS with provenance, never identifiers — ADR 0007 is
     * explicit that a matching name is not proof two entities are the same.
     *
     * `also_known_as` is deliberately not called "aliases": in Atlas an alias
     * is a row in the id ledger, and letting one word mean both a nickname and
     * an id redirect is precisely how a rename turns into a re-identification.
     * Renaming writes no ledger row and cannot move an id.
     */
    display_name: z.string().min(1),
    also_known_as: z.array(z.string().min(1)),

    /** Belief time, stamped by Atlas at registration. Never caller-supplied. */
    registered_at: RecordedAtSchema,
    /** Belief time of the most recent name or type change. */
    updated_at: RecordedAtSchema,

    provenance: ProvenanceSchema,
    sensitivity: SensitivitySchema
  })
  .strict();

export type Entity = z.infer<typeof EntitySchema>;

/**
 * What a caller may propose. Note what is absent and cannot be supplied:
 * `entity_id`, `registered_at`, `updated_at`, and `provenance.client_id`.
 * Everything that carries authority is minted or stamped by Atlas.
 */
export const EntityDraftSchema = z
  .object({
    type: EntityTypeSchema,
    type_label: z.string().min(1).optional(),
    display_name: z.string().min(1),
    also_known_as: z.array(z.string().min(1)),
    basis: z.string().optional(),
    proposed_at: z.string().optional()
  })
  .strict();

export type EntityDraft = z.infer<typeof EntityDraftSchema>;

/**
 * Cross-field rules the schema cannot express, as a function rather than a
 * refinement — matching `validateLineage` in `assertion.ts`.
 *
 * An `other` type without a label is an entity nobody can interpret later, and
 * a label on a known type is a second, unvalidated type field that will
 * eventually contradict the first.
 */
export function validateEntityType(draft: {
  type: EntityType;
  type_label?: string | undefined;
}): void {
  if (draft.type === "other" && !draft.type_label) {
    throw new Error('entity type "other" requires a type_label naming what it is');
  }
  if (draft.type !== "other" && draft.type_label !== undefined) {
    throw new Error(`type_label is only for type "other", not "${draft.type}"`);
  }
}

/**
 * What an import observed about where an entity came from — and the only reason
 * a re-import can find an entity it already minted an id for.
 *
 * Every trait here is unstable on its own. A path changes when a file is
 * renamed, an ordinal changes when a bullet is inserted above, a digest changes
 * when a typo is fixed, and only 433 of 17,036 source bullets (2.5%) carry an
 * explicit `id::` at all. The old store's mistake was not using these traits —
 * it was deriving identity FROM them, so any single change re-identified the
 * record. Here they are evidence for a match, weighed together, and the id they
 * find is one that was minted independently of all of them.
 *
 * `text_digest` rather than the text itself: the index has to be inspectable
 * without exposing content. It is a fingerprint, not a redaction — anyone
 * holding the source can confirm a match, which is what makes it useful for
 * verification and why the index stays local-private.
 */
export const SourceObservationSchema = z
  .object({
    source_path_ref: z.string().min(1).optional(),
    block_ordinal: z.number().int().nonnegative().optional(),
    text_digest: z.string().min(1).optional(),
    /** An identifier the source itself declares, e.g. a Logseq `id::` UUID. */
    id_property: z.string().min(1).optional()
  })
  .strict();

export type SourceObservation = z.infer<typeof SourceObservationSchema>;

export const OBSERVATION_TRAITS = [
  "source_path_ref",
  "block_ordinal",
  "text_digest",
  "id_property"
] as const;

export type ObservationTrait = (typeof OBSERVATION_TRAITS)[number];

/** How many of the four traits an observation actually carries. */
export function observedTraits(observation: SourceObservation): ObservationTrait[] {
  return OBSERVATION_TRAITS.filter((trait) => observation[trait] !== undefined);
}
