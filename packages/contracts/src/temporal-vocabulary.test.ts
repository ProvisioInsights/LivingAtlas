import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EndpointRecordSchema,
  EndpointTypeValues,
  HAS_TYPE_VS_ABOUT_RULE,
  OccurrenceSubtypeValues,
  PredicateEndpointError,
  PredicateRegistry,
  RetiredPredicates,
  SubtypedEndpointTypes,
  TemporalEdgeSchema,
  assertPredicateEndpoints,
  canonicalizePredicate,
  checkPredicateEndpoints,
  endpointTypeCarriesSubtype,
  type EndpointType,
  type OccurrenceSubtype,
  type Predicate
} from "./index";

/**
 * The ratified vocabulary, held to the standard it was ratified under: an enum
 * survives only if it is TOTAL, and a domain rule counts only if code enforces
 * it. Both claims are checkable, so both are checked here rather than asserted
 * in a comment beside a permissive schema.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT_DOCUMENT = join(REPO_ROOT, "docs", "contract", "atlas-knowledge-contract-2026.08.1.md");

const timestamp = "2026-08-05T12:00:00.000Z";

function occurrence(subtype: OccurrenceSubtype, suffix: string): Record<string, unknown> {
  return {
    object_id: `la_object_vocabulary${suffix}`,
    type: "occurrence",
    subtype,
    name: `Synthetic ${subtype}`,
    occurred_on: "2026-07-04",
    access_class: "local-private",
    created_at: timestamp,
    updated_at: timestamp
  };
}

function edge(input: {
  predicate: Predicate;
  sourceType: EndpointType;
  targetType: EndpointType;
  attrs?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    edge_id: "la_edge_vocabulary0001",
    source_object_id: "la_object_vocabulary0001",
    source_type: input.sourceType,
    target_object_id: "la_object_vocabulary0002",
    target_type: input.targetType,
    predicate: input.predicate,
    valid_from: "2026",
    source: "synthetic-vocabulary-fixture",
    ...(input.attrs ? { attrs: input.attrs } : {})
  };
}

describe("the occurrence subtype enum is total, and it is the only one left", () => {
  it("covers a fixture of every occurrence subtype and admits no fifth", () => {
    // Totality is the rule that killed the other seven enums, so it is asserted
    // over a fixture that instantiates EVERY value rather than a representative
    // one: an enum with a member nothing can produce is the shape `other` had.
    const fixture = OccurrenceSubtypeValues.map((subtype, index) =>
      occurrence(subtype, `occ${String(index).padStart(4, "0")}`)
    );
    expect(fixture).toHaveLength(4);

    const parsed = fixture.map((record) => EndpointRecordSchema.parse(record));
    expect(parsed.map((record) => (record.type === "occurrence" ? record.subtype : undefined))).toEqual([
      "segment",
      "trip",
      "stay",
      "meeting"
    ]);
    expect(new Set(OccurrenceSubtypeValues).size).toBe(OccurrenceSubtypeValues.length);

    // No fifth value, and specifically not the ones that were retired into
    // has-type: `other` above all, because reintroducing it would restore the
    // bucket that answered every question plausibly and wrongly.
    for (const retired of ["other", "social", "appointment", "travel", "hotel-stay", "meal", "incident"]) {
      const outcome = EndpointRecordSchema.safeParse({ ...occurrence("meeting", "occ9999"), subtype: retired });
      expect(`${retired} accepted: ${outcome.success}`).toBe(`${retired} accepted: false`);
    }

    // And an occurrence with no subtype at all is refused rather than defaulted:
    // a default would file it under a word nobody chose.
    const { subtype: _dropped, ...withoutSubtype } = occurrence("meeting", "occ8888");
    expect(EndpointRecordSchema.safeParse(withoutSubtype).success).toBe(false);
  });

  it("gives the other seven types no subtype at all, and refuses one that is sent", () => {
    expect([...SubtypedEndpointTypes]).toEqual(["occurrence"]);

    for (const type of EndpointTypeValues) {
      expect(`${type} carries a subtype: ${endpointTypeCarriesSubtype(type)}`).toBe(
        `${type} carries a subtype: ${type === "occurrence"}`
      );
    }

    // `organization` is the type whose enum failed hardest — its MODAL value was in
    // `other` — so it is the one this pins.
    const organization = {
      object_id: "la_object_vocabulary0003",
      type: "organization",
      name: "Employer 0",
      access_class: "local-private",
      created_at: timestamp,
      updated_at: timestamp
    };
    expect(EndpointRecordSchema.safeParse(organization).success).toBe(true);
    expect(EndpointRecordSchema.safeParse({ ...organization, subtype: "company" }).success).toBe(false);
  });
});

describe("domain rules are enforced in code, not documented", () => {
  it("rejects a wrong-direction edge with a typed error naming the expected domain and range", () => {
    // The measured defect: `based-in` accepting both person -> location and
    // location -> organization, so "where is this organization based" and "who
    // runs this place" were one edge nobody could tell apart.
    const outcome = checkPredicateEndpoints("based-in", "location", "organization");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;

    expect(outcome.violations.map((violation) => violation.code)).toEqual([
      "predicate-domain-violation",
      "predicate-range-violation"
    ]);
    for (const violation of outcome.violations) {
      expect(violation.predicate).toBe("based-in");
      expect([...violation.expected_domain]).toEqual(["person", "organization"]);
      expect([...violation.expected_range]).toEqual(["location"]);
      // The message has to name BOTH sides: a reader told only that the source
      // is wrong goes off to fix the half that is arguably right.
      expect(violation.message).toContain("person|organization -> location");
      expect(violation.message).toContain("got location -> organization");
    }

    let thrown: unknown;
    try {
      assertPredicateEndpoints("based-in", "location", "organization");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PredicateEndpointError);
    const typed = thrown as PredicateEndpointError;
    expect(typed.code).toBe("predicate-endpoint-violation");
    expect(typed.predicate).toBe("based-in");
    expect(typed.violations).toHaveLength(2);

    // The schema and the throwing entry point share one implementation, so the
    // parsed edge carries the same sentence at the same paths.
    const parsed = TemporalEdgeSchema.safeParse(
      edge({ predicate: "based-in", sourceType: "location", targetType: "organization" })
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join("."))).toEqual(["source_type", "target_type"]);
    expect(parsed.error.issues[0]?.message).toContain("person|organization -> location");

    // The correctly directed edge for that pair is operated-by, and it parses.
    expect(
      TemporalEdgeSchema.safeParse(
        edge({ predicate: "operated-by", sourceType: "location", targetType: "organization" })
      ).success
    ).toBe(true);
  });

  it("keeps every registry row inside the eight endpoint types and reports a clean check as ok", () => {
    const types = new Set<string>(EndpointTypeValues);
    for (const [predicate, definition] of Object.entries(PredicateRegistry)) {
      expect(`${predicate} domain non-empty: ${definition.domain.length > 0}`).toBe(`${predicate} domain non-empty: true`);
      expect(`${predicate} range non-empty: ${definition.range.length > 0}`).toBe(`${predicate} range non-empty: true`);
      for (const type of [...definition.domain, ...definition.range]) {
        expect(`${predicate} names ${type}: ${types.has(type)}`).toBe(`${predicate} names ${type}: true`);
      }
      expect(checkPredicateEndpoints(
        predicate as Predicate,
        definition.domain[0] as EndpointType,
        definition.range[0] as EndpointType
      )).toEqual({ ok: true });
    }
  });

  it("refuses the two edges the ratified retype must never produce", () => {
    // A person does not own a taxi ride. The 323 travel segments become
    // occurrences and their ownership edges become participation IN THE SAME
    // transaction, so an intermediate state asserting person owns occurrence
    // must be unrepresentable rather than merely discouraged.
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "owns", sourceType: "person", targetType: "occurrence" })
    ).success).toBe(false);
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "participant-in", sourceType: "person", targetType: "occurrence" })
    ).success).toBe(true);

    // part-of is occurrence-only. A topic hierarchy edge would silently reuse
    // the travel composition predicate for a broader/narrower relation.
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "part-of", sourceType: "topic", targetType: "topic" })
    ).success).toBe(false);
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "part-of", sourceType: "occurrence", targetType: "occurrence" })
    ).success).toBe(true);
  });
});

/**
 * The predicate vocabulary as revision 2026.08.0 published it, written down here
 * because a test is entitled to write down what it is checking — that is what
 * makes it a test rather than a restatement of the implementation.
 *
 * Without this list, "every retired predicate is refused with its successor"
 * would iterate the retirement map and therefore pass for any predicate somebody
 * forgot to put in it. With it, dropping a row is a failure: every name that was
 * once publishable must today be either still canonical or explicitly retired.
 */
