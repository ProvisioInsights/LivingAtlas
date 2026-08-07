import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProjectionPlan,
  createLegacyGraphFixture,
  createLogseqBlockFixture,
  createUnmappedCategoryFixture,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  migrationPlaneDirectories,
  openDurableMigrationPlane,
  readMigrationPlaneCensus,
  type MigrationPlaneCensus,
  type ProjectionPlan
} from "@living-atlas/atlas-migrate";
import {
  LaunchctlServiceNotFound,
  checkReportPathIsSafe,
  checkSyncDaemonIsNotLoaded,
  checkTargetHoldsNoForeignStore,
  checkTargetIsNotTheReplica,
  launchctlSyncDaemonProbe,
  realPathOrNearestAncestor,
  reconcileMigrationApply,
  runMigrationApply,
  type LaunchctlResult,
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

/**
 * THE EXIT CODES ARE THE GUARD.
 *
 * Every one of these was measured on the operator's host before it was written
 * down: a job genuinely loaded in `gui/501` answers `launchctl print` with exit
 * 0 there and exit 125 in `gui/0`; a nonexistent job in `gui/501` answers 113;
 * `launchctl print gui/0` itself answers 125 because that domain has no GUI
 * session. The probe used to read EVERY non-zero exit as "not loaded", so under
 * sudo or over ssh it reported the daemon off while it was loaded and writing.
 */
describe("the launchd probe reads exit codes rather than guessing from them", () => {
  function runnerFor(results: Record<string, LaunchctlResult>): (args: string[]) => LaunchctlResult {
    return (args) => {
      const key = args.join(" ");
      const result = results[key];
      if (!result) throw new Error(`test runner has no answer for: ${key}`);
      return result;
    };
  }

  it("says not-loaded ONLY for exit 113", () => {
    const probe = launchctlSyncDaemonProbe(
      "io.livingatlas.personal-prod.sync",
      501,
      runnerFor({
        "print gui/501": { status: 0, detail: "domain exists" },
        "print gui/501/io.livingatlas.personal-prod.sync": {
          status: LaunchctlServiceNotFound,
          detail: "exited 113: Could not find service"
        }
      })
    );
    expect(probe().status).toBe("not-loaded");
  });

  it("refuses to call a domain it could not reach an absent daemon", () => {
    // The measured sudo/ssh case: exit 125, "Domain does not support specified
    // action". The old probe read this as proof the job was not loaded, which is
    // how a migration could run alongside the daemon it exists to exclude.
    const probe = launchctlSyncDaemonProbe(
      "io.livingatlas.personal-prod.sync",
      0,
      runnerFor({
        "print gui/0": { status: 125, detail: "exited 125: Domain does not support specified action" }
      })
    );
    const state = probe();
    expect(state.status).toBe("undeterminable");
    expect(state.detail).toContain("gui/0");
    expect(checkSyncDaemonIsNotLoaded(probe)?.guard).toBe("sync-daemon-loaded");
  });

  it("refuses on any other exit from the service probe, quoting the code", () => {
    const probe = launchctlSyncDaemonProbe(
      "io.livingatlas.personal-prod.sync",
      501,
      runnerFor({
        "print gui/501": { status: 0, detail: "domain exists" },
        "print gui/501/io.livingatlas.personal-prod.sync": { status: 125, detail: "exited 125" }
      })
    );
    const state = probe();
    expect(state.status).toBe("undeterminable");
    expect(state.detail).toContain("125");
    expect(state.detail).toContain("113");
  });

  it("reports a job that IS loaded", () => {
    const probe = launchctlSyncDaemonProbe(
      "io.livingatlas.personal-prod.sync",
      501,
      runnerFor({
        "print gui/501": { status: 0, detail: "domain exists" },
        "print gui/501/io.livingatlas.personal-prod.sync": { status: 0, detail: "succeeded" }
      })
    );
    expect(probe().status).toBe("loaded");
  });

  it("refuses when the platform has no uid to name a domain with", () => {
    // `?? 0` used to fill this in, and 0 is the single value most likely to name
    // a domain that does not exist — so the fallback manufactured the pass.
    const probe = launchctlSyncDaemonProbe("io.livingatlas.personal-prod.sync", undefined, () => {
      throw new Error("launchctl must not be reached without a uid");
    });
    expect(probe().status).toBe("undeterminable");
  });

  it("refuses when launchctl could not be run at all", () => {
    const probe = launchctlSyncDaemonProbe("io.livingatlas.personal-prod.sync", 501, () => ({
      status: undefined,
      detail: "launchctl could not be run: ENOENT"
    }));
    expect(probe().status).toBe("undeterminable");
  });
});

describe("guard: the report is a write, and it must land somewhere safe", () => {
  const trees = (replica: string, target: string) => [
    { label: "the frozen replica", directory: replica },
    { label: "the new store", directory: target }
  ];

  it("refuses a report aimed inside the frozen replica", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    // The exact shape that destroys the recovery story: a truncating write onto
    // the snapshot the migration read.
    const refusal = checkReportPathIsSafe(join(replica, "snapshot.json"), trees(replica, join(root, "atlas")));
    expect(refusal?.guard).toBe("report-collides-with-a-store");
    expect(refusal?.detail).toContain("the frozen replica");
  });

  it("refuses a report aimed inside the new store", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    const target = join(root, "personal-prod-atlas");
    mkdirSync(replica, { recursive: true });
    mkdirSync(target, { recursive: true });
    // `provisional-blocks.jsonl` lives here. One typo would truncate every
    // carried block after the run that carried them.
    const refusal = checkReportPathIsSafe(join(target, "provisional-blocks.jsonl"), trees(replica, target));
    expect(refusal?.guard).toBe("report-collides-with-a-store");
    expect(refusal?.detail).toContain("the new store");
  });

  it("refuses a report reaching the replica only through a symlink", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    const link = join(root, "reports");
    symlinkSync(replica, link);
    expect(checkReportPathIsSafe(join(link, "apply.txt"), trees(replica, join(root, "atlas")))?.guard).toBe(
      "report-collides-with-a-store"
    );
  });

  it("refuses a relative path and a directory that does not exist", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    expect(checkReportPathIsSafe("apply.txt", trees(replica, join(root, "atlas")))?.guard).toBe(
      "report-path-unusable"
    );
    // Today's failure mode: a full migration, then ENOENT, then no report at all.
    expect(
      checkReportPathIsSafe(join(root, "no", "such", "dir", "apply.txt"), trees(replica, join(root, "atlas")))
        ?.guard
    ).toBe("report-path-unusable");
  });

  it("passes a report beside the two stores rather than inside either", () => {
    const root = temporaryRoot();
    const replica = join(root, "personal-prod");
    mkdirSync(replica, { recursive: true });
    expect(checkReportPathIsSafe(join(root, "apply.txt"), trees(replica, join(root, "atlas")))).toBeUndefined();
  });
});

