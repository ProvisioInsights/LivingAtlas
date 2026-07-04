import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  LocalWormStore,
  dueLevels,
  selectForDeletion,
  wrapKeyringForEscrow,
  writeBackup,
  type BackupRef,
  type CadenceConfig,
  type LastRun,
  type Level,
  type RetentionRule,
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

/** Reads the sealed graph snapshot bytes without decrypting. */
async function readSealedSnapshot(graphDir: string): Promise<{ bytes: Buffer; generation: number }> {
  const store = await FileLocalGraphStore.open({ directory: graphDir });
  const generation = store.status().generation;
  const snapshotPath = join(graphDir, "snapshot.json");
  const bytes = await readFile(snapshotPath);
  return { bytes, generation };
}

export async function runBackup(nowMs: number = Date.now()): Promise<number> {
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
  const { bytes: snapshotBytes, generation } = await readSealedSnapshot(graphDir);

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
  const result = await writeBackup([staging], input);

  if (!result.durable) {
    for (const err of result.errors) console.error(`backup: store error: ${err}`);
    console.error(`backup: NOT durable (${backupId})`);
    return 1;
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