const PREDICATES_PUBLISHED_IN_2026_08_0 = [
  "employed-by", "reports-to", "founder-of", "board-member-of", "advises",
  "invests-in", "customer-of", "engaged", "acquired-by", "merged-with",
  "introduced-by", "intro-path-to", "connects", "member-of", "alumnus-of",
  "based-in", "participant-in", "occurred-at", "hosted", "discussed-at",
  "about", "offered-by", "instance-of", "purchased-from", "purchased",
  "owns", "created", "created-for", "related-topic", "part-of-topic",
  "spouse-of", "partner-of", "parent-of", "sibling-of", "related-to",
  "estranged-from", "mentor-of"
] as const;

describe("the retired names", () => {
  it("accounts for every predicate the previous revision published", () => {
    // Each of the thirty-seven is either carried forward or retired with a
    // successor. Neither silently, and never both.
    const stranded: string[] = [];
    for (const predicate of PREDICATES_PUBLISHED_IN_2026_08_0) {
      const carried = predicate in PredicateRegistry;
      const retired = predicate in RetiredPredicates;
      if (carried === retired) stranded.push(`${predicate} (carried=${carried} retired=${retired})`);
    }
    expect(stranded).toEqual([]);

    // And nothing was invented into the retirement map that was never published:
    // a retirement note for a word nobody ever used is documentation of a
    // decision that was never made. Safe aliases of retired names are exempt,
    // because a caller may hold the alias too.
    const publishedAliases = new Set([
      "advisor-to", "advisor", "sits-on-board-of", "model-of", "bought-from", "made-for"
    ]);
    for (const retired of Object.keys(RetiredPredicates)) {
      const known = (PREDICATES_PUBLISHED_IN_2026_08_0 as readonly string[]).includes(retired)
        || publishedAliases.has(retired);
      expect(`${retired} was previously reachable: ${known}`).toBe(`${retired} was previously reachable: true`);
    }
  });

  it("refuses every retired predicate by name and says what replaced it", () => {
    expect(Object.keys(RetiredPredicates).length).toBeGreaterThan(15);

    for (const [retired, replacement] of Object.entries(RetiredPredicates)) {
      // Gone from the registry entirely — not merely discouraged.
      expect(`${retired} still registered: ${retired in PredicateRegistry}`).toBe(`${retired} still registered: false`);

      const outcome = canonicalizePredicate(retired);
      expect(`${retired} canonicalized: ${outcome.ok}`).toBe(`${retired} canonicalized: false`);
      if (outcome.ok) continue;
      // NOT unknown-predicate: telling a caller the word never existed is false
      // and leaves them nowhere to go.
      expect(`${retired} reason: ${outcome.reason}`).toBe(`${retired} reason: retired-predicate`);
      expect(outcome.suggestion).toContain(replacement);
    }

    expect(canonicalizePredicate("no-such-predicate-anywhere")).toEqual({ ok: false, reason: "unknown-predicate" });
    expect(canonicalizePredicate("member-of")).toEqual({ ok: true, predicate: "member-of", source: "canonical" });
    expect(canonicalizePredicate("knows")).toEqual({ ok: true, predicate: "connects", source: "safe-alias" });
  });

  it("carries each collapsed distinction on an attribute the schema recognises", () => {
    // The collapse is only lossless if the survivor can still say which kind of
    // member, participant or creation this was.
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "member-of", sourceType: "person", targetType: "organization", attrs: { role: "board-member" } })
    ).success).toBe(true);
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "participant-in", sourceType: "person", targetType: "occurrence", attrs: { role: "organizer" } })
    ).success).toBe(true);
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "connects", sourceType: "person", targetType: "person", attrs: { relation: "mentor" } })
    ).success).toBe(true);
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "created", sourceType: "person", targetType: "item", attrs: { created_for: "la_object_vocabulary0009" } })
    ).success).toBe(true);

    // created_for is an object id, not free text: the beneficiary stays an
    // identity-checked node rather than a name that resolves to nothing.
    expect(TemporalEdgeSchema.safeParse(
      edge({ predicate: "created", sourceType: "person", targetType: "item", attrs: { created_for: "Person 1" } })
    ).success).toBe(false);
  });
});

