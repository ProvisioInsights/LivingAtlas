import { writeFileSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { restoreStore, type StoreRestoreResult } from "./store-archive.js";
import { checkReportPathIsSafe, realPathOrNearestAncestor } from "./migration-apply.js";

/**
 * RESTORE THE SEGMENT-LOG STORE FROM A BACKUP (`real-data:store-restore`, ADR 0032).
 *
 * Reconstructs a store from a directory produced by `real-data:store-backup`, or
 * fails with a typed reason and leaves the target untouched. It refuses a
 * non-empty target (a merge is how you get a spliced graph nobody can reason
 * about), verifies every artifact against the manifest BEFORE it writes a byte
 * into place, and only renames the reconstructed store into the target once its
 * feed epoch, history floor and published watermark, re-read from the rebuilt
 * segments, match the manifest. A missing manifest is treated as an interrupted
 * backup and refused.
 *
 * The restored store is served READ-ONLY like any other; enabling writes is a
 * separate, later decision (ADR 0032). This entrypoint does not enable writes.
 *
 * The restore cannot record its own event INSIDE the store without breaking the
 * byte-identity it exists to guarantee, so its durable, content-free record is the
 * optional report and its stdout line — counts and store markers, never a record.
 *
 * Env contract:
 *   LIVING_ATLAS_STORE_BACKUP_DIR     (required) the backup to restore from
 *   LIVING_ATLAS_STORE_RESTORE_DIR    (required) where the store is reconstructed;
 *                                      must not exist, or be an empty directory.
 *                                      Deliberately NOT LIVING_ATLAS_STORE_DIR: a
 *                                      restore must never be pointed at the live
 *                                      served store by reusing the serving variable.
 *   STORE_RESTORE_REPORT_OUT          (optional) content-free report path, guarded
 */

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

/**
 * True when `inner` is `outer` or sits beneath it, on resolved real paths. The
 * separator matters: `store-new` is not inside `store`, and a bare `startsWith`
 * would refuse it.
 */
function withinOrEqual(inner: string, outer: string): boolean {
  const left = realPathOrNearestAncestor(inner).toLowerCase();
  const right = realPathOrNearestAncestor(outer).toLowerCase();
  return left === right || left.startsWith(right.endsWith(sep) ? right : `${right}${sep}`);
}

/** Content-free: counts and the store markers the restore reconstructed. */
function renderReport(result: StoreRestoreResult): string {
  const body = result.ok
    ? {
        ok: true,
        artifact_count: result.artifact_count,
        total_bytes: result.total_bytes,
        store: result.store
      }
    : { ok: false, code: result.code };
  return `${JSON.stringify(body, null, 2)}\n`;
}

export function runStoreRestore(): number {
  const backupDir = requireEnv("LIVING_ATLAS_STORE_BACKUP_DIR");
  const restoreDir = requireEnv("LIVING_ATLAS_STORE_RESTORE_DIR");
  const reportOut = process.env["STORE_RESTORE_REPORT_OUT"];

  if (!isAbsolute(backupDir)) throw new Error("LIVING_ATLAS_STORE_BACKUP_DIR must be an absolute path");
  if (!isAbsolute(restoreDir)) throw new Error("LIVING_ATLAS_STORE_RESTORE_DIR must be an absolute path");

  // Reconstructing the store inside the backup it is reading from would let the
  // rename step clobber the backup mid-restore. The two trees must be disjoint.
  if (withinOrEqual(restoreDir, backupDir) || withinOrEqual(backupDir, restoreDir)) {
    process.stderr.write(
      "REFUSED backup-and-target-overlap: the backup directory and the restore target must be disjoint; " +
        "one is nested in the other\n"
    );
    return 1;
  }

  if (reportOut !== undefined) {
    const refusal = checkReportPathIsSafe(reportOut, [
      { label: "the backup", directory: backupDir },
      { label: "the restore target", directory: restoreDir }
    ]);
    if (refusal) {
      process.stderr.write(`REFUSED ${refusal.guard}: ${refusal.detail}\n`);
      return 1;
    }
  }

  const result = restoreStore({ backup_directory: backupDir, store_directory: restoreDir });

  if (reportOut !== undefined) writeFileSync(reportOut, renderReport(result), { mode: 0o600 });

  if (!result.ok) {
    process.stderr.write(
      `store-restore: REFUSED ${result.code}: ${result.detail}${result.path ? ` (${result.path})` : ""}\n`
    );
    return 1;
  }

  process.stdout.write(
    `store-restore: ok artifacts=${result.artifact_count} bytes=${result.total_bytes} ` +
      `feed_epoch=${result.store.feed_epoch} watermark=${result.store.published_watermark}\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runStoreRestore();
  } catch (error) {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
