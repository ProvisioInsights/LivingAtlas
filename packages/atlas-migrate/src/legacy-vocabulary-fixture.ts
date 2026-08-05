import { createHash } from "node:crypto";
import { GraphObjectEnvelopeSchema, type GraphObjectEnvelope } from "@living-atlas/contracts";

/**
 * A synthetic legacy graph that still speaks the RETIRED vocabulary.
 *
 * `legacy-fixture.ts` was updated to the ratified words, which left the
 * subtype-to-`has-type` backfill with nothing to run against: a fixture whose
 * organizations already carry no subtype cannot prove that an organization
 * carrying one is carried across rather than refused.
 *
 * The COUNTS here are invented. They are shaped to exercise the mapping -- many
 * values collapsing onto one subtype, one value shared by several carriers, each
 * endpoint-coverage shape, a value the table does not name -- and deliberately
 * do NOT mirror the owner's corpus, because a public repository is not a place
 * to record how many of anything a private graph holds. Tests assert against the
 * distribution declared below, never against a remembered number.
 */

export const legacyVocabularyFixtureAuthorityId = "la_authority_legacyvocab";

const fixtureCreatedAt = "2023-01-05T08:00:00.000Z";
const fixtureUpdatedAt = "2025-06-30T12:00:00.000Z";

/**
 * How a travel leg's endpoints arrive. The three shapes are disjoint in the
 * corpus and the fixture keeps them disjoint: no row carries both a route and an
 * origin, because the projector must never have a reason to prefer one.
 */
export type FixtureEndpointShape = "route" | "origin-destination" | "partial-origin-only" | "none";

export type FixtureNodeSpec = {
  /** Legacy `type`. */
  type: string;
  /** Legacy `subtype`, absent where the fixture exercises a missing one. */
  subtype?: string;
  count: number;
  /** Travel legs only. */
  endpoints?: FixtureEndpointShape;
  /** Set on the rows that exercise the G5 backfill. */
  participants?: number;
  /** Set where the legacy node carried its own `mode`, distinct from its subtype. */
  mode?: string;
};

/**
 * THE FIXTURE'S DECLARED DISTRIBUTION. Every count assertion in the suite is
 * derived from this table, so a test can only pass by agreeing with the fixture
 * it was actually given.
 */
export const legacyVocabularyFixtureDistribution: readonly FixtureNodeSpec[] = [
  // item -> occurrence/segment. Five legacy words, one target subtype, and the
  // mode kept as an attribute rather than re-encoded.
  { type: "item", subtype: "rideshare", count: 4, endpoints: "none" },
  { type: "item", subtype: "flight", count: 3, endpoints: "route" },
  { type: "item", subtype: "car-service", count: 1, endpoints: "origin-destination" },
  { type: "item", subtype: "drive", count: 1, endpoints: "partial-origin-only" },
  { type: "item", subtype: "train", count: 1, endpoints: "none", mode: "rail" },

  // occurrence collapses. `travel` is absorbed into trip, `other` and `event`
  // mint nothing, `meal` / `social` / `incident` / `hotel-stay` mint topics.
  { type: "occurrence", subtype: "trip", count: 2 },
  { type: "occurrence", subtype: "travel", count: 1 },
  { type: "occurrence", subtype: "hotel-stay", count: 2 },
  { type: "occurrence", subtype: "stay", count: 1 },
  { type: "occurrence", subtype: "meal", count: 3 },
  { type: "occurrence", subtype: "meeting", count: 1 },
  { type: "occurrence", subtype: "event", count: 1 },
  { type: "occurrence", subtype: "other", count: 2 },
  { type: "occurrence", subtype: "social", count: 1 },
  { type: "occurrence", subtype: "incident", count: 1 },

  // G5: no subtype at all, but participants. Backfills to meeting.
  { type: "occurrence", count: 2, participants: 3 },

  // The negative control for RULE A. The table does not name this word, so the
  // node is refused rather than filed under the modal value.
  { type: "occurrence", subtype: "symposium", count: 1 },

  // RULE B. Type is kept, the retired value becomes a has-type topic. Three
  // organizations share one `airline` node -- the assertion that matters most.
  { type: "organization", subtype: "airline", count: 3 },
  { type: "organization", subtype: "law-firm", count: 2 },
  { type: "organization", subtype: "university", count: 1 },
  { type: "location", subtype: "city", count: 2 },
  { type: "location", subtype: "country", count: 1 },
  { type: "item", subtype: "device", count: 2 },

  // The ratified table declined to decide these, so they are projected unchanged
  // and counted where a human will see them.
  { type: "project", subtype: "tool", count: 1 },
  { type: "project", subtype: "product", count: 1 }
];

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function slug(spec: FixtureNodeSpec): string {
  return `${spec.type}_${spec.subtype ?? "nosubtype"}`.replace(/[^a-z0-9]+/gi, "_");
}

