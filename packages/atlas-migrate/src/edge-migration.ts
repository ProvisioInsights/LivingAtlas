import { z } from "zod";
import {
  ConfidenceSchema,
  EdgeStatusSchema,
  EndpointTypeSchema,
  MixedPrecisionDateSchema,
  ObjectIdSchema,
  PredicateRegistry,
  RetiredPredicates,
  TemporalEdgeSchema,
  canonicalizePredicate,
  checkPredicateEndpoints,
  type EndpointType,
  type OccurrenceSubtype,
  type Predicate,
  type TemporalEdge
} from "@living-atlas/contracts";
import { canonicalDigest } from "./target-plane.js";

export type EdgeStatus = z.infer<typeof EdgeStatusSchema>;

/**
 * A legacy edge AS STORED, with the predicate left as free text.
 *
 * It is the edge counterpart of `LegacyEndpointPayloadSchema` and it exists for
 * the same reason: `TemporalEdgeSchema.predicate` is `PredicateSchema`, the
 * ratified twenty-five, so parsing a legacy edge with it refuses every retired
 * name, every safe alias and every direction-unsafe alias AT THE PARSE — before
 * the absorption table has been consulted, and with `invalid-legacy-payload` as
 * the only reason available to report. A `board-member-of` edge is not a
 * malformed payload; it is a well-formed edge in the vocabulary the old store
 * spoke, and reading it is the whole job.
 *
 * Every other field is the contract's, unchanged: the widening is the predicate
 * and nothing else, so a legacy edge cannot smuggle a malformed date or a
 * non-endpoint type past the projector on the strength of this schema.
 */
export const LegacyTemporalEdgeSchema = z.object({
  edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
  source_object_id: ObjectIdSchema,
  source_type: EndpointTypeSchema,
  target_object_id: ObjectIdSchema,
  target_type: EndpointTypeSchema,
  predicate: z.string().min(1),
  valid_from: MixedPrecisionDateSchema,
  valid_to: MixedPrecisionDateSchema.optional(),
  status: EdgeStatusSchema.default("active"),
  confidence: ConfidenceSchema.default("medium"),
  source: z.string().min(1),
  attrs: z.record(z.string(), z.unknown()).default({})
});
export type LegacyTemporalEdge = z.infer<typeof LegacyTemporalEdgeSchema>;

/**
 * A node as the legacy plane held it.
 *
 * `subtype` is free text rather than a typed enum because the seven retired
 * subtype enums no longer exist in the contract to type it against. Typing this
 * field against the surviving occurrence enum would make the legacy corpus
 * unreadable by the very tool written to read it.
 */
export type LegacyGraphNode = {
  object_id: string;
  type: EndpointType;
  subtype?: string;
};

/**
 * A legacy edge, deliberately WITHOUT `source_type` / `target_type`.
 *
 * The legacy plane stored an endpoint type on the edge itself. Carrying that
 * copy forward is precisely what would let a retype and a rewrite drift apart:
 * the node table would say `occurrence` while the edge still said `item`, and a
 * domain check reading the edge's own copy would happily certify a person owning
 * an event. Endpoint types are therefore resolved from the node table at plan
 * time and from the transaction's post-state at commit time, never from the edge.
 */
export type LegacyGraphEdge = {
  edge_id: string;
  source_object_id: string;
  target_object_id: string;
  /** Free text on purpose: retired names are what this module exists to read. */
  predicate: string;
  valid_from: string;
  valid_to?: string;
  status?: EdgeStatus;
  source: string;
  attrs?: Record<string, unknown>;
};

export type LegacyGraph = {
  authority_id: string;
  nodes: LegacyGraphNode[];
  edges: LegacyGraphEdge[];
};

// ---------------------------------------------------------------------------
// the travel retype (gate G1a)
// ---------------------------------------------------------------------------

/**
 * Legacy `item` subtypes that name a journey rather than a possession. Measured
 * on the graph: 165 rideshare, 146 flight, 6 car-service, 4 drive, 2 train — the
 * 323 objects that `owns` points at. A taxi ride is an event a person took part
 * in, not a thing they hold, and the whole `owns` -> `participant-in` rewrite
 * exists because the legacy plane could not tell those apart.
 */
