import { z } from "zod";
import {
  EndpointTypeSchema,
  IsoTimestampSchema,
  MixedPrecisionDateSchema,
  ObjectIdSchema,
  OccurrenceSubtypeSchema,
  WorldTimeSchema
} from "@living-atlas/contracts";

/**
 * THE LEGACY ENDPOINT VOCABULARY — the shape the old store actually wrote.
 *
 * It exists because the projector was parsing legacy payloads with
 * `EndpointRecordSchema`, which is the TARGET vocabulary and is `.strict()`.
 * That combination is silently fatal on a real corpus: every legacy record
 * carrying a retired subtype (`restaurant`, `airline`, `company`) or a retired
 * attribute (`provider`, `company_current`, `job_title`) parses as
 * `invalid-legacy-payload` and is refused wholesale. The migration would then
 * report a tidy closure — every object accounted for, with a named reason — while
 * having carried across almost nothing. A refusal that lands on 100% of the
 * corpus is not a safety property, it is a bug wearing one.
 *
 * So the legacy plane gets its own schema. It is deliberately a SUPERSET of the
 * target vocabulary: anything the new schema accepts, this accepts too, which is
 * what lets one projector read both a modern fixture and a real legacy export.
 * Unknown keys are stripped rather than refused, matching what the projector has
 * always done with the legacy fields it does not model.
 */
