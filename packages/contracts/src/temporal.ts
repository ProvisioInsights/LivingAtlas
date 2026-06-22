import { z } from "zod";
import { EventIdSchema, IsoTimestampSchema, ObjectIdSchema } from "./ids";

export const EndpointTypeValues = ["person", "organization", "project", "location", "cluster"] as const;
export const EndpointTypeSchema = z.enum(EndpointTypeValues);
export type EndpointType = z.infer<typeof EndpointTypeSchema>;

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
  "personal"
]);

export const PredicateRegistry = {
  "employed-by": { category: "employment", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  "reports-to": { category: "employment", direction: "directed", domain: ["person"], range: ["person"], required: ["valid_from"] },
  "founder-of": { category: "employment", direction: "directed", domain: ["person"], range: ["organization", "project"], required: ["valid_from"] },
  "board-member-of": { category: "governance", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  advises: { category: "advisory", direction: "directed", domain: ["person"], range: ["organization", "project"], required: ["valid_from"] },
  "invests-in": { category: "capital", direction: "directed", domain: ["person", "organization"], range: ["organization", "project"], required: ["amount", "status"] },
  "customer-of": { category: "customer", direction: "directed", domain: ["organization"], range: ["organization"], required: [] },
  engaged: { category: "customer", direction: "directed", domain: ["person"], range: ["organization"], required: ["valid_from"] },
  "acquired-by": { category: "structural", direction: "directed", domain: ["organization"], range: ["organization"], required: ["valid_from"] },
  "merged-with": { category: "structural", direction: "symmetric", domain: ["organization"], range: ["organization"], required: ["valid_from"] },
  "introduced-by": { category: "network", direction: "directed", domain: ["person"], range: ["person"], required: [] },
  "intro-path-to": { category: "network", direction: "directed", domain: ["person"], range: ["organization", "person"], required: ["via"] },
  connects: { category: "network", direction: "symmetric", domain: ["person"], range: ["person"], required: ["note"] },
  "member-of": { category: "affiliation", direction: "directed", domain: ["person"], range: ["organization", "cluster"], required: [] },
  "alumnus-of": { category: "affiliation", direction: "directed", domain: ["person"], range: ["organization"], required: [] },
  "based-in": { category: "geography", direction: "directed", domain: ["person", "organization"], range: ["location"], required: [] },
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
    occurred_on: MixedPrecisionDateSchema,
    occurred_until: MixedPrecisionDateSchema.optional(),
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
  });

export type TemporalEdge = z.infer<typeof TemporalEdgeSchema>;
export type TemporalEvent = z.infer<typeof TemporalEventSchema>;
