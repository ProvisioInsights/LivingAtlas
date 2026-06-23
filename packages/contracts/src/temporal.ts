import { z } from "zod";
import * as rrule from "rrule";
import { AccessClassSchema } from "./classification";
import { EventIdSchema, IsoTimestampSchema, ObjectIdSchema } from "./ids";

const { rrulestr } = rrule;

export const EndpointTypeValues = ["person", "organization", "project", "location", "occurrence", "topic"] as const;
export const EndpointTypeSchema = z.enum(EndpointTypeValues);
export type EndpointType = z.infer<typeof EndpointTypeSchema>;

export const PersonSubtypeSchema = z.enum(["individual", "role-account"]);
export const OrganizationSubtypeSchema = z.enum([
  "company",
  "nonprofit",
  "government",
  "education",
  "fund",
  "community",
  "team",
  "cohort",
  "family-office",
  "other"
]);
export const ProjectSubtypeSchema = z.enum([
  "initiative",
  "product",
  "deal",
  "research",
  "campaign",
  "engagement",
  "case",
  "other"
]);
export const LocationSubtypeSchema = z.enum([
  "country",
  "region",
  "city",
  "venue",
  "address",
  "site",
  "other"
]);
export const OccurrenceSubtypeSchema = z.enum([
  "meeting",
  "appointment",
  "social",
  "work-session",
  "travel",
  "milestone",
  "life-event",
  "observation",
  "transaction",
  "other"
]);
export const TopicSubtypeSchema = z.enum([
  "domain",
  "theme",
  "skill",
  "interest",
  "risk",
  "question",
  "other"
]);

export const EndpointSubtypeSchema = z.union([
  PersonSubtypeSchema,
  OrganizationSubtypeSchema,
  ProjectSubtypeSchema,
  LocationSubtypeSchema,
  OccurrenceSubtypeSchema,
  TopicSubtypeSchema
]);
export type EndpointSubtype = z.infer<typeof EndpointSubtypeSchema>;

export const EdgeStatusSchema = z.enum(["active", "pending", "ended", "dormant"]);
export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export const EdgeCategorySchema = z.enum([
  "employment",
  "governance",
  "advisory",
  "capital",
  "structural",
  "customer",
  "network",
  "affiliation",
  "geography",
  "occurrence",
  "taxonomy",
  "personal"
]);

