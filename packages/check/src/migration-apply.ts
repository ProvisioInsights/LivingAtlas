import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { decryptGraphObjectPayload, openLocalKeyring, resolveLocalSecret } from "@living-atlas/local-keyring";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  countDeferredEntityContent,
  evaluateClosureGate,
  openDurableMigrationPlane,
  readMigrationPlaneCensus,
  renderProjectionPlanReport,
  UnmodelledRecordKinds,
  type ApplyProjectionPlanResult,
  type LegacyPayloadResolution,
  type MigrationPlaneCensus,
  type ProjectedRecordKind,
  type ProjectionPlan
} from "@living-atlas/atlas-migrate";

/**
 * Migration APPLY against the real replica — the one irreversible step.
 *
 * The dry run beside this file (`migration-plan-dryrun.ts`) is read-only by
 * construction: it builds no sink, so it cannot write even by accident. This one
 * can, so everything that is structural over there is a GUARD here. Each guard
 * refuses and exits non-zero, and none of them is advisory:
 *
 *   1. THE CLOSURE GATE. `applyProjectionPlan` refuses a failing plan on its
 *      own, but it does so after the caller has already opened the target
 *      plane — which creates two segment logs. Evaluating the gate first means
 *      a plan that cannot be certified leaves no directory behind for somebody
 *      to later mistake for a partial migration.
 *
 *   2. THE TARGET IS NOT THE REPLICA. The frozen replica is the recovery story
 *      for everything written into the new store, because new-format backup is
 *      deferred; a migration that wrote inside it would destroy the only copy of
 *      what it was migrating FROM. Compared on real paths, after resolving
 *      symlinks, because `~/store-new -> store` is the shape of this mistake.
 *
 *   3. THE SYNC DAEMON IS NOT LOADED. A second writer during a migration is how
 *      you get a half-graph nobody can reason about: the daemon and the
 *      migration would interleave against one replica, and afterwards there is
 *      no way to tell which of them wrote what.
 *
 * Guards 2 and 3 are evaluated BEFORE the plan is built, and both are evaluated
 * even when the first has already failed. Building the plan means decrypting the
 * whole replica, and an operator should not pay that to be told their target
 * path was wrong — nor should they fix one problem, wait, and be told about the
 * second.
 *
 * Env contract (mirrors `real-data:migration-plan`):
 *   LIVING_ATLAS_LOCAL_GRAPH_DIR         (required) sealed graph replica dir
 *   LIVING_ATLAS_LOCAL_KEYRING           (required) sealed keyring file path
 *   LIVING_ATLAS_BACKUP_AUTHORITY_ID     (required) authority id stamped in the plan
 *   MIGRATION_TARGET_DIR                 (required) the SIBLING root the new store lives at
 *   MIGRATION_ACTOR_ID                   (required) who is running this, for the audit event
 *   MIGRATION_APPLY_REPORT_OUT           (required) where the content-free report is written
 *   MIGRATION_SYNC_DAEMON_LABEL          (optional) launchd label, defaults below
 */

export const DefaultSyncDaemonLabel = "io.livingatlas.personal-prod.sync";

export const MigrationApplyGuardValues = [
  "closure-gate",
  "target-collides-with-replica",
  "sync-daemon-loaded"
] as const;
export type MigrationApplyGuard = (typeof MigrationApplyGuardValues)[number];

export type MigrationApplyRefusal = {
  guard: MigrationApplyGuard;
  detail: string;
};

/**
 * Whether the sync daemon would be writing during the run.
 *
 * `undeterminable` is a REFUSAL, not a pass. A guard that could not check has
 * not checked, and "launchctl was not on the PATH" is not evidence that nothing
 * else is holding the replica open. This runner is a macOS operator tool by
 * construction — the daemon is a launchd job — so a host where the probe cannot
 * run is a host this must not run on.
 */
export type SyncDaemonState = {
  status: "loaded" | "not-loaded" | "undeterminable";
  detail: string;
};

