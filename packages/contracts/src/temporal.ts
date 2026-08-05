import { z } from "zod";
import * as rrule from "rrule";
import { AccessClassSchema } from "./classification";
import { EventIdSchema, IsoTimestampSchema, ObjectIdSchema } from "./ids";

const { rrulestr } = rrule;

export const EndpointTypeValues = ["person", "organization", "project", "location", "occurrence", "topic", "offering", "item"] as const;
export const EndpointTypeSchema = z.enum(EndpointTypeValues);
export type EndpointType = z.infer<typeof EndpointTypeSchema>;

/**
 * `agent` is not a ninth endpoint type. It is the two types that can ACT, named
 * once so two domain rules meaning the same thing cannot drift into meaning
 * different things — the defect this prevents is `member-of` accepting
 * `["person", "organization"]` while `connects` accepts `["person"]` because
 * somebody edited one row of the table and not the other.
 */
export const AgentEndpointTypes = ["person", "organization"] as const satisfies readonly EndpointType[];

/** Every endpoint type, for the two predicates whose domain genuinely is anything. */
export const AnyEndpointTypes = EndpointTypeValues;

/**
 * THE ONE SURVIVING SUBTYPE ENUM, and the rule that killed the other seven.
 *
 * A subtype enum earns its slot only when BOTH hold: (a) the value changes which
 * attributes and edges the node carries, and (b) the enum can be made TOTAL —
 * every node of that type receives a real value, with no residual `other`.
 * `organization` failed both: its MODAL value was `other`, and a single slot
 * cannot hold legal form and line of business at the same time. An enum whose
 * modal value is `other` does not classify: it produces plausible-looking wrong
 * answers, which is worse than no answer.
 *
 * These four cover the occurrence corpus with no residue: `segment` (one leg),
 * `trip` (the container its legs join via `part-of`), `stay`, and `meeting`.
 * Everything the retired values used to say — meal, conference, incident,
 * hotel-stay, appointment — is now a `has-type` edge to a `topic` node, where it
 * is multi-valued, bitemporal, and identity-checked instead of being one string.
 *
 * `segment` is the only new subtype word in the whole vocabulary.
 */
export const OccurrenceSubtypeValues = ["segment", "trip", "stay", "meeting"] as const;
export const OccurrenceSubtypeSchema = z.enum(OccurrenceSubtypeValues);
export type OccurrenceSubtype = z.infer<typeof OccurrenceSubtypeSchema>;

/**
 * The subtype vocabulary as a whole, which is now exactly the occurrence one.
 *
 * Kept under its own name because callers ask "is this a legal subtype for any
 * endpoint?", and that question outlives the fact that today only one type
 * answers it. A caller that inlined the occurrence enum here would silently stop
 * being right the moment a second type earned a subtype.
 */
export const EndpointSubtypeSchema = OccurrenceSubtypeSchema;
export type EndpointSubtype = z.infer<typeof EndpointSubtypeSchema>;

/**
 * The endpoint types that carry a subtype at all. Everything else classifies
 * through `has-type`, so asking one of them for a subtype is a bug, not a gap.
 */
export const SubtypedEndpointTypes = ["occurrence"] as const satisfies readonly EndpointType[];

export function endpointTypeCarriesSubtype(type: EndpointType): boolean {
  return (SubtypedEndpointTypes as readonly EndpointType[]).includes(type);
}

export const EdgeStatusSchema = z.enum(["active", "pending", "ended", "dormant"]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);

/**
 * `governance` and `advisory` are gone with the predicates that used them.
 * A category no predicate can be filed under is a value nothing produces and
 * everything must still handle — which is how a switch statement acquires a
 * branch nobody has ever executed.
 */
export const EdgeCategorySchema = z.enum([
  "employment",
  "affiliation",
  "capital",
  "structural",
  "customer",
  "network",
  "geography",
  "occurrence",
  "taxonomy",
  "commerce",
  "creation",
  "personal"
]);
export type EdgeCategory = z.infer<typeof EdgeCategorySchema>;

/**
 * THE DISAMBIGUATION RULE, stated once and published verbatim.
 *
 * `has-type` and `about` have the identical signature — `any -> topic` — so no
 * shape check can tell them apart, and pretending otherwise by inventing a
 * structural difference would be a lie the schema tells to look rigorous. The
 * separation is semantic and it is a CONVENTION, enforced by review and by this
 * sentence appearing in the published contract rather than by validation.
 *
 * A topic node may legitimately be the target of both: "cybersecurity" is what a
 * project is *about* and what a consultancy *is*. That is one concept used in
 * two relations, which is exactly SKOS — one `skos:Concept`, many relations
 * pointing at it — not two words for one thing.
 */