export const TravelItemSubtypes = ["rideshare", "flight", "car-service", "drive", "train"] as const;
export type TravelItemSubtype = (typeof TravelItemSubtypes)[number];

const TravelItemSubtypeSet = new Set<string>(TravelItemSubtypes);

/** Every travel item becomes the one occurrence subtype that names a leg. */
export const TravelOccurrenceSubtype = "segment" satisfies OccurrenceSubtype;

export type NodeRetype = {
  object_id: string;
  from_type: EndpointType;
  from_subtype?: string;
  to_type: EndpointType;
  to_subtype: OccurrenceSubtype;
};

// ---------------------------------------------------------------------------
// absorptions
// ---------------------------------------------------------------------------

/**
 * How a retired predicate survives its own retirement.
 *
 * A collapse is only lossless if the distinction the retired NAME carried lands
 * somewhere a query can still reach. `board-member-of` and `advises` and
 * `alumnus-of` all become `member-of`; without `attrs.role` the three become
 * indistinguishable and the collapse has destroyed information rather than
 * normalised it. Every rule here therefore either writes an attr, sets a status,
 * or carries a legacy attr across under its contract name.
 */
export type EdgeAbsorptionRule = {
  predicate: Predicate;
  /** Attrs the collapse writes because the retired NAME asserted them. */
  set_attrs?: Readonly<Record<string, string>>;
  /** Legacy attr key -> contract attr key. Copied only when the legacy edge had it. */
  carry_attrs?: Readonly<Record<string, string>>;
  /** Edge status the collapse must set, where the retired name implied one. */
  status?: EdgeStatus;
  /**
   * The collapse is only honest if the legacy edge already bounded the relation
   * in time. Set for `alumnus-of`: "was a member and no longer is" IS the
   * argument for folding it into `member-of`, so an alumnus edge with no
   * `valid_to` cannot be migrated without inventing the year somebody left.
   */
  requires_valid_to?: boolean;
  note: string;
};

/**
 * The ratified absorptions, and only those.
 *
 * Every OTHER retired name is refused with the contract's own suggestion string
 * attached rather than absorbed by guesswork here. `reports-to` is the reason
 * that matters: its replacement is `employed-by`, whose range is `organization`,
 * but a `reports-to` edge names a manager and no employer at all. Absorbing it
 * would mean inventing the organization, so it is refused and counted.
 */
export const EdgeAbsorptionRules: Readonly<Record<string, EdgeAbsorptionRule>> = {
  "board-member-of": {
    predicate: "member-of",
    set_attrs: { role: "board-member" },
    note: "The seat is a role, not a separate relation."
  },
  advises: {
    predicate: "member-of",
    set_attrs: { role: "advisor" },
    note: "Advising is a role, not a separate relation."
  },
  "alumnus-of": {
    predicate: "member-of",
    set_attrs: { role: "alumnus" },
    requires_valid_to: true,
    note: "A membership that ended. The time bound is the claim, so it is not optional."
  },
  "mentor-of": {
    predicate: "connects",
    set_attrs: { relation: "mentor" },
    note: "The relation lived in the predicate name; it moves to attrs.relation."
  },
  "partner-of": {
    predicate: "connects",
    set_attrs: { relation: "partner" },
    note: "The relation lived in the predicate name; it moves to attrs.relation."
  },
  "related-to": {
    predicate: "connects",
    carry_attrs: { relation: "relation" },
    note: "A true synonym for connects. attrs.relation is carried when the legacy edge had one and is NOT invented when it did not — connects requires no discriminator precisely so this migration need not fabricate a word."
  },
  engaged: {
    predicate: "spouse-of",
    status: "pending",
    note: "An engagement is a marriage that is not valid yet, which the bitemporal spine already expresses as a pending edge."
  },
  "purchased-from": {
    predicate: "sold-by",
    note: "Renamed. The rename only holds when the legacy source was the thing sold; a purchased-from whose source is the BUYER names no merchandise and is refused rather than re-pointed."
  },
  "created-for": {
    predicate: "created",
    carry_attrs: { created_for: "created_for", beneficiary: "created_for" },
    note: "created absorbs created-for through attrs.created_for. Holds only when the legacy target is the artifact; a created-for whose target is the beneficiary names no artifact and is refused."
  }
};

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