export type SyncDaemonProbe = () => SyncDaemonState;

export function launchctlSyncDaemonProbe(label: string, uid: number): SyncDaemonProbe {
  return () => {
    try {
      execFileSync("launchctl", ["print", `gui/${uid}/${label}`], { stdio: "pipe" });
      return { status: "loaded", detail: `launchctl print gui/${uid}/${label} succeeded` };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { status?: number };
      // A non-zero exit means launchctl ran and the job is not there, which is
      // the answer we want. Anything else — launchctl missing, not executable,
      // killed by a signal — means the question was never asked.
      if (typeof failure.status === "number") {
        return { status: "not-loaded", detail: `launchctl print exited ${failure.status}` };
      }
      return { status: "undeterminable", detail: `launchctl could not be run: ${failure.message}` };
    }
  };
}

/**
 * The real path of `candidate`, resolving symlinks as far as the filesystem
 * actually goes.
 *
 * The target directory usually does not exist yet — it is a new store — so
 * `realpathSync` on the whole path would throw. Resolving the nearest existing
 * ancestor and re-appending the remainder is what makes the guard work on a path
 * that has not been created: a target whose PARENT is a symlink into the replica
 * is exactly the case a naive `resolve()` would wave through.
 */
export function realPathOrNearestAncestor(candidate: string): string {
  let current = resolve(candidate);
  const trailing: string[] = [];
  for (;;) {
    if (existsSync(current)) return join(realpathSync(current), ...trailing.reverse());
    const parent = dirname(current);
    if (parent === current) return resolve(candidate);
    trailing.push(current.slice(parent.length + 1));
    current = parent;
  }
}

/**
 * Compared case-insensitively, deliberately.
 *
 * The operator's filesystem is case-insensitive by default, so `personal-prod`
 * and `Personal-Prod` name one directory there and two here. The guard's two
 * failure modes are not symmetric: a spurious refusal costs a rename, and a
 * missed one writes into the only surviving copy of the source graph.
 */