export const HAS_TYPE_VS_ABOUT_RULE =
  "has-type says what the subject IS. about says what the subject is CONCERNED WITH.";

type PredicateDefinition = {
  category: EdgeCategory;
  direction: "directed" | "symmetric";
  /** Endpoint types accepted as `source_type`. Enforced, not documented. */
  domain: readonly EndpointType[];
  /** Endpoint types accepted as `target_type`. Enforced, not documented. */
  range: readonly EndpointType[];
  /** Attr keys the edge must carry. `valid_from` is on the spine and skipped there. */
  required: readonly string[];
  /** Why the predicate exists and what it must not be confused with. */
  note: string;
};

/**
 * THE PREDICATE VOCABULARY.
 *
 * Every row carries a DOMAIN RULE, and the rule is enforced by
 * `checkPredicateEndpoints` on every edge that is parsed — not written down in a
 * comment beside a permissive schema. A predicate whose domain rule is a comment
 * is not a rule: the measured failure was `based-in` accepting both
 * `person -> location` and `location -> organization`, so "where is this
 * organization based" and "who runs this place" were the same edge and no
 * consumer could tell which it had.
 *
 * The set shrank because eight predicates said the same thing as a survivor plus
 * an attribute, and an attribute is the honest place for a distinction that does
 * not change the shape of the relation. `board-member-of` and `advises` and
 * `alumnus-of` are all `member-of` with a different `role`; keeping them as
 * separate predicates meant three query paths for one question.
 */
export const PredicateRegistry = {
  "employed-by": {
    category: "employment",
    direction: "directed",
    domain: ["person"],
    range: ["organization"],
    required: ["valid_from"],
    note: "Employment. attrs.role carries the job title, which used to be an attribute of the person and belongs to the relationship: a title without an employer is not a fact about anybody."
  },
  "member-of": {
    category: "affiliation",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["organization"],
    required: [],
    note: "Non-employment affiliation. Absorbs board-member-of, advises and alumnus-of through attrs.role, following W3C ORG's Membership+role rather than one predicate per kind of member."
  },
  "part-of": {
    category: "structural",
    direction: "directed",
    domain: ["occurrence"],
    range: ["occurrence"],
    required: [],
    note: "Composition between occurrences: a segment is part-of the trip it belongs to. Deliberately occurrence-only — a general-purpose part-of would be asked to mean containment, membership and composition at once."
  },
  "contained-in": {
    category: "geography",
    direction: "directed",
    domain: ["location"],
    range: ["location"],
    required: [],
    note: "Spatial containment: the granularity ladder city -> state -> country, carried by edges instead of by a subtype enum that could only hold one rung."
  },
  "has-type": {
    category: "taxonomy",
    direction: "directed",
    domain: AnyEndpointTypes,
    range: ["topic"],
    required: [],
    note: `${HAS_TYPE_VS_ABOUT_RULE} Classification is a multi-valued, bitemporal edge to an identity-checked topic node, replacing the seven retired subtype enums.`
  },
  "operated-by": {
    category: "structural",
    direction: "directed",
    domain: ["location"],
    range: ["organization"],
    required: [],
    note: "The place-to-business link, correctly directed. A restaurant is a location AND an organization joined by this edge; without it the inverse kept arriving as based-in and inverted the geography vocabulary."
  },
  "based-in": {
    category: "geography",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["location"],
    required: [],
    note: "Where an agent is based. NEVER location -> organization: that is operated-by, and accepting both directions here is what made the two indistinguishable."
  },
  "occurred-at": {
    category: "occurrence",
    direction: "directed",
    domain: ["occurrence"],
    range: ["location"],
    required: [],
    note: "Where something happened. Domain-restricted to occurrence so it cannot drift into standing for an agent's location."
  },
  "participant-in": {
    category: "occurrence",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["occurrence"],
    required: [],
    note: "Who was there. Absorbs the organizer distinction through attrs.role = \"organizer\", which is why hosted is gone: an organizer is a participant with a job."
  },
  connects: {
    category: "network",
    direction: "symmetric",
    domain: AgentEndpointTypes,
    range: AgentEndpointTypes,
    required: [],
    note: "The single generic agent-to-agent association. Absorbs related-to, mentor-of and partner-of; attrs.relation names which, and attrs.note carries the free text the older edges held."
  },
  owns: {
    category: "commerce",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["item", "offering", "organization"],
    required: [],
    note: "Ownership as a STATE. Never an occurrence: a person does not own a taxi ride, they participated in one, and the range excludes occurrence so that edge cannot be written."
  },
  "offered-by": {
    category: "commerce",
    direction: "directed",
    domain: ["offering", "occurrence"],
    range: ["organization"],
    required: [],
    note: "Who operates or provides the thing. A flight segment is offered-by the airline that flew it; the booking channel is sold-by."
  },
  "sold-by": {
    category: "commerce",
    direction: "directed",
    domain: ["item", "offering", "occurrence"],
    range: ["organization"],
    required: [],
    note: "The counterparty of a sale. Renamed from purchased-from, whose source was the BUYER; the endpoints changed, so the old name is retired rather than aliased."
  },
  purchased: {
    category: "commerce",
    direction: "directed",
    domain: ["person"],
    range: ["item", "offering", "occurrence"],
    required: [],
    note: "The ACT of buying, distinct from owns (the resulting state) and sold-by (the counterparty). Three facts about one transaction that a single predicate kept conflating."
  },
  "customer-of": {
    category: "customer",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["organization"],
    required: [],
    note: "A standing commercial relationship, as opposed to one purchase."
  },
  "founder-of": {
    category: "employment",
    direction: "directed",
    domain: ["person"],
    range: ["organization"],
    required: ["valid_from"],
    note: "Founding. Range narrowed to organization: a project or an offering is created, not founded, and created already says so."
  },
  "acquired-by": {
    category: "structural",
    direction: "directed",
    domain: ["organization"],
    range: ["organization"],
    required: ["valid_from"],
    note: "Which organization absorbed which. Replaces merged-with, which named neither survivor and so could not be queried in either direction."
  },
  "invests-in": {
    category: "capital",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["organization"],
    required: ["amount", "investment_status"],
    note: "Capital deployed into an organization. attrs.investment_status rather than attrs.status, because the edge spine already owns status."
  },
  about: {
    category: "taxonomy",
    direction: "directed",
    domain: AnyEndpointTypes,
    range: ["topic"],
    required: [],
    note: `${HAS_TYPE_VS_ABOUT_RULE} Subject matter, the counterpart to has-type; both point at topic nodes and a topic may legitimately be the target of both.`
  },
  "parent-of": {
    category: "personal",
    direction: "directed",
    domain: ["person"],
    range: ["person"],
    required: [],
    note: "Parenthood, directed parent -> child."
  },
  "spouse-of": {
    category: "personal",
    direction: "symmetric",
    domain: ["person"],
    range: ["person"],
    required: [],
    note: "Marriage. Absorbs engaged as an edge with status \"pending\": an engagement is a marriage that is not valid yet, which the bitemporal spine already expresses."
  },
  "sibling-of": {
    category: "personal",
    direction: "symmetric",
    domain: ["person"],
    range: ["person"],
    required: [],
    note: "Siblinghood."
  },
  "estranged-from": {
    category: "personal",
    direction: "symmetric",
    domain: ["person"],
    range: ["person"],
    required: [],
    note: "An explicitly broken relationship, kept because its absence is not the same claim as its negation."
  },
  "introduced-by": {
    category: "network",
    direction: "directed",
    domain: ["person"],
    range: ["person"],
    required: [],
    note: "Who introduced whom. intro-path-to is retired: a path nobody has walked is a plan, not an edge."
  },
  created: {
    category: "creation",
    direction: "directed",
    domain: AgentEndpointTypes,
    range: ["item", "offering"],
    required: [],
    note: "Authorship. Absorbs created-for through attrs.created_for, which names the beneficiary as an object id rather than as a second edge with reversed endpoints."
  }
} as const satisfies Record<string, PredicateDefinition>;

