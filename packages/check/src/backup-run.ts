import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  LocalWormStore,
  PersonalOneDriveStore,
  R2ObjectLockStore,
  dueLevels,
  selectForDeletion,
  wrapKeyringForEscrow,
  writeBackup,
  type BackupRef,
  type CadenceConfig,
  type GraphFetch,
  type ImmutableStore,
  type LastRun,
  type Level,
  type RetentionRule,
  type S3PutObjectClient,
  type WriteBackupInput,
} from "@living-atlas/backup";

/**
 * Automated backup runner (launchd timer entrypoint).
 *
 * Ciphertext-only: reads the already-sealed graph snapshot and the already-sealed
 * keyring file, and wraps them under a 256-bit recovery master. It NEVER decrypts
 * either — the recovery master is used only to produce the escrow envelope for the
 * staging write. Decryption happens exclusively in the human-driven restore path.
 *
 * Env contract (mirrors the existing check runners):
 *   LIVING_ATLAS_BACKUP_STAGING_DIR       (required) local WORM staging root
 *   LIVING_ATLAS_BACKUP_RECOVERY_MASTER   (required) base64 32-byte recovery master
 *   LIVING_ATLAS_LOCAL_GRAPH_DIR          (required for full) sealed graph replica dir
 *   LIVING_ATLAS_LOCAL_KEYRING            (required) sealed keyring file path
 *   LIVING_ATLAS_BACKUP_AUTHORITY_ID      (optional) authority id stamped in manifest
 *   LIVING_ATLAS_BACKUP_DIFF_EVERY_MS     (optional) differential cadence, default 15m
 *   LIVING_ATLAS_BACKUP_FULL_EVERY_MS     (optional) full cadence, default 24h
 *   LIVING_ATLAS_BACKUP_DIFF_RETAIN_MS    (optional) differential retention, default 24h
 *   LIVING_ATLAS_BACKUP_FULL_RETAIN_MS    (optional) full retention, default 90d
 *
 * Cloud fan-out (see assembleBackupStores):
 *   LIVING_ATLAS_BACKUP_R2_BUCKET         (required for cloud) R2 Object-Lock bucket
 *                                          — the SINGLE HARD ANCHOR. Its S3 client is
 *                                          constructed at deploy time (see
 *                                          buildCloudStoreFactory); durability depends
 *                                          on it, and the lock is verified fail-closed.
 *   LIVING_ATLAS_BACKUP_ONEDRIVE_FOLDER   (optional) consumer-OneDrive folder for the
 *                                          best-effort redundant copy. Its Graph token
 *                                          is supplied at deploy time; its failure is
 *                                          logged/alerted but does NOT fail the backup.
 *
 * The real S3/Graph clients require live credentials and are therefore NOT
 * constructed in this file by default — see buildCloudStoreFactory, which returns
 * `undefined` builders unless deployment wiring is injected. Tests inject fakes
 * through the CloudStoreFactory seam so this runner never touches the network.
 */

const stateFileName = "backup-state.json";
const defaultDiffEveryMs = 15 * 60_000;
const defaultFullEveryMs = 24 * 60 * 60_000;
const defaultDiffRetainMs = 24 * 60 * 60_000;
const defaultFullRetainMs = 90 * 24 * 60 * 60_000;

type BackupState = {
  lastDifferentialMs: number;
  lastFullMs: number;
  lastFullBaseGeneration: number;
  serial: number;
  backups: BackupRef[];
};

const emptyState: BackupState = {
  lastDifferentialMs: 0,
  lastFullMs: 0,
  lastFullBaseGeneration: 0,
  serial: 0,
  backups: [],
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) throw new Error(`missing required env var ${key}`);
  return value;
}

