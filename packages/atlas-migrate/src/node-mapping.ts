import type { EndpointType, OccurrenceSubtype } from "@living-atlas/contracts";
import {
  HandReviewSubtypes,
  LegacyVocabularyPayloadSchema,
  TRAVEL_DESTINATION_ATTRIBUTE,
  TRAVEL_MODE_ATTRIBUTE,
  TRAVEL_ORIGIN_ATTRIBUTE,
  TRAVEL_ROUTE_ATTRIBUTE,
  isKnownEndpointType,
  isOccurrenceSubtype,
  normalizeTopicValue,
  retypeRuleFor,
  typeHasEnumeratedRetypes,
  type LegacyValueDisposition,
  type RetypeRule
} from "./legacy-vocabulary.js";

/**
 * Maps one legacy node onto the ratified vocabulary. Pure, and deliberately
 * separate from the projection plan: the mapping is the decision, the plan is
 * the bookkeeping, and reviewing the decision should not require reading the
 * bookkeeping.
 */

/**
 * How a travel leg's endpoints arrived, reported rather than repaired.
 *
 * The three shapes are DISJOINT in the corpus -- a leg carries `route`, or
 * carries `origin`/`destination`, or carries neither, and the third group is
 * the largest. Synthesising an origin for those would be the single most
 * damaging thing this migration could do: an invented endpoint is
 * indistinguishable from a recorded one the moment it lands, and every later
 * question about where somebody went would be answered partly with fiction.
 */
export type TravelEndpointCoverage =
  | { kind: "route"; route: string }
  | { kind: "origin-destination"; origin: string; destination: string }
  | { kind: "partial"; origin?: string; destination?: string }
  | { kind: "none" };

export const TravelEndpointCoverageKinds = ["route", "origin-destination", "partial", "none"] as const;
export type TravelEndpointCoverageKind = (typeof TravelEndpointCoverageKinds)[number];

/**
 * An attribute the legacy node carried that no endpoint schema in the ratified
 * revision has a key for.
 *
 * It is neither dropped nor forced into a topic. `mode` is the case this exists
 * for: the ratified table says the mode of travel stays an attribute, and the
 * 2026.08.1 occurrence endpoint is `.strict()` with no slot for one, so the two
 * statements cannot both be satisfied today. Reporting the collision is the only
 * honest move -- dropping the value would silently lose one fact per travel leg,
 * and widening a frozen contract revision from inside a migration would be worse.
 */
export type UnplacedAttribute = {
  attribute: string;
  /** Kept so a reviewer can see the value is real, not to re-home it here. */
  value: string;
};

export type LegacyNodeRefusalReason =
  | "unknown-legacy-type"
  | "unmapped-legacy-subtype";

export type MappedLegacyNode = {
  kind: "mapped";
  entity_type: EndpointType;
  entity_subtype?: OccurrenceSubtype;
  /** True when the node changed type, which is the reviewable half of the table. */
  retyped: boolean;
  /** Normalised topic values this node is classified by, via `has-type`. */
  has_type_topics: string[];
  /** Set when the ratified table declined to decide and sent the node to a human. */
  hand_review?: string;
  unplaced_attributes: UnplacedAttribute[];
  travel_endpoints?: TravelEndpointCoverage;
  /** Set when a missing occurrence subtype was filled from `participant_refs`. */
  backfilled_from_participants: boolean;
};

export type LegacyNodeMapping = {
  legacy_object_id: string;
  legacy_type: string;
  legacy_subtype?: string;
  outcome: MappedLegacyNode | { kind: "refused"; reason: LegacyNodeRefusalReason; detail: string };
};

