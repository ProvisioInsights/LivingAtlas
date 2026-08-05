import { describe, expect, it } from "vitest";
import {
  buildProjectionPlan,
  createLegacyGraphFixture,
  legacyFixtureAuthorityId,
  legacyFixtureIds,
  legacyFixturePayloadResolver,
  renderProjectionPlanReport,
  isEntityRecord,
  isRelationshipRecord,
  isRetractionRecord,
  type ProjectionPlan,
  type SourceOutcome
} from "./index.js";

function planFixture(): ProjectionPlan {
  return buildProjectionPlan(createLegacyGraphFixture(), {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

function outcomeFor(plan: ProjectionPlan, legacyObjectId: string): SourceOutcome {
  const outcome = plan.outcomes.find((candidate) => candidate.legacy_object_id === legacyObjectId);
  if (!outcome) {
    throw new Error(`no outcome for ${legacyObjectId}`);
  }
  return outcome;
}

function refusalReason(plan: ProjectionPlan, legacyObjectId: string): string {
  const { disposition } = outcomeFor(plan, legacyObjectId);
  return disposition.kind === "refused" ? disposition.reason : `not-refused:${disposition.kind}`;
}

function collectKeys(value: unknown, key: string, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, key, found);
    }
    return found;
  }
  if (value && typeof value === "object") {
    for (const [candidate, child] of Object.entries(value)) {
      if (candidate === key) {
        found.push(String(child));
      }
      collectKeys(child, key, found);
    }
  }
  return found;
}

