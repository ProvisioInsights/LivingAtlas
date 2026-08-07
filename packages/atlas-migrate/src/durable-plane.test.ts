import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableAssertionLog,
  DurableEntityRegistry,
  scanIdentityLog,
  scanSegmentLog,
  type Assertion,
  type AssertionId
} from "@living-atlas/atlas-core";
import {
  DeferredAssertionIdPrefix,
  LegacyTombstonePredicate,
  MigrationClientId,
  applyProjectionPlan,
  buildProjectionPlan,
  countDeferredEntityContent,
  createLegacyGraphFixture,
  createUnmappedCategoryFixture,
  decodeNoTargetReason,
  encodeNoTargetReason,
  isEntityRecord,
  isMintedEntityRecord,
  legacyFixtureAuthorityId,
  legacyFixtureIds,
  legacyFixturePayloadResolver,
  migrationPlaneDirectories,
  openDurableMigrationPlane,
  readMigrationPlaneCensus,
  type DurableMigrationPlane,
  type MigrationIdempotencyKey,
  type ProjectionPlan,
  type TargetPlaneSink
} from "./index.js";

/**
 * THE POINT OF THIS FILE.
 *
 * Every apply test before it ran against `createInMemoryTargetPlane()`, which
 * accepts any id shape, any timestamp and any sequence number. A projection can
 * satisfy that plane completely and still be unable to write one record into the
 * store it is about to be pointed at — which is how the adapter gap sat
 * unnoticed for a week. So everything here runs the REAL `DurableAssertionLog`
 * and `DurableEntityRegistry` against real directories on disk, and reads its
 * conclusions back out of the segment files rather than out of the process that
 * wrote them.
 */