/**
 * Closed set. An edge that cannot be migrated lands on exactly one of these and
 * is counted; nothing is dropped and nothing is silently re-pointed at a
 * different node to make a rule pass.
 */
export const EdgeMigrationRefusalReasonValues = [
  "dangling-edge-endpoint",
  "predicate-domain-violation",
  "predicate-range-violation",
  "retired-predicate-without-absorption",
  "direction-unsafe-alias",
  "unknown-predicate",
  "absorption-requires-valid-to",
  "absorption-endpoints-unavailable",
  "absorption-attr-conflict",
  "invalid-migrated-edge"
] as const;
export const EdgeMigrationRefusalReasonSchema = z.enum(EdgeMigrationRefusalReasonValues);
export type EdgeMigrationRefusalReason = z.infer<typeof EdgeMigrationRefusalReasonSchema>;

export type EdgeMigrationRefusal = {
  edge_id: string;
  legacy_predicate: string;
  reason: EdgeMigrationRefusalReason;
  detail: string;
};

export type EdgeRewrite = {
  edge_id: string;
  legacy_predicate: string;
  /** Already parsed by TemporalEdgeSchema, so a rewrite in a plan is contract-valid by construction. */
  edge: TemporalEdge;
};

/**
 * The unit of atomicity. A transaction's post-state is validated as a whole, so
 * anything that must never be observed together must travel together.
 *
 * `edge_withdrawals` carries the ids of the edges this transaction removes —
 * every edge the plan refused. Leaving a refused edge in place would mean the
 * migrated plane still holds an edge its own vocabulary rejects, which is the
 * silent-drop failure inverted: nothing was dropped, and the result is wrong
 * anyway. The REASON each id was withdrawn is in `plan.refusals`, kept in one
 * place so the two cannot disagree about why an edge went away.
 */
export type MigrationTransaction = {
  ordinal: number;
  node_retypes: NodeRetype[];
  edge_rewrites: EdgeRewrite[];
  edge_withdrawals: string[];
};

export type EdgeMigrationBreakdown = {
  legacy_edge_count: number;
  migrated_count: number;
  refused_count: number;
  nodes_retyped: number;
  refusals_by_reason: Array<{ reason: EdgeMigrationRefusalReason; count: number }>;
  absorptions_by_rule: Array<{ from: string; to: Predicate; count: number }>;
  migrated_by_predicate: Array<{ predicate: Predicate; count: number }>;
};

export const EdgeMigrationPlanSchemaName = "living-atlas-migration-edge-plan:v1" as const;

export type EdgeMigrationPlan = {
  plan_schema: typeof EdgeMigrationPlanSchemaName;
  authority_id: string;
  transactions: MigrationTransaction[];
  refusals: EdgeMigrationRefusal[];
  breakdown: EdgeMigrationBreakdown;
  plan_digest: `sha256:${string}`;
};

function countBy<T extends string>(values: T[], universe: readonly T[]): Array<{ value: T; count: number }> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return universe
    .filter((candidate) => (counts.get(candidate) ?? 0) > 0)
    .map((candidate) => ({ value: candidate, count: counts.get(candidate) ?? 0 }));
}

const PredicateUniverse = Object.keys(PredicateRegistry).sort() as Predicate[];
const AbsorptionRuleUniverse = Object.keys(EdgeAbsorptionRules).sort();

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

export type ResolvedTypes = { source: EndpointType; target: EndpointType };

/**
 * The parts of a legacy edge the predicate resolution actually reads.
 *
 * Structural rather than nominal so BOTH callers pass their own shape without a
 * conversion step: `planEdgeMigration` holds a `LegacyGraphEdge`, the projector
 * holds a `LegacyTemporalEdge`, and a conversion between them is one more place
 * for the two paths to disagree about what an absorption saw. The defect this
 * prevents is the one the review found: the absorption table existed, was
 * tested, and was reachable from exactly one caller — the test.
 */
export type LegacyEdgeFacts = {
  predicate: string;
  valid_to?: string;
  attrs?: Record<string, unknown>;
};

export type PredicateResolution =
  | { ok: true; predicate: Predicate; attrs: Record<string, unknown>; status?: EdgeStatus; valid_to?: string }
  | { ok: false; reason: EdgeMigrationRefusalReason; detail: string };