export const LegacyEndpointPayloadSchema = z.object({
  type: EndpointTypeSchema,
  object_id: ObjectIdSchema,
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  description: z.string().min(1).optional(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,

  /**
   * The seven retired subtype enums arrive here as one free-text slot. It is a
   * string and not an enum on purpose: the legacy values are exactly the set
   * nobody can enumerate in advance, and refusing an unrecognised one would
   * refuse the node that carried it. Every value becomes a `has-type` edge to a
   * topic node instead, which is the mechanism that replaced the enums.
   */
  subtype: z.string().min(1).optional(),

  parent_location_ref: ObjectIdSchema.optional(),

  /** Properties of a PLACE. */
  geo: z
    .object({
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      shape_ref: z.string().min(1).optional()
    })
    .optional(),
  timezone: z.string().min(1).optional(),

  /** Properties of a BUSINESS. */
  founded_year: MixedPrecisionDateSchema.optional(),
  homepage_ref: z.string().min(1).optional(),

  /**
   * Three attribute names for one fact. `date`, `occurred_on` and
   * `purchase_date` were never reconciled, so a query for "when" had to know
   * which generation of writer produced the row.
   */
  date: MixedPrecisionDateSchema.optional(),
  occurred_on: WorldTimeSchema.optional(),
  purchase_date: MixedPrecisionDateSchema.optional(),

  participant_refs: z.array(ObjectIdSchema).default([]),
  organizer_refs: z.array(ObjectIdSchema).default([]),

  /**
   * `provider` and `airline` are the same fact under two names, and gate G8
   * measured them PERFECTLY DISJOINT — no object carries both. That measurement
   * is enforced below rather than trusted: an object carrying both is a source
   * that stopped matching the evidence this merge was authorised on.
   */
  provider: z.string().min(1).optional(),
  airline: z.string().min(1).optional(),
  merchant: z.string().min(1).optional(),

  /** Employment denormalised onto the person, which is why it drifted. */
  company_current: z.string().min(1).optional(),
  job_title: z.string().min(1).optional()
});
export type LegacyEndpointPayload = z.infer<typeof LegacyEndpointPayloadSchema>;

/**
 * Location subtypes that name a VENUE — a place that is also a business.
 *
 * Gate G6 found NO venue with a same-named organization, so the split mints a
 * new organization for each rather than reconciling duplicates. That is why
 * `operated-by` launches with no existing warrant: there was nothing for it to
 * connect until this migration created the other end.
 */
export const VenueLocationSubtypes = ["restaurant", "hotel"] as const;
export type VenueLocationSubtype = (typeof VenueLocationSubtypes)[number];

export function isVenueLocation(payload: LegacyEndpointPayload): boolean {
  return (
    payload.type === "location" &&
    payload.subtype !== undefined &&
    (VenueLocationSubtypes as readonly string[]).includes(payload.subtype)
  );
}

/**
 * Why a node exists that no legacy object corresponds to.
 *
 * These are the three cases where the migration MINTS rather than projects: a
 * classification word becomes a topic node, a provider name becomes an
 * organization, and an occupation becomes a topic. Each is shared by every legacy
 * object that named it, which is precisely why it cannot borrow one of their
 * provenances.
 */
export const DerivedNodeOriginValues = [
  "legacy-subtype-word",
  "legacy-counterparty-name",
  "legacy-occupation-name"
] as const;
export const DerivedNodeOriginSchema = z.enum(DerivedNodeOriginValues);
export type DerivedNodeOrigin = z.infer<typeof DerivedNodeOriginSchema>;

/**
 * Which legacy attribute produced a derived edge.
 *
 * A derived edge carries this instead of a `legacy_edge_id`, and the relationship
 * schema requires exactly one of the two. The invariant is the point: an edge in
 * the new plane either came across from an edge the old store wrote, or was
 * computed from an attribute — and a reader auditing it must be able to tell
 * which without guessing, because only one of those has a source row to go back to.
 */
export const EdgeDerivationValues = [
  "legacy-subtype",
  "venue-split",
  "parent-location-ref",
  "provider-attr",
  "merchant-attr",
  "participant-refs",
  "organizer-refs",
  "company-current-attr",
  "job-title-attr"
] as const;
export const EdgeDerivationSchema = z.enum(EdgeDerivationValues);
export type EdgeDerivation = z.infer<typeof EdgeDerivationSchema>;

export type LegacyAttributeConflict = {
  attribute: string;
  detail: string;
};

/**
 * Collapses `provider` and `airline` into the one attribute they always were.
 *
 * Returns a conflict rather than picking a winner when both are present. G8
 * authorised this merge on the evidence that the two never co-occur; if they do,
 * the source is not the source that was measured, and silently keeping one would
 * discard a real value on the strength of a gate result that no longer holds.
 */
export function legacyProviderName(
  payload: LegacyEndpointPayload
): { ok: true; provider?: string } | { ok: false; conflict: LegacyAttributeConflict } {
  const { provider, airline } = payload;
  if (provider !== undefined && airline !== undefined) {
    if (provider === airline) {
      return { ok: true, provider };
    }
    return {
      ok: false,
      conflict: {
        attribute: "provider",
        detail: "provider and airline are both present and disagree; gate G8 measured them disjoint"
      }
    };
  }
  const merged = provider ?? airline;
  return merged === undefined ? { ok: true } : { ok: true, provider: merged };
}

/**
 * Collapses `date`, `occurred_on` and `purchase_date` into one `occurred_on`.
 *
 * Disagreeing values are a conflict, not a precedence question. Ranking the three
 * names would silently drop whichever lost, and the losing value is exactly the
 * one a reader would want to see: three names disagreeing about when something
 * happened is a data-quality finding, not a formatting problem.
 */
export function legacyOccurredOn(
  payload: LegacyEndpointPayload
): { ok: true; occurred_on?: string } | { ok: false; conflict: LegacyAttributeConflict } {
  const present = [payload.occurred_on, payload.date, payload.purchase_date].filter(
    (value): value is string => value !== undefined
  );
  const distinct = [...new Set(present)];
  if (distinct.length > 1) {
    return {
      ok: false,
      conflict: {
        attribute: "occurred_on",
        detail: "date, occurred_on and purchase_date disagree; the migration will not rank one over another"
      }
    };
  }
  const only = distinct[0];
  return only === undefined ? { ok: true } : { ok: true, occurred_on: only };
}

/**
 * The occurrence subtype, which is the ONE subtype the new vocabulary kept.
 *
 * A legacy value outside the four is not mapped here and not guessed at: the
 * item/occurrence RETYPE table (rideshare and flight become `segment`, meal and
 * incident become `meeting`) belongs to the retype lane, and a projector that
 * quietly invented a mapping would make that lane's decisions unreviewable.
 */
export function legacyOccurrenceSubtype(
  payload: LegacyEndpointPayload
): { ok: true; subtype: z.infer<typeof OccurrenceSubtypeSchema> } | { ok: false; detail: string } {
  const parsed = OccurrenceSubtypeSchema.safeParse(payload.subtype);
  if (parsed.success) {
    return { ok: true, subtype: parsed.data };
  }
  return {
    ok: false,
    detail:
      `occurrence subtype ${payload.subtype === undefined ? "<absent>" : JSON.stringify(payload.subtype)} is not one of ` +
      `${OccurrenceSubtypeSchema.options.join("|")}; the retype lane owns that mapping`
  };
}

/**
 * THE VENUE SPLIT ALLOCATION RULE.
 *
 * An attribute goes to the node whose identity it is a property OF, and the test
 * is what survives change: a restaurant that moves premises is the same business
 * at a different place, so `geo` and `timezone` belong to the location and
 * `founded_year` and `homepage_ref` belong to the organization. Nothing is
 * duplicated across the pair, so there is no second copy to drift.
 *
 * `name`, `aliases` and `description` are the exception and are copied to both —
 * not as duplication but because a venue genuinely has ONE name that belongs to
 * the place and the business alike. That shared name is precisely why a bare
 * legacy id cannot say which was meant, and therefore why the alias row is an
 * ambiguous split rather than a redirect.
 *
 * Attributes that became edges appear nowhere here: `parent_location_ref` is
 * `contained-in`, `provider` is `offered-by`, `merchant` is `sold-by`,
 * `participant_refs` is `participant-in`, `company_current` is `employed-by`,
 * `subtype` and `job_title` are `has-type`. Leaving a copy behind as an attribute
 * would be the same fact in two mechanisms that can disagree.
 */
export function endpointAttributes(
  payload: LegacyEndpointPayload,
  entityType: string
): { attrs: Record<string, unknown>; conflict?: LegacyAttributeConflict } {
  const attrs: Record<string, unknown> = {};

  if (entityType === "location") {
    if (payload.geo !== undefined) attrs.geo = payload.geo;
    if (payload.timezone !== undefined) attrs.timezone = payload.timezone;
  }

  if (entityType === "organization") {
    if (payload.founded_year !== undefined) attrs.founded_year = payload.founded_year;
    if (payload.homepage_ref !== undefined) attrs.homepage_ref = payload.homepage_ref;
  }

  if (entityType === "occurrence" || entityType === "item" || entityType === "offering") {
    const occurredOn = legacyOccurredOn(payload);
    if (!occurredOn.ok) {
      // The node still projects, WITHOUT a date. Refusing the whole occurrence
      // over one disagreeing attribute would discard a real event; keeping a
      // guessed date would make it findable under a time nobody recorded. The
      // gap is deliberate and the hand-review row is what makes it countable.
      return { attrs, conflict: occurredOn.conflict };
    }
    if (occurredOn.occurred_on !== undefined) {
      attrs.occurred_on = occurredOn.occurred_on;
    }
  }

  return { attrs };
}

/**
 * The classification words this object should carry as `has-type` edges.
 *
 * An occurrence contributes none: its subtype survived as a real enum, so
 * emitting a topic for it too would state the same fact twice in two mechanisms
 * and leave a later reader to discover they can disagree.
 */
export function legacyTypeWords(payload: LegacyEndpointPayload): string[] {
  if (payload.subtype === undefined || payload.type === "occurrence") {
    return [];
  }
  return [payload.subtype];
}