const applyActorId = "la_user_migration01";
const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-migrate-plane-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function planFor(envelopes = createLegacyGraphFixture()): ProjectionPlan {
  return buildProjectionPlan(envelopes, {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
}

function openPlane(root: string): DurableMigrationPlane {
  return openDurableMigrationPlane({ directory: root, authority_id: legacyFixtureAuthorityId });
}

async function applyOnce(plan: ProjectionPlan, plane: DurableMigrationPlane, at: string, sink = plane.sink) {
  return applyProjectionPlan({
    plan,
    actor_id: applyActorId,
    registry: plane.registry,
    alias_ledger: plane.alias_ledger,
    sink,
    audit: plane.audit,
    now: () => at
  });
}

function countByKind(plan: ProjectionPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of plan.breakdown.records_by_kind) counts[entry.record_kind] = entry.count;
  return counts;
}

/** Every assertion the target root holds, read back off the segment files. */
function assertionsOnDisk(root: string): Assertion[] {
  return scanSegmentLog(migrationPlaneDirectories(root).assertions).restored.assertions;
}

function auditEvents(root: string): Record<string, unknown>[] {
  return readFileSync(migrationPlaneDirectories(root).audit, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the durable migration plane", () => {
  it("commits a whole plan into real segment files and reconciles against the plan's own counts", async () => {
    const root = temporaryRoot();
    const plan = planFor();
    const plane = openPlane(root);

    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    expect(result.ok).toBe(true);

    // Read back off disk, not from the run's counters. The four equations are
    // computed from `records_by_kind`, never from a constant: a hardcoded total
    // stops being a check the moment the fixture grows.
    const kinds = countByKind(plan);
    const census = readMigrationPlaneCensus(root);
    expect(census.entities).toBe((kinds.entity ?? 0) + (kinds["minted-entity"] ?? 0));
    expect(census.assertions).toBe(
      (kinds.relationship ?? 0) + (kinds["minted-relationship"] ?? 0) + (kinds.retraction ?? 0)
    );
    expect(census.alias_rows).toBe(plan.outcomes.length);
    expect(census.empty_submissions).toBe(kinds.absence ?? 0);

    // The fixture actually exercises all four classes, so the equations above
    // are not vacuously true.
    expect(kinds.entity ?? 0).toBeGreaterThan(0);
    expect(kinds.relationship ?? 0).toBeGreaterThan(0);
    expect(kinds.retraction ?? 0).toBeGreaterThan(0);
    expect(kinds.absence ?? 0).toBeGreaterThan(0);
  });

  it("takes recorded_at from the store at commit and ignores the time the plan was applied with", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);

    const result = await applyOnce(planFor(), plane, "1999-01-01T00:00:00.000Z");
    plane.close();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Not one receipt carries the instant the caller passed: the log stamps
    // belief time itself, which is the property that makes an as-of read
    // repeatable.
    for (const receipt of result.receipts) {
      expect(receipt.recorded_at).not.toBe("1999-01-01T00:00:00.000Z");
    }
    for (const assertion of assertionsOnDisk(root)) {
      expect(assertion.recorded_at).not.toBe("1999-01-01T00:00:00.000Z");
      expect(assertion.provenance.origin).toBe("pre-contract-import");
      expect(assertion.provenance.recorded_at_fidelity).toBe("import-artifact");
      expect(assertion.provenance.client_id).toBe(MigrationClientId);
    }
  });

  it("lets the log allocate seq, gapless from one, rather than replaying the plan's per-source ordinals", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const seqs = assertionsOnDisk(root)
      .map((assertion) => assertion.seq)
      .sort((left, right) => left - right);
    expect(seqs).toEqual(seqs.map((_value, index) => index + 1));
    // The plan hands out a small per-legacy-object ordinal, so if those had been
    // written through, the highest seq would be far below the record count and
    // the same number would appear many times.
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("never lets the deferred assertion handle reach a durable byte", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const paths = migrationPlaneDirectories(root);
    for (const segment of [
      ...scanSegmentLog(paths.assertions).segments,
      ...scanIdentityLog(paths.identity).segments
    ]) {
      expect(readFileSync(segment.path, "utf8")).not.toContain(DeferredAssertionIdPrefix);
    }
  });

  it("mints one entity per entity-shaped record and gives every one a real name", async () => {
    const root = temporaryRoot();
    const plan = planFor();
    const plane = openPlane(root);
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const entities = scanIdentityLog(migrationPlaneDirectories(root).identity).restored.entities;
    const entityRecords = plan.records.filter(
      (record) => isEntityRecord(record) || isMintedEntityRecord(record)
    );
    expect(entities).toHaveLength(entityRecords.length);

    const names = new Set(entityRecords.map((record) => record.name));
    for (const entity of entities) {
      expect(entity.display_name.length).toBeGreaterThan(0);
      expect(names.has(entity.display_name)).toBe(true);
      expect(entity.provenance.basis).toMatch(/^la_idem_[a-f0-9]{32}$/);
      if (entity.type === "other") expect(entity.type_label).toBeDefined();
      else expect(entity.type_label).toBeUndefined();
    }
  });

  it("records a legacy tombstone over an entity as an assertion, because entities are never deleted", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const tombstones = assertionsOnDisk(root).filter(
      (assertion) => assertion.predicate === LegacyTombstonePredicate
    );
    expect(tombstones.length).toBeGreaterThan(0);
    const entities = new Set(
      scanIdentityLog(migrationPlaneDirectories(root).identity).restored.entities.map(
        (entity) => entity.entity_id
      )
    );
    for (const tombstone of tombstones) {
      // It is ABOUT the entity, and the entity is still there.
      expect(entities.has(tombstone.subject_entity_id)).toBe(true);
      expect(tombstone.lineage_action).toBe("assert");
      expect(tombstone.supersedes).toEqual([]);
    }
  });

  it("retracts natively when the tombstoned record became an assertion", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const assertions = assertionsOnDisk(root);
    const retractions = assertions.filter((assertion) => assertion.lineage_action === "retract");
    expect(retractions.length).toBeGreaterThan(0);

    const byId = new Map(assertions.map((assertion) => [assertion.assertion_id, assertion]));
    for (const retraction of retractions) {
      expect(retraction.supersedes).toHaveLength(1);
      const supersededId = retraction.supersedes[0] as AssertionId;
      const superseded = byId.get(supersededId);
      expect(superseded).toBeDefined();
      // The original is still readable and now carries the write-once stamp,
      // which is the whole proof that a retraction did not edit history.
      expect(superseded?.superseded_at).not.toBeNull();
      expect(superseded?.superseded_by).toBe(retraction.assertion_id);
      // A retraction is a belief error; the world did not change, so the
      // interval is copied rather than closed.
      expect(retraction.valid_from).toEqual(superseded?.valid_from);
      expect(retraction.valid_to).toEqual(superseded?.valid_to);
    }
  });

  it("resolves a legacy edge id to the assertion it became, and refuses to call it an entity", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    // Reopened from the segment files, so this is what a later reader gets.
    const registry = DurableEntityRegistry.open({
      directory: migrationPlaneDirectories(root).identity
    });
    const resolution = registry.registry.resolve(legacyFixtureIds.edgeEmployment);
    registry.close();

    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.code).toBe("carried-as-assertion");
    if (resolution.code !== "carried-as-assertion") return;
    expect(resolution.new_assertion_id).toMatch(/^la_assertion_/);
  });

  it("answers a refused legacy id with a stated outcome rather than a bare miss", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    await applyOnce(planFor(), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const registry = DurableEntityRegistry.open({
      directory: migrationPlaneDirectories(root).identity
    });
    const refused = registry.registry.resolve(legacyFixtureIds.edgeDangling);
    const unrecoverable = registry.registry.resolve(legacyFixtureIds.liveUnrecoverable);
    const neverSeen = registry.registry.resolve("la_object_legacy_never_existed");
    registry.close();

    expect(refused.ok).toBe(false);
    if (!refused.ok && refused.code === "not-carried-forward") {
      expect(refused.disposition).toBe("never-migrated");
      expect(refused.reason).toContain("dangling-edge-endpoint");
    } else {
      expect.unreachable("a refused legacy id must resolve to a stated outcome");
    }

    // "we could not decrypt it" and "we chose not to carry it" are different
    // answers and the ledger keeps them apart.
    expect(unrecoverable.ok).toBe(false);
    if (!unrecoverable.ok && unrecoverable.code === "not-carried-forward") {
      expect(unrecoverable.disposition).toBe("content-unrecoverable");
    } else {
      expect.unreachable("an undecryptable legacy id must resolve to content-unrecoverable");
    }

    // And an id nobody ever held is still a miss, so the two stay tellable apart.
    expect(neverSeen.ok).toBe(false);
    if (!neverSeen.ok) expect(neverSeen.code).toBe("unknown-id");
  });

  it("verifies the alias ledger's hash chain after the whole plan has been written", async () => {
    const root = temporaryRoot();
    const plan = planFor();
    const plane = openPlane(root);
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const registry = DurableEntityRegistry.open({
      directory: migrationPlaneDirectories(root).identity
    });
    const integrity = registry.registry.verifyLedger();
    const conflicts = [...registry.registry.conflicts];
    registry.close();

    expect(integrity.ok).toBe(true);
    if (integrity.ok) expect(integrity.rows).toBe(plan.outcomes.length);
    expect(conflicts).toEqual([]);
  });

  it("writes one durable audit event per apply call, carrying aggregate counts only", async () => {
    const root = temporaryRoot();
    const plan = planFor();
    const plane = openPlane(root);
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    await applyOnce(plan, plane, "2026-08-05T10:00:00.000Z");
    plane.close();

    const events = auditEvents(root);
    expect(events).toHaveLength(2);
    expect(events[0]?.event_schema).toBe("living-atlas-migration-apply:v1");
    expect(events[0]?.outcome).toBe("committed");
    expect(events[0]?.records_committed).toBe(plan.records.length);
    // The second run is a pure replay: nothing was written twice.
    expect(events[1]?.records_committed).toBe(0);
    expect(events[1]?.records_replayed).toBe(plan.records.length);
    expect(events[1]?.alias_rows_written).toBe(0);
    expect(events[1]?.alias_rows_reused).toBe(plan.outcomes.length);
    // Aggregates only: no event enumerates a record.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("la_object_legacy_person_0");
  });

  it("refuses a plan that fails the closure gate and writes nothing but the refusal", async () => {
    const root = temporaryRoot();
    const plane = openPlane(root);
    const result = await applyOnce(planFor(createUnmappedCategoryFixture()), plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    expect(result.ok).toBe(false);
    const census = readMigrationPlaneCensus(root);
    expect(census).toEqual({ entities: 0, assertions: 0, alias_rows: 0, empty_submissions: 0 });
    expect(auditEvents(root)).toHaveLength(1);
    expect(auditEvents(root)[0]?.outcome).toBe("closure-gate-failed");
  });
});