describe("legacy projection", () => {
  it("gives every source object exactly one outcome", () => {
    const source = createLegacyGraphFixture();
    const plan = planFixture();

    expect(plan.outcomes).toHaveLength(source.length);
    expect(new Set(plan.outcomes.map((outcome) => outcome.legacy_object_id)).size).toBe(source.length);
    expect(plan.breakdown.projected_count + plan.breakdown.refused_count).toBe(source.length);
  });

  it("projects a decryptable ciphertext entity exactly like a plaintext one", () => {
    const plan = planFixture();
    const entity = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.organization1);

    expect(entity?.entity_type).toBe("organization");
    expect(entity?.name).toBe("Employer 1");
    expect(entity?.provenance.legacy_access_class).toBe("local-private");
  });

  it("stamps import origin and fidelity on every projected record", () => {
    const plan = planFixture();

    expect(plan.records.length).toBeGreaterThan(0);
    for (const record of plan.records) {
      expect(record.origin).toBe("pre-contract-import");
      expect(record.recorded_at_fidelity).toBe("import-artifact");
    }
  });

  it("keeps legacy timestamps in provenance and mints no time of record", () => {
    const plan = planFixture();
    const entity = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.person);

    expect(entity?.provenance.legacy_created_at).toBe("2024-03-04T09:00:00.000Z");
    expect(entity?.provenance.legacy_updated_at).toBe("2025-11-19T17:30:00.000Z");
    // recorded_at belongs to the commit, so a plan must not contain one anywhere.
    expect(collectKeys(plan, "recorded_at")).toEqual([]);
  });

  it("mints no new-plane identity at plan time", () => {
    const source = createLegacyGraphFixture();
    const plan = planFixture();
    const legacyIds = new Set(source.map((envelope) => envelope.object_id));

    const objectIdsInPlan = JSON.stringify(plan).match(/la_object_[A-Za-z0-9_-]+/g) ?? [];
    for (const objectId of objectIdsInPlan) {
      expect(legacyIds.has(objectId)).toBe(true);
    }
  });

  it("reports world time at the fidelity the legacy edge actually had", () => {
    const plan = planFixture();
    const relationships = plan.records.filter(isRelationshipRecord);
    const byLegacyId = new Map(relationships.map((record) => [record.provenance.legacy_object_id, record]));

    expect(byLegacyId.get(legacyFixtureIds.edgeEmployment)?.valid_from_fidelity).toBe("exact");
    expect(byLegacyId.get(legacyFixtureIds.edgeFounder)?.valid_from_fidelity).toBe("approximate");
    expect(byLegacyId.get(legacyFixtureIds.edgeFounder)?.valid_from).toBe("~2018");
    expect(byLegacyId.get(legacyFixtureIds.edgeBasedIn)?.valid_from_fidelity).toBe("unknown");
    expect(byLegacyId.get(legacyFixtureIds.edgeEmployment)?.valid_to_fidelity).toBe("unknown");
  });

  it("does not carry legacy free-text source or bare confidence into the new plane", () => {
    const plan = planFixture();
    const relationship = plan.records
      .filter(isRelationshipRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.edgeEmployment);

    expect(relationship).toBeDefined();
    expect(Object.keys(relationship ?? {})).not.toContain("confidence");
    expect(JSON.stringify(relationship)).not.toContain("legacy-fixture");
  });

  it("projects a readable tombstone as the pre-deletion record plus a retraction", () => {
    const plan = planFixture();
    const entity = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.organizationTombstoned);
    const retraction = plan.records
      .filter(isRetractionRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.organizationTombstoned);

    expect(entity).toBeDefined();
    expect(retraction?.retracts_idempotency_key).toBe(entity?.idempotency_key);
    expect(retraction?.retraction_basis).toBe("legacy-tombstone");
    expect(outcomeFor(plan, legacyFixtureIds.organizationTombstoned).disposition.kind).toBe("projected-as-retraction");

    const edgeRelationship = plan.records
      .filter(isRelationshipRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.edgeMembershipTombstoned);
    const edgeRetraction = plan.records
      .filter(isRetractionRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.edgeMembershipTombstoned);
    expect(edgeRetraction?.retracts_idempotency_key).toBe(edgeRelationship?.idempotency_key);
  });

  it("maps each tombstone kind to exactly one declared disposition", () => {
    const plan = planFixture();

    expect(outcomeFor(plan, legacyFixtureIds.tombstonedUnrecoverable).disposition.kind).toBe("unrecoverable-ciphertext");
    expect(outcomeFor(plan, legacyFixtureIds.tombstonedQuarantine).disposition.kind).toBe("redaction-stub");
    expect(refusalReason(plan, legacyFixtureIds.tombstonedUnavailable)).toBe("ciphertext-not-attempted");
  });

  it("withholds quarantined content even when the caller can read it", () => {
    const plan = planFixture();
    const outcome = outcomeFor(plan, legacyFixtureIds.liveQuarantine);

    expect(outcome.category).toBe("quarantined-object");
    expect(outcome.disposition.kind).toBe("redaction-stub");
    expect(JSON.stringify(plan)).not.toContain("withheld synthetic content");
  });

  /**
   * Quarantine outranks readability in both directions. An unreadable
   * quarantined object must be reported as withheld by policy, never as lost
   * data — the two send a reader to completely different remedies.
   */
  it("reports an unreadable quarantined object as withheld, not as unrecoverable", () => {
    const plan = planFixture();
    const outcome = outcomeFor(plan, legacyFixtureIds.unreadableQuarantine);

    expect(outcome.category).toBe("quarantined-object");
    expect(outcome.disposition.kind).toBe("redaction-stub");
  });

  it("names a distinct reason for every refusal it can make", () => {
    const plan = planFixture();

    expect(refusalReason(plan, legacyFixtureIds.edgeDangling)).toBe("dangling-edge-endpoint");
    expect(refusalReason(plan, legacyFixtureIds.edgeEndpointNotProjected)).toBe("endpoint-not-projected");
    expect(refusalReason(plan, legacyFixtureIds.edgeEndpointTypeMismatch)).toBe("endpoint-type-mismatch");
    expect(refusalReason(plan, legacyFixtureIds.edgeInvalidPayload)).toBe("invalid-legacy-payload");
    expect(refusalReason(plan, legacyFixtureIds.narrativePage)).toBe("no-typed-target-representation");
    expect(refusalReason(plan, legacyFixtureIds.liveUnavailable)).toBe("ciphertext-not-attempted");
  });

  it("flattens an alias chain to the record its final hop became", () => {
    const plan = planFixture();
    const personEntity = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.person);

    for (const hop of [legacyFixtureIds.aliasHop1, legacyFixtureIds.aliasHop2]) {
      const outcome = outcomeFor(plan, hop);
      expect(outcome.disposition.kind).toBe("projected-as-alias-redirect");
      expect(outcome.alias_target.kind).toBe("record");
      if (outcome.alias_target.kind === "record") {
        expect(outcome.alias_target.record_key).toBe(personEntity?.idempotency_key);
      }
    }
  });

  /**
   * Refusing an edge because its endpoint names a redirected id would drop a
   * real edge over bookkeeping the legacy store had already resolved.
   */
  it("attaches an edge that names a redirected id to the object the chain ends at", () => {
    const plan = planFixture();
    const personEntity = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.person);
    const relationship = plan.records
      .filter(isRelationshipRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.edgeThroughRedirect);

    expect(relationship?.source_slot).toBe(personEntity?.slot);
    expect(outcomeFor(plan, legacyFixtureIds.edgeThroughRedirect).disposition.kind).toBe(
      "projected-as-relationship"
    );
  });

  it("refuses an alias cycle instead of walking it", () => {
    const source = createLegacyGraphFixture().filter(
      (envelope) => envelope.object_id !== legacyFixtureIds.aliasHop2
    );
    const cyclic = [
      ...source,
      ...createLegacyGraphFixture()
        .filter((envelope) => envelope.object_id === legacyFixtureIds.aliasHop2)
        .map((envelope) => ({
          ...envelope,
          payload: { kind: "plaintext-json" as const, data: { redirects_to: legacyFixtureIds.aliasHop1 } }
        }))
    ];

    const plan = buildProjectionPlan(cyclic, {
      authority_id: legacyFixtureAuthorityId,
      resolve_payload: legacyFixturePayloadResolver
    });

    expect(refusalReason(plan, legacyFixtureIds.aliasHop1)).toBe("alias-cycle");
    expect(refusalReason(plan, legacyFixtureIds.aliasHop2)).toBe("alias-cycle");
  });

  it("plans an alias row for every legacy id, including the ones that carried nothing", () => {
    const source = createLegacyGraphFixture();
    const plan = planFixture();

    expect(plan.outcomes.map((outcome) => outcome.legacy_object_id).sort()).toEqual(
      source.map((envelope) => envelope.object_id).sort()
    );
    const noTarget = outcomeFor(plan, legacyFixtureIds.narrativePage).alias_target;
    expect(noTarget.kind).toBe("no-target");
    if (noTarget.kind === "no-target") {
      expect(noTarget.reason).toBe("no-typed-target-representation");
    }
  });

  it("is a pure function of the source, so plans diff cleanly", () => {
    expect(JSON.stringify(planFixture())).toBe(JSON.stringify(planFixture()));
    expect(planFixture().plan_digest).toBe(planFixture().plan_digest);
  });

  it("renders a report that carries counts, not corpus content", () => {
    const plan = planFixture();
    const report = renderProjectionPlanReport(plan);

    expect(report).toContain("source objects");
    expect(report).toContain(legacyFixtureIds.narrativePage);
    expect(report).toContain("dangling-edge-endpoint");
    expect(report).not.toContain("Person 0");
    expect(report).not.toContain("Employer 0");
    expect(report).not.toContain("Synthetic narrative body.");
  });
});
