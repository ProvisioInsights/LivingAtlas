import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  addTieringKeysToKeyring,
  decryptGraphObjectPayload,
  openLocalKeyring,
  resolveLocalSecret,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import { loadPrivateTieringRuleset, type TieringRuleset } from "@living-atlas/policy";

import { reencryptToTier, type TieringOptions } from "./local-tiering";

/**
 * LOSSLESS RE-TIER VERIFIER.
 *
 * PROVES, without writing anything, that re-tiering an object (local-keyring-v1
 * -> cloud-unlock-v1 / cloud-unlock-escalated-v1) is byte-for-byte reversible
 * BEFORE anyone runs the apply path on real data. For EVERY object it:
 *
 *   1. decrypts the ORIGINAL payload and records the canonical plaintext bytes;
 *   2. computes the re-tier (in memory, via reencryptToTier);
 *   3. decrypts the RE-TIERED result back with the tiering keys carried in the
 *      keyring (the Task-1 tier-aware local decrypt path);
 *   4. asserts the recovered bytes are IDENTICAL to the original.
 *
 * Any object whose original cannot be decrypted, whose re-tier is not
 * decryptable, or whose recovered bytes differ is flagged in `mismatches` and
 * forces `lossless_ok=false`. The verifier NEVER writes the store.
 */

const textEncoder = new TextEncoder();

export type RetierVerifyOptions = {
  ruleset: TieringRuleset;
  /** Base64 primary cloud-unlock key (normal tier). */
  unlockKey: string;
  /** Base64 escalation key (super-sensitive tier). */
  escalationKey: string;
  /**
   * TEST SEAM ONLY: flip one byte of the recovered plaintext for this object id
   * to prove the byte-level comparison catches silent loss. Never set in
   * production callers.
   */
  __corruptPlaintextForObjectId?: string;
};

export type RetierVerifyReport = {
  report_schema: "living-atlas-retier-verify:v1";
  read_only: true;
  total: number;
  normal: number;
  escalated: number;
  held: number;
  lossless_ok: boolean;
  mismatches: string[];
  any_decrypt_failure: boolean;
};

/**
 * Canonical byte serialization of a decrypted plaintext-json payload's data.
 * Byte-identity of this serialization across the original and the re-tiered
 * decrypt is the losslessness guarantee.
 */
