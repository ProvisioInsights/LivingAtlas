import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  decryptGraphObjectPayload,
  openLocalKeyring,
  resolveLocalSecret,
  type LocalKeyringState
} from "@living-atlas/local-keyring";

/**
 * Decrypt-coverage readiness gate.
 *
 * Encrypted objects are only as durable as key custody: ciphertext whose
 * key_ref does not resolve to a keyring key is permanently unreadable and
 * indistinguishable from deleted data. This gate fails readiness when any
 * stored ciphertext object cannot be attributed to the local keyring, or when
 * a sampled decrypt under an attributed key fails.
 *
 * This class of failure has already occurred once: parity-proof tooling that
 * generated and discarded per-object AES keys wrote ~39k undecryptable
 * objects into a real replica. This gate exists so that can never pass a
 * go-live check again.
 */

export type DecryptCoverageResult = {
  report_schema: "living-atlas-local-decrypt-coverage:v1";
  plaintext_policy: "counts-and-refs-only";
  total_objects: number;
  /** Tombstoned objects are excluded: dead-by-intent is not unreadable-by-accident. */
  tombstoned_objects: number;
  ciphertext_objects: number;
  covered_objects: number;
  uncovered_objects: number;
  uncovered_key_ref_prefixes: Record<string, number>;
  sampled_decrypts: number;
  sampled_decrypt_failures: number;
  complete: boolean;
};

function keyRefPrefix(keyRef: string): string {
  return `${keyRef.replace(/[0-9a-f]{8,}$/i, "")}*`;
}

export async function runLocalDecryptCoverage(options: {
  keyring: LocalKeyringState;
  objects: GraphObjectEnvelope[];
  sampleLimit?: number;
}): Promise<DecryptCoverageResult> {
  const sampleLimit = options.sampleLimit ?? 50;
  const keyringIds = new Set(options.keyring.keys.map((key) => key.key_id));

  const liveObjects = options.objects.filter((object) => !object.visible_metadata.tombstone);
  const tombstonedCount = options.objects.length - liveObjects.length;
  const ciphertextObjects = liveObjects.filter((object) => object.payload.kind !== "plaintext-json");
  const covered: GraphObjectEnvelope[] = [];
  const uncoveredPrefixes: Record<string, number> = {};

  for (const object of ciphertextObjects) {
    if (object.key_ref && keyringIds.has(object.key_ref)) {
      covered.push(object);
    } else {
      const prefix = keyRefPrefix(object.key_ref ?? "<missing-key-ref>");
      uncoveredPrefixes[prefix] = (uncoveredPrefixes[prefix] ?? 0) + 1;
    }
  }

  const inlineCovered = covered.filter((object) => object.payload.kind === "ciphertext-inline");
  const step = Math.max(1, Math.floor(inlineCovered.length / sampleLimit));
  let sampledDecrypts = 0;
  let sampledDecryptFailures = 0;
  for (let index = 0; index < inlineCovered.length; index += step) {
    sampledDecrypts += 1;
    const plaintext = await decryptGraphObjectPayload(inlineCovered[index]!, options.keyring).catch(() => undefined);
    if (!plaintext) {
      sampledDecryptFailures += 1;
    }
  }

  const uncoveredCount = ciphertextObjects.length - covered.length;
  return {
    report_schema: "living-atlas-local-decrypt-coverage:v1",
    plaintext_policy: "counts-and-refs-only",
    total_objects: options.objects.length,
    tombstoned_objects: tombstonedCount,
    ciphertext_objects: ciphertextObjects.length,
    covered_objects: covered.length,
    uncovered_objects: uncoveredCount,
    uncovered_key_ref_prefixes: uncoveredPrefixes,
    sampled_decrypts: sampledDecrypts,
    sampled_decrypt_failures: sampledDecryptFailures,
    complete: uncoveredCount === 0 && sampledDecryptFailures === 0
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

  const keyring = await openLocalKeyring(
    JSON.parse(readFileSync(keyringPath, "utf8")),
    passphrase.value
  );
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as {
    objects: GraphObjectEnvelope[];
  };

  const result = await runLocalDecryptCoverage({ keyring, objects: snapshot.objects });
  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) {
    console.error("decrypt coverage gate FAILED: replica contains ciphertext that local keys cannot open");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
