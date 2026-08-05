import { z } from "zod";
import {
  EndpointTypeSchema,
  OccurrenceSubtypeSchema,
  type EndpointType,
  type OccurrenceSubtype
} from "@living-atlas/contracts";

/**
 * The legacy plane's node vocabulary, and how each of its words maps onto the
 * ratified one.
 *
 * The legacy store filed a node under a `type` plus a free-string `subtype`.
 * Seven of the eight subtype enums are gone; classification is now a `has-type`
 * edge to a `topic` node. This file is the whole of that mapping, kept as DATA
 * so the decision is reviewable as a table rather than reconstructed by reading
 * a chain of if-statements.
 *
 * Two rules, and the split between them is the point:
 *
 *   RULE A — RETYPE. A closed, enumerated table, for the legacy values that
 *   change the node's TYPE. Those are exactly the travel items that become
 *   occurrences and the occurrence subtypes that collapse onto the four
 *   survivors. Enumerated because a wrong guess here moves a node into a type
 *   whose edges mean something else, and there is no way to detect that later.
 *
 *   RULE B — CLASSIFY. An open rule, for every other legacy subtype: the value
 *   becomes a `has-type` topic and the node keeps its type. Open because the
 *   legacy organization and location vocabularies were never closed either --
 *   the modal organization value was `other` -- so enumerating them would only
 *   move the residue from a subtype slot into a mapping table.
 *
 * Rule A is total over its own domain and REFUSES a value it does not name; it
 * never falls through to a default. `meeting` was the modal occurrence target,
 * so defaulting to it would look like a successful mapping while quietly filing
 * an unknown word under the most common word -- which is the same defect as
 * `other`, wearing a better name.
 */

/**
 * How a legacy subtype value is carried across, once its type is settled.
 *
 * `topic` is the normal answer: the value said something the new type does not,
 * so it becomes an identity-checked node. `absorbed` is for the values the
 * surviving subtype already says -- `travel` and `trip` are one concept, and
 * SKOS would give them one node with two labels, not two nodes. `vacuous` is
 * for the words that classify nothing: minting a controlled-vocabulary topic
 * called `other` would rebuild the exact residue the enum deletion removed.
 */
export const LegacyValueDispositionValues = ["topic", "absorbed", "vacuous"] as const;
export const LegacyValueDispositionSchema = z.enum(LegacyValueDispositionValues);
export type LegacyValueDisposition = z.infer<typeof LegacyValueDispositionSchema>;

export type RetypeRule = {
  /** Legacy `type` the row applies to. */
  from_type: EndpointType;
  /** Legacy `subtype` value the row applies to. */
  from_subtype: string;
  to_type: EndpointType;
  /** Present exactly when `to_type` carries a subtype, which today means occurrence. */
  to_subtype?: OccurrenceSubtype;
  disposition: LegacyValueDisposition;
  /** The topic value minted when `disposition` is `topic`. */
  topic?: string;
  /** Why this row reads the way it does. Printed in the mapping report. */
  basis: string;
};

/**
 * RULE A, the enumerated retypes.
 *
 * The travel rows are the legs the legacy store filed as `item`. They are
 * events, not possessions: the corpus asserted that a person OWNED a taxi ride.
 * Their mode of travel stays an attribute and is deliberately absent from this
 * table -- see `TRAVEL_MODE_ATTRIBUTE`.
 */
const TravelSegmentSubtypes = ["rideshare", "flight", "car-service", "drive", "train"] as const;

export const RetypeRules: readonly RetypeRule[] = [
  ...TravelSegmentSubtypes.map(
    (subtype): RetypeRule => ({
      from_type: "item",
      from_subtype: subtype,
      to_type: "occurrence",
      to_subtype: "segment",
      // The mode is NOT a topic. `has-type` says what a thing IS, and a taxi
      // ride is a segment whether it was a taxi or a train; the vehicle is a
      // property of the leg. Re-encoding it as a topic would put the same fact
      // in two places and let them disagree.
      disposition: "absorbed",
      basis: "travel leg; the mode of travel stays an attribute rather than becoming a subtype or a topic"
    })
  ),

  {
    from_type: "occurrence",
    from_subtype: "trip",
    to_type: "occurrence",
    to_subtype: "trip",
    disposition: "absorbed",
    basis: "the word survived as the subtype; nothing was lost"
  },
  {
    from_type: "occurrence",
    from_subtype: "travel",
    to_type: "occurrence",
    to_subtype: "trip",
    disposition: "absorbed",
    basis: "a second label for trip; one concept gets one node, so no separate topic is minted"
  },
  {
    from_type: "occurrence",
    from_subtype: "stay",
    to_type: "occurrence",
    to_subtype: "stay",
    disposition: "absorbed",
    basis: "the word survived as the subtype; nothing was lost"
  },
  {
    from_type: "occurrence",
    from_subtype: "hotel-stay",
    to_type: "occurrence",
    to_subtype: "stay",
    disposition: "topic",
    topic: "hotel",
    basis: "`stay` keeps the shape; `hotel` is the kind of place stayed at and survives as a topic"
  },
  {
    from_type: "occurrence",
    from_subtype: "meeting",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "absorbed",
    basis: "the word survived as the subtype; nothing was lost"
  },
  {
    from_type: "occurrence",
    from_subtype: "meal",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "topic",
    topic: "meal",
    basis: "a meal is people meeting to eat; the eating is what `meal` adds and it survives as a topic"
  },
  {
    from_type: "occurrence",
    from_subtype: "social",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "topic",
    topic: "social",
    basis: "social is a real distinction from a working meeting and survives as a topic"
  },
  {
    from_type: "occurrence",
    from_subtype: "incident",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "topic",
    topic: "incident",
    basis: "an incident is an occurrence people attended; `incident` survives as a topic"
  },
  {
    from_type: "occurrence",
    from_subtype: "event",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "vacuous",
    basis: "`event` is the superclass of every occurrence; a topic true of every one of them partitions nothing"
  },
  {
    from_type: "occurrence",
    from_subtype: "other",
    to_type: "occurrence",
    to_subtype: "meeting",
    disposition: "vacuous",
    basis: "`other` is the residue the enum deletion removed; minting a topic for it would rebuild the residue"
  }
];