function stringAttribute(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads a travel leg's endpoints WITHOUT ever completing them. `partial` is a
 * separate answer from `origin-destination` on purpose: a leg that knows where
 * it started and not where it ended is a real, reportable state, and folding it
 * into either neighbour would either invent a destination or discard an origin.
 */
export function readTravelEndpoints(payload: Record<string, unknown>): TravelEndpointCoverage {
  const route = stringAttribute(payload, TRAVEL_ROUTE_ATTRIBUTE);
  if (route !== undefined) {
    return { kind: "route", route };
  }

  const origin = stringAttribute(payload, TRAVEL_ORIGIN_ATTRIBUTE);
  const destination = stringAttribute(payload, TRAVEL_DESTINATION_ATTRIBUTE);
  if (origin !== undefined && destination !== undefined) {
    return { kind: "origin-destination", origin, destination };
  }
  if (origin !== undefined || destination !== undefined) {
    return {
      kind: "partial",
      ...(origin === undefined ? {} : { origin }),
      ...(destination === undefined ? {} : { destination })
    };
  }
  return { kind: "none" };
}

/**
 * The mode of a travel leg. Taken from the `mode` attribute when the legacy node
 * carried one and from the legacy subtype otherwise, because for these rows the
 * subtype WAS the mode -- `item/flight` and `mode: "flight"` are one fact under
 * two keys, so reading the second when the first is absent is a rename, not an
 * invention. Nothing else is inferred: a leg with neither gets no mode.
 */
export function travelModeFor(payload: Record<string, unknown>, legacySubtype: string | undefined): string | undefined {
  return stringAttribute(payload, TRAVEL_MODE_ATTRIBUTE) ?? legacySubtype;
}

function participantRefCount(payload: Record<string, unknown>): number {
  const refs = payload["participant_refs"];
  return Array.isArray(refs) ? refs.length : 0;
}

/**
 * Maps one legacy node.
 *
 * The order of the branches is the mapping's whole discipline: an enumerated
 * type consults the table and REFUSES what the table does not name, and only a
 * type with no enumerated retypes falls through to the open classification rule.
 * Reversing the two would make every unknown occurrence subtype quietly become a
 * `has-type` topic on a node with no subtype at all -- a node that passes every
 * schema check while having lost the one field that says what kind of event it
 * was.
 */
export function mapLegacyNode(payload: Record<string, unknown>): LegacyNodeMapping {
  const parsed = LegacyVocabularyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      legacy_object_id: String(payload["object_id"] ?? "<unidentified>"),
      legacy_type: String(payload["type"] ?? "<untyped>"),
      outcome: {
        kind: "refused",
        reason: "unknown-legacy-type",
        detail: "legacy node payload does not carry object_id, type and name"
      }
    };
  }

  const node = parsed.data;
  const base = {
    legacy_object_id: node.object_id,
    legacy_type: node.type,
    ...(node.subtype === undefined ? {} : { legacy_subtype: node.subtype })
  };

  if (!isKnownEndpointType(node.type)) {
    return {
      ...base,
      outcome: {
        kind: "refused",
        reason: "unknown-legacy-type",
        detail: `legacy type ${node.type} is not one of the eight endpoint types`
      }
    };
  }

  if (typeHasEnumeratedRetypes(node.type)) {
    return mapEnumeratedType(base, node.type, node.subtype, payload);
  }

  return { ...base, outcome: classifyByHasType(node.type, node.subtype) };
}

type MappingBase = {
  legacy_object_id: string;
  legacy_type: string;
  legacy_subtype?: string;
};

function mapEnumeratedType(
  base: MappingBase,
  legacyType: EndpointType,
  legacySubtype: string | undefined,
  payload: Record<string, unknown>
): LegacyNodeMapping {
  if (legacySubtype === undefined) {
    // G5: an occurrence whose subtype is MISSING and which names participants is
    // a meeting. This fills a hole; it never overrides a value the legacy store
    // actually recorded, because a backfill that outranks recorded data is not a
    // backfill, it is a second classifier competing with the table.
    if (legacyType === "occurrence" && participantRefCount(payload) > 0) {
      return {
        ...base,
        outcome: {
          kind: "mapped",
          entity_type: "occurrence",
          entity_subtype: "meeting",
          retyped: false,
          has_type_topics: [],
          unplaced_attributes: [],
          backfilled_from_participants: true
        }
      };
    }
    return {
      ...base,
      outcome: {
        kind: "refused",
        reason: "unmapped-legacy-subtype",
        detail: `${legacyType} carries no subtype and no signal this projector maps to one`
      }
    };
  }

  const rule = retypeRuleFor(legacyType, legacySubtype);
  if (!rule) {
    /**
     * A word that is ALREADY one of the four ratified occurrence values needs no
     * retype, and refusing it would be the table punishing a node for being
     * correct. The retype table maps legacy words onto ratified ones, so a
     * ratified word is simply absent from it.
     *
     * This is only reachable because the projector now hands every entity
     * payload to the mapper. It used to try the strict contract schema first and
     * that caught the already-ratified case -- but only for a payload carrying
     * no legacy attributes, which on a real corpus is almost none of them.
     */
    if (legacyType === "occurrence" && isOccurrenceSubtype(legacySubtype)) {
      return {
        ...base,
        outcome: {
          kind: "mapped",
          entity_type: "occurrence",
          entity_subtype: legacySubtype,
          retyped: false,
          has_type_topics: [],
          unplaced_attributes: [],
          backfilled_from_participants: false
        }
      };
    }
    return {
      ...base,
      outcome: {
        kind: "refused",
        reason: "unmapped-legacy-subtype",
        detail: `no ratified retype names ${legacyType}/${legacySubtype}; defaulting it would file it under the modal value`
      }
    };
  }

  const isTravelSegment = rule.to_type === "occurrence" && rule.to_subtype === "segment";
  const unplaced: UnplacedAttribute[] = [];
  if (isTravelSegment) {
    const mode = travelModeFor(payload, legacySubtype);
    if (mode !== undefined) {
      unplaced.push({ attribute: TRAVEL_MODE_ATTRIBUTE, value: mode });
    }
  }

  return {
    ...base,
    outcome: {
      kind: "mapped",
      entity_type: rule.to_type,
      ...(rule.to_subtype === undefined ? {} : { entity_subtype: rule.to_subtype }),
      retyped: rule.to_type !== legacyType,
      has_type_topics: topicsFor(rule),
      unplaced_attributes: unplaced,
      ...(isTravelSegment ? { travel_endpoints: readTravelEndpoints(payload) } : {}),
      backfilled_from_participants: false
    }
  };
}

