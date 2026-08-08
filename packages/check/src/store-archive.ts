import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { z } from "zod";
import {
  LocalPrivateDirectoryMode,
  LocalPrivateFileMode,
  RecordedAtSchema,
  canonicalRecordedAt,
  digestOf,
  scanSegmentLog,
  writeAllSync,
  type RecordedAt
} from "@living-atlas/atlas-core";
import { storeLayout } from "@living-atlas/atlas-mcp";

/**
 * BACKUP AND RESTORE FOR THE SEGMENT-LOG STORE (ADR 0032).
 *
 * The new store is an append-only segment log — an `assertions/` directory and
 * an `identity/` directory, each a set of zero-padded NDJSON segments — plus two
 * sidecars beside them, `provisional-blocks.jsonl` and `migration-apply.jsonl`.
 * `backup-run.ts` only understands the OLD `snapshot.json` shape, so until this
 * exists there is no recovery path for the new store, which is the whole reason
 * it is held read-only (see `AtlasStoreMode`): anything written into it would be
 * unrecoverable. This module is that recovery path.
 *
 * Three properties are load-bearing, and each is a defect this repo has already
 * paid for somewhere:
 *
 *  1. **The backup captures the WHOLE store and proves it did.** Every file under
 *     the store root is copied and hashed, and the manifest records the store's
 *     own `feed_epoch` / `history_floor` / `published_watermark` — re-derived from
 *     the segment bytes, never from a counter. A restore checks BOTH the per-file
 *     digests AND that the reconstructed store yields the same three values, so a
 *     same-sized store is not mistaken for the same store.
 *
 *  2. **A restore is all-or-nothing.** It refuses a non-empty target (a merge is
 *     how you get a spliced graph nobody can reason about), verifies every
 *     artifact against the manifest BEFORE it writes a byte into place, stages the
 *     store in a temporary directory, and only renames it into the target once the
 *     reconstructed store has been re-read and matched. Any mismatch is a typed
 *     failure and leaves the target untouched — never a partial store.
 *
 *  3. **An interrupted backup is detectable as incomplete.** The manifest is
 *     written LAST and atomically (temp file, fsync, rename), so a backup that
 *     died partway has no manifest and a restore refuses it rather than
 *     reconstructing a truncated store from a half-written directory.
 *
 * CONTENT-AT-REST IS CLEARTEXT, SO THE BACKUP IS CLEARTEXT TOO. `atlas-core`
 * stores records in the clear behind 0600/0700 permissions; a byte-faithful copy
 * of them is equally readable. This artifact must therefore be treated with the
 * same care as the store — the payload files are written owner-only, like the
 * store they mirror. Whether the backup should additionally be ENCRYPTED at rest,
 * given the old store's escrow model, is a real question and is marked OPEN in ADR
 * 0032; this ships the cleartext copy the read-only store needs today and does not
 * pretend the encryption question is settled.
 *
 * THE MANIFEST AND EVERY TYPED RESULT ARE CONTENT-FREE. They carry paths, byte
 * counts and digests — never a record, a value, a name or a block's text. The
 * store's filenames are ordinals and fixed sidecar names, so a path leaks
 * nothing; a digest is a one-way hash. This is enforced by shape: the result
 * types have no field a value could be put in.
 */

// ---------------------------------------------------------------------------
// on-disk layout of a backup
// ---------------------------------------------------------------------------

/**
 * The manifest's schema tag, versioned. A backup is read back by a DIFFERENT
 * process than wrote it — possibly a newer one — so the manifest is untrusted
 * bytes until parsed, and the tag is what lets a future format refuse an old
 * backup loudly instead of misreading it.
 */
export const StoreBackupManifestSchemaName = "living-atlas-store-backup:v1" as const;

/**
 * The manifest lives at the backup root; the store's files live under `store/`.
 * Separated so the completeness marker (the manifest) can never collide with a
 * store file, and so "the manifest is written last" is visible in the directory
 * listing: a backup dir with `store/` but no `manifest.json` is an interrupted
 * one.
 */