export const PredicateRegistry = {
  "employed-by": { category: "employment", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  "reports-to": { category: "employment", direction: "directed", domain: ["person"], range: ["person"], required: ["valid_from"] },
  "founder-of": { category: "employment", direction: "directed", domain: ["person"], range: ["organization", "project"], required: ["valid_from"] },
  "board-member-of": { category: "governance", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  advises: { category: "advisory", direction: "directed", domain: ["person"], range: ["organization", "project"], required: ["valid_from"] },
  "invests-in": { category: "capital", direction: "directed", domain: ["person", "organization"], range: ["organization", "project"], required: ["amount", "investment_status"] },
  "customer-of": { category: "customer", direction: "directed", domain: ["organization"], range: ["organization"], required: [] },
  engaged: { category: "customer", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  "acquired-by": { category: "structural", direction: "directed", domain: ["organization"], range: ["organization"], required: ["valid_from"] },
  "merged-with": { category: "structural", direction: "symmetric", domain: ["organization"], range: ["organization"], required: ["valid_from"] },
  "introduced-by": { category: "network", direction: "directed", domain: ["person"], range: ["person"], required: [] },
  "intro-path-to": { category: "network", direction: "directed", domain: ["person"], range: ["organization", "person"], required: ["via"] },
  connects: { category: "network", direction: "symmetric", domain: ["person"], range: ["person"], required: ["note"] },
  "member-of": { category: "affiliation", direction: "directed", domain: ["person"], range: ["organization"], required: [] },
  "alumnus-of": { category: "affiliation", direction: "directed", domain: ["person"], range: ["organization"], required: [] },
  "based-in": { category: "geography", direction: "directed", domain: ["person", "organization"], range: ["location"], required: [] },
  "participant-in": { category: "occurrence", direction: "directed", domain: ["person", "organization"], range: ["occurrence"], required: [] },
  "occurred-at": { category: "occurrence", direction: "directed", domain: ["occurrence"], range: ["location"], required: [] },
  hosted: { category: "occurrence", direction: "directed", domain: ["person", "organization"], range: ["occurrence"], required: [] },
  "discussed-at": { category: "occurrence", direction: "directed", domain: ["organization", "project", "topic"], range: ["occurrence"], required: [] },
  about: { category: "taxonomy", direction: "directed", domain: ["person", "organization", "project", "occurrence"], range: ["topic"], required: [] },
  "related-topic": { category: "taxonomy", direction: "symmetric", domain: ["topic"], range: ["topic"], required: [] },
  "part-of-topic": { category: "taxonomy", direction: "directed", domain: ["topic"], range: ["topic"], required: [] },
  "spouse-of": { category: "personal", direction: "symmetric", domain: ["person"], range: ["person"], required: [] },
  "partner-of": { category: "personal", direction: "symmetric", domain: ["person"], range: ["person"], required: [] },
  "parent-of": { category: "personal", direction: "directed", domain: ["person"], range: ["person"], required: [] },
  "sibling-of": { category: "personal", direction: "symmetric", domain: ["person"], range: ["person"], required: [] },
  "related-to": { category: "personal", direction: "symmetric", domain: ["person"], range: ["person"], required: ["relation"] },
  "estranged-from": { category: "personal", direction: "symmetric", domain: ["person"], range: ["person"], required: [] },
  "mentor-of": { category: "personal", direction: "directed", domain: ["person"], range: ["person"], required: [] }
} as const;

export type Predicate = keyof typeof PredicateRegistry;
export const PredicateSchema = z.enum(Object.keys(PredicateRegistry) as [Predicate, ...Predicate[]]);

const SafeAliasMap: Record<string, Predicate> = {
  "works-at": "employed-by",
  "works-for": "employed-by",
  "employee-of": "employed-by",
  "advisor-to": "advises",
  advisor: "advises",
  "investor-in": "invests-in",
  backs: "invests-in",
  "client-of": "customer-of",
  "co-founded": "founder-of",
  "married-to": "spouse-of",
  "sits-on-board-of": "board-member-of",
  knows: "connects",
  "connected-to": "connects"
};

const DirectionUnsafeAliases = new Set(["manages", "acquired", "bought", "led-by", "board-includes", "employs", "portfolio-company-of", "funded-by"]);

export type PredicateCanonicalization =
  | { ok: true; predicate: Predicate; source: "canonical" | "safe-alias" }
  | { ok: false; reason: "unknown-predicate" | "direction-unsafe-alias"; suggestion?: string };

export function canonicalizePredicate(input: string): PredicateCanonicalization {
  if (input in PredicateRegistry) {
    return { ok: true, predicate: input as Predicate, source: "canonical" };
  }

  const safeAlias = SafeAliasMap[input];
  if (safeAlias) {
    return { ok: true, predicate: safeAlias, source: "safe-alias" };
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

export const PersonEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("person"),
  subtype: PersonSubtypeSchema.default("individual"),
  primary_location_ref: ObjectIdSchema.optional(),
  notes_ref: ObjectIdSchema.optional()
});

export const OrganizationEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("organization"),
  subtype: OrganizationSubtypeSchema.default("other"),
  founded_year: MixedPrecisionDateSchema.optional(),
  homepage_ref: z.string().min(1).optional(),
  primary_location_ref: ObjectIdSchema.optional()
});

export const ProjectEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("project"),
  subtype: ProjectSubtypeSchema.default("other"),
  status: z.string().min(1).optional(),
  start_date: MixedPrecisionDateSchema.optional(),
  end_date: MixedPrecisionDateSchema.optional(),
  primary_location_ref: ObjectIdSchema.optional()
});

export const LocationEndpointSchema = EndpointBaseSchema.extend({
  type: z.literal("location"),
  subtype: LocationSubtypeSchema.default("other"),
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
  subtype: OccurrenceSubtypeSchema.default("other"),
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
  subtype: TopicSubtypeSchema.default("other"),
  parent_topic_ref: ObjectIdSchema.optional(),
  controlled: z.literal(true).default(true),
  tags: z.array(z.string().min(1)).default([])
});

export const EndpointRecordSchema = z.discriminatedUnion("type", [
  PersonEndpointSchema,
  OrganizationEndpointSchema,
  ProjectEndpointSchema,
  LocationEndpointSchema,
  OccurrenceEndpointSchema,
  TopicEndpointSchema
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
  role: NonEmptyStringSchema,
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
    if (!(registry.domain as readonly string[]).includes(edge.source_type)) {
      ctx.addIssue({
        code: "custom",
        path: ["source_type"],
        message: `${edge.predicate} does not accept ${edge.source_type} as a source endpoint`
      });
    }

    if (!(registry.range as readonly string[]).includes(edge.target_type)) {
      ctx.addIssue({
        code: "custom",
        path: ["target_type"],
        message: `${edge.predicate} does not accept ${edge.target_type} as a target endpoint`
      });
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