export type Predicate = keyof typeof PredicateRegistry;
export const PredicateSchema = z.enum(Object.keys(PredicateRegistry) as [Predicate, ...Predicate[]]);

// ---------------------------------------------------------------------------
// domain rules, enforced
// ---------------------------------------------------------------------------

export type PredicateEndpointViolation = {
  code: "predicate-domain-violation" | "predicate-range-violation";
  predicate: Predicate;
  /** Which end of the edge broke the rule, so a caller can point at a field. */
  position: "source" | "target";
  actual: EndpointType;
  /** Both sides are reported on every violation: a wrong-direction edge is diagnosed by the PAIR, not by either half. */
  expected_domain: readonly EndpointType[];
  expected_range: readonly EndpointType[];
  message: string;
};

export type PredicateEndpointCheck =
  | { ok: true }
  | { ok: false; violations: readonly [PredicateEndpointViolation, ...PredicateEndpointViolation[]] };

function endpointViolationMessage(
  predicate: Predicate,
  position: "source" | "target",
  sourceType: EndpointType,
  targetType: EndpointType
): string {
  const definition = PredicateRegistry[predicate];
  return (
    `${predicate} accepts ${position === "source" ? "source" : "target"} endpoints ` +
    `[${(position === "source" ? definition.domain : definition.range).join(", ")}] ` +
    `and is written ${definition.domain.join("|")} -> ${definition.range.join("|")}; ` +
    `got ${sourceType} -> ${targetType}`
  );
}