export const StoreBackupManifestFileName = "manifest.json" as const;
export const StoreBackupPayloadDirName = "store" as const;

/**
 * The three values that distinguish this store from a same-sized one. All three
 * live in the assertion log and are re-derived by RE-READING its segments, never
 * copied from a process counter — a reconciliation computed from a run's own
 * bookkeeping only proves the run is self-consistent.
 */
export const StoreIdentityMarkersSchema = z
  .object({
    feed_epoch: z.string(),
    history_floor: RecordedAtSchema,
    published_watermark: z.number().int().nonnegative()
  })
  .strict();

export type StoreIdentityMarkers = z.infer<typeof StoreIdentityMarkersSchema>;

/** One captured file: where it sits in the store, how big, and its digest. */
export const StoreBackupArtifactSchema = z
  .object({
    /** POSIX-relative to the store root, e.g. `assertions/0000000001.ndjson`. */
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    /** `sha256:<hex>`, computed by `digestOf` so the format cannot drift. */
    sha256: z.string()
  })
  .strict();

export type StoreBackupArtifact = z.infer<typeof StoreBackupArtifactSchema>;

export const StoreBackupManifestSchema = z
  .object({
    manifest_schema: z.literal(StoreBackupManifestSchemaName),
    created_at: RecordedAtSchema,
    /** Opaque deployment id, not record content. Traceability only. */
    authority_id: z.string(),
    store: StoreIdentityMarkersSchema,
    /** Redundant count so a truncated `artifacts` array cannot pass silently. */
    artifact_count: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
    artifacts: z.array(StoreBackupArtifactSchema),
    /**
     * The completeness marker. Its presence is already implied by the manifest
     * existing at all; stated explicitly so a hand-edited or half-written
     * manifest that omits it is refused rather than trusted.
     */
    complete: z.literal(true)
  })
  .strict();

export type StoreBackupManifest = z.infer<typeof StoreBackupManifestSchema>;

// ---------------------------------------------------------------------------
// typed results
// ---------------------------------------------------------------------------

export type StoreBackupFailureCode =
  | "store-directory-missing"
  | "store-not-a-directory"
  | "store-incomplete-layout"
  | "backup-target-not-empty"
  | "unsupported-entry";

export type StoreBackupResult =
  | {
      ok: true;
      backup_directory: string;
      store: StoreIdentityMarkers;
      artifact_count: number;
      total_bytes: number;
    }
  | { ok: false; code: StoreBackupFailureCode; detail: string; path?: string };

export type StoreRestoreFailureCode =
  | "manifest-missing"
  | "manifest-unreadable"
  | "target-not-empty"
  | "artifact-missing"
  | "artifact-extra"
  | "size-mismatch"
  | "digest-mismatch"
  | "artifact-count-mismatch"
  | "store-metadata-mismatch";

export type StoreRestoreResult =
  | {
      ok: true;
      store_directory: string;
      store: StoreIdentityMarkers;
      artifact_count: number;
      total_bytes: number;
    }
  | { ok: false; code: StoreRestoreFailureCode; detail: string; path?: string };

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Every regular file under `root`, as POSIX-relative paths, sorted.
 *
 * Symlinks and other special entries are refused rather than followed: a store
 * holds neither, and copying the target bytes of a link — or the link itself —
 * would make "byte-faithful copy" ambiguous in exactly the place an attacker
 * would choose. `lstat` so a link is seen as a link, not as what it points at.
 */
function collectFiles(root: string): { files: string[] } | { unsupported: string } {
  if (!existsSync(root)) return { files: [] };
  const out: string[] = [];
  const walk = (directory: string): string | undefined => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        const bad = walk(absolute);
        if (bad) return bad;
      } else if (entry.isFile()) {
        out.push(relative(root, absolute).split(sep).join(posix.sep));
      } else {
        // A symlink, socket, fifo or device. None belong in a store, and none
        // can be copied byte-faithfully without deciding what "the bytes" are.
        return relative(root, absolute).split(sep).join(posix.sep);
      }
    }
    return undefined;
  };
  const unsupported = walk(root);
  if (unsupported !== undefined) return { unsupported };
  out.sort();
  return { files: out };
}

function isNonEmptyDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  if (!statSync(path).isDirectory()) return true; // a file where a dir should be is "occupied"
  return readdirSync(path).length > 0;
}

/** Write bytes owner-only, creating parent directories owner-only, then fsync. */
function writeArtifact(destination: string, bytes: Buffer): void {
  mkdirSync(dirname(destination), { recursive: true, mode: LocalPrivateDirectoryMode });
  const handle = openSync(destination, "w", LocalPrivateFileMode);
  try {
    writeAllSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * Write JSON so a crash cannot leave a half-file that reads as complete: write a
 * temp sibling, fsync it, then rename it into place. `rename` is atomic on the
 * local filesystems this store targets, so the manifest either is not there or is
 * whole.
 */
function writeJsonAtomic(destination: string, value: unknown): void {
  const temporary = `${destination}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = openSync(temporary, "w", LocalPrivateFileMode);
  try {
    writeAllSync(handle, payload);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, destination);
}

/**
 * The store's three identity markers, re-derived from the assertion segments.
 *
 * `repair: false`: reading a store to back it up, or to check a restore, must
 * never truncate it — a torn tail is reported by the scan and left exactly where
 * it is. The three values all live in the assertion log's headers and records, so
 * the identity directory is not needed to compute them.
 */
function readStoreIdentityMarkers(storeDirectory: string): StoreIdentityMarkers {
  const scan = scanSegmentLog(storeLayout(storeDirectory).assertions, { repair: false });
  return {
    feed_epoch: scan.feed_epoch,
    history_floor: scan.history_floor,
    published_watermark: scan.restored.published_watermark
  };
}

function markersEqual(left: StoreIdentityMarkers, right: StoreIdentityMarkers): boolean {
  return (
    left.feed_epoch === right.feed_epoch &&
    left.history_floor === right.history_floor &&
    left.published_watermark === right.published_watermark
  );
}

// ---------------------------------------------------------------------------
// backup
// ---------------------------------------------------------------------------

export type BackupStoreInput = {
  /** The store root: holds `assertions/`, `identity/` and the sidecars. */
  store_directory: string;
  /** Where the backup is written. Must not exist, or be an empty directory. */
  backup_directory: string;
  /** Opaque deployment id stamped into the manifest. Not record content. */
  authority_id: string;
  clock?: () => Date;
};

/**
 * Copy the whole store into a fresh backup directory and write a manifest that
 * proves what was copied.
 *
 * Reads the source only; never writes to it. The source may be — and in
 * production is — served read-only while this runs.
 */
export function backupStore(input: BackupStoreInput): StoreBackupResult {
  const clock = input.clock ?? (() => new Date());
  const layout = storeLayout(input.store_directory);

  if (!existsSync(layout.root)) {
    return {
      ok: false,
      code: "store-directory-missing",
      detail:
        "the store directory does not exist; a backup of nothing would look identical to a backup " +
        "of an empty store, so it is refused rather than produced",
      path: layout.root
    };
  }
  if (!statSync(layout.root).isDirectory()) {
    return { ok: false, code: "store-not-a-directory", detail: "the store path is not a directory", path: layout.root };
  }
  for (const [role, path] of [
    ["assertion log", layout.assertions],
    ["identity log", layout.identity]
  ] as const) {
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      return {
        ok: false,
        code: "store-incomplete-layout",
        detail:
          `the store's ${role} directory is missing; this is not a store the reader would open, and ` +
          "backing it up would preserve a shape no restore could serve",
        path
      };
    }
  }

  if (isNonEmptyDirectory(input.backup_directory)) {
    return {
      ok: false,
      code: "backup-target-not-empty",
      detail:
        "the backup directory already holds files; writing into it would weld a new backup onto an old " +
        "one and leave a manifest describing neither",
      path: input.backup_directory
    };
  }

  const markers = readStoreIdentityMarkers(input.store_directory);

  const collected = collectFiles(input.store_directory);
  if ("unsupported" in collected) {
    return {
      ok: false,
      code: "unsupported-entry",
      detail:
        "the store holds an entry that is neither a regular file nor a directory (a symlink or special " +
        "file); it cannot be copied byte-faithfully and a store should not contain one",
      path: collected.unsupported
    };
  }

  const payloadRoot = join(input.backup_directory, StoreBackupPayloadDirName);
  mkdirSync(payloadRoot, { recursive: true, mode: LocalPrivateDirectoryMode });

  const artifacts: StoreBackupArtifact[] = [];
  let totalBytes = 0;
  for (const relativePath of collected.files) {
    const bytes = readFileSync(join(input.store_directory, relativePath));
    writeArtifact(join(payloadRoot, relativePath), bytes);
    artifacts.push({ path: relativePath, bytes: bytes.length, sha256: digestOf(bytes) });
    totalBytes += bytes.length;
  }

  const manifest: StoreBackupManifest = {
    manifest_schema: StoreBackupManifestSchemaName,
    created_at: canonicalRecordedAt(clock()),
    authority_id: input.authority_id,
    store: markers,
    artifact_count: artifacts.length,
    total_bytes: totalBytes,
    artifacts,
    complete: true
  };

  // LAST, and atomically. Until this line lands the backup has no manifest and a
  // restore refuses it as incomplete; after it lands the backup is whole.
  writeJsonAtomic(join(input.backup_directory, StoreBackupManifestFileName), manifest);

  return {
    ok: true,
    backup_directory: input.backup_directory,
    store: markers,
    artifact_count: artifacts.length,
    total_bytes: totalBytes
  };
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export type RestoreStoreInput = {
  /** A backup directory produced by `backupStore`. */
  backup_directory: string;
  /** Where the store is reconstructed. Must not exist, or be an empty directory. */
  store_directory: string;
  clock?: () => Date;
};

