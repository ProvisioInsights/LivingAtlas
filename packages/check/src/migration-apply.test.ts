import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectionPlan,
  createLegacyGraphFixture,
  createUnmappedCategoryFixture,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  readMigrationPlaneCensus,
  type MigrationPlaneCensus,
  type ProjectionPlan
} from "@living-atlas/atlas-migrate";
import {
  checkSyncDaemonIsNotLoaded,
  checkTargetIsNotTheReplica,
  realPathOrNearestAncestor,
  reconcileMigrationApply,
  runMigrationApply,
  type SyncDaemonProbe
} from "./migration-apply";

/**
 * The guards are the only thing standing between a plan and the operator's real
 * graph, so each one is proven twice: once refusing the condition it exists for,
 * and once letting a clean run through. A guard that has only ever been seen to
 * pass has not been tested — it may simply never fire.
 */

const roots: string[] = [];
const actorId = "la_user_migration01";

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-migration-apply-"));
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

const daemonNotLoaded: SyncDaemonProbe = () => ({ status: "not-loaded", detail: "launchctl print exited 113" });
const daemonLoaded: SyncDaemonProbe = () => ({ status: "loaded", detail: "launchctl print succeeded" });
const daemonUnknown: SyncDaemonProbe = () => ({ status: "undeterminable", detail: "launchctl not found" });

describe("guard: the target must not be the frozen replica", () => {
  it("refuses a target directly inside the replica", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    const refusal = checkTargetIsNotTheReplica(join(replica, "new-store"), replica);
    expect(refusal?.guard).toBe("target-collides-with-replica");
  });

  it("refuses the replica itself", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    expect(checkTargetIsNotTheReplica(replica, replica)?.guard).toBe("target-collides-with-replica");
  });

  it("refuses a target that only reaches the replica through a symlink", () => {
    /**
     * The case a `path.resolve` comparison waves through, and the shape this
     * mistake actually takes: somebody makes `store-new` point at the store.
     */
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    const link = join(root, "personal-prod-new");
    symlinkSync(replica, link);

    expect(checkTargetIsNotTheReplica(link, replica)?.guard).toBe("target-collides-with-replica");
    // And through a parent that is the symlink, for a directory that does not
    // exist yet — which is the normal state of a brand new store.
    expect(checkTargetIsNotTheReplica(join(link, "atlas"), replica)?.guard).toBe(
      "target-collides-with-replica"
    );
  });

  it("refuses a target that CONTAINS the replica", () => {
    const root = temporaryRoot();
    const replica = join(root, "outer", "personal-prod");
    mkdirSync(replica, { recursive: true });
    expect(checkTargetIsNotTheReplica(join(root, "outer"), replica)?.guard).toBe(
      "target-collides-with-replica"
    );
  });

  it("passes a genuine sibling, including one whose name extends the replica's", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    expect(checkTargetIsNotTheReplica(join(root, "personal-prod-atlas"), replica)).toBeUndefined();
    expect(checkTargetIsNotTheReplica(join(root, "atlas-store"), replica)).toBeUndefined();
  });

  it("resolves through symlinks even where the path does not exist yet", () => {
    const root = temporaryRoot();
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link");
    symlinkSync(real, link);
    expect(realPathOrNearestAncestor(join(link, "a", "b"))).toBe(
      join(realPathOrNearestAncestor(real), "a", "b")
    );
  });
});

describe("guard: the sync daemon must not be loaded", () => {
  it("refuses when the daemon is loaded", () => {
    expect(checkSyncDaemonIsNotLoaded(daemonLoaded)?.guard).toBe("sync-daemon-loaded");
  });

  it("refuses when it cannot tell, rather than assuming the daemon is off", () => {
    const refusal = checkSyncDaemonIsNotLoaded(daemonUnknown);
    expect(refusal?.guard).toBe("sync-daemon-loaded");
    expect(refusal?.detail).toContain("could not be determined");
  });

  it("passes when the daemon is not loaded", () => {
    expect(checkSyncDaemonIsNotLoaded(daemonNotLoaded)).toBeUndefined();
  });
});