/**
 * The domain rule as CODE.
 *
 * Returns every violation rather than the first, because the case this exists
 * for — an edge written backwards — breaks both ends at once, and reporting only
 * the source sends the reader off to fix the half that is arguably right. A
 * `based-in` written `location -> organization` gets told the domain wants
 * person|organization AND the range wants location, which together say "you
 * wrote operated-by".
 */
export function checkPredicateEndpoints(
  predicate: Predicate,
  sourceType: EndpointType,
  targetType: EndpointType
): PredicateEndpointCheck {
  const definition = PredicateRegistry[predicate];
  const violations: PredicateEndpointViolation[] = [];

  if (!(definition.domain as readonly EndpointType[]).includes(sourceType)) {
    violations.push({
      code: "predicate-domain-violation",
      predicate,
      position: "source",
      actual: sourceType,
      expected_domain: definition.domain,
      expected_range: definition.range,
      message: endpointViolationMessage(predicate, "source", sourceType, targetType)
    });
  }

  if (!(definition.range as readonly EndpointType[]).includes(targetType)) {
    violations.push({
      code: "predicate-range-violation",
      predicate,
      position: "target",
      actual: targetType,
      expected_domain: definition.domain,
      expected_range: definition.range,
      message: endpointViolationMessage(predicate, "target", sourceType, targetType)
    });
  }

  const [first, ...rest] = violations;
  return first === undefined ? { ok: true } : { ok: false, violations: [first, ...rest] };
}

/** The typed refusal, for callers that throw rather than collect zod issues. */
export class PredicateEndpointError extends Error {
  readonly code = "predicate-endpoint-violation";
  readonly predicate: Predicate;
  readonly violations: readonly PredicateEndpointViolation[];

  constructor(violations: readonly [PredicateEndpointViolation, ...PredicateEndpointViolation[]]) {
    super(violations.map((violation) => violation.message).join("; "));
    this.name = "PredicateEndpointError";
    this.predicate = violations[0].predicate;
    this.violations = violations;
  }
}

export function assertPredicateEndpoints(
  predicate: Predicate,
  sourceType: EndpointType,
  targetType: EndpointType
): void {
  const outcome = checkPredicateEndpoints(predicate, sourceType, targetType);
  if (!outcome.ok) {
    throw new PredicateEndpointError(outcome.violations);
  }
}

// ---------------------------------------------------------------------------
// canonicalization
// ---------------------------------------------------------------------------

/**
 * Aliases that mean the SAME relation between the SAME endpoint types. Nothing
 * else belongs here: an alias that also has to move an endpoint or add an attr
 * is a migration, and pretending it is a spelling produces silently wrong edges.
 */
const SafeAliasMap: Record<string, Predicate> = {
  "works-at": "employed-by",
  "works-for": "employed-by",
  "employee-of": "employed-by",
  "investor-in": "invests-in",
  backs: "invests-in",
  "client-of": "customer-of",
  "provided-by": "offered-by",
  "purchased-item": "purchased",
  made: "created",
  "made-by": "created",
  "co-founded": "founder-of",
  "married-to": "spouse-of",
  knows: "connects",
  "connected-to": "connects",
  "classified-as": "has-type",
  "part-of-trip": "part-of",
  "located-within": "contained-in"
};

const DirectionUnsafeAliases = new Set([
  "manages",
  "acquired",
  "bought",
  "led-by",
  "board-includes",
  "employs",
  "portfolio-company-of",
  "funded-by",
  "operator-of",
  "sells",
  "sold-to",
  "contains"
]);

/**
 * Predicates this contract used to accept, and what replaced each one.
 *
 * Refusing a retired name as `unknown-predicate` would tell a caller the word
 * never existed, which is false and leaves them nowhere to go. Naming the
 * successor AND the attribute that carries the distinction the collapse would
 * otherwise lose is the difference between a refusal and a dead end — and it is
 * why none of these is a safe alias: every one of them needs an attr set or an
 * endpoint moved, which an alias cannot do.
 */