function canonicalPlaintextBytes(data: Record<string, unknown>): Uint8Array {
  return textEncoder.encode(stableJson(data));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Verify losslessness of the re-tier for every object. READ-ONLY: the input
 * objects and keyring are never mutated. `keyring` must carry the per-access-
 * class keys to decrypt local-keyring-v1 originals; the tiering keys (primary +
 * escalation) matching `options.unlockKey`/`options.escalationKey` are added to
 * a COPY of the keyring so the re-tiered ciphertext can be decrypted back.
 */
export async function verifyRetierLossless(
  objects: GraphObjectEnvelope[],
  keyring: LocalKeyringState,
  options: RetierVerifyOptions
): Promise<RetierVerifyReport> {
  // Decrypt keyring: same access-class keys, plus the tiering keys that match
  // the keys the re-tier seals under, so the Task-1 tier-aware decrypt path can
  // reverse the re-tiered ciphertext. Non-mutating (addTieringKeysToKeyring is
  // pure). The tiering material is base64 32-byte; guarded by the encrypt path.
  const decryptKeyring = addTieringKeysToKeyring(keyring, {
    primary_cloud_unlock_key_base64: options.unlockKey,
    escalation_key_base64: options.escalationKey
  });

  const tieringOptions: TieringOptions = {
    keyring,
    ruleset: options.ruleset,
    unlockKey: options.unlockKey,
    escalationKey: options.escalationKey
  };

  let normal = 0;
  let escalated = 0;
  let held = 0;
  const mismatches: string[] = [];
  let anyDecryptFailure = false;

  for (const object of objects) {
    // 1. Original plaintext bytes.
    const original = await decryptGraphObjectPayload(object, keyring).catch(() => undefined);
    if (!original || original.kind !== "plaintext-json") {
      anyDecryptFailure = true;
      mismatches.push(object.object_id);
      continue;
    }
    const originalBytes = canonicalPlaintextBytes(original.data);

    // 2. Re-tier (in memory; store untouched).
    const retier = await reencryptToTier(object, tieringOptions).catch(() => undefined);
    if (!retier) {
      anyDecryptFailure = true;
      mismatches.push(object.object_id);
      continue;
    }
    if (retier.action === "skipped-undecryptable") {
      held += 1;
      // An object we could originally decrypt but the re-tier held is itself a
      // loss of coverage — flag it.
      mismatches.push(object.object_id);
      anyDecryptFailure = true;
      continue;
    }
    if (retier.action === "reencrypted-escalated" || retier.action === "skipped-already-escalated") {
      escalated += 1;
    } else {
      normal += 1;
    }

    // 3. Decrypt the re-tiered result back.
    const recovered = await decryptGraphObjectPayload(retier.object, decryptKeyring).catch(() => undefined);
    if (!recovered || recovered.kind !== "plaintext-json") {
      anyDecryptFailure = true;
      mismatches.push(object.object_id);
      continue;
    }
    let recoveredBytes = canonicalPlaintextBytes(recovered.data);
    if (options.__corruptPlaintextForObjectId === object.object_id && recoveredBytes.byteLength > 0) {
      recoveredBytes = recoveredBytes.slice();
      recoveredBytes[0] = recoveredBytes[0]! ^ 0xff;
    }

    // 4. Byte-identity assertion.
    if (!bytesEqual(originalBytes, recoveredBytes)) {
      mismatches.push(object.object_id);
    }
  }

  return {
    report_schema: "living-atlas-retier-verify:v1",
    read_only: true,
    total: objects.length,
    normal,
    escalated,
    held,
    lossless_ok: mismatches.length === 0 && !anyDecryptFailure,
    mismatches,
    any_decrypt_failure: anyDecryptFailure
  };
}

function generateSessionKey(): string {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return Buffer.from(raw).toString("base64");
}

async function main(): Promise<void> {
  const replicaDir = process.env.LIVING_ATLAS_LOCAL_REPLICA_DIR?.trim();
  const graphDir = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR?.trim()
    || (replicaDir ? join(replicaDir, "graph") : undefined);
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING?.trim()
    || (replicaDir ? join(replicaDir, "keyring.json") : undefined);
  if (!graphDir) {
    throw new Error("missing LIVING_ATLAS_LOCAL_GRAPH_DIR (or LIVING_ATLAS_LOCAL_REPLICA_DIR)");
  }
  if (!keyringPath) {
    throw new Error("missing LIVING_ATLAS_LOCAL_KEYRING (or LIVING_ATLAS_LOCAL_REPLICA_DIR)");
  }

  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) {
    throw new Error(
      "missing LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE (set it directly or via LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE)"
    );
  }

  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as { objects: GraphObjectEnvelope[] };

  // The verifier proves REVERSIBILITY of the crypto transform; any valid
  // distinct 32-byte primary/escalation pair suffices. If real tiering keys are
  // provided via env they are used; otherwise synthetic distinct keys are
  // generated. Nothing is written to the replica.
  const unlockKey = process.env.LIVING_ATLAS_CLOUD_UNLOCK_KEY?.trim() || generateSessionKey();
  let escalationKey = process.env.LIVING_ATLAS_ESCALATION_KEY?.trim() || generateSessionKey();
  while (escalationKey === unlockKey) {
    escalationKey = generateSessionKey();
  }

  const report = await verifyRetierLossless(snapshot.objects, keyring, {
    ruleset: loadPrivateTieringRuleset(),
    unlockKey,
    escalationKey
  });

  console.log(JSON.stringify(report, null, 2));
  if (!report.lossless_ok) {
    console.error(
      `retier-verify FAILED: ${report.mismatches.length} object(s) did not round-trip byte-identically ` +
        `(any_decrypt_failure=${report.any_decrypt_failure}).`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