describe("the entity content this adapter does not carry", () => {
  /**
   * A deferral the owner can see is a decision; a deferral nobody counts is a
   * loss that has not been noticed yet. These assertions exist so that the day
   * somebody starts carrying attributes onto the entity, or stops projecting
   * them at all, the number moves and a test says so.
   */
  it("counts it rather than leaving it to be discovered", () => {
    const plan = planFor();
    const deferred = countDeferredEntityContent(plan.records);

    const kinds = countByKind(plan);
    expect(deferred.entity_records).toBe((kinds.entity ?? 0) + (kinds["minted-entity"] ?? 0));
    // The fixture really does carry all four, so the count is not vacuous.
    expect(deferred.with_attributes).toBeGreaterThan(0);
    expect(deferred.with_a_description).toBeGreaterThan(0);
    expect(deferred.with_a_subtype).toBeGreaterThan(0);
    expect(deferred.with_a_topic_scheme).toBeGreaterThan(0);
    // Keys only. An attribute VALUE is graph content and never leaves the store
    // through a report.
    expect(deferred.attribute_keys.length).toBeGreaterThan(0);
    for (const key of deferred.attribute_keys) expect(key).toMatch(/^[a-z_]+$/);
  });

  it("is genuinely absent from the identity log, not quietly smuggled into a name", async () => {
    const root = temporaryRoot();
    const plan = planFor();
    const plane = openPlane(root);
    await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    plane.close();

    const descriptions = plan.records.flatMap((record) =>
      record.record_kind === "entity" && record.description !== undefined ? [record.description] : []
    );
    expect(descriptions.length).toBeGreaterThan(0);
    const identityBytes = scanIdentityLog(migrationPlaneDirectories(root).identity)
      .segments.map((segment) => readFileSync(segment.path, "utf8"))
      .join("");
    for (const description of descriptions) {
      expect(identityBytes).not.toContain(description);
    }
  });
});

