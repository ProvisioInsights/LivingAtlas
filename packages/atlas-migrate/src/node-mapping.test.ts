import { describe, expect, it } from "vitest";
import { EndpointTypeValues, OccurrenceSubtypeValues } from "@living-atlas/contracts";
import {
  RetypeRules,
  buildLegacyNodeMappingReport,
  buildProjectionPlan,
  createLegacyVocabularyFixture,
  distinctTopicValues,
  evaluateClosureGate,
  isEntityRecord,
  legacyObjectIdOf,
  isMintedEntityRecord,
  isMintedRelationshipRecord,
  legacyVocabularyFixtureAuthorityId,
  legacyVocabularyFixtureCount,
  legacyVocabularyFixtureDistribution,
  legacyVocabularyFixtureNodeCount,
  legacyVocabularyFixtureObjectId,
  mapLegacyNode,
  mintedTopicSlot,
  projectionPlanDigest,
  readTravelEndpoints,
  recomputeProjectionBreakdown,
  renderProjectionPlanReport,
  retypeRuleFor,
  travelModeFor,
  type LegacyNodeMapping,
  type ProjectedRecord,
  type ProjectionPlan
} from "./index.js";

function planFixture(): ProjectionPlan {
  return buildProjectionPlan(createLegacyVocabularyFixture(), {
    authority_id: legacyVocabularyFixtureAuthorityId
  });
}

function mappingsFromFixture(): LegacyNodeMapping[] {
  return createLegacyVocabularyFixture().map((envelope) => {
    if (envelope.payload.kind !== "plaintext-json") {
      throw new Error("the vocabulary fixture is plaintext by construction");
    }
    return mapLegacyNode(envelope.payload.data);
  });
}

/**
 * Adds a record to a plan and rebuilds everything the plan derives from its
 * records, so the gate is forced to judge the record rather than trip over a
 * stale digest or a stale breakdown on the way there.
 */
function retallied(plan: ProjectionPlan, extra: ProjectedRecord): ProjectionPlan {
  const records = [...plan.records, extra].sort((left, right) =>
    left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0
  );
  const content = {
    ...plan,
    records,
    minted_record_keys: [...plan.minted_record_keys, extra.idempotency_key].sort(),
    // The hand-review queue is an INPUT to the breakdown, not decoration: the
    // travel-endpoint coverage is reconstructed from it. Recomputing without it
    // would hand the gate a breakdown that disagrees with the plan for a reason
    // that has nothing to do with the record under test.
    breakdown: recomputeProjectionBreakdown(plan.outcomes, records, plan.hand_review)
  };
  return { ...content, plan_digest: projectionPlanDigest(content) };
}