/**
 * Reconstruct a store from a backup, or fail with a typed reason and leave the
 * target untouched.
 *
 * Order matters and is the whole safety story:
 *  1. refuse a non-empty target;
 *  2. read and parse the manifest (its absence is an incomplete backup);
 *  3. verify EVERY artifact against the manifest before writing a byte into place;
 *  4. stage the store in a temporary directory;
 *  5. re-derive the store's identity markers from the staged bytes and match them
 *     to the manifest;
 *  6. only then rename the staged directory into the target.
 * A failure at any step removes the staging directory and returns — the target is
 * only ever populated by an atomic rename of a fully verified store.
 */
export function restoreStore(input: RestoreStoreInput): StoreRestoreResult {
  const manifestPath = join(input.backup_directory, StoreBackupManifestFileName);
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      code: "manifest-missing",
      detail:
        "the backup has no manifest; the manifest is written last, so its absence means the backup was " +
        "interrupted and must not be mistaken for a good one",
      path: manifestPath
    };
  }

  let manifest: StoreBackupManifest;
  try {
    manifest = StoreBackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch (cause) {
    return {
      ok: false,
      code: "manifest-unreadable",
      detail: `the manifest is not readable as a v1 backup manifest: ${(cause as Error).message}`,
      path: manifestPath
    };
  }

  if (isNonEmptyDirectory(input.store_directory)) {
    return {
      ok: false,
      code: "target-not-empty",
      detail:
        "the restore target already holds files; merging a backup into an existing store produces a " +
        "spliced graph nobody can reason about, so it is refused",
      path: input.store_directory
    };
  }

  const payloadRoot = join(input.backup_directory, StoreBackupPayloadDirName);

  // Verify BEFORE writing. A single flipped byte, or a dropped sidecar, is caught
  // here — against the backup, before the target is touched at all.
  for (const artifact of manifest.artifacts) {
    const source = join(payloadRoot, artifact.path);
    if (!existsSync(source)) {
      return {
        ok: false,
        code: "artifact-missing",
        detail: "the manifest lists a file the payload does not hold; the backup is incomplete",
        path: artifact.path
      };
    }
    const bytes = readFileSync(source);
    if (bytes.length !== artifact.bytes) {
      return {
        ok: false,
        code: "size-mismatch",
        detail: `${artifact.path} is ${bytes.length} bytes; the manifest records ${artifact.bytes}`,
        path: artifact.path
      };
    }
    if (digestOf(bytes) !== artifact.sha256) {
      return {
        ok: false,
        code: "digest-mismatch",
        detail: `${artifact.path} does not match its recorded digest; the file was altered or corrupted`,
        path: artifact.path
      };
    }
  }

  // No file in the payload may be absent from the manifest: an artifact the
  // manifest never vouched for is exactly the byte a restore must not carry in.
  const present = collectFiles(payloadRoot);
  if ("unsupported" in present) {
    return {
      ok: false,
      code: "artifact-extra",
      detail: "the backup payload holds an entry that is neither a regular file nor a directory",
      path: present.unsupported
    };
  }
  const manifestPaths = new Set(manifest.artifacts.map((artifact) => artifact.path));
  for (const relativePath of present.files) {
    if (!manifestPaths.has(relativePath)) {
      return {
        ok: false,
        code: "artifact-extra",
        detail: "the backup payload holds a file the manifest does not list; the backup is not the one it claims",
        path: relativePath
      };
    }
  }
  if (present.files.length !== manifest.artifact_count) {
    return {
      ok: false,
      code: "artifact-count-mismatch",
      detail: `the payload holds ${present.files.length} file(s); the manifest records ${manifest.artifact_count}`
    };
  }

  // Stage in a sibling temp directory so the move into the target is a rename on
  // the same filesystem, and so a mid-restore failure never touches the target.
  const stagingParent = dirname(input.store_directory);
  mkdirSync(stagingParent, { recursive: true, mode: LocalPrivateDirectoryMode });
  const staging = mkdtempSync(join(stagingParent, ".store-restore-"));
  try {
    let totalBytes = 0;
    for (const artifact of manifest.artifacts) {
      const bytes = readFileSync(join(payloadRoot, artifact.path));
      writeArtifact(join(staging, artifact.path), bytes);
      totalBytes += bytes.length;
    }

    // Prove the reconstructed store IS the store, not merely the same size: the
    // three identity markers re-read from the staged segments must match the ones
    // the manifest recorded. A manifest that lied about the markers while every
    // file digest matched is caught here.
    const restoredMarkers = readStoreIdentityMarkers(staging);
    if (!markersEqual(restoredMarkers, manifest.store)) {
      return {
        ok: false,
        code: "store-metadata-mismatch",
        detail:
          "the reconstructed store's feed epoch, history floor or published watermark does not match the " +
          "manifest; the backup does not reconstruct the store it claims"
      };
    }

    // The staged store is whole and verified. Put it in place with a single
    // rename. If the operator pre-created an empty target directory, remove that
    // empty directory first so the rename lands cleanly — removing a directory we
    // just confirmed empty destroys nothing.
    if (existsSync(input.store_directory)) rmdirSync(input.store_directory);
    renameSync(staging, input.store_directory);

    return {
      ok: true,
      store_directory: input.store_directory,
      store: restoredMarkers,
      artifact_count: manifest.artifact_count,
      total_bytes: totalBytes
    };
  } catch (error) {
    // Any failure after staging began: the staging directory is ours and the
    // target was never touched, so remove the staging and rethrow. `rmSync` here
    // only ever deletes the temp directory this call created.
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    // If we returned a typed failure above (rather than renaming), the staging
    // directory still exists and must be cleaned up. After a successful rename it
    // is already gone, so `force` makes this a no-op.
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