export function legacyVocabularyFixtureObjectId(spec: FixtureNodeSpec, ordinal: number): string {
  return `la_object_lv_${slug(spec)}_${ordinal}`;
}

function endpointAttributes(shape: FixtureEndpointShape | undefined, ordinal: number): Record<string, unknown> {
  switch (shape) {
    case "route":
      return { route: `PT${ordinal}-QR${ordinal}` };
    case "origin-destination":
      return { origin: `Place ${ordinal}`, destination: `Place ${ordinal + 1}` };
    case "partial-origin-only":
      return { origin: `Place ${ordinal}` };
    default:
      return {};
  }
}

function payloadFor(spec: FixtureNodeSpec, ordinal: number): Record<string, unknown> {
  const objectId = legacyVocabularyFixtureObjectId(spec, ordinal);
  return {
    object_id: objectId,
    type: spec.type,
    ...(spec.subtype === undefined ? {} : { subtype: spec.subtype }),
    name: `${spec.type} ${spec.subtype ?? "unclassified"} ${ordinal}`,
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    ...(spec.type === "occurrence" ? { occurred_on: "2024-05-05" } : {}),
    ...(spec.mode === undefined ? {} : { mode: spec.mode }),
    ...(spec.participants === undefined
      ? {}
      : {
          participant_refs: Array.from({ length: spec.participants }, (_unused, index) => `la_object_lv_participant_${index}`)
        }),
    ...endpointAttributes(spec.endpoints, ordinal)
  };
}

function plaintextEnvelope(objectId: string, data: Record<string, unknown>): GraphObjectEnvelope {
  return GraphObjectEnvelopeSchema.parse({
    schema_version: 1,
    authority_id: legacyVocabularyFixtureAuthorityId,
    object_id: objectId,
    object_type: "entity",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: fixtureCreatedAt,
    updated_at: fixtureUpdatedAt,
    content_hash: sha256(JSON.stringify(data)),
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json", data }
  });
}

export function createLegacyVocabularyFixture(): GraphObjectEnvelope[] {
  return legacyVocabularyFixtureDistribution.flatMap((spec) =>
    Array.from({ length: spec.count }, (_unused, index) => {
      const ordinal = index + 1;
      return plaintextEnvelope(legacyVocabularyFixtureObjectId(spec, ordinal), payloadFor(spec, ordinal));
    })
  );
}

/** The fixture's own node count, so no test has to restate it. */
export function legacyVocabularyFixtureNodeCount(): number {
  return legacyVocabularyFixtureDistribution.reduce((total, spec) => total + spec.count, 0);
}

/** How many fixture nodes match a predicate over the declared distribution. */
export function legacyVocabularyFixtureCount(predicate: (spec: FixtureNodeSpec) => boolean): number {
  return legacyVocabularyFixtureDistribution
    .filter(predicate)
    .reduce((total, spec) => total + spec.count, 0);
}
