import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  createLogseqBlockFixture,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  openDurableMigrationPlane
} from "@living-atlas/atlas-migrate";
import { openAtlasStore } from "@living-atlas/atlas-mcp";
import { runStoreBackup } from "./store-backup";
import { runStoreRestore } from "./store-restore";

/**
 * The two entrypoints, driven the way the operator drives them: through the
 * environment. The engine's own suite proves the mechanics; this proves the CLIs
 * wire the environment to it, guard their writes, and round-trip end to end.
 */

const temps: string[] = [];
const STORE_ENV = [
  "LIVING_ATLAS_STORE_DIR",
  "LIVING_ATLAS_STORE_BACKUP_DIR",
  "LIVING_ATLAS_STORE_RESTORE_DIR",
  "LIVING_ATLAS_BACKUP_AUTHORITY_ID",
  "STORE_BACKUP_REPORT_OUT",
  "STORE_RESTORE_REPORT_OUT"
] as const;

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `la-store-cli-${prefix}-`));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const name of STORE_ENV) delete process.env[name];
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Silence a CLI's stdout/stderr for the duration of `run`, returning its code. */
function quietly(run: () => number): number {
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    return run();
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
}

async function populatedStore(prefix: string): Promise<string> {
  const store = join(tempRoot(prefix), "store");
  const plane = openDurableMigrationPlane({ directory: store, authority_id: legacyFixtureAuthorityId });
  const plan = buildProjectionPlan(createLogseqBlockFixture(), {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
  const result = await applyProjectionPlan({
    plan,
    actor_id: "la_user_backup01",
    registry: plane.registry,
    alias_ledger: plane.alias_ledger,
    sink: plane.sink,
    audit: plane.audit,
    now: () => "2026-08-06T10:00:00.000Z"
  });
  plane.close();
  if (!result.ok) throw new Error("fixture migration did not apply");
  return store;
}

describe("real-data:store-backup / store-restore end to end", () => {
  it("backs up and restores a servable store through the environment", async () => {
    const source = await populatedStore("src");
    const backupDir = join(tempRoot("backup"), "out");
    const restoreDir = join(tempRoot("restore"), "out");
    const backupReport = join(tempRoot("rep"), "backup-report.json");
    const restoreReport = join(tempRoot("rep2"), "restore-report.json");

    process.env["LIVING_ATLAS_STORE_DIR"] = source;
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = backupDir;
    process.env["STORE_BACKUP_REPORT_OUT"] = backupReport;
    expect(quietly(runStoreBackup)).toBe(0);

    const backupBody = JSON.parse(readFileSync(backupReport, "utf8")) as { ok: boolean; artifact_count: number };
    expect(backupBody.ok).toBe(true);
    expect(backupBody.artifact_count).toBeGreaterThan(0);

    delete process.env["LIVING_ATLAS_STORE_DIR"];
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = backupDir;
    process.env["LIVING_ATLAS_STORE_RESTORE_DIR"] = restoreDir;
    process.env["STORE_RESTORE_REPORT_OUT"] = restoreReport;
    expect(quietly(runStoreRestore)).toBe(0);

    const restoreBody = JSON.parse(readFileSync(restoreReport, "utf8")) as { ok: boolean };
    expect(restoreBody.ok).toBe(true);

    // The restored store opens read-only and reports the same census as the source.
    const before = openAtlasStore({ directory: source, mode: "read-only" });
    const after = openAtlasStore({ directory: restoreDir, mode: "read-only" });
    try {
      expect(after.status()).toEqual(before.status());
    } finally {
      before.close();
      after.close();
    }
  });

  it("propagates a typed refusal as a non-zero exit and a report", async () => {
    const source = await populatedStore("src");
    const backupDir = join(tempRoot("backup"), "out");
    const restoreDir = join(tempRoot("restore"), "out");
    const restoreReport = join(tempRoot("rep"), "restore-report.json");

    process.env["LIVING_ATLAS_STORE_DIR"] = source;
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = backupDir;
    expect(quietly(runStoreBackup)).toBe(0);

    // Drop a sidecar from the backup payload, then restore: a non-zero exit and a
    // report that names the typed failure, not a half-written store.
    rmSync(join(backupDir, "store", "provisional-blocks.jsonl"));
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = backupDir;
    process.env["LIVING_ATLAS_STORE_RESTORE_DIR"] = restoreDir;
    process.env["STORE_RESTORE_REPORT_OUT"] = restoreReport;
    expect(quietly(runStoreRestore)).toBe(1);

    const body = JSON.parse(readFileSync(restoreReport, "utf8")) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("artifact-missing");
    expect(existsSync(restoreDir)).toBe(false);
  });

  it("refuses a backup directory nested inside the store", async () => {
    const source = await populatedStore("src");
    process.env["LIVING_ATLAS_STORE_DIR"] = source;
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = join(source, "nested-backup");
    expect(quietly(runStoreBackup)).toBe(1);
    // Nothing was written into the store.
    expect(existsSync(join(source, "nested-backup"))).toBe(false);
  });

  it("refuses a report that would be written inside the store", async () => {
    const source = await populatedStore("src");
    process.env["LIVING_ATLAS_STORE_DIR"] = source;
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = join(tempRoot("backup"), "out");
    process.env["STORE_BACKUP_REPORT_OUT"] = join(source, "report.json");
    expect(quietly(runStoreBackup)).toBe(1);
    expect(existsSync(join(source, "report.json"))).toBe(false);
  });

  it("throws when a required variable is unset", () => {
    // No LIVING_ATLAS_STORE_DIR set.
    process.env["LIVING_ATLAS_STORE_BACKUP_DIR"] = join(tempRoot("backup"), "out");
    expect(() => quietly(runStoreBackup)).toThrow(/LIVING_ATLAS_STORE_DIR/);
  });
});