function withinTree(inner: string, outer: string): boolean {
  const left = inner.toLowerCase();
  const right = outer.toLowerCase();
  // The separator matters: `personal-prod-new` is not inside `personal-prod`,
  // and a bare `startsWith` would refuse it.
  return left === right || left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`);
}

/**
 * GUARD 2. The new store and the frozen replica must be disjoint trees.
 *
 * Both nesting directions are refused. "Target inside the replica" is the
 * mistake that writes into the frozen store; "replica inside the target" is the
 * same hazard read the other way round, because it makes the frozen bytes a
 * subdirectory of a tree this run owns and is about to fill.
 */
export function checkTargetIsNotTheReplica(
  targetDirectory: string,
  replicaDirectory: string
): MigrationApplyRefusal | undefined {
  const target = realPathOrNearestAncestor(targetDirectory);
  const replica = realPathOrNearestAncestor(replicaDirectory);
  if (withinTree(target, replica)) {
    return {
      guard: "target-collides-with-replica",
      detail:
        `the target resolves inside the frozen replica (${target} within ${replica}); the replica ` +
        "is the recovery story for everything this run writes and is never written to again"
    };
  }
  if (withinTree(replica, target)) {
    return {
      guard: "target-collides-with-replica",
      detail:
        `the frozen replica resolves inside the target (${replica} within ${target}); the new store ` +
        "must not own the tree that holds the only copy of what it is migrating from"
    };
  }
  return undefined;
}

/** GUARD 3. */
export function checkSyncDaemonIsNotLoaded(probe: SyncDaemonProbe): MigrationApplyRefusal | undefined {
  const state = probe();
  if (state.status === "not-loaded") return undefined;
  return {
    guard: "sync-daemon-loaded",
    detail:
      state.status === "loaded"
        ? `the sync daemon is loaded (${state.detail}); a second writer during a migration produces ` +
          "a half-graph nobody can reason about"
        : `whether the sync daemon is loaded could not be determined (${state.detail}); a guard that ` +
          "could not check has not checked"
  };
}

export type MigrationApplyExpectation = {
  entities: number;
  assertions: number;
  alias_rows: number;
  /** Reported, and proven to have produced nothing by the two equations above. */
  absence_records: number;
  /**
   * Records carried with their modelling deferred (ADR 0029). It gets an
   * equation of its own because it is the one class of record with no contract:
   * if it were folded into any of the other three, the run could carry every
   * block into the wrong file, or none of them anywhere, and still reconcile.
   */
  provisional_blocks: number;
  /**
   * Retractions of carried records, which land beside the block rather than in
   * the assertion log. Subtracted from `assertions` below rather than counted
   * twice: a tombstoned block produces a retraction the published log cannot
   * hold, and an equation that still expected it there would fail every run that
   * carried one.
   */
  provisional_retractions: number;
};

export type MigrationApplyReconciliation = {
  ok: boolean;
  expected: MigrationApplyExpectation;
  observed: MigrationPlaneCensus;
  mismatches: string[];
};

function recordsOfKind(plan: ProjectionPlan, kind: ProjectedRecordKind): number {
  return plan.breakdown.records_by_kind.find((entry) => entry.record_kind === kind)?.count ?? 0;
}

/**
 * Retractions whose target is a record with no published shape.
 *
 * Resolved through the plan's own records rather than assumed from a count: the
 * question is what each retraction POINTS AT, and only the record it names can
 * answer that. A retraction naming a key the plan does not hold is left in the
 * assertion total, where the apply path will fail on it loudly, instead of being
 * quietly excused here.
 */
function countRetractionsOfUnmodelledRecords(plan: ProjectionPlan): number {
  const kindByKey = new Map(plan.records.map((record) => [record.idempotency_key, record.record_kind]));
  let count = 0;
  for (const record of plan.records) {
    if (record.record_kind !== "retraction") continue;
    const targetKind = kindByKey.get(record.retracts_idempotency_key);
    if (targetKind !== undefined && UnmodelledRecordKinds.has(targetKind)) count += 1;
  }
  return count;
}

/**
 * What the target root must hold once the run is done, computed from the plan
 * at run time and never from a constant.
 *
 * A hardcoded total stops being a check the moment the corpus grows: it passes
 * for the run it was written against and then either fails forever or is quietly
 * updated to whatever the run produced, at which point it is measuring nothing.
 * These four numbers come from `records_by_kind`, which the closure gate
 * recomputes from the records themselves, so the reconciliation is anchored to
 * the plan rather than to whoever last edited this file.
 *
 * `absence` is the one that needs saying out loud: an absence record reports
 * that an object existed and did not come across, so it must produce no entity
 * and no assertion. That is not asserted separately — it is what the first two
 * equations MEAN. If an absence had committed an assertion, `assertions` would
 * exceed the relationship-and-retraction total and the run would fail.
 */
export function reconcileMigrationApply(
  plan: ProjectionPlan,
  observed: MigrationPlaneCensus
): MigrationApplyReconciliation {
  const provisionalRetractions = countRetractionsOfUnmodelledRecords(plan);
  const expected: MigrationApplyExpectation = {
    entities: recordsOfKind(plan, "entity") + recordsOfKind(plan, "minted-entity"),
    assertions:
      recordsOfKind(plan, "relationship") +
      recordsOfKind(plan, "minted-relationship") +
      recordsOfKind(plan, "retraction") -
      provisionalRetractions,
    alias_rows: plan.outcomes.length,
    absence_records: recordsOfKind(plan, "absence"),
    provisional_blocks: recordsOfKind(plan, "provisional-block"),
    provisional_retractions: provisionalRetractions
  };

  const mismatches: string[] = [];
  const compare = (label: string, want: number, got: number): void => {
    if (want !== got) mismatches.push(`${label}: expected ${want}, found ${got}`);
  };
  compare("entities", expected.entities, observed.entities);
  compare("assertions", expected.assertions, observed.assertions);
  compare("alias rows", expected.alias_rows, observed.alias_rows);
  compare("absence receipts", expected.absence_records, observed.empty_submissions);
  compare("provisional blocks", expected.provisional_blocks, observed.provisional_blocks);
  compare("provisional retractions", expected.provisional_retractions, observed.provisional_retractions);

  return { ok: mismatches.length === 0, expected, observed, mismatches };
}

export type MigrationApplyRun = {
  ok: boolean;
  refusals: MigrationApplyRefusal[];
  reconciliation?: MigrationApplyReconciliation;
  apply?: ApplyProjectionPlanResult;
  report: string;
};

export type RunMigrationApplyInput = {
  /** Built by the caller so a test can supply a fixture plan and no keyring. */
  plan: ProjectionPlan;
  target_directory: string;
  replica_directory: string;
  actor_id: string;
  probe_sync_daemon: SyncDaemonProbe;
  now?: () => string;
};

function pad(label: string, width = 34): string {
  return label.length >= width ? `${label} ` : label.padEnd(width, " ");
}

/**
 * The report is content-free by the same rule as the plan report: counts,
 * verdicts and record kinds only. An apply report is read in whatever terminal
 * or file the operator happens to be in, and that is the last place personal
 * graph content should land.
 */
function renderApplyReport(input: {
  plan: ProjectionPlan;
  refusals: MigrationApplyRefusal[];
  reconciliation?: MigrationApplyReconciliation;
  apply?: ApplyProjectionPlanResult;
  outcome: string;
}): string {
  const lines: string[] = [
    "living-atlas-migration-apply-report:v1",
    `authority        ${input.plan.authority_id}`,
    `plan-digest      ${input.plan.plan_digest}`,
    `outcome          ${input.outcome}`,
    "",
    "guards"
  ];
  for (const guard of MigrationApplyGuardValues) {
    const refusal = input.refusals.find((candidate) => candidate.guard === guard);
    lines.push(`  ${pad(guard)}${refusal ? "REFUSED" : "pass"}`);
    if (refusal) lines.push(`    ${refusal.detail}`);
  }

  if (input.apply) {
    const audit = input.apply.audit;
    lines.push(
      "",
      "apply",
      `  ${pad("mode")}${audit.mode}`,
      `  ${pad("outcome")}${audit.outcome}`,
      `  ${pad("records committed")}${audit.records_committed}`,
      `  ${pad("records replayed")}${audit.records_replayed}`,
      `  ${pad("entities minted")}${audit.entities_minted}`,
      `  ${pad("assertions minted")}${audit.assertions_minted}`,
      // `assertions_minted` counts every non-entity record that asked the
      // registry for an id, and an absence asks. It therefore reads HIGHER than
      // the assertions the store actually holds, and the difference is exactly
      // the absences. Spelled out here because the two numbers appear a few
      // lines apart, and a reader who has to work out why they disagree is a
      // reader who will assume one of them is wrong.
      `  ${pad("  of which absence, committing none")}${recordsOfKind(input.plan, "absence")}`,
      `  ${pad("alias rows written")}${audit.alias_rows_written}`,
      `  ${pad("alias rows reused")}${audit.alias_rows_reused}`,
      `  ${pad("alias rows conflicted")}${audit.alias_rows_conflicted}`
    );
  }

  /**
   * Printed on EVERY run, zero or not.
   *
   * An entity record carries attributes, a description and sometimes a subtype
   * that `atlas.entity:v1` has no field for, and this adapter does not invent an
   * assertion shape to hold them — see ADR 0030. The values are still readable
   * in the frozen replica, so nothing is lost; what would be lost is anyone's
   * awareness of it, which is why the count is a line in the report rather than
   * a sentence in a document. A section that disappeared when it read zero is a
   * section people stop looking for.
   */
  const deferred = countDeferredEntityContent(input.plan.records);
  lines.push(
    "",
    "entity-content-not-carried (ADR 0030; still readable in the frozen replica)",
    `  ${pad("entity records")}${deferred.entity_records}`,
    `  ${pad("with attributes")}${deferred.with_attributes}`,
    `  ${pad("with a description")}${deferred.with_a_description}`,
    `  ${pad("with a subtype")}${deferred.with_a_subtype}`,
    `  ${pad("with a topic scheme")}${deferred.with_a_topic_scheme}`,
    `  ${pad("attribute keys")}${deferred.attribute_keys.join(", ") || "none"}`
  );

  const reconciliation = input.reconciliation;
  if (reconciliation) {
    lines.push(
      "",
      "reconciliation",
      `  ${pad("verdict")}${reconciliation.ok ? "pass" : "FAIL"}`,
      `  ${pad("entities")}${reconciliation.observed.entities} / ${reconciliation.expected.entities}`,
      `  ${pad("assertions")}${reconciliation.observed.assertions} / ${reconciliation.expected.assertions}`,
      `  ${pad("alias rows")}${reconciliation.observed.alias_rows} / ${reconciliation.expected.alias_rows}`,
      `  ${pad("absence receipts")}${reconciliation.observed.empty_submissions} / ${reconciliation.expected.absence_records}`,
      // Printed whether or not the run carried any, matching the plan report's
      // unmodelled-records section. A line that appears only when the number is
      // interesting is a line nobody learns to look for.
      `  ${pad("provisional blocks")}${reconciliation.observed.provisional_blocks} / ${reconciliation.expected.provisional_blocks}`,
      `  ${pad("provisional retractions")}${reconciliation.observed.provisional_retractions} / ${reconciliation.expected.provisional_retractions}`
    );
    for (const mismatch of reconciliation.mismatches) lines.push(`    ${mismatch}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function runMigrationApply(input: RunMigrationApplyInput): Promise<MigrationApplyRun> {
  const refusals: MigrationApplyRefusal[] = [];

  // The two structural guards first, and BOTH of them, before anything is built
  // or opened. They cost microseconds; the plan costs a full decrypt of the
  // replica.
  const collision = checkTargetIsNotTheReplica(input.target_directory, input.replica_directory);
  if (collision) refusals.push(collision);
  const daemon = checkSyncDaemonIsNotLoaded(input.probe_sync_daemon);
  if (daemon) refusals.push(daemon);

  const gate = evaluateClosureGate(input.plan);
  if (!gate.ok) {
    refusals.push({
      guard: "closure-gate",
      detail: `the plan does not certify: ${gate.findings
        .filter((finding) => finding.severity === "failure")
        .map((finding) => `${finding.code}=${finding.subject_count}`)
        .join(", ")}`
    });
  }

  if (refusals.length > 0) {
    return {
      ok: false,
      refusals,
      report: renderApplyReport({ plan: input.plan, refusals, outcome: "refused" })
    };
  }

  const plane = openDurableMigrationPlane({
    directory: input.target_directory,
    authority_id: input.plan.authority_id
  });
  let apply: ApplyProjectionPlanResult;
  try {
    apply = await applyProjectionPlan({
      plan: input.plan,
      actor_id: input.actor_id,
      registry: plane.registry,
      alias_ledger: plane.alias_ledger,
      sink: plane.sink,
      audit: plane.audit,
      ...(input.now ? { now: input.now } : {})
    });
  } finally {
    // Closed before the census: the reconciliation reads the segment files, and
    // reading them while a writer still holds the active segment would count
    // whatever happened to be flushed rather than what the run wrote.
    plane.close();
  }

  const reconciliation = reconcileMigrationApply(
    input.plan,
    readMigrationPlaneCensus(input.target_directory)
  );
  const outcome = !apply.ok
    ? `apply-failed:${apply.reason}`
    : reconciliation.ok
      ? "completed"
      : "reconciliation-mismatch";

  return {
    // A mismatch is a FAILED run and is reported as one. A migration that wrote
    // a different number of records than its own plan called for has not
    // "completed with a warning" — nobody can say what it did.
    ok: apply.ok && reconciliation.ok,
    refusals,
    reconciliation,
    apply,
    report: renderApplyReport({ plan: input.plan, refusals, reconciliation, apply, outcome })
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const graphDir = requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR");
  const keyringPath = requireEnv("LIVING_ATLAS_LOCAL_KEYRING");
  const authorityId = requireEnv("LIVING_ATLAS_BACKUP_AUTHORITY_ID");
  const targetDir = requireEnv("MIGRATION_TARGET_DIR");
  const actorId = requireEnv("MIGRATION_ACTOR_ID");
  const reportOut = requireEnv("MIGRATION_APPLY_REPORT_OUT");
  const daemonLabel = process.env.MIGRATION_SYNC_DAEMON_LABEL ?? DefaultSyncDaemonLabel;

  if (!isAbsolute(targetDir)) throw new Error("MIGRATION_TARGET_DIR must be an absolute path");

  const probe = launchctlSyncDaemonProbe(daemonLabel, process.getuid?.() ?? 0);

  // The structural guards are checked here too, before the keyring is opened.
  // Decrypting the replica to build a plan the guards were always going to
  // refuse costs the operator a long wait and puts plaintext in memory for no
  // reason.
  const preflight = [
    checkTargetIsNotTheReplica(targetDir, graphDir),
    checkSyncDaemonIsNotLoaded(probe)
  ].filter((refusal): refusal is MigrationApplyRefusal => refusal !== undefined);
  if (preflight.length > 0) {
    for (const refusal of preflight) process.stderr.write(`REFUSED ${refusal.guard}: ${refusal.detail}\n`);
    process.exit(1);
  }

  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) throw new Error("keyring passphrase not resolvable");
  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);

  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as {
    objects: GraphObjectEnvelope[];
  };
  const objects = snapshot.objects;
  process.stderr.write(`source objects: ${objects.length}\n`);

  // Same resolver shape as the dry run: a decrypt that FAILS is "unrecoverable"
  // (we tried and the bytes cannot be opened), a payload kind we never attempt
  // is "unavailable". Conflating them would report content as permanently lost
  // when it is merely unattempted.
  const resolved = new Map<string, Record<string, unknown>>();
  const failed = new Map<string, string>();
  for (const envelope of objects) {
    if (envelope.payload.kind !== "ciphertext-inline") continue;
    try {
      const payload = await decryptGraphObjectPayload(envelope, keyring);
      if (payload && payload.kind === "plaintext-json") {
        resolved.set(envelope.object_id, payload.data as Record<string, unknown>);
      } else {
        failed.set(envelope.object_id, "decrypt returned no plaintext payload");
      }
    } catch (error) {
      failed.set(envelope.object_id, (error as Error).message.slice(0, 120));
    }
  }

  const resolvePayload = (envelope: GraphObjectEnvelope): LegacyPayloadResolution => {
    if (envelope.payload.kind === "plaintext-json") {
      return { kind: "plaintext", data: envelope.payload.data as Record<string, unknown> };
    }
    const data = resolved.get(envelope.object_id);
    if (data) return { kind: "plaintext", data };
    const detail = failed.get(envelope.object_id);
    if (detail) return { kind: "unrecoverable", detail };
    return { kind: "unavailable", detail: `payload kind ${envelope.payload.kind} not attempted` };
  };

  const plan = buildProjectionPlan(objects, { authority_id: authorityId, resolve_payload: resolvePayload });
  const run = await runMigrationApply({
    plan,
    target_directory: targetDir,
    replica_directory: graphDir,
    actor_id: actorId,
    probe_sync_daemon: probe
  });

  // The plan report goes out beside the apply report: the numbers the
  // reconciliation is checked against have to be readable next to the result.
  writeFileSync(reportOut, `${renderProjectionPlanReport(plan, evaluateClosureGate(plan))}\n${run.report}`, "utf8");
  process.stdout.write(run.report);
  if (!run.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exit(1);
  });
}
