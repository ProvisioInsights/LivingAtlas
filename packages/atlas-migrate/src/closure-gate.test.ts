import { describe, expect, it } from "vitest";
import {
  buildProjectionPlan,
  createLegacyGraphFixture,
  createUnmappedCategoryFixture,
  evaluateClosureGate,
  isRelationshipRecord,
  isRetractionRecord,
  legacyFixtureAuthorityId,
  legacyFixtureIds,
  legacyFixturePayloadResolver,
  projectionPlanDigest,
  type ClosureGateFindingCode,
  type ProjectionPlan
} from "./index.js";

function planFor(envelopes = createLegacyGraphFixture()): ProjectionPlan {
  return buildProjectionPlan(envelopes, {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

function codes(plan: ProjectionPlan): ClosureGateFindingCode[] {
  return evaluateClosureGate(plan).findings.map((finding) => finding.code);
}

/**
 * Re-anchors a hand-edited plan so a negative control isolates the check it is
 * aiming at instead of tripping the digest first.
 */
function reseal(plan: ProjectionPlan): ProjectionPlan {
  return { ...plan, plan_digest: projectionPlanDigest(plan) };
}

describe("closure gate", () => {
  it("passes a plan where every source object is projected or named as refused", () => {
    const plan = planFor();
    const gate = evaluateClosureGate(plan);

    expect(gate.findings).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(gate.plan_digest).toBe(plan.plan_digest);
  });

  it("holds the closure identity with a per-category breakdown", () => {
    const source = createLegacyGraphFixture();
    const gate = evaluateClosureGate(planFor(source));

    expect(gate.breakdown.source_object_count).toBe(source.length);
    expect(gate.breakdown.projected_count + gate.breakdown.refused_count).toBe(source.length);
    expect(gate.breakdown.by_category.reduce((total, entry) => total + entry.count, 0)).toBe(source.length);
    expect(gate.breakdown.by_disposition.reduce((total, entry) => total + entry.count, 0)).toBe(source.length);
    expect(gate.breakdown.refusals_by_reason.reduce((total, entry) => total + entry.count, 0)).toBe(
      gate.breakdown.refused_count
    );
  });

  /**
   * The seeded negative control. The arithmetic still balances — the forgotten
   * object is counted as refused — so a gate that only checked the identity
   * would report success while an entire class of objects was left behind.
   */
  it("fails on a source category the projector never declared a mapping for", () => {
    const plan = planFor(createUnmappedCategoryFixture());
    const gate = evaluateClosureGate(plan);

    expect(gate.breakdown.projected_count + gate.breakdown.refused_count).toBe(
      gate.breakdown.source_object_count
    );
    expect(gate.ok).toBe(false);
    expect(gate.findings.map((finding) => finding.code)).toContain("unclassified-source-category");

    const finding = gate.findings.find((candidate) => candidate.code === "unclassified-source-category");
    expect(finding?.subjects).toContain(legacyFixtureIds.unmappedObject);
    expect(finding?.subject_count).toBe(1);
  });

  it("fails when a projected relationship names an endpoint the plan does not mint", () => {
    const plan = structuredClone(planFor());
    const relationship = plan.records.find(isRelationshipRecord);
    expect(relationship).toBeDefined();
    if (relationship) {
      relationship.source_slot = `slot_entity_${"0".repeat(24)}`;
    }

    expect(codes(reseal(plan))).toEqual(["dangling-projected-endpoint"]);
  });

  it("fails when a retraction names a record the plan does not create", () => {
    const plan = structuredClone(planFor());
    const retraction = plan.records.find(isRetractionRecord);
    expect(retraction).toBeDefined();
    if (retraction) {
      retraction.retracts_idempotency_key = `la_idem_${"0".repeat(32)}`;
    }

    expect(codes(reseal(plan))).toEqual(["retraction-target-missing"]);
  });

  it("fails when a plan misreports its own totals", () => {
    const plan = structuredClone(planFor());
    plan.breakdown.projected_count += 1;

    const found = codes(reseal(plan));
    expect(found).toContain("closure-arithmetic-mismatch");
    expect(found).toContain("breakdown-mismatch");
  });

  /**
   * The dry run is only worth something if the thing applied is the thing
   * reviewed, so a plan edited after the review must not certify.
   */
  it("fails when the plan content no longer matches the digest it was reviewed under", () => {
    const plan = structuredClone(planFor());
    const record = plan.records.find(isRelationshipRecord);
    if (record) {
      record.status = "ended";
    }

    expect(codes(plan)).toContain("plan-digest-mismatch");
    expect(codes(reseal(plan))).not.toContain("plan-digest-mismatch");
  });

  it("fails when a projected record does not satisfy its schema", () => {
    const plan = structuredClone(planFor());
    const record = plan.records[0];
    expect(record).toBeDefined();
    if (record) {
      (record as { origin: string }).origin = "hand-edited";
    }

    expect(codes(reseal(plan))).toContain("invalid-record-shape");
  });

  /**
   * A source object that never became an outcome is the failure the independent
   * denominator exists to catch: every summary the plan computes about itself
   * would still balance.
   */
  it("fails when a source object never became an outcome", () => {
    const plan = structuredClone(planFor());
    const dropped = plan.outcomes[0];
    expect(dropped).toBeDefined();
    plan.outcomes = plan.outcomes.slice(1);
    plan.records = plan.records.filter((record) => !(dropped?.record_keys ?? []).includes(record.idempotency_key));
    plan.breakdown = evaluateClosureGate(plan).breakdown;

    // Several arithmetic checks catch it independently; no other check should.
    expect([...new Set(codes(reseal(plan)))]).toEqual(["closure-arithmetic-mismatch"]);
  });

  it("fails when the reader counted a different number of source objects", () => {
    const plan = planFor();
    const gate = evaluateClosureGate(plan, { expected_source_object_count: plan.source_object_count + 1 });

    expect(gate.ok).toBe(false);
    expect(gate.findings.map((finding) => finding.code)).toContain("closure-arithmetic-mismatch");
  });

  it("fails when a record vanishes from the plan but an outcome still claims it", () => {
    const plan = structuredClone(planFor());
    plan.records = plan.records.slice(1);

    expect(codes(reseal(plan))).toContain("record-not-accounted");
  });

  it("fails when two records share an idempotency key", () => {
    const plan = structuredClone(planFor());
    const first = plan.records[0];
    const second = plan.records[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first && second) {
      second.idempotency_key = first.idempotency_key;
    }

    expect(codes(reseal(plan))).toContain("duplicate-idempotency-key");
  });

  it("fails when an alias row points at a record the plan does not create", () => {
    const plan = structuredClone(planFor());
    const outcome = plan.outcomes.find((candidate) => candidate.alias_target.kind === "record");
    expect(outcome).toBeDefined();
    if (outcome && outcome.alias_target.kind === "record") {
      outcome.alias_target.record_key = `la_idem_${"1".repeat(32)}`;
    }

    expect(codes(reseal(plan))).toContain("alias-target-missing-record");
  });

  it("refuses a source object whose legacy id appears twice", () => {
    const duplicated = createLegacyGraphFixture();
    const first = duplicated[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    const plan = planFor([...duplicated, first]);

    const gate = evaluateClosureGate(plan);
    expect(gate.ok).toBe(true);
    expect(plan.breakdown.refusals_by_reason.find((entry) => entry.reason === "duplicate-legacy-object-id")?.count).toBe(
      1
    );
  });
});
