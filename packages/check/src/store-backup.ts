import { writeFileSync } from "node:fs";
import { isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { backupStore, type StoreBackupResult } from "./store-archive.js";
import { checkReportPathIsSafe, realPathOrNearestAncestor } from "./migration-apply.js";

/**
 * BACK UP THE SEGMENT-LOG STORE (`real-data:store-backup`, ADR 0032).
 *
 * The new store has no recovery path until this runs: `backup-run.ts` speaks only
 * the old `snapshot.json` shape, so the store is held read-only precisely because
 * anything written into it would be unrecoverable. This copies the WHOLE store —
 * both segment logs and every sidecar — into a fresh backup directory and writes a
 * manifest that records a per-file SHA-256 and the store's own feed epoch, history
 * floor and published watermark, so a restore can prove it rebuilt the same store.
 *
 * The store is read, never written; it may be served read-only while this runs.
 * The backup is CLEARTEXT, like the store it mirrors — see ADR 0032, which marks
 * "encrypt the backup at rest" as an OPEN question rather than shipping it as
 * decided. The manifest and the optional report are content-free: counts, digests
 * and store markers, never a record.
 *
 * Env contract (mirrors the other real-data:* runners):
 *   LIVING_ATLAS_STORE_DIR            (required) the store to back up
 *   LIVING_ATLAS_STORE_BACKUP_DIR     (required) where the backup is written;
 *                                      must not exist, or be an empty directory
 *   LIVING_ATLAS_BACKUP_AUTHORITY_ID  (optional) opaque id stamped in the manifest;
 *                                      defaults to la_authority_local
 *   STORE_BACKUP_REPORT_OUT           (optional) content-free report path, guarded
 *                                      the same way the migration runners guard theirs
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

/** Content-free: counts, digests-by-way-of-the-manifest, and the store markers. */
function renderReport(result: StoreBackupResult): string {
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

export function runStoreBackup(): number {
  const storeDir = requireEnv("LIVING_ATLAS_STORE_DIR");
  const backupDir = requireEnv("LIVING_ATLAS_STORE_BACKUP_DIR");
  const authorityId = process.env["LIVING_ATLAS_BACKUP_AUTHORITY_ID"]?.trim() || "la_authority_local";
  const reportOut = process.env["STORE_BACKUP_REPORT_OUT"];

  if (!isAbsolute(storeDir)) throw new Error("LIVING_ATLAS_STORE_DIR must be an absolute path");
  if (!isAbsolute(backupDir)) throw new Error("LIVING_ATLAS_STORE_BACKUP_DIR must be an absolute path");

  // A backup written inside the store it is copying would capture itself on the
  // next run and, worse, write bytes into a store that is supposed to be read
  // only. The two trees must be disjoint.
  if (withinOrEqual(backupDir, storeDir) || withinOrEqual(storeDir, backupDir)) {
    process.stderr.write(
      "REFUSED backup-and-store-overlap: the backup directory and the store directory must be disjoint; " +
        "one is nested in the other\n"
    );
    return 1;
  }

  // The report is a write, and writes are guarded (ADR 0031): it must not land
  // inside the store — where it would truncate a segment or sidecar — nor inside
  // the backup it describes.
  if (reportOut !== undefined) {
    const refusal = checkReportPathIsSafe(reportOut, [
      { label: "the store", directory: storeDir },
      { label: "the backup", directory: backupDir }
    ]);
    if (refusal) {
      process.stderr.write(`REFUSED ${refusal.guard}: ${refusal.detail}\n`);
      return 1;
    }
  }

  const result = backupStore({ store_directory: storeDir, backup_directory: backupDir, authority_id: authorityId });

  if (reportOut !== undefined) writeFileSync(reportOut, renderReport(result), { mode: 0o600 });

  if (!result.ok) {
    process.stderr.write(
      `store-backup: REFUSED ${result.code}: ${result.detail}${result.path ? ` (${result.path})` : ""}\n`
    );
    return 1;
  }

  process.stdout.write(
    `store-backup: ok artifacts=${result.artifact_count} bytes=${result.total_bytes} ` +
      `feed_epoch=${result.store.feed_epoch} watermark=${result.store.published_watermark}\n`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runStoreBackup();
  } catch (error) {
    process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