describe("the apply entrypoint", () => {
  it("refuses a plan that fails the closure gate and leaves no target behind", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const run = await runMigrationApply({
      plan: planFor(createUnmappedCategoryFixture()),
      target_directory: target,
      replica_directory: join(root, "personal-prod"),
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });

    expect(run.ok).toBe(false);
    expect(run.refusals.map((refusal) => refusal.guard)).toEqual(["closure-gate"]);
    // Nothing was opened, so nothing was created. A refused run that left two
    // empty segment logs behind would look like a partial migration to whoever
    // found it next.
    expect(() => readMigrationPlaneCensus(target)).not.toThrow();
    expect(readMigrationPlaneCensus(target)).toEqual({
      entities: 0,
      assertions: 0,
      alias_rows: 0,
      empty_submissions: 0,
      provisional_blocks: 0,
      provisional_retractions: 0
    });
    expect(run.report).toContain("closure-gate                      REFUSED");
  });

  it("reports every guard that fired, not just the first", async () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    const run = await runMigrationApply({
      plan: planFor(createUnmappedCategoryFixture()),
      target_directory: join(replica, "inside"),
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonLoaded
    });

    expect(run.ok).toBe(false);
    expect(run.refusals.map((refusal) => refusal.guard).sort()).toEqual([
      "closure-gate",
      "sync-daemon-loaded",
      "target-collides-with-replica"
    ]);
  });

  it("writes nothing when the daemon guard fires, even on a plan that would certify", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const run = await runMigrationApply({
      plan: planFor(),
      target_directory: target,
      replica_directory: join(root, "personal-prod"),
      actor_id: actorId,
      probe_sync_daemon: daemonLoaded
    });

    expect(run.ok).toBe(false);
    expect(run.refusals.map((refusal) => refusal.guard)).toEqual(["sync-daemon-loaded"]);
    expect(readMigrationPlaneCensus(target).entities).toBe(0);
  });

  it("applies a clean plan and reconciles against the plan's own record counts", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const plan = planFor();
    const run = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: join(root, "personal-prod"),
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });

    expect(run.refusals).toEqual([]);
    expect(run.ok).toBe(true);
    expect(run.reconciliation?.ok).toBe(true);
    expect(run.reconciliation?.mismatches).toEqual([]);
    expect(run.report).toContain("outcome          completed");
    // The report is content-free: counts and verdicts, never a legacy id or a
    // name out of the graph.
    expect(run.report).not.toContain("la_object_legacy");
    expect(run.report).not.toContain("Person 0");
  });

  it("finishes an interrupted migration on a re-run without committing anything twice", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const plan = planFor();
    const replica = join(root, "personal-prod");

    const first = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });
    expect(first.ok).toBe(true);
    const afterFirst = readMigrationPlaneCensus(target);

    const second = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });

    expect(second.ok).toBe(true);
    expect(second.apply?.audit.records_committed).toBe(0);
    expect(second.apply?.audit.records_replayed).toBe(plan.records.length);
    expect(readMigrationPlaneCensus(target)).toEqual(afterFirst);
  });
});

describe("the reconciliation", () => {
  const plan = planFor();

  function census(overrides: Partial<MigrationPlaneCensus> = {}): MigrationPlaneCensus {
    const kinds = new Map(plan.breakdown.records_by_kind.map((entry) => [entry.record_kind, entry.count]));
    const at = (kind: string): number => kinds.get(kind as never) ?? 0;
    return {
      entities: at("entity") + at("minted-entity"),
      assertions: at("relationship") + at("minted-relationship") + at("retraction"),
      alias_rows: plan.outcomes.length,
      empty_submissions: at("absence"),
      provisional_blocks: at("provisional-block"),
      provisional_retractions: 0,
      ...overrides
    };
  }

  it("passes only when all five numbers agree", () => {
    expect(reconcileMigrationApply(plan, census()).ok).toBe(true);
  });

  it("fails a run that carried a block the plan did not call for", () => {
    const result = reconcileMigrationApply(
      plan,
      census({ provisional_blocks: census().provisional_blocks + 1 })
    );
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(["provisional blocks: expected 0, found 1"]);
  });

  /**
   * The equation that would otherwise be missing entirely. A carried block
   * leaves no assertion, no entity and no submission, so if it had no line of
   * its own a run could drop every one of them and still reconcile.
   */
  it("fails a run that carried none of the blocks the plan called for", () => {
    const withBlocks = { ...plan, breakdown: { ...plan.breakdown, records_by_kind: [...plan.breakdown.records_by_kind, { record_kind: "provisional-block" as const, count: 3 }] } };
    const result = reconcileMigrationApply(withBlocks, census({ provisional_blocks: 0 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual(["provisional blocks: expected 3, found 0"]);
  });

  it("fails a run that committed one entity too many", () => {
    const result = reconcileMigrationApply(plan, census({ entities: census().entities + 1 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(" ")).toContain("entities");
  });

  it("fails a run that committed one assertion too few", () => {
    const result = reconcileMigrationApply(plan, census({ assertions: census().assertions - 1 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(" ")).toContain("assertions");
  });

  it("fails a run that wrote the wrong number of alias rows", () => {
    const result = reconcileMigrationApply(plan, census({ alias_rows: 0 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(" ")).toContain("alias rows");
  });

  it("fails a run where an absence record went missing", () => {
    const result = reconcileMigrationApply(plan, census({ empty_submissions: 0 }));
    expect(result.ok).toBe(false);
    expect(result.mismatches.join(" ")).toContain("absence receipts");
  });

  it("takes its expectations from the plan rather than from a constant", () => {
    /**
     * The check that stops this from becoming a number somebody updated once.
     * A smaller corpus must produce smaller expectations, computed the same way,
     * with nothing in the file to edit.
     */
    const smaller = planFor(createLegacyGraphFixture().slice(0, 8));
    const full = reconcileMigrationApply(plan, census()).expected;
    const partial = reconcileMigrationApply(smaller, census()).expected;
    expect(partial.entities).toBeLessThan(full.entities);
    expect(partial.alias_rows).toBe(smaller.outcomes.length);
    expect(partial.alias_rows).toBeLessThan(full.alias_rows);
  });
});