describe("has-type versus about", () => {
  it("publishes the has-type versus about rule verbatim in the contract document", () => {
    // The two predicates have the identical signature, so the separation cannot
    // be a shape check. It is a convention, and a convention only exists if it
    // is written down in the artifact consumers read — so the sentence in the
    // code and the sentence in the published document are compared, not merely
    // both present.
    expect(HAS_TYPE_VS_ABOUT_RULE).toBe(
      "has-type says what the subject IS. about says what the subject is CONCERNED WITH."
    );
    const document = readFileSync(CONTRACT_DOCUMENT, "utf8");
    const published = document
      .split("\n")
      .filter((line) => line.startsWith("> "))
      .map((line) => line.slice(2).trim())
      .join(" ")
      .replace(/\*\*/g, "")
      .replace(/`/g, "");
    expect(published).toContain(HAS_TYPE_VS_ABOUT_RULE);

    // Identical signatures, stated as an assertion rather than as a hope: if a
    // later change narrows one of them, the convention stops being the only
    // thing separating them and this test says so.
    expect([...PredicateRegistry["has-type"].domain]).toEqual([...PredicateRegistry.about.domain]);
    expect([...PredicateRegistry["has-type"].range]).toEqual([...PredicateRegistry.about.range]);
    expect([...PredicateRegistry["has-type"].range]).toEqual(["topic"]);

    // Both must accept the same subject, since a topic may legitimately be the
    // target of both.
    for (const predicate of ["has-type", "about"] as const) {
      expect(TemporalEdgeSchema.safeParse(
        edge({ predicate, sourceType: "organization", targetType: "topic" })
      ).success).toBe(true);
      expect(TemporalEdgeSchema.safeParse(
        edge({ predicate, sourceType: "organization", targetType: "organization" })
      ).success).toBe(false);
    }
  });
});