function topicsFor(rule: RetypeRule): string[] {
  return rule.disposition === "topic" && rule.topic !== undefined ? [normalizeTopicValue(rule.topic)] : [];
}

/**
 * RULE B. The node keeps its type and its retired subtype becomes a `has-type`
 * topic. Open by design: the legacy organization vocabulary was never closed, so
 * enumerating it would only move the residue into this file.
 */
function classifyByHasType(legacyType: EndpointType, legacySubtype: string | undefined): MappedLegacyNode {
  const handReview = legacySubtype === undefined ? undefined : HandReviewSubtypes[`${legacyType}/${legacySubtype}`];

  return {
    kind: "mapped",
    entity_type: legacyType,
    retyped: false,
    has_type_topics: legacySubtype === undefined ? [] : [normalizeTopicValue(legacySubtype)],
    ...(handReview === undefined ? {} : { hand_review: handReview }),
    unplaced_attributes: [],
    backfilled_from_participants: false
  };
}

/**
 * The distinct topic values a set of mappings asks for, in a stable order.
 *
 * Distinctness is the entire point of the change: the topic nodes ARE the
 * controlled vocabulary, so nine airlines that each minted their own `airline`
 * node would leave nine unrelated concepts where the corpus has one, and every
 * query for "which of these are airlines" would answer with a ninth of the truth.
 */
export function distinctTopicValues(mappings: LegacyNodeMapping[]): string[] {
  const seen = new Set<string>();
  for (const mapping of mappings) {
    if (mapping.outcome.kind !== "mapped") {
      continue;
    }
    for (const topic of mapping.outcome.has_type_topics) {
      seen.add(topic);
    }
  }
  return [...seen].sort();
}