describe("guard: the target must not already hold somebody else's store", () => {
  it("passes a target that does not exist yet", () => {
    const root = temporaryRoot();
    expect(checkTargetHoldsNoForeignStore(join(root, "atlas-store"), planFor())).toBeUndefined();
  });

  it("refuses a target holding a DIFFERENT plan's records, before writing anything", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const replica = join(root, "personal-prod");

    // Somebody else's migration, under its own authority, already in the target.
    const foreignPlan = buildProjectionPlan(createLegacyGraphFixture(), {
      authority_id: "la_authority_someoneelse",
      resolve_payload: legacyFixturePayloadResolver
    });
    const first = await runMigrationApply({
      plan: foreignPlan,
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });
    expect(first.ok).toBe(true);
    const afterForeign = readMigrationPlaneCensus(target);

    const run = await runMigrationApply({
      plan: planFor(),
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });

    expect(run.ok).toBe(false);
    expect(run.refusals.map((refusal) => refusal.guard)).toEqual(["target-holds-a-foreign-store"]);
    // THE POINT: nothing of ours was appended. Before this guard the run
    // committed all 49 records and only then reported a count mismatch.
    expect(readMigrationPlaneCensus(target)).toEqual(afterForeign);
    expect(run.apply).toBeUndefined();
    // Counts, never the ids of the foreign records: this detail is printed into
    // a content-free report.
    expect(run.report).not.toContain("la_object_legacy");
  });

  it("still lets an interrupted run of the SAME plan resume", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const replica = join(root, "personal-prod");
    const plan = planFor();

    await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });
    // A resume is not a foreign store, and a guard that could not tell them
    // apart would make the resumability the whole design rests on unreachable.
    expect(checkTargetHoldsNoForeignStore(target, plan)).toBeUndefined();

    const second = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: replica,
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });
    expect(second.refusals).toEqual([]);
    expect(second.ok).toBe(true);
  });

  it("refuses a target that cannot be read as a store at all", () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    mkdirSync(join(target, "assertions"), { recursive: true });
    // A zero-byte segment: the shape of the production journal this store was
    // built against. Refusing beats appending into it to find out.
    writeFileSync(join(target, "assertions", "0000000001.ndjson"), "");
    expect(checkTargetHoldsNoForeignStore(target, planFor())?.guard).toBe("target-holds-a-foreign-store");
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

  /**
   * A RUN THAT DIES STILL OWES THE OPERATOR A REPORT.
   *
   * `applyProjectionPlan` throwing used to propagate straight out of here: no
   * reconciliation, no report file, `main()` exiting 1 with nothing but a stack
   * trace — over a store that already held records. The census below is taken
   * from the STORE rather than from the dead run's counters, which is the same
   * rule a successful run follows.
   */
  it("reports what the store holds when the run dies mid-apply, instead of only throwing", async () => {
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const plan = planFor();

    const run = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: join(root, "personal-prod"),
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded,
      open_plane: (options) => {
        const plane = openDurableMigrationPlane(options);
        let accepted = 0;
        return {
          ...plane,
          sink: {
            receiptFor: (key) => plane.sink.receiptFor(key),
            commit: async (request) => {
              if (accepted >= 6) throw new Error("no space left on device");
              accepted += 1;
              return plane.sink.commit(request);
            }
          }
        };
      }
    });

    expect(run.ok).toBe(false);
    expect(run.abort?.message).toContain("no space left on device");
    expect(run.report).toContain("outcome          apply-aborted");
    // The reconciliation is still taken and still printed, so the operator is
    // told how far it got rather than being left to guess.
    expect(run.reconciliation?.ok).toBe(false);
    expect(run.report).toContain("reconciliation");
    const census = readMigrationPlaneCensus(target);
    expect(census.entities).toBeGreaterThan(0);
    expect(census.entities).toBeLessThan(plan.records.length);
    // And the durable event names the abort, so the store and the audit file
    // agree that a run happened here.
    const auditPath = migrationPlaneDirectories(target).audit;
    expect(existsSync(auditPath)).toBe(true);
    const events = readFileSync(auditPath, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { outcome?: string; records_committed?: number });
    expect(events.at(-1)?.outcome).toBe("aborted");
    expect(events.at(-1)?.records_committed).toBe(6);
    // The abort's message never reaches the report: it can name an idempotency
    // key, which carries a legacy object id.
    expect(run.report).not.toContain("no space left on device");
  });

  it("prints the three kinds of minted assertion that never reach the assertion log", async () => {
    /**
     * The report used to explain the gap between `assertions minted` and the
     * assertions the store holds with one line — "of which absence" — and
     * asserted in a comment that the difference was "exactly the absences". That
     * stopped being true when blocks were carried. On the real corpus the
     * headline would have read ~18,000 assertions minted against a near-zero
     * assertion count, with the only reconciling line naming absences, and an
     * operator reading it would conclude 18,000 assertions had vanished.
     */
    const root = temporaryRoot();
    const target = join(root, "atlas-store");
    const plan = buildProjectionPlan(createLogseqBlockFixture(), {
      authority_id: legacyFixtureAuthorityId,
      resolve_payload: legacyFixturePayloadResolver
    });
    const run = await runMigrationApply({
      plan,
      target_directory: target,
      replica_directory: join(root, "personal-prod"),
      actor_id: actorId,
      probe_sync_daemon: daemonNotLoaded
    });

    expect(run.ok).toBe(true);
    const minted = run.apply?.audit.assertions_minted ?? 0;
    const census = readMigrationPlaneCensus(target);
    const kinds = new Map(plan.breakdown.records_by_kind.map((entry) => [entry.record_kind, entry.count]));
    const absences = kinds.get("absence") ?? 0;
    const blocks = kinds.get("provisional-block") ?? 0;
    const blockRetractions = census.provisional_retractions;

    // The fixture exercises all three, so the equation is not vacuous.
    expect(blocks).toBeGreaterThan(0);
    expect(blockRetractions).toBeGreaterThan(0);
    // THE EQUATION the report now states in full. A fourth kind of record that
    // mints an id without committing an assertion breaks this test rather than
    // silently reopening the gap.
    expect(minted - absences - blocks - blockRetractions).toBe(census.assertions);

    expect(run.report).toContain("of which absence, committing none");
    expect(run.report).toContain(`of which carried block, committing none`);
    expect(run.report).toContain("of which retraction of a carried block");
    const line = run.report
      .split("\n")
      .find((candidate) => candidate.includes("of which carried block"));
    expect(line?.trimEnd().endsWith(String(blocks))).toBe(true);
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

  /**
   * A TOMBSTONED BLOCK'S RETRACTION IS NOT IN THE ASSERTION LOG.
   *
   * It has no published shape to live in — a retraction is an
   * `atlas.assertion:v1` naming what it supersedes, and the log holds no record
   * with a carried block's id — so it is carried beside the block instead. The
   * assertion equation has to subtract it. Without the subtraction this expects
   * a retraction in a file it was never written to, and every run that carried a
   * deleted block reconciles as a mismatch.
   *
   * The fixture above has no blocks in it, so this is the only place the
   * subtraction is exercised at all.
   */
  it("does not expect a carried block's retraction in the assertion log", () => {
    const blockPlan = buildProjectionPlan(createLogseqBlockFixture(), {
      authority_id: legacyFixtureAuthorityId,
      resolve_payload: legacyFixturePayloadResolver
    });
    const kinds = new Map(blockPlan.breakdown.records_by_kind.map((entry) => [entry.record_kind, entry.count]));
    const at = (kind: string): number => kinds.get(kind as never) ?? 0;

    // The fixture really does tombstone a block, so the subtraction is not
    // vacuously zero.
    expect(at("retraction")).toBeGreaterThan(0);
    expect(at("provisional-block")).toBeGreaterThan(0);

    const result = reconcileMigrationApply(blockPlan, {
      entities: at("entity") + at("minted-entity"),
      // Every retraction in this plan targets a block, so none of them reaches
      // the assertion log.
      assertions: at("relationship") + at("minted-relationship"),
      alias_rows: blockPlan.outcomes.length,
      empty_submissions: at("absence"),
      provisional_blocks: at("provisional-block"),
      provisional_retractions: at("retraction")
    });
    expect(result.mismatches).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.expected.provisional_retractions).toBe(at("retraction"));
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