/**
 * Applies one absorption rule, refusing rather than guessing whenever the rule
 * cannot be satisfied from what the legacy edge actually carried.
 */
function applyAbsorption(
  legacyPredicate: string,
  rule: EdgeAbsorptionRule,
  edge: LegacyEdgeFacts,
  types: ResolvedTypes
): PredicateResolution {
  const definition = PredicateRegistry[rule.predicate];

  // Checked BEFORE the attrs, because an absorption whose endpoints do not fit
  // the successor is not a rule that needs better attrs — it is a rule that
  // would have to invent a node. `purchased-from` from a buyer and `created-for`
  // at a beneficiary both land here.
  const endpoints = checkPredicateEndpoints(rule.predicate, types.source, types.target);
  if (!endpoints.ok) {
    return {
      ok: false,
      reason: "absorption-endpoints-unavailable",
      detail:
        `${legacyPredicate} absorbs into ${rule.predicate} (${definition.domain.join("|")} -> ` +
        `${definition.range.join("|")}), but this edge is ${types.source} -> ${types.target}. ` +
        "The endpoint the successor needs is not named by this edge and will not be invented."
    };
  }

  const attrs: Record<string, unknown> = { ...(edge.attrs ?? {}) };

  for (const [key, value] of Object.entries(rule.set_attrs ?? {})) {
    const existing = attrs[key];
    if (existing !== undefined && existing !== value) {
      // Overwriting would destroy a value the legacy edge actually held, which
      // is the one thing an absorption must not do.
      return {
        ok: false,
        reason: "absorption-attr-conflict",
        detail: `${legacyPredicate} would write attrs.${key}="${value}" over an existing value`
      };
    }
    attrs[key] = value;
  }

  for (const [legacyKey, contractKey] of Object.entries(rule.carry_attrs ?? {})) {
    const carried = attrs[legacyKey];
    if (carried === undefined) {
      continue;
    }
    const existing = attrs[contractKey];
    if (legacyKey !== contractKey && existing !== undefined && existing !== carried) {
      return {
        ok: false,
        reason: "absorption-attr-conflict",
        detail: `${legacyPredicate} would carry attrs.${legacyKey} onto an occupied attrs.${contractKey}`
      };
    }
    attrs[contractKey] = carried;
    if (legacyKey !== contractKey) {
      delete attrs[legacyKey];
    }
  }

  if (rule.requires_valid_to && edge.valid_to === undefined) {
    return {
      ok: false,
      reason: "absorption-requires-valid-to",
      detail:
        `${legacyPredicate} collapses into ${rule.predicate} because the membership ENDED; ` +
        "this edge records no valid_to and the end date will not be invented"
    };
  }

  return {
    ok: true,
    predicate: rule.predicate,
    attrs,
    ...(rule.status ? { status: rule.status } : {})
  };
}

/**
 * Chooses the predicate a legacy edge migrates to.
 *
 * The `owns` case is the one that is not a vocabulary lookup: whether it stays
 * `owns` or becomes `participant-in` depends on what its TARGET turned into, so
 * the answer is a function of the retype and cannot be computed without it. That
 * is why `types` must be the POST-retype types: passing the legacy types here
 * would leave the rule looking at `item`, the rewrite would never fire, and the
 * plan would assert that a person owns an event.
 *
 * Exported because the projector is the path that actually runs against the
 * corpus and must reach the same answers as `planEdgeMigration`. Two
 * implementations of the absorption table is how one of them silently stops
 * being the one that ships.
 */
export function resolveMigratedPredicate(edge: LegacyEdgeFacts, types: ResolvedTypes): PredicateResolution {
  const attrs: Record<string, unknown> = { ...(edge.attrs ?? {}) };

  if (edge.predicate === "owns" && types.target === "occurrence") {
    // G1a. A person does not own a taxi ride. This rewrite and the retype that
    // made the target an occurrence are inseparable, which is why they are
    // planned together and committed together.
    return { ok: true, predicate: "participant-in", attrs };
  }

  const canonical = canonicalizePredicate(edge.predicate);
  if (canonical.ok) {
    return { ok: true, predicate: canonical.predicate, attrs };
  }

  if (canonical.reason === "retired-predicate") {
    const rule = EdgeAbsorptionRules[edge.predicate];
    if (!rule) {
      return {
        ok: false,
        reason: "retired-predicate-without-absorption",
        detail: RetiredPredicates[edge.predicate] ?? "this predicate was retired with no successor recorded"
      };
    }
    return applyAbsorption(edge.predicate, rule, edge, types);
  }

  if (canonical.reason === "direction-unsafe-alias") {
    return {
      ok: false,
      reason: "direction-unsafe-alias",
      detail: canonical.suggestion ?? "this alias does not fix which way the edge points"
    };
  }

  return { ok: false, reason: "unknown-predicate", detail: `${edge.predicate} is not in the vocabulary` };
}

