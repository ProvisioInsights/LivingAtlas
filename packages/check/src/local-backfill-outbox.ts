import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  FileLocalKeyringStore,
  resolveLocalSecret
} from "@living-atlas/local-keyring";

/**
 * Backfill push staging for the first real Cloudflare sync.
 *
 * Direct-store imports bypass the sync outbox by design, so a freshly
 * imported local graph has nothing queued to push. This tool packages every
 * LIVE (non-tombstoned) object from the local store into bounded
 * queued-outbox files that the existing push handshake / drain flow consumes
 * verbatim ({ record_schema: living-atlas-local-mcp-outbox:v1, objects }).
 *
 * Two-phase by design:
 * 1. stage: writes files into a STAGING directory. Safe — the daemon only
 *    drains the live outbox, so staging never triggers a push.
 * 2. arm: moves staged files into the live outbox. From that moment the
 *    sync daemon / drain command WILL push ciphertext to Cloudflare, so
 *    arming requires an explicit acknowledgement that the R2 reclamation
 *    lifecycle rule has been removed (it would expire newly pushed objects).
 */

const ownerOnlyMode = 0o600;
const stageAckEnv = "LIVING_ATLAS_BACKFILL_STAGE_ACK";
const stageAckValue = "stage-backfill-outbox-files";
const armAckEnv = "LIVING_ATLAS_BACKFILL_ARM_ACK";
const armAckValue = "lifecycle-rule-removed-push-authorized";

function digest(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export type StageBackfillResult = {
  report_schema: "living-atlas-backfill-outbox-stage:v1";
  plaintext_policy: "counts-and-refs-only";
  live_objects: number;
  objects_staged: number;
  files_written: number;
  skipped_existing_files: number;
  staging_dir: string;
};

export async function stageBackfillOutbox(options: {
  store: FileLocalGraphStore;
  stagingDir: string;
  objectsPerFile?: number;
  now?: string;
}): Promise<StageBackfillResult> {
  const objectsPerFile = options.objectsPerFile ?? 200;
  const now = options.now ?? new Date().toISOString();
  const live = options.store
    .listObjects()
    .sort((left, right) => left.object_id.localeCompare(right.object_id));

  await mkdir(options.stagingDir, { recursive: true });

  let filesWritten = 0;
  let skippedExisting = 0;
  let objectsStaged = 0;

  for (let index = 0; index < live.length; index += objectsPerFile) {
    const chunk = live.slice(index, index + objectsPerFile);
    const chunkKey = digest(chunk.map((object) => `${object.object_id}:${object.version}:${object.content_hash}`).join("|"));
    const fileName = `queued-backfill-${String(index / objectsPerFile).padStart(5, "0")}-${chunkKey}.json`;
    const filePath = join(options.stagingDir, fileName);

    if (existsSync(filePath)) {
      skippedExisting += 1;
      objectsStaged += chunk.length;
      continue;
    }

    await writeFile(filePath, `${JSON.stringify({
      record_schema: "living-atlas-local-mcp-outbox:v1",
      enqueued_at: now,
      mutation: "backfill",
      actor_id: "la_client_backfilloutbox0001",
      recorded_at: now,
      local_generation: options.store.status().generation,
      objects: chunk
    }, null, 2)}\n`, { mode: ownerOnlyMode });
    await chmod(filePath, ownerOnlyMode);
    filesWritten += 1;
    objectsStaged += chunk.length;
  }

  return {
    report_schema: "living-atlas-backfill-outbox-stage:v1",
    plaintext_policy: "counts-and-refs-only",
    live_objects: live.length,
    objects_staged: objectsStaged,
    files_written: filesWritten,
    skipped_existing_files: skippedExisting,
    staging_dir: options.stagingDir
  };
}

export type ArmBackfillResult = {
  report_schema: "living-atlas-backfill-outbox-arm:v1";
  moved_files: number;
  outbox_dir: string;
};

export async function armBackfillOutbox(options: {
  stagingDir: string;
  outboxDir: string;
}): Promise<ArmBackfillResult> {
  const entries = await readdir(options.stagingDir);
  const staged = entries.filter((name) => name.startsWith("queued-backfill-") && name.endsWith(".json")).sort();
  await mkdir(options.outboxDir, { recursive: true });

  let moved = 0;
  for (const name of staged) {
    await rename(join(options.stagingDir, name), join(options.outboxDir, name));
    moved += 1;
  }

  return {
    report_schema: "living-atlas-backfill-outbox-arm:v1",
    moved_files: moved,
    outbox_dir: options.outboxDir
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const replicaDir = requireEnv("LIVING_ATLAS_LOCAL_REPLICA_DIR");
  const graphDir = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR?.trim() || join(replicaDir, "graph");
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING?.trim() || join(replicaDir, "keyring.json");
  const stagingDir = process.env.LIVING_ATLAS_BACKFILL_STAGING_DIR?.trim() || join(replicaDir, "outbox-staging");
  const outboxDir = process.env.LIVING_ATLAS_LOCAL_SYNC_OUTBOX_DIR?.trim() || join(replicaDir, "outbox");
  const mode = process.argv[2] === "arm" ? "arm" : "stage";

  if (mode === "arm") {
    if (process.env[armAckEnv]?.trim() !== armAckValue) {
      throw new Error(
        `arming moves staged files into the LIVE outbox and the daemon WILL push them to Cloudflare. ` +
        `First remove the R2 reclamation lifecycle rule, then set ${armAckEnv}=${armAckValue}`
      );
    }
    const armed = await armBackfillOutbox({ stagingDir, outboxDir });
    console.log(JSON.stringify(armed, null, 2));
    return;
  }

  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) {
    throw new Error(
      "missing LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE (set it directly or via LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE)"
    );
  }
  const keyring = await new FileLocalKeyringStore(keyringPath).read(passphrase.value);
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as { authority_id: string };
  const store = await FileLocalGraphStore.open({
    directory: graphDir,
    authorityId: snapshot.authority_id,
    plaintextPersistence: "redact",
    keyring
  });

  if (process.env[stageAckEnv]?.trim() !== stageAckValue) {
    const live = store.listObjects().length;
    console.log(JSON.stringify({
      report_schema: "living-atlas-backfill-outbox-stage:v1",
      dry_run: true,
      live_objects: live,
      staging_dir: stagingDir
    }, null, 2));
    console.error(`dry run only; set ${stageAckEnv}=${stageAckValue} to stage ${live} objects`);
    return;
  }

  const staged = await stageBackfillOutbox({ store, stagingDir });
  console.log(JSON.stringify(staged, null, 2));
  console.error(
    `staged only — nothing will sync until you run the arm step after removing the R2 lifecycle rule: ` +
    `${armAckEnv}=${armAckValue} npm run real-data:backfill-outbox -- arm`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