function entitySubtypeCounts(plan: ProjectionPlan): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of plan.records.filter(isEntityRecord)) {
    const key = `${record.entity_type}${record.entity_subtype === undefined ? "" : `/${record.entity_subtype}`}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe("the ratified retype table", () => {
  it("names a target every row can actually reach", () => {
    for (const rule of RetypeRules) {
      expect(EndpointTypeValues).toContain(rule.to_type);
      if (rule.to_subtype !== undefined) {
        expect(OccurrenceSubtypeValues).toContain(rule.to_subtype);
      }
      // A subtype on a type that carries none would be dropped by the target
      // schema without anybody being told.
      expect(rule.to_subtype === undefined).toBe(rule.to_type !== "occurrence");
      // A row that mints a topic must say which one, and a row that does not
      // must not carry a stray value nothing reads.
      expect(rule.topic !== undefined).toBe(rule.disposition === "topic");
      expect(rule.basis.length).toBeGreaterThan(0);
    }
  });

  it("collapses every legacy occurrence word onto one of the four survivors", () => {
    const occurrenceRules = RetypeRules.filter((rule) => rule.from_type === "occurrence");
    const targets = new Set(occurrenceRules.map((rule) => rule.to_subtype));

    expect(occurrenceRules.length).toBeGreaterThan(OccurrenceSubtypeValues.length);
    for (const target of targets) {
      expect(OccurrenceSubtypeValues).toContain(target);
    }
  });

  it("sends every travel word to occurrence/segment and none of them to a topic", () => {
    const travel = RetypeRules.filter((rule) => rule.from_type === "item");

    expect(travel.length).toBeGreaterThan(0);
    for (const rule of travel) {
      expect(rule.to_type).toBe("occurrence");
      expect(rule.to_subtype).toBe("segment");
      // The mode stays an attribute. A topic here would put one fact in two
      // places and let them disagree.
      expect(rule.disposition).toBe("absorbed");
      expect(rule.topic).toBeUndefined();
    }
  });
});

describe("mapping a legacy node", () => {
  it("retypes a travel item to an occurrence segment and keeps its mode as an attribute", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_flight",
      type: "item",
      subtype: "flight",
      name: "Leg 1"
    });

    expect(mapping.outcome.kind).toBe("mapped");
    if (mapping.outcome.kind !== "mapped") return;
    expect(mapping.outcome.entity_type).toBe("occurrence");
    expect(mapping.outcome.entity_subtype).toBe("segment");
    expect(mapping.outcome.retyped).toBe(true);
    expect(mapping.outcome.has_type_topics).toEqual([]);
    expect(mapping.outcome.unplaced_attributes).toEqual([{ attribute: "mode", value: "flight" }]);
  });

  it("prefers a recorded mode attribute over the legacy subtype", () => {
    expect(travelModeFor({ mode: "rail" }, "train")).toBe("rail");
    expect(travelModeFor({}, "train")).toBe("train");
    expect(travelModeFor({}, undefined)).toBeUndefined();
  });

  it("classifies a retired organization subtype with has-type instead of refusing it", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_org",
      type: "organization",
      subtype: "Airline",
      name: "Employer 0"
    });

    expect(mapping.outcome.kind).toBe("mapped");
    if (mapping.outcome.kind !== "mapped") return;
    expect(mapping.outcome.entity_type).toBe("organization");
    expect(mapping.outcome.entity_subtype).toBeUndefined();
    // Case-folded, so two spellings do not become two nodes.
    expect(mapping.outcome.has_type_topics).toEqual(["airline"]);
  });

  it("refuses an occurrence word the table does not name rather than defaulting it", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_unknown",
      type: "occurrence",
      subtype: "symposium",
      name: "Occurrence 0"
    });

    expect(mapping.outcome.kind).toBe("refused");
    if (mapping.outcome.kind !== "refused") return;
    expect(mapping.outcome.reason).toBe("unmapped-legacy-subtype");
    // The failure this guards: `meeting` is the modal target, so a default would
    // look like a successful mapping while filing an unknown word under the most
    // common one.
    expect(mapping.outcome.detail).toContain("occurrence/symposium");
  });

  it("backfills a subtypeless occurrence with participants to meeting, and only then", () => {
    const withParticipants = mapLegacyNode({
      object_id: "la_object_lv_case_participants",
      type: "occurrence",
      name: "Occurrence 1",
      participant_refs: ["la_object_lv_participant_0"]
    });
    const without = mapLegacyNode({
      object_id: "la_object_lv_case_bare",
      type: "occurrence",
      name: "Occurrence 2"
    });

    expect(withParticipants.outcome.kind).toBe("mapped");
    if (withParticipants.outcome.kind === "mapped") {
      expect(withParticipants.outcome.entity_subtype).toBe("meeting");
      expect(withParticipants.outcome.backfilled_from_participants).toBe(true);
    }
    expect(without.outcome.kind).toBe("refused");
  });

  /**
   * The backfill fills a hole; it must never outrank a value the legacy store
   * recorded. A backfill that wins over recorded data is a second classifier
   * competing with the ratified table, and the two will disagree silently.
   */
  it("lets a recorded subtype outrank the participant backfill", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_trip_with_people",
      type: "occurrence",
      subtype: "travel",
      name: "Occurrence 3",
      participant_refs: ["la_object_lv_participant_0", "la_object_lv_participant_1"]
    });

    expect(mapping.outcome.kind).toBe("mapped");
    if (mapping.outcome.kind !== "mapped") return;
    expect(mapping.outcome.entity_subtype).toBe("trip");
    expect(mapping.outcome.backfilled_from_participants).toBe(false);
  });

  it("flags the project rows the ratified table declined to decide", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_tool",
      type: "project",
      subtype: "tool",
      name: "Project 0"
    });

    expect(mapping.outcome.kind).toBe("mapped");
    if (mapping.outcome.kind !== "mapped") return;
    expect(mapping.outcome.entity_type).toBe("project");
    expect(mapping.outcome.hand_review).toContain("offering");
  });
});

describe("travel endpoints are reported, never synthesised", () => {
  it("reads each shape as itself and invents nothing for the empty one", () => {
    expect(readTravelEndpoints({ route: "PT1-QR1" })).toEqual({ kind: "route", route: "PT1-QR1" });
    expect(readTravelEndpoints({ origin: "Place 1", destination: "Place 2" })).toEqual({
      kind: "origin-destination",
      origin: "Place 1",
      destination: "Place 2"
    });
    expect(readTravelEndpoints({ origin: "Place 1" })).toEqual({ kind: "partial", origin: "Place 1" });
    expect(readTravelEndpoints({})).toEqual({ kind: "none" });
  });

  it("never puts an endpoint on a leg whose payload had none", () => {
    const mapping = mapLegacyNode({
      object_id: "la_object_lv_case_bare_leg",
      type: "item",
      subtype: "rideshare",
      name: "Leg 2"
    });

    expect(mapping.outcome.kind).toBe("mapped");
    if (mapping.outcome.kind !== "mapped") return;
    expect(mapping.outcome.travel_endpoints).toEqual({ kind: "none" });
    // A leg with no origin is a leg whose origin is unknown. The whole record
    // must be free of a guessed one, not merely free of one in the obvious field.
    expect(JSON.stringify(mapping)).not.toContain("Place ");
  });

  it("counts every coverage shape the fixture actually contains", () => {
    const report = buildLegacyNodeMappingReport(mappingsFromFixture());
    const coverage = new Map(report.travel_endpoint_coverage.map((entry) => [entry.coverage, entry.count]));

    expect(coverage.get("none")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "none")
    );
    expect(coverage.get("route")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "route")
    );
    expect(coverage.get("origin-destination")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "origin-destination")
    );
    expect(coverage.get("partial")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "partial-origin-only")
    );
  });
});

describe("projecting the legacy vocabulary fixture", () => {
  it("gives every fixture node exactly one outcome and passes the closure gate", () => {
    const plan = planFixture();
    const gate = evaluateClosureGate(plan, { expected_source_object_count: legacyVocabularyFixtureNodeCount() });

    expect(plan.outcomes).toHaveLength(legacyVocabularyFixtureNodeCount());
    expect(gate.findings).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("retypes every travel item to occurrence/segment", () => {
    const plan = planFixture();
    const expected = legacyVocabularyFixtureCount(
      (spec) => spec.type === "item" && retypeRuleFor("item", spec.subtype ?? "")?.to_subtype === "segment"
    );

    expect(entitySubtypeCounts(plan).get("occurrence/segment")).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it("collapses the legacy occurrence words onto the four survivors and no fifth", () => {
    const plan = planFixture();
    const counts = entitySubtypeCounts(plan);

    const occurrenceKeys = [...counts.keys()].filter((key) => key.startsWith("occurrence/"));
    for (const key of occurrenceKeys) {
      expect(OccurrenceSubtypeValues).toContain(key.slice("occurrence/".length));
    }

    for (const survivor of ["trip", "stay", "meeting"] as const) {
      const expected = legacyVocabularyFixtureCount(
        (spec) => spec.type === "occurrence" && retypeRuleFor("occurrence", spec.subtype ?? "")?.to_subtype === survivor
      );
      const backfilled =
        survivor === "meeting"
          ? legacyVocabularyFixtureCount(
              (spec) => spec.type === "occurrence" && spec.subtype === undefined && spec.participants !== undefined
            )
          : 0;
      expect(counts.get(`occurrence/${survivor}`)).toBe(expected + backfilled);
    }
  });

  it("mints one topic node per distinct retired value, however many nodes carried it", () => {
    const plan = planFixture();
    const minted = plan.records.filter(isMintedEntityRecord);
    const values = minted.map((record) => record.minted_basis.legacy_value).sort();

    expect(new Set(values).size).toBe(values.length);
    expect(values).toEqual(distinctTopicValues(mappingsFromFixture()));

    // The assertion the whole change turns on: three organizations that each
    // said `airline` share ONE node, not three.
    const airline = minted.find((record) => record.minted_basis.legacy_value === "airline");
    const carriers = legacyVocabularyFixtureCount((spec) => spec.subtype === "airline");
    expect(carriers).toBeGreaterThan(1);
    expect(airline?.classified_node_count).toBe(carriers);
    expect(minted.filter((record) => record.minted_basis.legacy_value === "airline")).toHaveLength(1);
  });

  it("points every has-type edge at the one node minted for its value", () => {
    const plan = planFixture();
    const classifications = plan.records.filter(isMintedRelationshipRecord);
    const airlineSlot = mintedTopicSlot(legacyVocabularyFixtureAuthorityId, "airline");
    const airlineEdges = classifications.filter((record) => record.target_slot === airlineSlot);

    expect(airlineEdges).toHaveLength(legacyVocabularyFixtureCount((spec) => spec.subtype === "airline"));
    for (const edge of classifications) {
      expect(edge.predicate).toBe("has-type");
      expect(edge.target_type).toBe("topic");
      // A subtype string carried no time; stamping one would date the fact to
      // the day the migration ran.
      expect(edge.valid_from).toBe("unknown");
      expect(edge.valid_from_fidelity).toBe("unknown");
    }
  });

  it("mints the same nodes on a re-run instead of a second copy", () => {
    const first = planFixture();
    const second = planFixture();

    expect(second.plan_digest).toBe(first.plan_digest);
    expect(second.minted_record_keys).toEqual(first.minted_record_keys);
    expect(new Set(first.minted_record_keys).size).toBe(first.minted_record_keys.length);
    expect(first.minted_record_keys.length).toBeGreaterThan(0);
  });

  it("mints no topic for the values the table absorbed or called vacuous", () => {
    const plan = planFixture();
    const values = new Set(plan.records.filter(isMintedEntityRecord).map((record) => record.minted_basis.legacy_value));

    for (const rule of RetypeRules) {
      if (rule.disposition !== "topic") {
        expect(values.has(rule.from_subtype)).toBe(false);
      }
    }
    // `other` in particular: minting a controlled-vocabulary node for the residue
    // would rebuild the residue the enum deletion removed.
    expect(values.has("other")).toBe(false);
  });

  it("refuses the unmapped occurrence word by name and projects no entity for it", () => {
    const plan = planFixture();
    const unmappedSpec = legacyVocabularyFixtureDistribution.find((spec) => spec.subtype === "symposium");
    expect(unmappedSpec).toBeDefined();
    if (!unmappedSpec) return;

    const legacyId = legacyVocabularyFixtureObjectId(unmappedSpec, 1);
    const outcome = plan.outcomes.find((candidate) => candidate.legacy_object_id === legacyId);

    expect(outcome?.disposition.kind).toBe("refused");
    if (outcome?.disposition.kind === "refused") {
      expect(outcome.disposition.reason).toBe("unmapped-legacy-subtype");
    }
    expect(plan.records.filter(isEntityRecord).some((record) => legacyObjectIdOf(record) === legacyId)).toBe(false);
  });

  it("reports the segments with no endpoint data rather than filling them in", () => {
    const report = buildLegacyNodeMappingReport(mappingsFromFixture());
    const none = report.travel_endpoint_coverage.find((entry) => entry.coverage === "none");

    expect(none?.count).toBe(legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "none"));
    expect(none?.count).toBeGreaterThan(0);
  });

  it("reports the mode attribute the ratified endpoint schema has no slot for", () => {
    const report = buildLegacyNodeMappingReport(mappingsFromFixture());
    const mode = report.attributes_without_a_contract_slot.find((entry) => entry.attribute === "mode");

    // The table says the mode stays an attribute; the 2026.08.1 occurrence
    // endpoint is strict and has no key for one. Reporting the collision is the
    // only move that neither drops a fact per leg nor widens a frozen revision.
    expect(mode?.count).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && retypeRuleFor("item", spec.subtype ?? "")?.to_subtype === "segment")
    );
  });

  /**
   * The two assertions above are about the mapper's own report, which no
   * production path builds. These are the same properties asserted on the
   * artifact the operator actually receives — the plan. Without them the mapper
   * could compute a perfect report while `buildProjectionPlan` dropped every
   * value on the floor, which is exactly what it was doing.
   */
  it("carries the unplaceable travel attributes into the plan's hand-review queue", () => {
    const plan = planFixture();
    const rows = plan.hand_review.filter((item) => item.reason === "no-contract-slot");
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.attribute, (counts.get(row.attribute) ?? 0) + 1);
    }

    const segments = legacyVocabularyFixtureCount(
      (spec) => spec.type === "item" && retypeRuleFor("item", spec.subtype ?? "")?.to_subtype === "segment"
    );
    expect(counts.get("mode")).toBe(segments);
    expect(counts.get("route")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "route")
    );
    expect(counts.get("origin")).toBe(
      legacyVocabularyFixtureCount(
        (spec) => spec.type === "item" && (spec.endpoints === "origin-destination" || spec.endpoints === "partial-origin-only")
      )
    );
    expect(counts.get("destination")).toBe(
      legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === "origin-destination")
    );

    // The queue names the object and the attribute and never the value, because
    // the plan is written to whatever directory a dry run is reviewed in.
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain("Place ");
      expect(JSON.stringify(row)).not.toContain("PT");
    }
  });

  it("counts every endpoint coverage shape in the plan, including the legs that carried none", () => {
    const plan = planFixture();
    const coverage = new Map(plan.breakdown.travel_endpoint_coverage.map((entry) => [entry.coverage, entry.count]));

    for (const [kind, shape] of [
      ["none", "none"],
      ["route", "route"],
      ["origin-destination", "origin-destination"],
      ["partial", "partial-origin-only"]
    ] as const) {
      expect(coverage.get(kind)).toBe(
        legacyVocabularyFixtureCount((spec) => spec.type === "item" && spec.endpoints === shape)
      );
    }
    // The largest group in the corpus is the one with nothing. A zero here would
    // mean somebody had started filling endpoints in.
    expect(coverage.get("none")).toBeGreaterThan(0);
  });

  it("shows the nodes the ratified table declined to decide", () => {
    const plan = planFixture();
    const declined = plan.hand_review.filter((item) => item.reason === "ratified-table-declined");

    expect(declined).toHaveLength(
      legacyVocabularyFixtureCount((spec) => spec.type === "project" && (spec.subtype === "tool" || spec.subtype === "product"))
    );
    expect(declined.length).toBeGreaterThan(0);
    // They still project — the decline is a question for a human, not a refusal
    // that throws the node away.
    for (const item of declined) {
      const outcome = plan.outcomes.find((candidate) => candidate.legacy_object_id === item.legacy_object_id);
      expect(outcome?.disposition.kind).toBe("projected-as-entity");
    }
  });

  it("renders the two aggregates a reviewer checks before the per-object rows", () => {
    const report = renderProjectionPlanReport(planFixture());

    expect(report).toContain("attributes-without-a-contract-slot");
    expect(report).toContain("travel-endpoint-coverage");
    expect(report).toContain("ratified-table-declined");
    // Counts and ids only, never the corpus content behind them.
    expect(report).not.toContain("Place ");
  });

  /**
   * The rule above is a property of today's minting code. This is the permanent
   * control: whatever produces the plan, a plan that holds two nodes for one
   * value must not be certifiable. Without it the duplicate check is a branch no
   * test has ever executed.
   */
  it("fails the closure gate on a plan that minted two nodes for one value", () => {
    const plan = planFixture();
    const original = plan.records.filter(isMintedEntityRecord)[0];
    expect(original).toBeDefined();
    if (!original) return;

    const duplicate = {
      ...original,
      idempotency_key: `la_idem_${"d".repeat(32)}` as typeof original.idempotency_key,
      slot: `slot_entity_${"d".repeat(24)}` as typeof original.slot
    };
    const gate = evaluateClosureGate(retallied(plan, duplicate));

    expect(gate.ok).toBe(false);
    expect(gate.findings.map((item) => item.code)).toContain("duplicate-minted-topic");
    expect(gate.findings.find((item) => item.code === "duplicate-minted-topic")?.subjects).toEqual([
      original.minted_basis.legacy_value
    ]);
  });

  it("fails the closure gate on a minted record the plan does not claim", () => {
    const plan = planFixture();
    const unclaimed: ProjectionPlan = {
      ...plan,
      minted_record_keys: plan.minted_record_keys.slice(1)
    };
    const gate = evaluateClosureGate({ ...unclaimed, plan_digest: projectionPlanDigest(unclaimed) });

    expect(gate.findings.map((item) => item.code)).toContain("minted-record-not-accounted");
  });

  it("carries no legacy subtype word into an entity record", () => {
    const plan = planFixture();

    for (const record of plan.records.filter(isEntityRecord)) {
      if (record.entity_subtype === undefined) {
        continue;
      }
      expect(OccurrenceSubtypeValues).toContain(record.entity_subtype);
    }
  });
});