export type PlanEdgeMigrationOptions = {
  /** Stamped into every migrated edge's `source`, so a reader can tell an import from an authored edge. */
  migration_source?: string;
};

/**
 * Plans the migration of a legacy graph onto the ratified predicate vocabulary.
 *
 * Pure: the same input always yields the same plan, nothing is written, and no
 * clock is read. The retypes and the edge rewrites land in ONE transaction
 * because there is no ordering of the two that is safe to observe — see
 * `commitTransaction`.
 */
export function planEdgeMigration(graph: LegacyGraph, options: PlanEdgeMigrationOptions = {}): EdgeMigrationPlan {
  const migrationSource = options.migration_source ?? "atlas-migrate-edge-migration:v1";

  const retypes: NodeRetype[] = [];
  const typeById = new Map<string, EndpointType>();

  for (const node of graph.nodes) {
    if (node.type === "item" && node.subtype !== undefined && TravelItemSubtypeSet.has(node.subtype)) {
      retypes.push({
        object_id: node.object_id,
        from_type: node.type,
        ...(node.subtype === undefined ? {} : { from_subtype: node.subtype }),
        to_type: "occurrence",
        to_subtype: TravelOccurrenceSubtype
      });
      // The post-retype type is what every later check reads. Recording the
      // legacy type here instead would let an `owns` edge validate against the
      // node's old shape and certify exactly the state this lane must prevent.
      typeById.set(node.object_id, "occurrence");
      continue;
    }
    typeById.set(node.object_id, node.type);
  }

  const rewrites: EdgeRewrite[] = [];
  const refusals: EdgeMigrationRefusal[] = [];
  const absorbed: string[] = [];

  for (const edge of graph.edges) {
    const sourceType = typeById.get(edge.source_object_id);
    const targetType = typeById.get(edge.target_object_id);

    if (sourceType === undefined || targetType === undefined) {
      const missing = sourceType === undefined ? "source" : "target";
      refusals.push({
        edge_id: edge.edge_id,
        legacy_predicate: edge.predicate,
        reason: "dangling-edge-endpoint",
        detail: `edge ${missing} endpoint is not a node in this graph; no target will be invented for it`
      });
      continue;
    }

    const types: ResolvedTypes = { source: sourceType, target: targetType };
    const resolved = resolveMigratedPredicate(edge, types);
    if (!resolved.ok) {
      refusals.push({
        edge_id: edge.edge_id,
        legacy_predicate: edge.predicate,
        reason: resolved.reason,
        detail: resolved.detail
      });
      continue;
    }

    // The domain rule, on the types the nodes will actually have. Runs for every
    // edge including the ones that kept their predicate: a legacy `based-in`
    // written location -> organization is wrong in the new vocabulary no matter
    // that its name survived.
    const endpoints = checkPredicateEndpoints(resolved.predicate, types.source, types.target);
    if (!endpoints.ok) {
      const violation = endpoints.violations[0];
      refusals.push({
        edge_id: edge.edge_id,
        legacy_predicate: edge.predicate,
        reason: violation.code,
        detail: endpoints.violations.map((each) => each.message).join("; ")
      });
      continue;
    }

    const candidate = {
      edge_id: edge.edge_id,
      source_object_id: edge.source_object_id,
      source_type: types.source,
      target_object_id: edge.target_object_id,
      target_type: types.target,
      predicate: resolved.predicate,
      valid_from: edge.valid_from,
      ...(edge.valid_to === undefined ? {} : { valid_to: edge.valid_to }),
      status: resolved.status ?? edge.status ?? "active",
      source: migrationSource,
      attrs: resolved.attrs
    };

    const parsed = TemporalEdgeSchema.safeParse(candidate);
    if (!parsed.success) {
      refusals.push({
        edge_id: edge.edge_id,
        legacy_predicate: edge.predicate,
        reason: "invalid-migrated-edge",
        detail: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      });
      continue;
    }

    rewrites.push({ edge_id: edge.edge_id, legacy_predicate: edge.predicate, edge: parsed.data });
    if (EdgeAbsorptionRules[edge.predicate]) {
      absorbed.push(edge.predicate);
    }
  }

  const transaction: MigrationTransaction = {
    ordinal: 0,
    node_retypes: retypes,
    edge_rewrites: rewrites,
    edge_withdrawals: refusals.map((refusal) => refusal.edge_id)
  };

  const breakdown: EdgeMigrationBreakdown = {
    legacy_edge_count: graph.edges.length,
    migrated_count: rewrites.length,
    refused_count: refusals.length,
    nodes_retyped: retypes.length,
    refusals_by_reason: countBy(
      refusals.map((refusal) => refusal.reason),
      EdgeMigrationRefusalReasonValues
    ).map(({ value, count }) => ({ reason: value, count })),
    absorptions_by_rule: countBy(absorbed, AbsorptionRuleUniverse).map(({ value, count }) => ({
      from: value,
      to: EdgeAbsorptionRules[value]!.predicate,
      count
    })),
    migrated_by_predicate: countBy(
      rewrites.map((rewrite) => rewrite.edge.predicate),
      PredicateUniverse
    ).map(({ value, count }) => ({ predicate: value, count }))
  };

  const content = {
    plan_schema: EdgeMigrationPlanSchemaName,
    authority_id: graph.authority_id,
    transactions: [transaction],
    refusals,
    breakdown
  };

  return { ...content, plan_digest: canonicalDigest(content) };
}

