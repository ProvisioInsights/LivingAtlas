import { createHash, type KeyObject } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { LocalWormStore, restoreBackup, restoreBackupWithRecoveryKey } from "@living-atlas/backup";

/**
 * Human-only backend restore runner.
 *
 * The recovery master is resolved INTERACTIVELY (prompted, never read from the
 * environment) so it stays under human custody. This runner is never invoked by
 * the automated timer and has no MCP surface.
 *
 * Usage:
 *   backup:restore --backup-id la_backup_000001 --store <staging-dir> --out <output-dir>
 *
 * Env fallbacks (for --store / --out only; the master is always prompted):
 *   LIVING_ATLAS_BACKUP_STAGING_DIR   store root if --store is omitted
 *   LIVING_ATLAS_BACKUP_RESTORE_OUT   output dir if --out is omitted
 */

type Args = { backupId: string; storeDir: string; outDir: string };

function parseArgs(argv: string[]): Args {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      map.set(key, value);
      i += 1;
    }
  }
  const backupId = map.get("backup-id");
  if (!backupId) throw new Error("missing required --backup-id");
  const storeDir = map.get("store") ?? process.env.LIVING_ATLAS_BACKUP_STAGING_DIR?.trim();
  if (!storeDir) throw new Error("missing --store (or LIVING_ATLAS_BACKUP_STAGING_DIR)");
  const outDir = map.get("out") ?? process.env.LIVING_ATLAS_BACKUP_RESTORE_OUT?.trim();
  if (!outDir) throw new Error("missing --out (or LIVING_ATLAS_BACKUP_RESTORE_OUT)");
  return { backupId, storeDir, outDir };
}

async function promptRecoveryMaster(): Promise<Buffer> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Recovery master (base64, human custody): ")).trim();
    const master = Buffer.from(answer, "base64");
    if (master.length !== 32) throw new Error("recovery master must decode to 32 bytes (base64)");
    return master;
  } finally {
    rl.close();
  }
}

export async function restoreRunner(args: Args, master: Buffer): Promise<void> {
  await assertRestoreOutputAvailable(args.outDir);
  const store = new LocalWormStore(args.storeDir);
  const restored = await restoreBackup(store, args.backupId, master);
  await writeRestoredReplica(args, restored);
}

export async function restoreRunnerWithRecoveryKey(
  args: Args,
  recoveryPrivateKey: KeyObject,
  installPassphrase: (passphrase: string) => Promise<void>
): Promise<void> {
  await assertRestoreOutputAvailable(args.outDir);
  const store = new LocalWormStore(args.storeDir);
  const restored = await restoreBackupWithRecoveryKey(store, args.backupId, recoveryPrivateKey);
  await installPassphrase(restored.keyringPassphrase);
  await writeRestoredReplica(args, restored);
}

async function assertRestoreOutputAvailable(outDir: string): Promise<void> {
  try {
    if ((await readdir(outDir)).length > 0) throw new Error("restore output directory must be empty");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function writeRestoredReplica(args: Args, restored: { kind: "full" | "differential"; artifactBytes: Buffer; keyringJson: string }): Promise<void> {
  await mkdir(args.outDir, { recursive: true, mode: 0o700 });
  if ((await readdir(args.outDir)).length > 0) {
    throw new Error("restore output directory must be empty");
  }
  if (restored.kind !== "full") {
    throw new Error("cannot restore a differential backup without its full backup chain");
  }

  const graphDir = join(args.outDir, "graph");
  await mkdir(graphDir, { recursive: true, mode: 0o700 });
  const artifactPath = join(graphDir, "snapshot.json");
  const journalPath = join(graphDir, "journal.jsonl");
  const keyringPath = join(args.outDir, "keyring.json");
  await writeFile(artifactPath, restored.artifactBytes, { mode: 0o600 });
  await writeFile(journalPath, "", { mode: 0o600 });
  await writeFile(keyringPath, restored.keyringJson, { mode: 0o600 });

  const artifactSha = createHash("sha256").update(restored.artifactBytes).digest("hex");
  const keyringSha = createHash("sha256").update(Buffer.from(restored.keyringJson, "utf8")).digest("hex");

  console.log("RESTORE COMPLETE");
  console.log(`  backup_id:     ${args.backupId}`);
  console.log(`  artifact:      ${artifactPath}`);
  console.log(`  artifact_sha256: ${artifactSha}`);
  console.log(`  keyring:       ${keyringPath}`);
  console.log(`  keyring_sha256:  ${keyringSha}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const master = await promptRecoveryMaster();
  await restoreRunner(args, master);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
