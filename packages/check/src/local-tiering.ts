import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  decryptGraphObjectPayload,
  openLocalKeyring,
  resolveLocalSecret,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import {
  classifyTier,
  extractClassifiableText,
  loadPrivateTieringRuleset,
  type TierDecision,
  type TieringRuleset
} from "@living-atlas/policy";
import {
  CloudUnlockObjectAlgorithm,
  encryptCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";

const LOCAL_KEYRING_ALGORITHM = "AES-GCM-256+local-keyring-v1";

export type TieringOptions = {
  keyring: LocalKeyringState;
  ruleset: TieringRuleset;
  /**
   * Base64 PRIMARY cloud-unlock key. Required to APPLY re-encryption of NORMAL
   * (cloud-unlockable) objects; the dry-run classifier does not need it.
   */
  unlockKey?: string;
  /**
   * Base64 ESCALATION key. Required to APPLY re-encryption of SUPER-SENSITIVE
   * objects into the escalated tier. Distinct from unlockKey.
   */
  escalationKey?: string;
};

/**
 * Classify a single decrypted-in-place object. Objects that cannot be decrypted
 * (unknown algorithm / missing key) are conservatively treated as
 * super-sensitive-by-default (kept local), because we cannot inspect their
 * content to clear them for cloud-unlock.
 */
export async function classifyObjectTier(object: GraphObjectEnvelope, options: TieringOptions): Promise<TierDecision & { decryptable: boolean }> {
  const plaintext = await decryptGraphObjectPayload(object, options.keyring).catch(() => undefined);
  if (!plaintext || plaintext.kind !== "plaintext-json") {
    return {
      object_id: object.object_id,
      tier: "super-sensitive",
      matched_rules: ["undecryptable-conservative-hold"],
      matches: [{ rule_id: "undecryptable-conservative-hold", field: "text", term: "<undecryptable>" }],
      decryptable: false
    };
  }

  const extracted = extractClassifiableText(plaintext.data);
  const decision = classifyTier(
    {
      object_id: object.object_id,
      object_type: object.object_type,
      access_class: object.access_class,
      tags: extracted.tags,
      entity_names: extracted.entity_names,
      text: extracted.text
    },
    options.ruleset
  );
  return { ...decision, decryptable: true };
}

export type SuperSensitiveMatch = {
  object_id: string;
  object_type: GraphObjectEnvelope["object_type"];
  access_class: GraphObjectEnvelope["access_class"];
  matched_rules: string[];
  /** Entity names extracted from the object — safe to surface for eyeballing. */
  entity_names: string[];
  /** The terms/fields that triggered each rule. */
  matches: TierDecision["matches"];
};

export type TieringPlan = {
  report_schema: "living-atlas-tiering-plan:v2";
  tier_model: "two-key-escalation";
  plaintext_policy: "counts-matches-and-entity-names-only";
  ruleset_version: string;
  dry_run: true;
  total_objects: number;
  tombstoned_excluded: number;
  /** NORMAL tier count (cloud-unlock-v1, primary key). Alias: cloud_unlockable. */
  normal: number;
  cloud_unlockable: number;
  /** SUPER-SENSITIVE / ESCALATED tier count (cloud-unlock-escalated-v1, escalation key). */
  escalated: number;
  super_sensitive: number;
  undecryptable_held: number;
  already_cloud_unlock: number;
  already_escalated: number;
  super_sensitive_matches: SuperSensitiveMatch[];
};

function isLiveObject(object: GraphObjectEnvelope): boolean {
  return !object.visible_metadata?.tombstone;
}

function isAlreadyCloudUnlock(object: GraphObjectEnvelope): boolean {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === CloudUnlockObjectAlgorithm;
}

function isAlreadyEscalated(object: GraphObjectEnvelope): boolean {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === CloudUnlockEscalatedObjectAlgorithm;
}

/**
 * DRY-RUN classifier over a set of objects. Reports tier counts and the full
 * super-sensitive match list (object id, matched rules, entity names, matched
 * terms) for eyeballing. Never emits decrypted plaintext bodies.
 */
export async function planTiering(objects: GraphObjectEnvelope[], options: TieringOptions): Promise<TieringPlan> {
  const live = objects.filter(isLiveObject);
  let cloudUnlockable = 0;
  let superSensitive = 0;
  let undecryptable = 0;
  let alreadyCloudUnlock = 0;
  let alreadyEscalated = 0;
  const matches: SuperSensitiveMatch[] = [];

  for (const object of live) {
    if (isAlreadyEscalated(object)) {
      // Already in the super-sensitive (escalated) cloud tier.
      alreadyEscalated += 1;
      superSensitive += 1;
      continue;
    }
    if (isAlreadyCloudUnlock(object)) {
      alreadyCloudUnlock += 1;
      cloudUnlockable += 1;
      continue;
    }
    const decision = await classifyObjectTier(object, options);
    if (decision.tier === "super-sensitive") {
      superSensitive += 1;
      if (!decision.decryptable) undecryptable += 1;
      const extracted = decision.decryptable
        ? extractEntityNames(object, options)
        : [];
      matches.push({
        object_id: object.object_id,
        object_type: object.object_type,
        access_class: object.access_class,
        matched_rules: decision.matched_rules,
        entity_names: await extracted,
        matches: decision.matches
      });
    } else {
      cloudUnlockable += 1;
    }
  }

  return {
    report_schema: "living-atlas-tiering-plan:v2",
    tier_model: "two-key-escalation",
    plaintext_policy: "counts-matches-and-entity-names-only",
    ruleset_version: options.ruleset.ruleset_version,
    dry_run: true,
    total_objects: objects.length,
    tombstoned_excluded: objects.length - live.length,
    normal: cloudUnlockable,
    cloud_unlockable: cloudUnlockable,
    escalated: superSensitive,
    super_sensitive: superSensitive,
    undecryptable_held: undecryptable,
    already_cloud_unlock: alreadyCloudUnlock,
    already_escalated: alreadyEscalated,
    super_sensitive_matches: matches
  };
}

async function extractEntityNames(object: GraphObjectEnvelope, options: TieringOptions): Promise<string[]> {
  const plaintext = await decryptGraphObjectPayload(object, options.keyring).catch(() => undefined);
  if (!plaintext || plaintext.kind !== "plaintext-json") return [];
  return extractClassifiableText(plaintext.data).entity_names;
}

export type ReencryptResult =
  | { action: "reencrypted"; object: GraphObjectEnvelope }
  | { action: "skipped-super-sensitive"; object: GraphObjectEnvelope }
  | { action: "skipped-already-cloud-unlock"; object: GraphObjectEnvelope }
  | { action: "skipped-undecryptable"; object: GraphObjectEnvelope };

/**
 * APPLY step (used behind an ack gate). Re-encrypts a single cloud-unlockable
 * object from local-keyring-v1 to cloud-unlock-v1, preserving identity.
 * Idempotent (already-cloud-unlock objects are skipped) and never touches
 * super-sensitive objects.
 */
export async function reencryptToCloudUnlock(object: GraphObjectEnvelope, options: TieringOptions): Promise<ReencryptResult> {
  if (isAlreadyCloudUnlock(object)) {
    return { action: "skipped-already-cloud-unlock", object };
  }
  if (
    object.payload.kind === "ciphertext-inline" &&
    object.payload.algorithm !== LOCAL_KEYRING_ALGORITHM
  ) {
    // Unknown ciphertext algorithm — cannot decrypt to re-encrypt; hold.
    return { action: "skipped-undecryptable", object };
  }

  const decision = await classifyObjectTier(object, options);
  if (decision.tier === "super-sensitive") {
    return { action: "skipped-super-sensitive", object };
  }
  if (!decision.decryptable) {
    return { action: "skipped-undecryptable", object };
  }

  if (!options.unlockKey) {
    throw new Error("cloud-unlock session key required to re-encrypt (options.unlockKey)");
  }

  const plaintext = await decryptGraphObjectPayload(object, options.keyring);
  if (!plaintext || plaintext.kind !== "plaintext-json") {
    return { action: "skipped-undecryptable", object };
  }

  const { content_hash: _contentHash, payload: _payload, ...identity } = object;
  const reencrypted = await encryptCloudUnlockObject({
    envelope: { ...identity, key_ref: object.key_ref },
    plaintext: plaintext.data,
    encodedUnlockKey: options.unlockKey
  });
  return { action: "reencrypted", object: reencrypted };
}

export type ReencryptTierResult =
  | { action: "reencrypted-normal"; tier: "normal"; object: GraphObjectEnvelope }
  | { action: "reencrypted-escalated"; tier: "super-sensitive"; object: GraphObjectEnvelope }
  | { action: "skipped-already-normal"; tier: "normal"; object: GraphObjectEnvelope }
  | { action: "skipped-already-escalated"; tier: "super-sensitive"; object: GraphObjectEnvelope }
  | { action: "skipped-undecryptable"; tier: "held"; object: GraphObjectEnvelope };

/**
 * TWO-KEY RE-TIER APPLY step (used behind an ack gate).
 *
 * The CORRECTED MODEL: nothing stays local-keyring-only anymore. Every
 * decryptable object is re-encrypted into a CLOUD tier —
 *
 *   - NORMAL          → "AES-GCM-256+cloud-unlock-v1"           (primary key)
 *   - SUPER-SENSITIVE → "AES-GCM-256+cloud-unlock-escalated-v1" (escalation key)
 *
 * The ONLY objects held on local-keyring-v1 are those the classifier cannot
 * decrypt (conservative hold — we cannot inspect them, so we do not expose
 * them to the cloud). Lossless (identity preserved) and idempotent (an object
 * already in its correct target tier is skipped).
 */
export async function reencryptToTier(
  object: GraphObjectEnvelope,
  options: TieringOptions,
  retierOptions: { targetVersion?: number; updatedAt?: string } = {}
): Promise<ReencryptTierResult> {
  if (isAlreadyEscalated(object)) {
    return { action: "skipped-already-escalated", tier: "super-sensitive", object };
  }
  if (isAlreadyCloudUnlock(object)) {
    return { action: "skipped-already-normal", tier: "normal", object };
  }
  if (
    object.payload.kind === "ciphertext-inline" &&
    object.payload.algorithm !== LOCAL_KEYRING_ALGORITHM
  ) {
    // Unknown ciphertext algorithm — cannot decrypt to re-encrypt; hold.
    return { action: "skipped-undecryptable", tier: "held", object };
  }

  const decision = await classifyObjectTier(object, options);
  if (!decision.decryptable) {
    return { action: "skipped-undecryptable", tier: "held", object };
  }

  const plaintext = await decryptGraphObjectPayload(object, options.keyring);
  if (!plaintext || plaintext.kind !== "plaintext-json") {
    return { action: "skipped-undecryptable", tier: "held", object };
  }

  const { content_hash: _contentHash, payload: _payload, ...identity } = object;
  // The stable cloud-unlock AAD binds only authority_id + object_id + algorithm.
  // Version and timestamp updates are still reflected in the envelope so the
  // store sees the re-tier as the intended object update, but they are not part
  // of AES-GCM authentication data.
  const envelope = {
    ...identity,
    key_ref: object.key_ref,
    version: retierOptions.targetVersion ?? object.version,
    updated_at: retierOptions.updatedAt ?? object.updated_at
  };

  if (decision.tier === "super-sensitive") {
    if (!options.escalationKey) {
      throw new Error("escalation key required to re-encrypt super-sensitive objects (options.escalationKey)");
    }
    const reencrypted = await encryptEscalatedCloudUnlockObject({
      envelope,
      plaintext: plaintext.data,
      encodedEscalationKey: options.escalationKey
    });
    return { action: "reencrypted-escalated", tier: "super-sensitive", object: reencrypted };
  }

  if (!options.unlockKey) {
    throw new Error("cloud-unlock primary key required to re-encrypt normal objects (options.unlockKey)");
  }
  const reencrypted = await encryptCloudUnlockObject({
    envelope,
    plaintext: plaintext.data,
    encodedUnlockKey: options.unlockKey
  });
  return { action: "reencrypted-normal", tier: "normal", object: reencrypted };
}

/**
 * Explicit acknowledgement required to WRITE a re-tiered object back into a
 * local graph store. The apply path is OFF by default: without this exact ack
 * value, {@link applyRetierToStore} refuses to write and the store is untouched.
 */
export const RETIER_APPLY_ACK = "reencrypt-two-key-tiers-real-data";

export type ApplyRetierOptions = TieringOptions & {
  /** Actor id recorded on the store update. */
  actorId: string;
  /** Explicit ack. Must equal RETIER_APPLY_ACK or the write is refused. */
  ack?: string;
  /** Recorded/updated timestamp for the store update (defaults to now). */
  recordedAt?: string;
};

export type ApplyRetierResult =
  | { action: "refused-no-ack"; object: GraphObjectEnvelope }
  | { action: "written-normal"; tier: "normal"; object: GraphObjectEnvelope }
  | { action: "written-escalated"; tier: "super-sensitive"; object: GraphObjectEnvelope }
  | { action: "skipped-already-normal"; tier: "normal"; object: GraphObjectEnvelope }
  | { action: "skipped-already-escalated"; tier: "super-sensitive"; object: GraphObjectEnvelope }
  | { action: "skipped-undecryptable"; tier: "held"; object: GraphObjectEnvelope }
  | { action: "store-conflict"; reason: string; object: GraphObjectEnvelope };

type MinimalGraphStore = {
  status(): { generation: number };
  readObject(objectId: string): GraphObjectEnvelope | undefined;
  updateObject(input: {
    object: GraphObjectEnvelope;
    expected_generation: number;
    expected_version?: number;
    actor_id: string;
    recorded_at?: string;
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
};

/**
 * ACK-GATED APPLY: re-encrypt an object IN PLACE and write it back to the store
 * as a version-bumped update, preserving object_id/authority. OFF by default —
 * an absent or wrong ack returns "refused-no-ack" and NEVER writes. With the
 * correct ack, the object is re-sealed to its target tier (normal ->
 * cloud-unlock-v1, super-sensitive -> cloud-unlock-escalated-v1) at version+1
 * and committed via store.updateObject. Idempotent skips and undecryptable
 * holds are surfaced without writing.
 */
export async function applyRetierToStore(
  store: MinimalGraphStore,
  object: GraphObjectEnvelope,
  options: ApplyRetierOptions
): Promise<ApplyRetierResult> {
  if (options.ack !== RETIER_APPLY_ACK) {
    return { action: "refused-no-ack", object };
  }

  const targetVersion = object.version + 1;
  const updatedAt = options.recordedAt ?? new Date().toISOString();
  const retier = await reencryptToTier(object, options, { targetVersion, updatedAt });

  if (retier.action === "skipped-already-normal") {
    return { action: "skipped-already-normal", tier: "normal", object: retier.object };
  }
  if (retier.action === "skipped-already-escalated") {
    return { action: "skipped-already-escalated", tier: "super-sensitive", object: retier.object };
  }
  if (retier.action === "skipped-undecryptable") {
    return { action: "skipped-undecryptable", tier: "held", object: retier.object };
  }

  const update = await store.updateObject({
    object: retier.object,
    expected_generation: store.status().generation,
    expected_version: object.version,
    actor_id: options.actorId,
    recorded_at: updatedAt
  });
  if (!update.ok) {
    return { action: "store-conflict", reason: update.reason, object: retier.object };
  }

  return retier.action === "reencrypted-escalated"
    ? { action: "written-escalated", tier: "super-sensitive", object: retier.object }
    : { action: "written-normal", tier: "normal", object: retier.object };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

const ACK_ENV = "LIVING_ATLAS_TIERING_APPLY_ACK";
const ACK_VALUE = "reencrypt-two-key-tiers-real-data";

async function main(): Promise<void> {
  const replicaDir = requireEnv("LIVING_ATLAS_LOCAL_REPLICA_DIR");
  const keyringPath = process.env.LIVING_ATLAS_LOCAL_KEYRING?.trim() || join(replicaDir, "keyring.json");
  const graphDir = process.env.LIVING_ATLAS_LOCAL_GRAPH_DIR?.trim() || join(replicaDir, "graph");
  const outPath = process.env.LIVING_ATLAS_TIERING_DRYRUN_OUT?.trim() || join(replicaDir, "tiering-dryrun.json");

  const passphrase = resolveLocalSecret("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE");
  if (!passphrase) {
    throw new Error(
      "missing LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE (set it directly or via LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE_KEYCHAIN_SERVICE)"
    );
  }

  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as { objects: GraphObjectEnvelope[] };

  const options: TieringOptions = { keyring, ruleset: loadPrivateTieringRuleset() };
  const plan = await planTiering(snapshot.objects, options);

  writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ...plan,
    super_sensitive_matches: `[${plan.super_sensitive_matches.length} matches written to ${outPath}]`
  }, null, 2));
  console.log(`tiering dry-run written to ${outPath}`);

  const ack = process.env[ACK_ENV]?.trim();
  if (ack !== ACK_VALUE) {
    console.log(
      `apply=skipped (DRY-RUN). Set ${ACK_ENV}=${ACK_VALUE} to re-encrypt into the two tiers ` +
        "(normal -> cloud-unlock-v1 with the primary key, super-sensitive -> cloud-unlock-escalated-v1 with the escalation key)."
    );
    return;
  }
  // Guarded, but intentionally NOT wired to write the replica in this phase.
  // A real apply would resolve LIVING_ATLAS_CLOUD_UNLOCK_KEY (primary) and
  // LIVING_ATLAS_ESCALATION_KEY (escalation-key keychain service) and route each
  // object through reencryptToTier — a coordinated later phase.
  throw new Error(
    "real-data re-encryption is a coordinated later phase and is not enabled in this tool build"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