// ---------------------------------------------------------------------------
// the graph state, and what makes a transaction refusable
// ---------------------------------------------------------------------------

export type MigrationGraphState = {
  nodes: Array<{ object_id: string; type: EndpointType; subtype?: string }>;
  edges: Array<{ edge_id: string; source_object_id: string; target_object_id: string; predicate: string }>;
};

export type StateDomainViolation = {
  edge_id: string;
  /** The predicate as the state holds it — a retired name is a string no `Predicate` covers. */
  predicate: string;
  code:
    | "predicate-domain-violation"
    | "predicate-range-violation"
    | "dangling-edge-endpoint"
    | "unratified-predicate";
  message: string;
};

/**
 * The domain rules read against a WHOLE graph state rather than a single edge.
 *
 * This is the check that makes "no intermediate state where a person owns an
 * event" enforceable rather than merely intended. `owns` has range
 * [item, offering, organization]; the moment a travel item becomes an
 * occurrence, every `owns` edge still pointing at it is a range violation. A
 * migration that retyped the nodes in one transaction and rewrote the edges in
 * the next would therefore leave a post-state this function rejects — which is
 * why it is run on every commit and not only at the end.
 */
export function findStateDomainViolations(state: MigrationGraphState): StateDomainViolation[] {
  const typeById = new Map<string, EndpointType>();
  for (const node of state.nodes) {
    typeById.set(node.object_id, node.type);
  }

  const violations: StateDomainViolation[] = [];
  for (const edge of state.edges) {
    const sourceType = typeById.get(edge.source_object_id);
    const targetType = typeById.get(edge.target_object_id);
    if (sourceType === undefined || targetType === undefined) {
      violations.push({
        edge_id: edge.edge_id,
        predicate: edge.predicate,
        code: "dangling-edge-endpoint",
        message: `edge ${edge.edge_id} has an endpoint that is not a node in this state`
      });
      continue;
    }
    if (!(edge.predicate in PredicateRegistry)) {
      // A retired or unknown name surviving into a committed state is its own
      // defect: the domain rules cannot speak about a predicate the vocabulary
      // does not define, so an unmigrated edge would otherwise pass every check
      // by being illegible to all of them.
      violations.push({
        edge_id: edge.edge_id,
        predicate: edge.predicate,
        code: "unratified-predicate",
        message: `edge ${edge.edge_id} still carries ${edge.predicate}, which the ratified vocabulary does not define`
      });
      continue;
    }
    const predicate = edge.predicate as Predicate;
    const check = checkPredicateEndpoints(predicate, sourceType, targetType);
    if (!check.ok) {
      for (const violation of check.violations) {
        violations.push({
          edge_id: edge.edge_id,
          predicate,
          code: violation.code,
          message: violation.message
        });
      }
    }
  }
  return violations;
}