export const RetiredPredicates: Record<string, string> = {
  "reports-to": "employed-by on the same person, with attrs.role naming the reporting line.",
  "board-member-of": 'member-of with attrs.role = "board-member".',
  advises: 'member-of with attrs.role = "advisor".',
  "advisor-to": 'member-of with attrs.role = "advisor".',
  advisor: 'member-of with attrs.role = "advisor".',
  "sits-on-board-of": 'member-of with attrs.role = "board-member".',
  "alumnus-of": 'member-of with attrs.role = "alumnus" and valid_to set to when the person left.',
  engaged: 'spouse-of with status "pending": an engagement is a marriage that is not valid yet.',
  "merged-with": "acquired-by, which names which organization survived. merged-with named neither.",
  "intro-path-to": "introduced-by, once the introduction has actually happened. A path nobody walked is a plan.",
  hosted: 'participant-in with attrs.role = "organizer".',
  "discussed-at": "about for the subject matter, plus participant-in for whoever was there.",
  "instance-of": "has-type pointing at a topic node, or offered-by when the target is the organization that provides it.",
  "model-of": "has-type pointing at a topic node.",
  "purchased-from": "sold-by, whose SOURCE is the thing sold rather than the buyer. The endpoints move; this is not a rename.",
  "bought-from": "sold-by, whose SOURCE is the thing sold rather than the buyer. The endpoints move; this is not a rename.",
  "created-for": "created with attrs.created_for naming the beneficiary object id.",
  "made-for": "created with attrs.created_for naming the beneficiary object id.",
  "related-topic": "about between the two subjects, or has-type when one of them classifies the other.",
  "part-of-topic": "the parent_topic_ref attribute on the topic endpoint. part-of is occurrence-only.",
  "partner-of": 'connects with attrs.relation = "partner".',
  "mentor-of": 'connects with attrs.relation = "mentor".',
  "related-to": "connects, with attrs.relation carrying whatever related-to's relation attr said."
};

export type PredicateCanonicalization =
  | { ok: true; predicate: Predicate; source: "canonical" | "safe-alias" }
  | { ok: false; reason: "unknown-predicate" | "direction-unsafe-alias" | "retired-predicate"; suggestion?: string };

export function canonicalizePredicate(input: string): PredicateCanonicalization {
  if (input in PredicateRegistry) {
    return { ok: true, predicate: input as Predicate, source: "canonical" };
  }

  const safeAlias = SafeAliasMap[input];
  if (safeAlias) {
    return { ok: true, predicate: safeAlias, source: "safe-alias" };
  }

  // Checked BEFORE the direction-unsafe set and before the unknown fallback: a
  // caller holding a retired name is holding real history, and "we do not know
  // that word" is the one answer that is certainly wrong.
  const replacement = RetiredPredicates[input];
  if (replacement) {
    return { ok: false, reason: "retired-predicate", suggestion: `${input} was retired. Use ${replacement}` };
  }

  if (DirectionUnsafeAliases.has(input)) {
    return {
      ok: false,
      reason: "direction-unsafe-alias",
      suggestion: "Use the canonical predicate with explicitly swapped endpoints and confirm direction."
    };
  }

  return { ok: false, reason: "unknown-predicate" };
}

export const MixedPrecisionDateSchema = z.string().refine((value) => {
  if (value === "unknown") {
    return true;
  }

  const withoutApprox = value.startsWith("~") ? value.slice(1) : value;
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(withoutApprox);
  if (!match) {
    return false;
  }

  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (month !== undefined && (month < 1 || month > 12)) {
    return false;
  }
  if (day !== undefined && (day < 1 || day > 31)) {
    return false;
  }
  if (month !== undefined && day !== undefined) {
    const year = Number(match[1]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day > daysInMonth) {
      return false;
    }
  }
  return true;
}, "Expected unknown, YYYY, YYYY-MM, YYYY-MM-DD, or approximate ~YYYY variants");
export const WorldTimeSchema = z.union([IsoTimestampSchema, MixedPrecisionDateSchema]);