describe("no-target ledger reasons round-trip", () => {
  /**
   * `applyProjectionPlan` decides a run conflicted by comparing a re-read alias
   * target against the planned one with `JSON.stringify`, so a row that does not
   * read back byte-identical makes every resume report a conflict with rows it
   * wrote itself. Key ORDER is part of that, which a value-wise assertion would
   * not catch.
   */
  it("reproduces the planned target exactly, key order included", () => {
    for (const target of [
      { kind: "no-target", disposition: "refused", reason: "dangling-edge-endpoint", detail: "no endpoint" },
      { kind: "no-target", disposition: "unrecoverable-ciphertext", detail: "decrypt failed: bad key" },
      { kind: "no-target", disposition: "other", detail: "" }
    ] as const) {
      const decoded = decodeNoTargetReason(encodeNoTargetReason(target));
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(target));
    }
  });

  it("declines to decode a reason it did not write, rather than normalising it into one it did", () => {
    expect(decodeNoTargetReason("merged by hand after review")).toBeUndefined();
    expect(decodeNoTargetReason("not-a-disposition: detail")).toBeUndefined();
    expect(decodeNoTargetReason("refused/not-a-reason: detail")).toBeUndefined();
  });
});

describe("resuming a durable apply that died part-way", () => {
  /**
   * The failure this proves survivable is the ordinary one: the disk fills, or
   * the process is killed, half way through a corpus-sized run. What must hold
   * is that re-running finishes the job and writes nothing twice — and "nothing
   * twice" has to be measured on the bytes, because the in-memory plane cannot
   * tell a second entity from a replayed one.
   */
  function sinkThatDiesAfter(inner: TargetPlaneSink, accepts: number): TargetPlaneSink {
    let accepted = 0;
    return {
      receiptFor: (key) => inner.receiptFor(key),
      commit: async (request) => {
        if (accepted >= accepts) throw new Error("no space left on device");
        accepted += 1;
        return inner.commit(request);
      }
    };
  }

  it("completes on a re-run and commits nothing twice", async () => {
    const root = temporaryRoot();
    const plan = planFor();

    const first = openPlane(root);
    await expect(
      applyOnce(plan, first, "2026-08-04T10:00:00.000Z", sinkThatDiesAfter(first.sink, 6))
    ).rejects.toThrow(/no space left on device/);
    first.close();

    /**
     * SEVEN, not six, and the extra one is the whole reason the resume handle
     * lives in the identity log.
     *
     * `mintEntity` writes to the identity log and returns an id BEFORE the sink
     * is asked to commit, because an id handed out before the bytes are durable
     * is an id that can be minted again for something else. So the record the
     * sink refused had already left an entity behind: durable, real, and with
     * no receipt naming it. That orphan is exactly what `EntityDraft.basis`
     * rescues — the resume finds it by key and replays it instead of minting a
     * second identity for one legacy record.
     */
    const partial = readMigrationPlaneCensus(root);
    expect(partial.entities + partial.assertions + partial.empty_submissions).toBe(7);
    expect(partial.entities).toBe(7);
    expect(partial.entities + partial.assertions).toBeLessThan(plan.records.length);

    // A NEW plane over the same directories: the resume rebuilds everything it
    // needs from the segment files, which is the point of putting the resume
    // handle in the identity log rather than in a sidecar.
    const second = openPlane(root);
    const resumed = await applyOnce(plan, second, "2026-08-05T10:00:00.000Z");
    second.close();

    expect(resumed.ok).toBe(true);

    const kinds = countByKind(plan);
    const census = readMigrationPlaneCensus(root);
    expect(census.entities).toBe((kinds.entity ?? 0) + (kinds["minted-entity"] ?? 0));
    expect(census.assertions).toBe(
      (kinds.relationship ?? 0) + (kinds["minted-relationship"] ?? 0) + (kinds.retraction ?? 0)
    );
    expect(census.alias_rows).toBe(plan.outcomes.length);

    // Nothing minted twice: one entity per plan key, one assertion per plan key.
    const entities = scanIdentityLog(migrationPlaneDirectories(root).identity).restored.entities;
    const bases = entities.map((entity) => entity.provenance.basis);
    expect(new Set(bases).size).toBe(bases.length);

    const submissions = scanSegmentLog(migrationPlaneDirectories(root).assertions).restored.submissions;
    const assertionIds = [...submissions.values()].flatMap((receipt) => receipt.assertion_ids);
    expect(new Set(assertionIds).size).toBe(assertionIds.length);
  });

  it("a third full run over a finished store writes nothing at all", async () => {
    const root = temporaryRoot();
    const plan = planFor();

    const first = openPlane(root);
    await applyOnce(plan, first, "2026-08-04T10:00:00.000Z");
    first.close();
    const afterFirst = readMigrationPlaneCensus(root);

    const second = openPlane(root);
    const result = await applyOnce(plan, second, "2026-08-06T10:00:00.000Z");
    second.close();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.audit.records_committed).toBe(0);
      expect(result.audit.records_replayed).toBe(plan.records.length);
    }
    expect(readMigrationPlaneCensus(root)).toEqual(afterFirst);
  });

  it("replays the original recorded_at rather than restamping a record that already committed", async () => {
    const root = temporaryRoot();
    const plan = planFor();

    const first = openPlane(root);
    const initial = await applyOnce(plan, first, "2026-08-04T10:00:00.000Z");
    first.close();
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const original = new Map(
      initial.receipts.map((receipt) => [receipt.idempotency_key, receipt.recorded_at])
    );

    const second = openPlane(root);
    const resumed = await applyOnce(plan, second, "2027-01-01T00:00:00.000Z");
    second.close();

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    for (const receipt of resumed.receipts) {
      expect(receipt.recorded_at).toBe(original.get(receipt.idempotency_key as MigrationIdempotencyKey));
    }
  });

  it("keeps every id it handed out resolving after a reopen", async () => {
    const root = temporaryRoot();
    const plan = planFor();

    const plane = openPlane(root);
    const result = await applyOnce(plan, plane, "2026-08-04T10:00:00.000Z");
    plane.close();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const log = DurableAssertionLog.open({ directory: migrationPlaneDirectories(root).assertions });
    const registry = DurableEntityRegistry.open({ directory: migrationPlaneDirectories(root).identity });
    try {
      for (const receipt of result.receipts) {
        if (receipt.object_id.startsWith("la_entity_")) {
          expect(registry.registry.read(receipt.object_id as never)).toBeDefined();
        } else if (receipt.object_id.startsWith("la_assertion_")) {
          expect(log.read(receipt.object_id as AssertionId)).toBeDefined();
        } else {
          // The only other shape is the submission that recorded an absence.
          expect(receipt.object_id).toMatch(/^la_submission_/);
          expect(log.log.readSubmissionById(receipt.object_id)).toBeDefined();
        }
      }
    } finally {
      log.close();
      registry.close();
    }
  });
});