export class MigrationTransactionRefused extends Error {
  readonly code = "migration-transaction-refused";
  readonly ordinal: number;
  readonly violations: readonly StateDomainViolation[];

  constructor(ordinal: number, violations: readonly StateDomainViolation[]) {
    super(
      `transaction ${ordinal} would leave ${violations.length} domain violation(s) in the graph: ` +
        violations
          .slice(0, 3)
          .map((violation) => violation.message)
          .join("; ")
    );
    this.name = "MigrationTransactionRefused";
    this.ordinal = ordinal;
    this.violations = violations;
  }
}

/**
 * An in-memory graph that commits a transaction ALL-OR-NOTHING and validates the
 * post-state before it becomes visible.
 *
 * `history()` exposes one snapshot per committed transaction. That is the whole
 * point: a caller can inspect every state this graph was ever observably in and
 * assert a property held in each of them. A store that applied changes as they
 * arrived would have no such sequence to inspect and no way to refuse.
 */
export class InMemoryMigrationGraph {
  #nodes: Map<string, { object_id: string; type: EndpointType; subtype?: string }>;
  #edges: Map<string, { edge_id: string; source_object_id: string; target_object_id: string; predicate: string }>;
  #history: MigrationGraphState[] = [];

  constructor(graph: LegacyGraph) {
    this.#nodes = new Map(
      graph.nodes.map((node) => [
        node.object_id,
        { object_id: node.object_id, type: node.type, ...(node.subtype === undefined ? {} : { subtype: node.subtype }) }
      ])
    );
    this.#edges = new Map(
      graph.edges.map((edge) => [
        edge.edge_id,
        {
          edge_id: edge.edge_id,
          source_object_id: edge.source_object_id,
          target_object_id: edge.target_object_id,
          predicate: edge.predicate
        }
      ])
    );
  }

  state(): MigrationGraphState {
    return {
      nodes: [...this.#nodes.values()].map((node) => ({ ...node })),
      edges: [...this.#edges.values()].map((edge) => ({ ...edge }))
    };
  }

  history(): MigrationGraphState[] {
    return this.#history.map((snapshot) => ({
      nodes: snapshot.nodes.map((node) => ({ ...node })),
      edges: snapshot.edges.map((edge) => ({ ...edge }))
    }));
  }

  /**
   * Applies a transaction to a COPY, validates that copy, and only then swaps it
   * in. A refused transaction leaves the graph exactly as it was, so a caller
   * that catches the refusal is looking at the pre-transaction state and not at
   * a half-applied one.
   */
  commitTransaction(transaction: MigrationTransaction): void {
    const nodes = new Map(this.#nodes);
    const edges = new Map(this.#edges);

    for (const retype of transaction.node_retypes) {
      const existing = nodes.get(retype.object_id);
      if (!existing) {
        continue;
      }
      nodes.set(retype.object_id, {
        object_id: retype.object_id,
        type: retype.to_type,
        subtype: retype.to_subtype
      });
    }

    for (const rewrite of transaction.edge_rewrites) {
      edges.set(rewrite.edge_id, {
        edge_id: rewrite.edge_id,
        source_object_id: rewrite.edge.source_object_id,
        target_object_id: rewrite.edge.target_object_id,
        predicate: rewrite.edge.predicate
      });
    }

    for (const edgeId of transaction.edge_withdrawals) {
      edges.delete(edgeId);
    }

    const candidate: MigrationGraphState = {
      nodes: [...nodes.values()].map((node) => ({ ...node })),
      edges: [...edges.values()].map((edge) => ({ ...edge }))
    };

    // Every violation, with nothing filtered out. An exemption here would be a
    // hole exactly the size of whatever it exempted, and the initial legacy
    // state is never validated — only states this graph is asked to ENTER.
    const violations = findStateDomainViolations(candidate);
    if (violations.length > 0) {
      throw new MigrationTransactionRefused(transaction.ordinal, violations);
    }

    this.#nodes = nodes;
    this.#edges = edges;
    this.#history.push(candidate);
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export const EdgeMigrationAuditSchemaName = "living-atlas-migration-edge-apply:v1" as const;

/**
 * ONE event per apply call carrying aggregate counts only. No edge id and no
 * object id appears here: a per-record audit trail would be a second copy of the
 * graph and would hand the shape of the corpus to anyone allowed to read audit.
 * Predicate names are vocabulary, not content, so counting by predicate is safe.
 */
export type EdgeMigrationAudit = {
  event_schema: typeof EdgeMigrationAuditSchemaName;
  authority_id: string;
  actor_id: string;
  plan_digest: string;
  recorded_at: string;
  outcome: "committed" | "transaction-refused";
  transactions_planned: number;
  transactions_committed: number;
  legacy_edge_count: number;
  nodes_retyped: number;
  edges_migrated: number;
  /** Refused by the PLAN. Equal to `edges_withdrawn` only on a run that committed every transaction. */
  edges_refused: number;
  /** Actually removed from the graph by the transactions that committed. */
  edges_withdrawn: number;
  refusals_by_reason: Array<{ reason: EdgeMigrationRefusalReason; count: number }>;
  absorptions_by_rule: Array<{ from: string; to: Predicate; count: number }>;
  migrated_by_predicate: Array<{ predicate: Predicate; count: number }>;
};

export interface EdgeMigrationAuditSink {
  record(event: EdgeMigrationAudit): Promise<void>;
}

export type ApplyEdgeMigrationInput = {
  plan: EdgeMigrationPlan;
  actor_id: string;
  graph: InMemoryMigrationGraph;
  audit: EdgeMigrationAuditSink;
  now?: () => string;
};

export type ApplyEdgeMigrationResult =
  | { ok: true; audit: EdgeMigrationAudit }
  | { ok: false; reason: "transaction-refused"; refusal: MigrationTransactionRefused; audit: EdgeMigrationAudit };

/**
 * Commits a plan transaction by transaction. A refused transaction stops the run
 * — continuing past one would mean committing later transactions on top of a
 * state the graph itself declined to enter.
 */
export async function applyEdgeMigration(input: ApplyEdgeMigrationInput): Promise<ApplyEdgeMigrationResult> {
  const { plan } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const recordedAt = now();

  let committed = 0;
  let refusal: MigrationTransactionRefused | undefined;

  for (const transaction of plan.transactions) {
    try {
      input.graph.commitTransaction(transaction);
      committed += 1;
    } catch (error) {
      if (error instanceof MigrationTransactionRefused) {
        refusal = error;
        break;
      }
      throw error;
    }
  }

  const committedTransactions = plan.transactions.slice(0, committed);
  const audit: EdgeMigrationAudit = {
    event_schema: EdgeMigrationAuditSchemaName,
    authority_id: plan.authority_id,
    actor_id: input.actor_id,
    plan_digest: plan.plan_digest,
    recorded_at: recordedAt,
    outcome: refusal ? "transaction-refused" : "committed",
    transactions_planned: plan.transactions.length,
    transactions_committed: committed,
    legacy_edge_count: plan.breakdown.legacy_edge_count,
    // Counted off what was actually committed rather than off the plan, so a run
    // that stopped at a refusal reports what it did and not what it intended.
    nodes_retyped: committedTransactions.reduce((total, each) => total + each.node_retypes.length, 0),
    edges_migrated: committedTransactions.reduce((total, each) => total + each.edge_rewrites.length, 0),
    edges_refused: plan.breakdown.refused_count,
    edges_withdrawn: committedTransactions.reduce((total, each) => total + each.edge_withdrawals.length, 0),
    refusals_by_reason: plan.breakdown.refusals_by_reason.map((row) => ({ ...row })),
    absorptions_by_rule: plan.breakdown.absorptions_by_rule.map((row) => ({ ...row })),
    migrated_by_predicate: plan.breakdown.migrated_by_predicate.map((row) => ({ ...row }))
  };
  await input.audit.record(audit);

  if (refusal) {
    return { ok: false, reason: "transaction-refused", refusal, audit };
  }
  return { ok: true, audit };
}