export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
export const IanaTimezoneSchema = z.string().min(1).refine((value) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Expected a valid IANA timezone");
export const IcalendarDurationTextSchema = z.string().regex(/^[+-]?P(?:\d+W|(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?)$/).refine((value) => /\d/.test(value), "Expected an RFC 5545 duration");

function unfoldIcalendarText(value: string): string {
  return value.replace(/\r?\n[ \t]/g, "").trim();
}

function icalendarLines(value: string): string[] {
  return unfoldIcalendarText(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function icalendarPropertyName(line: string): string | undefined {
  const match = /^([A-Za-z-]+)(?:;[^:]*)?:/.exec(line);
  return match?.[1]?.toUpperCase();
}

function icalendarTimezoneIds(value: string): string[] {
  return icalendarLines(value).flatMap((line) =>
    [...line.matchAll(/(?:^|;)TZID=([^;:]+)/gi)].map((match) => match[1]).filter((timezone): timezone is string => timezone !== undefined)
  );
}

function isValidIcalendarRRuleText(value: string): boolean {
  const unfolded = unfoldIcalendarText(value);
  if (!unfolded || /\r?\n/.test(unfolded)) {
    return false;
  }
  const rruleLine = /^RRULE:/i.test(unfolded) ? unfolded : `RRULE:${unfolded}`;
  if (!/(?:^|[;:])FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/i.test(rruleLine)) {
    return false;
  }
  try {
    rrulestr(rruleLine);
    return true;
  } catch {
    return false;
  }
}

function isValidIcalendarRecurrenceSetText(value: string): boolean {
  const unfolded = unfoldIcalendarText(value);
  const lines = icalendarLines(unfolded);
  if (lines.length === 0) {
    return false;
  }

  let hasDtstart = false;
  let hasRRule = false;
  let hasRuleOrDate = false;
  for (const line of lines) {
    const property = icalendarPropertyName(line);
    if (!property || !["DTSTART", "RRULE", "RDATE", "EXDATE"].includes(property)) {
      return false;
    }
    if (property === "DTSTART") {
      hasDtstart = true;
    }
    if (property === "RRULE") {
      hasRRule = true;
      hasRuleOrDate = true;
      if (!isValidIcalendarRRuleText(line)) {
        return false;
      }
    }
    if (property === "RDATE") {
      hasRuleOrDate = true;
    }
  }
  if (!hasRuleOrDate) {
    return false;
  }
  if (hasRRule && !hasDtstart) {
    return false;
  }

  try {
    rrulestr(unfolded, { forceset: true });
    return true;
  } catch {
    return false;
  }
}

export const IcalendarRRuleTextSchema = z.string().min(1).refine(isValidIcalendarRRuleText, "Expected an RFC 5545 RRULE value or RRULE line with FREQ");
export const IcalendarRecurrenceSetTextSchema = z.string().min(1).refine(isValidIcalendarRecurrenceSetText, "Expected RFC 5545 recurrence lines using DTSTART/RRULE/RDATE/EXDATE and at least one RRULE or RDATE");

export const RecurrenceExceptionSchema = z
  .object({
    date: z.union([IsoTimestampSchema, MixedPrecisionDateSchema]),
    status: z.enum(["canceled", "moved", "skipped", "extra"]),
    replacement_start: IsoTimestampSchema.optional(),
    replacement_end: IsoTimestampSchema.optional(),
    note: z.string().optional()
  })
  .strict();

export const IcalendarRecurrenceSchema = z
  .object({
    timezone: IanaTimezoneSchema,
    recurrence_set: IcalendarRecurrenceSetTextSchema,
    duration: IcalendarDurationTextSchema.optional(),
    exceptions: z.array(RecurrenceExceptionSchema).default([])
  })
  .strict()
  .superRefine((recurrence, ctx) => {
    const timezoneIds = icalendarTimezoneIds(recurrence.recurrence_set);
    const mismatchedTimezone = timezoneIds.find((timezoneId) => timezoneId !== recurrence.timezone);
    if (mismatchedTimezone) {
      ctx.addIssue({
        code: "custom",
        path: ["recurrence_set"],
        message: `TZID ${mismatchedTimezone} must match timezone ${recurrence.timezone}`
      });
    }
  });
export type IcalendarRecurrence = z.infer<typeof IcalendarRecurrenceSchema>;

const EndpointBaseSchema = z
  .object({
    object_id: ObjectIdSchema,
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)).default([]),
    description: z.string().optional(),
    access_class: AccessClassSchema.default("local-private"),
    source_ref: z.string().min(1).optional(),
    confidence: ConfidenceSchema.default("medium"),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema
  })
  .strict();

// Seven of the eight endpoint schemas carry NO `subtype` key at all, and the
// base schema is strict, so a payload that still sends one is refused rather
// than silently dropped. That refusal is the point: a caller shipping
// `subtype: "company"` believes it has classified something, and the only way to
// tell it otherwise is to fail.

export const PersonEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("person"),
  primary_location_ref: ObjectIdSchema.optional(),
  notes_ref: ObjectIdSchema.optional()
});

export const OrganizationEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("organization"),
  founded_year: MixedPrecisionDateSchema.optional(),
  homepage_ref: z.string().min(1).optional(),
  primary_location_ref: ObjectIdSchema.optional()
});

export const ProjectEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("project"),
  status: z.string().min(1).optional(),
  start_date: MixedPrecisionDateSchema.optional(),
  end_date: MixedPrecisionDateSchema.optional(),
  primary_location_ref: ObjectIdSchema.optional()
});

export const LocationEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("location"),
  parent_location_ref: ObjectIdSchema.optional(),
  geo: z
    .object({
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      shape_ref: z.string().min(1).optional()
    })
    .strict()
    .optional(),
  timezone: IanaTimezoneSchema.optional()
});

export const OccurrenceStatusSchema = z.enum(["planned", "occurred", "canceled", "moved", "tentative"]);

