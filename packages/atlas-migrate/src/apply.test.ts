import { describe, expect, it } from "vitest";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  createInMemoryTargetPlane,
  createLegacyGraphFixture,
  createUnmappedCategoryFixture,
  isEntityRecord,
  legacyFixtureAuthorityId,
  legacyFixtureIds,
  legacyFixturePayloadResolver,
  type InMemoryTargetPlane,
  type ProjectionPlan
} from "./index.js";

const applyActorId = "la_user_migration01";

function planFor(envelopes = createLegacyGraphFixture()): ProjectionPlan {
  return buildProjectionPlan(envelopes, {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

function fixedClock(value: string): () => string {
  return () => value;
}

async function applyOnce(plan: ProjectionPlan, plane: InMemoryTargetPlane, at: string) {
  return applyProjectionPlan({
    plan,
    actor_id: applyActorId,
    registry: plane.registry,
    alias_ledger: plane.alias_ledger,
    sink: plane.sink,
    audit: plane.audit,
    now: fixedClock(at)
  });
}

describe("projection apply", () => {
  it("commits every planned record and stamps recorded_at at commit", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    expect(result.ok).toBe(true);
    expect(plane.sink.commits).toHaveLength(plan.records.length);
    for (const commit of plane.sink.commits) {
      expect(commit.recorded_at).toBe("2026-08-04T10:00:00.000Z");
      expect(commit.record.recorded_at_fidelity).toBe("import-artifact");
    }
    if (result.ok) {
      expect(result.audit.records_committed).toBe(plan.records.length);
      expect(result.audit.records_replayed).toBe(0);
    }
  });

  it("takes time of record from the commit clock, not the plan", async () => {
    const plan = planFor();
    const first = createInMemoryTargetPlane();
    const second = createInMemoryTargetPlane();

    await applyOnce(plan, first, "2026-08-04T10:00:00.000Z");
    await applyOnce(plan, second, "2027-01-01T00:00:00.000Z");

    expect(first.sink.commits[0]?.recorded_at).toBe("2026-08-04T10:00:00.000Z");
    expect(second.sink.commits[0]?.recorded_at).toBe("2027-01-01T00:00:00.000Z");
    // Same plan, same digest: the plan itself never carried a time.
    expect(first.audit.events[0]?.plan_digest).toBe(second.audit.events[0]?.plan_digest);
  });

  it("projects nothing twice when the same plan is applied again", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();

    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    const mintedAfterFirst = plane.registry.mintedEntities.length + plane.registry.mintedAssertions.length;
    const aliasRowsAfterFirst = plane.alias_ledger.appendLog.length;

    const second = await applyOnce(plan, plane, "2026-08-05T10:00:00.000Z");

    expect(second.ok).toBe(true);
    expect(plane.sink.commits).toHaveLength(plan.records.length);
    expect(plane.registry.mintedEntities.length + plane.registry.mintedAssertions.length).toBe(mintedAfterFirst);
    expect(plane.alias_ledger.appendLog).toHaveLength(aliasRowsAfterFirst);
    if (second.ok) {
      expect(second.audit.records_committed).toBe(0);
      expect(second.audit.records_replayed).toBe(plan.records.length);
      expect(second.audit.alias_rows_written).toBe(0);
      expect(second.audit.alias_rows_reused).toBe(plan.outcomes.length);
    }
  });

  it("re-running does not move the recorded_at of an already committed record", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();

    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    const second = await applyOnce(plan, plane, "2026-08-05T10:00:00.000Z");

    expect(second.ok).toBe(true);
    if (second.ok) {
      for (const receipt of second.receipts) {
        expect(receipt.recorded_at).toBe("2026-08-04T10:00:00.000Z");
      }
    }
  });

  it("writes an alias-ledger row for every legacy id on basis mechanical-migration", async () => {
    const source = createLegacyGraphFixture();
    const plan = planFor(source);
    const plane = createInMemoryTargetPlane();

    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    expect([...plane.alias_ledger.rows.keys()].sort()).toEqual(source.map((envelope) => envelope.object_id).sort());
    for (const row of plane.alias_ledger.rows.values()) {
      expect(row.basis).toBe("mechanical-migration");
    }
  });

  it("redirects an alias chain to the minted id of the object its last hop became", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    const personRecord = plan.records
      .filter(isEntityRecord)
      .find((record) => record.provenance.legacy_object_id === legacyFixtureIds.person);
    const personCommit = plane.sink.commits.find(
      (commit) => commit.idempotency_key === personRecord?.idempotency_key
    );
    expect(personCommit).toBeDefined();

    for (const hop of [legacyFixtureIds.aliasHop1, legacyFixtureIds.aliasHop2]) {
      const row = plane.alias_ledger.rows.get(hop);
      expect(row?.target.kind).toBe("redirect");
      if (row?.target.kind === "redirect") {
        expect(row.target.object_id).toBe(personCommit?.object_id);
      }
    }
  });

  it("answers a lookup of a refused legacy id with a reason instead of a miss", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    const row = plane.alias_ledger.rows.get(legacyFixtureIds.edgeDangling);
    expect(row).toBeDefined();
    expect(row?.target.kind).toBe("no-target");
    if (row?.target.kind === "no-target") {
      expect(row.target.reason).toBe("dangling-edge-endpoint");
    }
  });

  it("writes ledger rows only: a mechanical redirect asserts no identity decision", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audit.resolution_assertions_written).toBe(0);
      expect(result.audit.alias_rows_written).toBe(plan.outcomes.length);
    }
    expect(plane.sink.commits.map((commit) => commit.record.record_kind)).not.toContain("entity-resolution");
  });

  it("mints identity through the registry and resolves relationship endpoints to minted ids", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    const entityRecordCount = plan.records.filter(isEntityRecord).length;
    expect(plane.registry.mintedEntities).toHaveLength(entityRecordCount);
    expect(plane.registry.mintedAssertions).toHaveLength(plan.records.length - entityRecordCount);

    const mintedIds = new Set(plane.sink.commits.map((commit) => commit.object_id));
    for (const commit of plane.sink.commits) {
      if (commit.resolved.record_kind === "relationship") {
        expect(mintedIds.has(commit.resolved.source_entity_id)).toBe(true);
        expect(mintedIds.has(commit.resolved.target_entity_id)).toBe(true);
      }
      if (commit.resolved.record_kind === "retraction") {
        expect(mintedIds.has(commit.resolved.retracts_object_id)).toBe(true);
      }
    }
  });

  it("gives each legacy object its own assertion sequence", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    const tombstoned = plane.sink.commits
      .filter((commit) => commit.record.provenance.legacy_object_id === legacyFixtureIds.organizationTombstoned)
      .sort((left, right) => left.seq - right.seq);

    expect(tombstoned.map((commit) => commit.seq)).toEqual([1, 2]);
    expect(tombstoned[0]?.record.record_kind).toBe("entity");
    expect(tombstoned[1]?.record.record_kind).toBe("retraction");
  });

  it("refuses to apply a plan that fails the closure gate, and records the refusal", async () => {
    const plan = planFor(createUnmappedCategoryFixture());
    const plane = createInMemoryTargetPlane();
    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "closure-gate-failed") {
      expect(result.gate.findings.map((finding) => finding.code)).toContain("unclassified-source-category");
      expect(result.audit.mode).toBe("refused");
      expect(result.audit.gate_verdict).toBe("fail");
    }
    expect(plane.sink.commits).toHaveLength(0);
    expect(plane.alias_ledger.appendLog).toHaveLength(0);
    expect(plane.registry.mintedEntities).toHaveLength(0);
    expect(plane.audit.events).toHaveLength(1);
  });

  it("emits exactly one aggregate audit event per apply call", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();

    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    expect(plane.audit.events).toHaveLength(1);

    await applyOnce(plan, plane, "2026-08-05T10:00:00.000Z");
    expect(plane.audit.events).toHaveLength(2);

    const event = plane.audit.events[0];
    expect(event?.event_schema).toBe("living-atlas-migration-apply:v1");
    expect(event?.actor_id).toBe(applyActorId);
    expect(event?.source_object_count).toBe(plan.source_object_count);
    expect(event?.refused_source_objects).toBe(plan.breakdown.refused_count);
  });

  it("reports a typed conflict when the ledger already redirects a legacy id elsewhere", async () => {
    const plan = planFor();
    const plane = createInMemoryTargetPlane();
    await plane.alias_ledger.append({
      legacy_object_id: legacyFixtureIds.person,
      basis: "mechanical-migration",
      target: { kind: "redirect", object_id: "la_object_someotherid", record_kind: "entity" },
      recorded_at: "2026-01-01T00:00:00.000Z"
    });

    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");

    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "alias-ledger-conflict") {
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.legacy_object_id).toBe(legacyFixtureIds.person);
    }
  });
});