/**
 * Legacy types whose retypes are enumerated: the table is consulted FIRST for
 * these, because a row here moves a node between types and a wrong move is
 * undetectable once the edges are rewritten.
 *
 * What happens when the table names no rule differs by type, and the difference
 * is not a detail. `occurrence` REFUSES: its subtype is required, so an unnamed
 * word has nowhere to go, and falling through to Rule B would produce a node
 * that passes every schema check having lost the field that says what kind of
 * event it was. `item` falls through to Rule B: it carries no subtype at all, so
 * an unnamed word means "this item stays an item" and the word becomes a topic
 * like every other classification. Treating them alike refused every non-travel
 * item in the corpus and took each one's `owns` edge with it one hop later.
 */
export const EnumeratedRetypeTypes = ["item", "occurrence"] as const satisfies readonly EndpointType[];

/**
 * Legacy types the ratified table sends to hand review rather than to a mapping.
 * `project/tool` and `project/product` are probably offerings; "probably" is not
 * a mapping, so they are projected unchanged, classified by `has-type`, and
 * counted where a human will see them.
 */
export const HandReviewSubtypes: Readonly<Record<string, string>> = {
  "project/tool": "probably an offering rather than a project; the ratified table declined to decide",
  "project/product": "probably an offering rather than a project; the ratified table declined to decide"
};

/**
 * The attribute the travel legs keep. Named as a constant because the rule is
 * "mode stays an attribute", and a rule stated only in prose gets re-litigated
 * every time somebody notices `segment` does not say whether it flew.
 */
export const TRAVEL_MODE_ATTRIBUTE = "mode" as const;

/**
 * Legacy attributes that carry a travel leg's endpoints. Disjoint in the corpus
 * and incompletely populated: some legs carry `route`, some carry
 * `origin`/`destination`, and the largest group carries NEITHER. A leg with no
 * origin is a leg whose origin is unknown, and the record must say so.
 */
export const TRAVEL_ROUTE_ATTRIBUTE = "route" as const;
export const TRAVEL_ORIGIN_ATTRIBUTE = "origin" as const;
export const TRAVEL_DESTINATION_ATTRIBUTE = "destination" as const;

const retypeIndex = new Map<string, RetypeRule>(
  RetypeRules.map((rule) => [`${rule.from_type}/${rule.from_subtype}`, rule])
);

export function retypeRuleFor(legacyType: string, legacySubtype: string): RetypeRule | undefined {
  return retypeIndex.get(`${legacyType}/${legacySubtype}`);
}

export function typeHasEnumeratedRetypes(legacyType: string): boolean {
  return (EnumeratedRetypeTypes as readonly string[]).includes(legacyType);
}

/**
 * Topic values are the controlled vocabulary, so two spellings of one word must
 * not become two nodes. Normalisation is deliberately conservative: case and
 * surrounding whitespace only. Collapsing `car-rental` and `car rental` would
 * be a judgement about synonymy that belongs to a curator, not to a migration.
 */
export function normalizeTopicValue(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The four fields the VOCABULARY mapper needs, and nothing else.
 *
 * Deliberately loose and deliberately distinct from `legacy-endpoint.ts`'s
 * `LegacyEndpointPayloadSchema`, which is the projector's full attribute-bearing
 * superset. Two modules briefly exported the same name for these two different
 * jobs; a barrel that re-exports both then has one name for two shapes, and
 * whichever import won would silently decide which fields a caller could see.
 */
export const LegacyVocabularyPayloadSchema = z.looseObject({
  object_id: z.string().min(1),
  type: z.string().min(1),
  subtype: z.string().min(1).optional(),
  name: z.string().min(1)
});
export type LegacyVocabularyPayload = z.infer<typeof LegacyVocabularyPayloadSchema>;

export function isKnownEndpointType(value: string): value is EndpointType {
  return EndpointTypeSchema.safeParse(value).success;
}

export function isOccurrenceSubtype(value: string): value is OccurrenceSubtype {
  return OccurrenceSubtypeSchema.safeParse(value).success;
}