export const OccurrenceEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("occurrence"),
  // Required, with no default. The four values are total over the corpus, but a
  // default would file every occurrence whose author did not choose under a word
  // nobody chose — which is exactly the silent misclassification that `other`
  // used to perform and that deleting `other` was meant to stop.
  subtype: OccurrenceSubtypeSchema,
  occurred_on: WorldTimeSchema.optional(),
  occurred_until: WorldTimeSchema.optional(),
  scheduled_start: IsoTimestampSchema.optional(),
  scheduled_end: IsoTimestampSchema.optional(),
  timezone: IanaTimezoneSchema.optional(),
  location_ref: ObjectIdSchema.optional(),
  participant_refs: z.array(ObjectIdSchema).default([]),
  organizer_refs: z.array(ObjectIdSchema).default([]),
  project_refs: z.array(ObjectIdSchema).default([]),
  recurrence_ref: ObjectIdSchema.optional(),
  recurrence: IcalendarRecurrenceSchema.optional(),
  status: OccurrenceStatusSchema.optional()
}).superRefine((occurrence, ctx) => {
  if (!occurrence.occurred_on && !occurrence.scheduled_start) {
    ctx.addIssue({
      code: "custom",
      path: ["occurred_on"],
      message: "occurrences must include occurred_on or scheduled_start"
    });
  }

  if ((occurrence.scheduled_start || occurrence.scheduled_end) && !occurrence.timezone && !occurrence.recurrence?.timezone) {
    ctx.addIssue({
      code: "custom",
      path: ["timezone"],
      message: "scheduled occurrences require a timezone"
    });
  }

  if (occurrence.status === "occurred" && !occurrence.occurred_on) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "occurrences with status occurred must include occurred_on"
    });
  }

  if (occurrence.occurred_on?.includes("T") && occurrence.occurred_until?.includes("T")) {
    const occurredOn = Date.parse(occurrence.occurred_on);
    const occurredUntil = Date.parse(occurrence.occurred_until);
    if (!Number.isNaN(occurredOn) && !Number.isNaN(occurredUntil) && occurredUntil < occurredOn) {
      ctx.addIssue({
        code: "custom",
        path: ["occurred_until"],
        message: "occurred_until must not be before occurred_on"
      });
    }
  }

  if (occurrence.scheduled_start && occurrence.scheduled_end) {
    const scheduledStart = Date.parse(occurrence.scheduled_start);
    const scheduledEnd = Date.parse(occurrence.scheduled_end);
    if (!Number.isNaN(scheduledStart) && !Number.isNaN(scheduledEnd) && scheduledEnd < scheduledStart) {
      ctx.addIssue({
        code: "custom",
        path: ["scheduled_end"],
        message: "scheduled_end must not be before scheduled_start"
      });
    }
  }
});

export const TopicEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("topic"),
  parent_topic_ref: ObjectIdSchema.optional(),
  controlled: z.literal(true).default(true),
  tags: z.array(z.string().min(1)).default([])
});

export const OfferingEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("offering"),
  provider_ref: ObjectIdSchema.optional(),
  homepage_ref: z.string().min(1).optional(),
  status: z.string().min(1).optional()
});

export const ItemEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("item"),
  offering_ref: ObjectIdSchema.optional(),
  owner_ref: ObjectIdSchema.optional(),
  location_ref: ObjectIdSchema.optional(),
  acquired_on: MixedPrecisionDateSchema.optional(),
  status: z.string().min(1).optional()
});

export const EndpointRecordSchema = z.discriminatedUnion("type", [
  PersonEndpointSchema,
  OrganizationEndpointSchema,
  ProjectEndpointSchema,
  LocationEndpointSchema,
  OccurrenceEndpointSchema,
  TopicEndpointSchema,
  OfferingEndpointSchema,
  ItemEndpointSchema
]);
export type EndpointRecord = z.infer<typeof EndpointRecordSchema>;

const TemporalEdgeReservedAttrKeys = new Set([
  "edge_id",
  "source_object_id",
  "source_type",
  "target_object_id",
  "target_type",
  "predicate",
  "valid_from",
  "valid_to",
  "status",
  "confidence",
  "source"
]);

const TemporalEdgeRejectedAttrKeys = new Set([
  "recurrence",
  "recurrence_set",
  "recurrence-set",
  "rrule",
  "dtstart",
  "rdate",
  "exdate",
  "starts_at_local",
  "starts-at-local"
]);