export function topicContributorCounts(mappings: LegacyNodeMapping[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    if (mapping.outcome.kind !== "mapped") {
      continue;
    }
    for (const topic of mapping.outcome.has_type_topics) {
      counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

export type RetypeCount = { from: string; to: string; count: number };
export type TopicCount = { topic: string; nodes_classified: number };
export type NotMintedCount = {
  legacy_value: string;
  disposition: Exclude<LegacyValueDisposition, "topic">;
  count: number;
  basis: string;
};

export type LegacyNodeMappingReport = {
  legacy_node_count: number;
  mapped_count: number;
  refused_count: number;
  retyped_count: number;
  retypes: RetypeCount[];
  topics_minted: TopicCount[];
  /**
   * Retired values that minted NO topic, with the reason. Printed because "we
   * dropped this word" is a decision a reviewer must be able to disagree with,
   * and a value that vanishes from the report vanishes from the review.
   */
  values_not_minted: NotMintedCount[];
  travel_endpoint_coverage: Array<{ coverage: TravelEndpointCoverageKind; count: number }>;
  attributes_without_a_contract_slot: Array<{ attribute: string; count: number }>;
  participant_backfill_applied: number;
  hand_review_count: number;
  refusals: Array<{ reason: LegacyNodeRefusalReason; count: number }>;
};

function sortedCounts<T>(counts: Map<string, number>, build: (key: string, count: number) => T): T[] {
  return [...counts.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, count]) => build(key, count));
}

export function buildLegacyNodeMappingReport(mappings: LegacyNodeMapping[]): LegacyNodeMappingReport {
  // Keyed by the printable `from -> to` pair with both halves kept in the VALUE.
  // An earlier version packed them into one string and split it back out, which
  // needs a separator that cannot occur in either half; the separator that
  // satisfies that is a NUL byte, and a NUL byte in a source file makes the file
  // binary to git and unreviewable. Carrying the pair is cheaper than picking a
  // separator carefully enough to be wrong about later.
  const retypes = new Map<string, RetypeCount>();
  const travel = new Map<string, number>();
  const unplaced = new Map<string, number>();
  const refusals = new Map<string, number>();
  let mapped = 0;
  let retypedCount = 0;
  let backfilled = 0;
  let handReview = 0;

  for (const mapping of mappings) {
    if (mapping.outcome.kind === "refused") {
      refusals.set(mapping.outcome.reason, (refusals.get(mapping.outcome.reason) ?? 0) + 1);
      continue;
    }
    mapped += 1;
    const from = `${mapping.legacy_type}${mapping.legacy_subtype === undefined ? "" : `/${mapping.legacy_subtype}`}`;
    const to = `${mapping.outcome.entity_type}${
      mapping.outcome.entity_subtype === undefined ? "" : `/${mapping.outcome.entity_subtype}`
    }`;
    const pair = `${from} -> ${to}`;
    retypes.set(pair, { from, to, count: (retypes.get(pair)?.count ?? 0) + 1 });
    if (mapping.outcome.retyped) {
      retypedCount += 1;
    }
    if (mapping.outcome.backfilled_from_participants) {
      backfilled += 1;
    }
    if (mapping.outcome.hand_review !== undefined) {
      handReview += 1;
    }
    if (mapping.outcome.travel_endpoints) {
      const kind = mapping.outcome.travel_endpoints.kind;
      travel.set(kind, (travel.get(kind) ?? 0) + 1);
    }
    for (const attribute of mapping.outcome.unplaced_attributes) {
      unplaced.set(attribute.attribute, (unplaced.get(attribute.attribute) ?? 0) + 1);
    }
  }

  const topicCounts = topicContributorCounts(mappings);

  return {
    legacy_node_count: mappings.length,
    mapped_count: mapped,
    refused_count: mappings.length - mapped,
    retyped_count: retypedCount,
    retypes: [...retypes.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, entry]) => entry),
    topics_minted: sortedCounts(topicCounts, (topic, nodes_classified) => ({ topic, nodes_classified })),
    values_not_minted: notMintedCounts(mappings),
    travel_endpoint_coverage: TravelEndpointCoverageKinds.filter((kind) => (travel.get(kind) ?? 0) > 0).map((kind) => ({
      coverage: kind,
      count: travel.get(kind) ?? 0
    })),
    attributes_without_a_contract_slot: sortedCounts(unplaced, (attribute, count) => ({ attribute, count })),
    participant_backfill_applied: backfilled,
    hand_review_count: handReview,
    refusals: sortedCounts(refusals, (reason, count) => ({ reason: reason as LegacyNodeRefusalReason, count }))
  };
}

function notMintedCounts(mappings: LegacyNodeMapping[]): NotMintedCount[] {
  const counts = new Map<string, { disposition: Exclude<LegacyValueDisposition, "topic">; count: number; basis: string }>();

  for (const mapping of mappings) {
    if (mapping.outcome.kind !== "mapped" || mapping.legacy_subtype === undefined) {
      continue;
    }
    const rule = retypeRuleFor(mapping.legacy_type, mapping.legacy_subtype);
    if (!rule || rule.disposition === "topic") {
      continue;
    }
    const existing = counts.get(mapping.legacy_subtype);
    counts.set(mapping.legacy_subtype, {
      disposition: rule.disposition,
      count: (existing?.count ?? 0) + 1,
      basis: rule.basis
    });
  }

  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([legacy_value, entry]) => ({ legacy_value, ...entry }));
}
