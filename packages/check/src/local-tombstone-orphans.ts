import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  FileLocalKeyringStore,
  resolveLocalSecret,
  type LocalKeyringState
} from "@living-atlas/local-keyring";

/**
 * Tombstone orphaned ciphertext: live objects whose key_ref does not resolve
 * to any local keyring key. Such ciphertext is permanently unreadable (the
 * throwaway-key import defect), so marking it tombstoned records the intent
 * to discard it, lets the decrypt-coverage gate distinguish dead-by-intent
 * from unreadable-by-accident, and queues the bytes for compaction/erasure.
 *
 * Requires an explicit acknowledgement in CLI mode because it mutates the
 * real replica: LIVING_ATLAS_TOMBSTONE_ORPHANS_ACK=tombstone-unrecoverable-ciphertext.
 * Without the ack it runs as a dry-run report.
 */

const ackEnv = "LIVING_ATLAS_TOMBSTONE_ORPHANS_ACK";
const ackValue = "tombstone-unrecoverable-ciphertext";

export type TombstoneOrphansResult = {
  report_schema: "living-atlas-tombstone-orphans:v1";
  plaintext_policy: "counts-and-refs-only";
  dry_run: boolean;
  scanned: number;
  orphans: number;
  tombstoned: number;
  failed: number;
  failed_reasons: Record<string, number>;
  orphan_key_ref_prefixes: Record<string, number>;
};

function keyRefPrefix(keyRef: string): string {
  return `${keyRef.replace(/[0-9a-f]{8,}$/i, "")}*`;
}

export async function tombstoneOrphanCiphertext(options: {
  store: FileLocalGraphStore;
  keyring: LocalKeyringState;
  actorId: string;
  dryRun: boolean;
  now?: string;
}): Promise<TombstoneOrphansResult> {
  const keyringIds = new Set(options.keyring.keys.map((key) => key.key_id));
  // Default listObjects() returns live (non-tombstoned) objects. The explicit
  // { include_tombstones: false } form is avoided: the committed store filter
  // mishandles explicit false (fixed separately in local-graph-store WIP).
  const live = options.store.listObjects();

  const orphans = live.filter(
    (object) =>
      object.payload.kind !== "plaintext-json" &&
      (!object.key_ref || !keyringIds.has(object.key_ref))
  );

  const orphanPrefixes: Record<string, number> = {};
  for (const orphan of orphans) {
    const prefix = keyRefPrefix(orphan.key_ref ?? "<missing-key-ref>");
    orphanPrefixes[prefix] = (orphanPrefixes[prefix] ?? 0) + 1;
  }

  let tombstoned = 0;
  let failed = 0;
  const failedReasons: Record<string, number> = {};

  if (!options.dryRun) {
    for (const orphan of orphans) {
      const result = await options.store.tombstoneObject({
        object_id: orphan.object_id,
        expected_generation: options.store.status().generation,
        actor_id: options.actorId,
        recorded_at: options.now ?? new Date().toISOString()
      });
      if (result.ok) {
        tombstoned += 1;
      } else {
        failed += 1;
        failedReasons[result.reason] = (failedReasons[result.reason] ?? 0) + 1;
      }
    }
  }

  return {
    report_schema: "living-atlas-tombstone-orphans:v1",
    plaintext_policy: "counts-and-refs-only",
    dry_run: options.dryRun,
    scanned: live.length,
    orphans: orphans.length,
    tombstoned,
    failed,
    failed_reasons: failedReasons,
    orphan_key_ref_prefixes: orphanPrefixes
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
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING?.trim() || join(replicaDir, "keyring.json");
  const graphDir = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR?.trim() || join(replicaDir, "graph");
  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) {
    throw new Error(
      "missing LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE (set it directly or via LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE)"
    );
  }

  const keyring = await new FileLocalKeyringStore(keyringPath).read(passphrase.value);
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as {
    authority_id: string;
  };
  const store = await FileLocalGraphStore.open({
    directory: graphDir,
    authorityId: snapshot.authority_id,
    plaintextPersistence: "redact",
    keyring
  });

  const dryRun = process.env[ackEnv]?.trim() !== ackValue;
  const result = await tombstoneOrphanCiphertext({
    store,
    keyring,
    actorId: "la_client_tombstoneorphans0001",
    dryRun
  });

  if (!dryRun && result.tombstoned > 0) {
    await store.compact();
  }

  console.log(JSON.stringify(result, null, 2));
  if (dryRun) {
    console.error(`dry run only; set ${ackEnv}=${ackValue} to tombstone ${result.orphans} orphaned objects`);
  }
  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
