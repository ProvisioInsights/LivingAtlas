import {
  canonicalWorldTimeInterval,
  CanonicalFactPayloadSchema,
  CanonicalRelationshipPayloadSchema,
  type CanonicalFactPayload,
  type CanonicalRelationshipPayload,
  type GraphObjectEnvelope
} from "@living-atlas/contracts";

export type CanonicalAssertion = CanonicalFactPayload | CanonicalRelationshipPayload;

export type CanonicalAssertionQuery = {
  valid_at?: string;
  known_at?: string;
  include_superseded?: boolean;
  include_retracted?: boolean;
  include_invalidated?: boolean;
};

export type CanonicalAssertionProjection = {
  assertions: CanonicalAssertion[];
  superseded_assertion_ids: string[];
};

export type CanonicalPayloadDecryptor = (
  object: GraphObjectEnvelope
) => Promise<Record<string, unknown> | undefined>;

function matchesValidAt(assertion: CanonicalAssertion, validAt: string | undefined): boolean {
  if (!validAt || !assertion.valid_from) {
    return true;
  }

  const queryInterval = canonicalWorldTimeInterval(validAt);
  const from = canonicalWorldTimeInterval(assertion.valid_from);
  if (!queryInterval || !from) {
    return false;
  }

  const to = assertion.valid_to ? canonicalWorldTimeInterval(assertion.valid_to) : undefined;
  if (assertion.valid_to === "unknown") {
    return false;
  }
  const upper = to?.lower;
  return from.lower < queryInterval.upper && (upper === undefined || queryInterval.lower < upper);
}

function isKnownAt(assertion: CanonicalAssertion, knownAt: string | undefined): boolean {
  return knownAt === undefined || assertion.recorded_at <= knownAt;
}

function isVisibleAction(assertion: CanonicalAssertion, query: CanonicalAssertionQuery): boolean {
  if (assertion.lineage_action === "retract") {
    return query.include_retracted === true;
  }
  if (assertion.lineage_action === "invalidate") {
    return query.include_invalidated === true;
  }
  return true;
}

export function projectCanonicalAssertions(
  assertions: CanonicalAssertion[],
  query: CanonicalAssertionQuery = {}
): CanonicalAssertionProjection {
  const knownAssertions = assertions.filter((assertion) => isKnownAt(assertion, query.known_at));
  const superseded = new Set(knownAssertions.flatMap((assertion) => assertion.supersedes));
  const visibleAssertions = knownAssertions
    .filter((assertion) => query.include_superseded === true || !superseded.has(assertion.assertion_id))
    .filter((assertion) => isVisibleAction(assertion, query))
    .filter((assertion) => matchesValidAt(assertion, query.valid_at))
    .sort((left, right) => left.recorded_at.localeCompare(right.recorded_at) || left.assertion_id.localeCompare(right.assertion_id));

  return {
    assertions: visibleAssertions,
    superseded_assertion_ids: [...superseded].sort()
  };
}

export async function loadCanonicalAssertionsFromObjects(
  objects: GraphObjectEnvelope[],
  decryptPayload: CanonicalPayloadDecryptor
): Promise<CanonicalAssertion[]> {
  const assertions: CanonicalAssertion[] = [];
  const canonicalEnvelopes = objects
    .filter((object) => object.object_type === "assertion" || object.object_type === "edge")
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.object_id.localeCompare(right.object_id));

  for (const object of canonicalEnvelopes) {
    const payload = await decryptPayload(object);
    if (!payload) {
      continue;
    }
    const fact = CanonicalFactPayloadSchema.safeParse(payload);
    if (fact.success) {
      assertions.push(fact.data);
      continue;
    }
    const relationship = CanonicalRelationshipPayloadSchema.safeParse(payload);
    if (relationship.success) {
      assertions.push(relationship.data);
    }
  }

  return assertions;
}