function envInt(key: string, fallback: number): number {
  const value = envValue(key);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${key}: ${value}`);
  return parsed;
}

function resolveRecoveryMaster(): Buffer {
  const master = Buffer.from(requireEnv("LIVING_ATLAS_BACKUP_RECOVERY_MASTER"), "base64");
  if (master.length !== 32) {
    throw new Error("LIVING_ATLAS_BACKUP_RECOVERY_MASTER must decode to 32 bytes (base64)");
  }
  return master;
}

/**
 * Injectable seam for the two cloud backends. Each builder returns a ready
 * ImmutableStore, or `undefined` when that backend is not configured for this
 * environment. Tests inject fakes; deployment injects real S3/Graph-backed
 * builders via buildCloudStoreFactory.
 */
export type CloudStoreFactory = {
  /** The R2 Object-Lock hard anchor. REQUIRED for a durable backup. */
  r2: () => ImmutableStore | undefined;
  /** The consumer-OneDrive soft copy. Best-effort redundancy only. */
  oneDrive: () => ImmutableStore | undefined;
};

export type AssembledStores = {
  /** Every store here must confirm for the backup to be "durable". */
  required: ImmutableStore[];
  /** Written best-effort; failures are logged/alerted, never fail the backup. */
  bestEffort: ImmutableStore[];
  /** Human-readable notes for the run log (e.g. "OneDrive copy not configured"). */
  notes: string[];
};

/**
 * Assemble the fan-out store list from local staging + the cloud factory.
 *
 * Invariants (fail-closed):
 *   - local staging is always required (write-verifiable local WORM copy);
 *   - the R2 hard anchor is REQUIRED — if the factory can't build it, this throws
 *     rather than silently running with no immutable anchor;
 *   - OneDrive, if configured, is best-effort redundancy — never required.
 */
export function assembleBackupStores(
  staging: ImmutableStore,
  factory: CloudStoreFactory,
): AssembledStores {
  const notes: string[] = [];
  const required: ImmutableStore[] = [staging];

  const r2 = factory.r2();
  if (!r2) {
    throw new Error(
      "backup: R2 Object-Lock hard anchor is not configured — refusing to run without the immutability anchor (set LIVING_ATLAS_BACKUP_R2_BUCKET and wire the S3 client at deploy time)",
    );
  }
  required.push(r2);

  const bestEffort: ImmutableStore[] = [];
  const oneDrive = factory.oneDrive();
  if (oneDrive) {
    bestEffort.push(oneDrive);
  } else {
    notes.push("OneDrive soft copy not configured — skipping best-effort redundant copy");
  }

  return { required, bestEffort, notes };
}

/**
 * Fan a backup's items out to best-effort stores. Collects errors per store
 * without throwing, so a redundant-copy failure never fails the backup — the
 * caller logs/alerts on any returned errors.
 */
export async function fanOutBestEffort(
  stores: ImmutableStore[],
  items: Array<[string, Buffer]>,
  retainUntilMs: number,
): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  for (const store of stores) {
    for (const [key, data] of items) {
      try {
        await store.put(key, data, { retainUntilMs });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { errors };
}

/**
 * Deploy-time factory. The real S3 and Graph clients require live credentials and
 * are intentionally NOT built here — both builders return `undefined` unless a
 * caller has injected an adapter (S3PutObjectClient / GraphFetch) that carries the
 * credentials. That keeps this package network-free and credential-free, while
 * documenting exactly what deployment must supply:
 *   - R2 hard anchor: an S3PutObjectClient over @aws-sdk/client-s3 (or equivalent)
 *     pointed at the R2 S3 endpoint, plus LIVING_ATLAS_BACKUP_R2_BUCKET.
 *   - OneDrive soft copy: a GraphFetch that attaches a consumer Microsoft-account
 *     bearer token, plus LIVING_ATLAS_BACKUP_ONEDRIVE_FOLDER.
 */
export function buildCloudStoreFactory(
  nowMs: number,
  deps: { s3Client?: S3PutObjectClient; graphFetch?: GraphFetch } = {},
): CloudStoreFactory {
  const bucket = envValue("LIVING_ATLAS_BACKUP_R2_BUCKET");
  const oneDriveFolder = envValue("LIVING_ATLAS_BACKUP_ONEDRIVE_FOLDER");
  return {
    r2: () => {
      if (!bucket) return undefined;
      if (!deps.s3Client) {
        console.error(
          "backup: LIVING_ATLAS_BACKUP_R2_BUCKET is set but no S3 client was injected — requires deployment credential: R2 S3 access key/secret via an @aws-sdk S3PutObjectClient adapter",
        );
        return undefined;
      }
      return new R2ObjectLockStore({ client: deps.s3Client, bucket, clock: () => nowMs });
    },
    oneDrive: () => {
      if (!oneDriveFolder) return undefined;
      if (!deps.graphFetch) {
        console.error(
          "backup: LIVING_ATLAS_BACKUP_ONEDRIVE_FOLDER is set but no Graph transport was injected — requires deployment credential: consumer Microsoft-account bearer token via a GraphFetch adapter",
        );
        return undefined;
      }
      return new PersonalOneDriveStore({ fetch: deps.graphFetch, rootFolder: oneDriveFolder });
    },
  };
}

async function loadState(stagingDir: string): Promise<BackupState> {
  const path = join(stagingDir, stateFileName);
  if (!existsSync(path)) return { ...emptyState };
  const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<BackupState>;
  return { ...emptyState, ...parsed };
}

async function saveState(stagingDir: string, state: BackupState): Promise<void> {
  await mkdir(stagingDir, { recursive: true });
  await writeFile(join(stagingDir, stateFileName), JSON.stringify(state, null, 2), { mode: 0o600 });
}

function formatBackupId(serial: number): string {
  return `la_backup_${String(serial).padStart(6, "0")}`;
}

/**
 * Materializes the sealed replayed graph state without decrypting or compacting
 * the source replica. A raw snapshot file alone can be behind its journal.
 */
async function materializeSealedSnapshot(graphDir: string): Promise<{ bytes: Buffer; generation: number }> {
  const store = await FileLocalGraphStore.open({ directory: graphDir });
  const snapshot = store.materializedSnapshot();
  return {
    bytes: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
    generation: snapshot.generation
  };
}

/**
 * Whether cloud fan-out (R2 hard anchor + OneDrive soft copy) is active for this
 * run. Cloud is enabled iff the R2 bucket is configured; when it is, R2 is a
 * REQUIRED anchor and its lock is verified fail-closed. With no R2 bucket set,
 * the runner stays in today's local-only staging mode (unchanged behavior).
 */
function cloudEnabled(): boolean {
  return envValue("LIVING_ATLAS_BACKUP_R2_BUCKET") !== undefined;
}

export async function runBackup(
  nowMs: number = Date.now(),
  factory?: CloudStoreFactory,
): Promise<number> {
  const stagingDir = requireEnv("LIVING_ATLAS_BACKUP_STAGING_DIR");
  const master = resolveRecoveryMaster();
  const keyringPath = requireEnv("LIVING_ATLAS_LOCAL_KEYRING");
  const authorityId = envValue("LIVING_ATLAS_BACKUP_AUTHORITY_ID") ?? "la_authority_local";

  const cadence: CadenceConfig = {
    differentialEveryMs: envInt("LIVING_ATLAS_BACKUP_DIFF_EVERY_MS", defaultDiffEveryMs),
    fullEveryMs: envInt("LIVING_ATLAS_BACKUP_FULL_EVERY_MS", defaultFullEveryMs),
  };
  const rules: RetentionRule[] = [
    { kind: "differential", keepForMs: envInt("LIVING_ATLAS_BACKUP_DIFF_RETAIN_MS", defaultDiffRetainMs) },
    { kind: "full", keepForMs: envInt("LIVING_ATLAS_BACKUP_FULL_RETAIN_MS", defaultFullRetainMs) },
  ];

  const state = await loadState(stagingDir);
  const last: LastRun = { lastDifferentialMs: state.lastDifferentialMs, lastFullMs: state.lastFullMs };
  const due: Level[] = dueLevels(cadence, last, nowMs);

  if (due.length === 0) {
    console.log("backup: nothing due");
    return 0;
  }

  const level = due[0]!;
  if (!existsSync(keyringPath)) throw new Error(`sealed keyring not found: ${keyringPath}`);
  const sealedKeyringBytes = await readFile(keyringPath);

  const graphDir = requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR");
  const { bytes: snapshotBytes, generation } = await materializeSealedSnapshot(graphDir);

  const baseGeneration = level === "full" ? 0 : state.lastFullBaseGeneration;
  const serial = state.serial + 1;
  const backupId = formatBackupId(serial);
  const retainMs = level === "full" ? rules[1]!.keepForMs : rules[0]!.keepForMs;
  const retainUntilMs = nowMs + retainMs;

  const input: WriteBackupInput = {
    authority_id: authorityId,
    kind: level,
    base_generation: baseGeneration,
    target_generation: generation,
    artifactBytes: snapshotBytes,
    escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow(sealedKeyringBytes.toString("utf8"), master)),
    createdAtIso: new Date(nowMs).toISOString(),
    backupId,
    retainUntilMs,
    parentBackupId: level === "differential" ? formatBackupId(state.serial) : undefined,
  };

  const staging = new LocalWormStore(stagingDir, () => nowMs);

  // Assemble the fan-out. In cloud mode the R2 hard anchor is required (its lock
  // is verified fail-closed) and OneDrive is best-effort redundancy; otherwise
  // we stay in local-only staging mode (unchanged behavior).
  let requiredStores: ImmutableStore[] = [staging];
  let bestEffortStores: ImmutableStore[] = [];
  if (cloudEnabled()) {
    const resolvedFactory = factory ?? buildCloudStoreFactory(nowMs);
    const assembled = assembleBackupStores(staging, resolvedFactory);
    requiredStores = assembled.required;
    bestEffortStores = assembled.bestEffort;
    for (const note of assembled.notes) console.log(`backup: ${note}`);
  }

  const result = await writeBackup(requiredStores, input);

  if (!result.durable) {
    for (const err of result.errors) console.error(`backup: store error: ${err}`);
    console.error(`backup: NOT durable (${backupId})`);
    // Immutable stores cannot overwrite a partially written backup ID. Consume
    // this serial without advertising it as recoverable, so the next attempt
    // uses a fresh ID rather than repeatedly colliding with WORM artifacts.
    await saveState(stagingDir, { ...state, serial });
    return 1;
  }

  // Best-effort redundant copy: OneDrive. Failures are logged/alerted but do NOT
  // fail the backup — durability lives in the required (R2 + staging) tier.
  if (bestEffortStores.length > 0) {
    const artifactName = level === "full" ? "snapshot.enc" : "differential.enc";
    const escrowBytes = Buffer.from(input.escrowEnvelopeJson, "utf8");
    const manifestBytes = Buffer.from(JSON.stringify(result.manifest), "utf8");
    const items: Array<[string, Buffer]> = [
      [`${backupId}/${artifactName}`, input.artifactBytes],
      [`${backupId}/keyring.escrow.json`, escrowBytes],
      [`${backupId}/manifest.json`, manifestBytes],
    ];
    const soft = await fanOutBestEffort(bestEffortStores, items, retainUntilMs);
    if (soft.errors.length > 0) {
      for (const err of soft.errors) {
        console.error(`backup: ALERT best-effort (OneDrive) copy error: ${err}`);
      }
      console.error(
        `backup: best-effort redundant copy incomplete (${backupId}) — backup remains durable via required tier`,
      );
    } else {
      console.log(`backup: best-effort redundant copy ok (${backupId})`);
    }
  }

  const next: BackupState = {
    lastDifferentialMs: level === "full" ? nowMs : nowMs,
    lastFullMs: level === "full" ? nowMs : state.lastFullMs,
    lastFullBaseGeneration: level === "full" ? generation : state.lastFullBaseGeneration,
    serial,
    backups: [
      ...state.backups,
      { backup_id: backupId, kind: level, created_at_ms: nowMs, locked_until_ms: retainUntilMs },
    ],
  };

  const toDelete = selectForDeletion(next.backups, rules, nowMs);
  for (const id of toDelete) {
    try {
      await staging.remove(`${id}/manifest.json`);
      await staging.remove(`${id}/keyring.escrow.json`);
      await staging.remove(`${id}/snapshot.enc`);
      await staging.remove(`${id}/differential.enc`);
    } catch {
      // Object-Lock window not yet expired — leave it; retention is a hard backstop.
    }
  }
  next.backups = next.backups.filter((b) => !toDelete.includes(b.backup_id));

  await saveState(stagingDir, next);
  const digest = createHash("sha256").update(snapshotBytes).digest("hex").slice(0, 12);
  console.log(`backup: durable=true kind=${level} id=${backupId} generation=${generation} sha=${digest}`);
  if (toDelete.length > 0) console.log(`backup: pruned ${toDelete.length} expired set(s)`);
  return 0;
}

async function main(): Promise<void> {
  const code = await runBackup();
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