const NonEmptyStringSchema = z.string().min(1);
const TemporalEdgeAttrSchemas: Record<string, z.ZodType<unknown>> = {
  schedule: IcalendarRecurrenceSchema,
  amount: z.union([NonEmptyStringSchema, z.number().finite()]),
  investment_status: NonEmptyStringSchema,
  // The carrier for every distinction a collapsed predicate used to make in its
  // NAME: board-member-of, advises, alumnus-of and hosted are all a survivor
  // plus a role. Untyped on purpose — the set of roles is the graph's to grow,
  // and freezing it here would recreate the enum the collapse just removed.
  role: NonEmptyStringSchema,
  // created absorbed created-for, whose target was the beneficiary. Object ids
  // rather than free text, so the beneficiary stays an identity-checked node and
  // the collapse loses no referential integrity.
  created_for: z.union([ObjectIdSchema, z.array(ObjectIdSchema).min(1)]),
  via: z.union([NonEmptyStringSchema, z.array(NonEmptyStringSchema).min(1)]),
  relation: NonEmptyStringSchema,
  note: NonEmptyStringSchema,
  scope: NonEmptyStringSchema,
  condition: NonEmptyStringSchema,
  relationship: NonEmptyStringSchema,
  relationship_origin: NonEmptyStringSchema,
  comparable_to: z.union([NonEmptyStringSchema, z.array(NonEmptyStringSchema).min(1)])
};

export const TemporalEdgeSchema = z
  .object({
    edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
    source_object_id: ObjectIdSchema,
    source_type: EndpointTypeSchema,
    target_object_id: ObjectIdSchema,
    target_type: EndpointTypeSchema,
    predicate: PredicateSchema,
    valid_from: MixedPrecisionDateSchema,
    valid_to: MixedPrecisionDateSchema.optional(),
    status: EdgeStatusSchema.default("active"),
    confidence: ConfidenceSchema.default("medium"),
    source: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()).default({})
  })
  .superRefine((edge, ctx) => {
    const registry = PredicateRegistry[edge.predicate];

    // One implementation of the domain rule, shared with the throwing entry
    // point. Two copies of a direction check is how a store ends up accepting an
    // edge its own validator would refuse.
    const endpoints = checkPredicateEndpoints(edge.predicate, edge.source_type, edge.target_type);
    if (!endpoints.ok) {
      for (const violation of endpoints.violations) {
        ctx.addIssue({
          code: "custom",
          path: [violation.position === "source" ? "source_type" : "target_type"],
          message: violation.message
        });
      }
    }

    for (const required of registry.required) {
      if (required === "valid_from") {
        continue;
      }
      if (!(required in edge.attrs)) {
        ctx.addIssue({
          code: "custom",
          path: ["attrs", required],
          message: `${edge.predicate} requires ${required}`
        });
      }
    }

    for (const [key, value] of Object.entries(edge.attrs)) {
      if (TemporalEdgeReservedAttrKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["attrs", key],
          message: `${key} is an edge spine field and must not appear in attrs`
        });
      }

      if (TemporalEdgeRejectedAttrKeys.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["attrs", key],
          message: "Use attrs.schedule with IcalendarRecurrenceSchema for recurring edge schedules"
        });
      }

      const attrSchema = TemporalEdgeAttrSchemas[key];
      if (attrSchema) {
        const parsedAttr = attrSchema.safeParse(value);
        if (!parsedAttr.success) {
          ctx.addIssue({
            code: "custom",
            path: ["attrs", key],
            message: `${key} has an invalid structured attr value`
          });
        }
      }
    }

  });

export const EventKindSchema = z.enum([
  "relationship-formed",
  "stage-change",
  "role-change",
  "engagement",
  "org-change",
  "life-event",
  "contact",
  "observation",
  "correction",
  "invalidate",
  "split"
]);

export const TemporalEventSchema = z
  .object({
    event_id: EventIdSchema,
    subject_object_id: ObjectIdSchema,
    subject_type: EndpointTypeSchema,
    kind: EventKindSchema,
    occurred_on: WorldTimeSchema,
    occurred_until: WorldTimeSchema.optional(),
    recorded_at: IsoTimestampSchema,
    predicate: PredicateSchema.optional(),
    object_object_id: ObjectIdSchema.optional(),
    source: z.string().min(1),
    detail: z.string().optional(),
    supersedes: z.array(EventIdSchema).default([])
  })
  .superRefine((event, ctx) => {
    if ((event.kind === "correction" || event.kind === "split") && event.supersedes.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["supersedes"],
        message: "correction and split events must list superseded event ids"
      });
    }

    if (event.predicate && !event.object_object_id) {
      ctx.addIssue({
        code: "custom",
        path: ["object_object_id"],
        message: "events with a predicate must identify the object endpoint"
      });
    }

    if (event.occurred_on.includes("T") && event.occurred_until?.includes("T")) {
      const occurredOn = Date.parse(event.occurred_on);
      const occurredUntil = Date.parse(event.occurred_until);
      if (!Number.isNaN(occurredOn) && !Number.isNaN(occurredUntil) && occurredUntil < occurredOn) {
        ctx.addIssue({
          code: "custom",
          path: ["occurred_until"],
          message: "occurred_until must not be before occurred_on"
        });
      }
    }
  });

export type TemporalEdge = z.infer<typeof TemporalEdgeSchema>;
export type TemporalEvent = z.infer<typeof TemporalEventSchema>;
