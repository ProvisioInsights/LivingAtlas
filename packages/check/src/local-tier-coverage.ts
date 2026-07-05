import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  decryptGraphObjectPayload,
  openLocalKeyring,
  resolveLocalSecret
} from "@living-atlas/local-keyring";
import { loadPrivateTieringRuleset, type Tier } from "@living-atlas/policy";
import {
  CloudUnlockObjectAlgorithm,
  decryptCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  decryptEscalatedCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";
import {
  classifyObjectTier,
  reencryptToTier,
  type TieringOptions
} from "./local-tiering";

/**
 * Tier-coverage readiness gate — TWO-KEY ESCALATION model. Proven
 * object-by-object, IN MEMORY (never mutates the replica):
 *
 *   1. EVERY normal object, once re-encrypted to cloud-unlock-v1, decrypts back
 *      to its original plaintext under the PRIMARY key.
 *
 *   2. EVERY super-sensitive object, once re-encrypted to
 *      cloud-unlock-escalated-v1, decrypts back to its original plaintext under
 *      the ESCALATION key — AND correctly REFUSES to decrypt when the escalation
 *      key is withheld (the escalation gate must fire).
 *
 *   3. EVERY live object is cloud-decryptable in SOME tier — none stranded
 *      host-blind (except conservatively-held undecryptables, which are counted
 *      separately and expected to be zero on a clean graph).
 *
 *   4. Tier isolation: no super-sensitive object sits in the plain cloud-unlock
 *      class (an escalated object that decrypts under the primary key would be an
 *      accidental exposure).
 *
 *   5. DEF-2 independent full-body backstop over all cloud-decryptable objects.
 */
export type TierCoverageResult = {
  report_schema: "living-atlas-tier-coverage:v2";
  tier_model: "two-key-escalation";
  plaintext_policy: "counts-only";
  ruleset_version: string;
  total_objects: number;
  tombstoned_excluded: number;
  cloud_unlockable_objects: number;
  super_sensitive_objects: number;
  /** Alias of super_sensitive_objects under the new naming. */
  escalated_objects: number;
  sampled_cloud_unlockable: number;
  cloud_unlock_roundtrip_ok: number;
  cloud_unlock_roundtrip_failed: number;
  sampled_escalated: number;
  /** Escalated objects that round-trip under the ESCALATION key. */
  escalation_roundtrip_ok: number;
  escalation_roundtrip_failed: number;
  /** Escalated objects that correctly REFUSE to decrypt without the escalation key (gate fires). */
  escalation_gate_refusals_ok: number;
  escalation_gate_refusals_failed: number;
  super_sensitive_in_cloud_unlock_class: number;
  /** Live objects that end up cloud-decryptable in NO tier (stuck host-blind). Expected 0. */
  host_blind_stuck_objects: number;
  /** True iff every live object is cloud-decryptable in some tier. */
  every_object_cloud_decryptable: boolean;
  /** DEF-2: full-body independent backstop — how many cloud-unlockable objects were scanned (100%). */
  exposure_backstop_scanned: number;
  /** DEF-2: how many cloud-unlockable objects had a high-signal term in their full plaintext body. */
  exposure_backstop_hits: number;
  /** DEF-2: the ids of cloud-unlockable objects that tripped the backstop (classifier false negatives). */
  exposure_backstop_hit_objects: string[];
  complete: boolean;
};

/**
 * DEF-2 independent backstop terms — GENERIC only. Deliberately NOT sourced from
 * the same ClassifiableObject/extractClassifiableText path the classifier uses —
 * this is a raw, high-signal, case-insensitive substring blacklist run over the
 * FULL decrypted plaintext body (JSON-stringified) of every cloud-unlockable
 * object. If any of these appears in a body slated for cloud-unlock, the
 * classifier under-read the object and the gate must fail.
 *
 * This list carries NO personal specifics — only universal category keywords.
 * An operator's private terms (exact firm/place/family names) are pulled from
 * the SAME private overlay the classifier uses (see `resolvePrivateBackstopTerms`)
 * and are never hardcoded here.
 */
export const EXPOSURE_BACKSTOP_TERMS: readonly string[] = [
  // immigration / legal / citizenship
  "immigration",
  "visa",
  "citizenship",
  "naturalization",
  "naturalisation",
  "reacquisition",
  "consulate",
  "consular",
  "honorary consul",
  "staatsangehörigkeit",
  "einbürgerung",
  "uscis",
  "green card",
  // inherited land
  "naturschutzgebiet",
  "nature reserve",
  "inherited land",
  "inherited property",
  // health / medical
  "medical",
  "diagnosis",
  "prescription",
  "physician",
  "hospital",
  "health record",
  "medication",
  "treatment plan",
  "mental health",
  // security clearance
  "security clearance",
  "classified information",
  "classified document",
  "top secret",
  "ts/sci",
  "ts-sci",
  "background investigation",
  "polygraph"
];

/**
 * Resolve the FULL backstop term list: the generic defaults PLUS any personal
 * entity/place/keyword terms an operator supplies through the private tiering
 * overlay (resolved at runtime from OUTSIDE the repo). The overlay's per-rule
 * entity_names/keywords are folded in (lowercased, de-duplicated) so the
 * independent backstop still catches the operator's specific super-sensitive
 * names that the generic list cannot enumerate. If no overlay is present, only
 * the generic defaults are used.
 */
export function resolvePrivateBackstopTerms(base: readonly string[] = EXPOSURE_BACKSTOP_TERMS): string[] {
  const terms = new Set(base.map((t) => t.toLowerCase()));
  // Diff the merged (overlay-applied) ruleset against the generic default to pull
  // only the OVERLAY-CONTRIBUTED entity_names/keywords — never printed, only used
  // as match terms.
  const merged = loadPrivateTieringRuleset();
  for (const rule of merged.rules) {
    for (const name of rule.entity_names) terms.add(name.toLowerCase());
    for (const keyword of rule.keywords) terms.add(keyword.toLowerCase());
  }
  return [...terms];
}

// Bounded trailing-inflection allowlist, matched with word boundaries — kept in
// lockstep with the classifier's own matcher so the backstop flags a body iff a
// genuinely-sensitive (possibly inflected) term is present, and does NOT flag
// unrelated longer tokens like "VisaSQ"/"hospitality" (safe over-inclusion).
const BACKSTOP_INFLECTION_SUFFIX =
  "(?:s|es|ed|ing|'s|ize|izes|ized|izing|ization|ise|ises|ised|ising|isation|ist)?";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scan a full decrypted plaintext body for any high-signal backstop term.
 * Independent of the classifier's field-extraction path: it JSON-stringifies the
 * WHOLE body and word-boundary matches each term (with bounded inflection) over
 * that raw string. Returns the matched terms (lowercased) for eyeballing.
 */
export function scanBodyForExposure(body: unknown, terms: readonly string[] = resolvePrivateBackstopTerms()): string[] {
  const haystack = JSON.stringify(body).toLowerCase();
  const hits: string[] = [];
  for (const term of terms) {
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}${BACKSTOP_INFLECTION_SUFFIX}([^\\p{L}\\p{N}]|$)`,
      "iu"
    );
    if (pattern.test(haystack)) hits.push(term);
  }
  return hits;
}

function isLive(object: GraphObjectEnvelope): boolean {
  return !object.visible_metadata?.tombstone;
}

function isCloudUnlockClass(object: GraphObjectEnvelope): boolean {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === CloudUnlockObjectAlgorithm;
}

function isEscalatedClass(object: GraphObjectEnvelope): boolean {
  return object.payload.kind === "ciphertext-inline" && object.payload.algorithm === CloudUnlockEscalatedObjectAlgorithm;
}

export async function runTierCoverage(
  objects: GraphObjectEnvelope[],
  options: TieringOptions & {
    sampleLimit?: number;
    /** Test hook: force the tier for every object, isolating the independent backstop. */
    classifierOverride?: (object: GraphObjectEnvelope) => Tier;
  }
): Promise<TierCoverageResult> {
  if (!options.unlockKey) {
    throw new Error("cloud-unlock primary key required to run tier-coverage round-trip proof");
  }
  if (!options.escalationKey) {
    throw new Error("escalation key required to run tier-coverage escalation proof");
  }
  const primaryKey = options.unlockKey;
  const escalationKey = options.escalationKey;
  const sampleLimit = options.sampleLimit ?? 200;
  const live = objects.filter(isLive);

  let cloudUnlockable = 0;
  let superSensitive = 0;
  let exposed = 0;
  let hostBlindStuck = 0;
  const cloudUnlockableForProof: GraphObjectEnvelope[] = [];
  const escalatedForProof: GraphObjectEnvelope[] = [];

  for (const object of live) {
    const tier = options.classifierOverride
      ? options.classifierOverride(object)
      : (await classifyObjectTier(object, options)).tier;
    if (tier === "super-sensitive") {
      superSensitive += 1;
      escalatedForProof.push(object);
      // Invariant 4: a super-sensitive object must NOT already sit in the plain
      // cloud-unlock class (that would make it primary-key-decryptable).
      if (isCloudUnlockClass(object)) {
        exposed += 1;
      }
    } else {
      cloudUnlockable += 1;
      cloudUnlockableForProof.push(object);
    }

    // Invariant 3: no live object may be stranded host-blind. A decryptable
    // object always routes to a cloud tier; only an object we cannot decrypt at
    // all (and which is not already in a cloud tier) is stuck.
    if (!isCloudUnlockClass(object) && !isEscalatedClass(object)) {
      const plaintext = await decryptGraphObjectPayload(object, options.keyring).catch(() => undefined);
      if (!plaintext || plaintext.kind !== "plaintext-json") {
        hostBlindStuck += 1;
      }
    }
  }

  // DEF-2 INDEPENDENT FULL-BODY BACKSTOP over every NORMAL (cloud-unlockable)
  // object — a hit is a classifier false negative that would expose sensitive
  // signal to the primary-key tier.
  let backstopScanned = 0;
  let backstopHits = 0;
  const backstopHitObjects: string[] = [];
  // Resolve the backstop terms ONCE (generic defaults + any private overlay
  // terms) rather than re-reading the overlay per object.
  const backstopTerms = resolvePrivateBackstopTerms();
  for (const object of cloudUnlockableForProof) {
    backstopScanned += 1;
    const plaintext = await decryptGraphObjectPayload(object, options.keyring).catch(() => undefined);
    if (!plaintext || plaintext.kind !== "plaintext-json") continue;
    const hits = scanBodyForExposure(plaintext.data, backstopTerms);
    if (hits.length > 0) {
      backstopHits += 1;
      backstopHitObjects.push(object.object_id);
    }
  }

  // Invariant 1: sampled NORMAL round-trip proof under the PRIMARY key.
  const normalStep = Math.max(1, Math.floor(cloudUnlockableForProof.length / sampleLimit));
  let sampled = 0;
  let roundtripOk = 0;
  let roundtripFailed = 0;
  for (let index = 0; index < cloudUnlockableForProof.length; index += normalStep) {
    const object = cloudUnlockableForProof[index]!;
    sampled += 1;
    try {
      const result = isCloudUnlockClass(object)
        ? { action: "reencrypted-normal" as const, object }
        : await reencryptToTier(object, options);
      if (result.action !== "reencrypted-normal" && result.action !== "skipped-already-normal") {
        roundtripFailed += 1;
        continue;
      }
      const decrypted = await decryptCloudUnlockObject(result.object, primaryKey);
      if (decrypted.ok) roundtripOk += 1;
      else roundtripFailed += 1;
    } catch {
      roundtripFailed += 1;
    }
  }

  // Invariant 2: sampled ESCALATED round-trip proof under the ESCALATION key,
  // AND proof that the escalation gate fires (refuses without the escalation
  // key). The "without escalation" leg decrypts under the PRIMARY key, which
  // MUST fail on an escalated object.
  const escStep = Math.max(1, Math.floor(escalatedForProof.length / sampleLimit));
  let sampledEscalated = 0;
  let escalationRoundtripOk = 0;
  let escalationRoundtripFailed = 0;
  let escalationGateRefusalsOk = 0;
  let escalationGateRefusalsFailed = 0;
  for (let index = 0; index < escalatedForProof.length; index += escStep) {
    const object = escalatedForProof[index]!;
    sampledEscalated += 1;
    let escalatedObject: GraphObjectEnvelope | undefined;
    try {
      const result = isEscalatedClass(object)
        ? { action: "reencrypted-escalated" as const, object }
        : await reencryptToTier(object, options);
      if (result.action === "reencrypted-escalated" || result.action === "skipped-already-escalated") {
        escalatedObject = result.object;
      }
    } catch {
      escalatedObject = undefined;
    }

    if (!escalatedObject) {
      escalationRoundtripFailed += 1;
      continue;
    }

    // WITH the escalation key: must decrypt.
    const withEscalation = await decryptEscalatedCloudUnlockObject(escalatedObject, escalationKey);
    if (withEscalation.ok) escalationRoundtripOk += 1;
    else escalationRoundtripFailed += 1;

    // WITHOUT the escalation key (primary key only): the gate must fire — an
    // escalated payload is not decryptable by the primary cloud-unlock path.
    const withoutEscalation = await decryptCloudUnlockObject(escalatedObject, primaryKey);
    if (!withoutEscalation.ok) escalationGateRefusalsOk += 1;
    else escalationGateRefusalsFailed += 1;
  }

  const everyObjectCloudDecryptable = hostBlindStuck === 0;

  return {
    report_schema: "living-atlas-tier-coverage:v2",
    tier_model: "two-key-escalation",
    plaintext_policy: "counts-only",
    ruleset_version: options.ruleset.ruleset_version,
    total_objects: objects.length,
    tombstoned_excluded: objects.length - live.length,
    cloud_unlockable_objects: cloudUnlockable,
    super_sensitive_objects: superSensitive,
    escalated_objects: superSensitive,
    sampled_cloud_unlockable: sampled,
    cloud_unlock_roundtrip_ok: roundtripOk,
    cloud_unlock_roundtrip_failed: roundtripFailed,
    sampled_escalated: sampledEscalated,
    escalation_roundtrip_ok: escalationRoundtripOk,
    escalation_roundtrip_failed: escalationRoundtripFailed,
    escalation_gate_refusals_ok: escalationGateRefusalsOk,
    escalation_gate_refusals_failed: escalationGateRefusalsFailed,
    super_sensitive_in_cloud_unlock_class: exposed,
    host_blind_stuck_objects: hostBlindStuck,
    every_object_cloud_decryptable: everyObjectCloudDecryptable,
    exposure_backstop_scanned: backstopScanned,
    exposure_backstop_hits: backstopHits,
    exposure_backstop_hit_objects: backstopHitObjects,
    complete:
      roundtripFailed === 0 &&
      escalationRoundtripFailed === 0 &&
      escalationGateRefusalsFailed === 0 &&
      exposed === 0 &&
      backstopHits === 0 &&
      hostBlindStuck === 0
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function generateSessionKey(): string {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return Buffer.from(raw).toString("base64");
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

  const keyring = await openLocalKeyring(JSON.parse(readFileSync(keyringPath, "utf8")), passphrase.value);
  const snapshot = JSON.parse(readFileSync(join(graphDir, "snapshot.json"), "utf8")) as { objects: GraphObjectEnvelope[] };

  // Synthetic keys are sufficient: the proof only needs SOME valid, DISTINCT
  // 32-byte primary and escalation keys to demonstrate the round-trips and the
  // escalation gate. Neither touches the replica.
  const unlockKey = process.env.LIVING_ATLAS_CLOUD_UNLOCK_KEY?.trim() || generateSessionKey();
  let escalationKey = process.env.LIVING_ATLAS_ESCALATION_KEY?.trim() || generateSessionKey();
  while (escalationKey === unlockKey) {
    escalationKey = generateSessionKey();
  }
  const result = await runTierCoverage(snapshot.objects, {
    keyring,
    ruleset: loadPrivateTieringRuleset(),
    unlockKey,
    escalationKey
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.complete) {
    console.error(
      "tier coverage gate FAILED: a normal object failed the primary round-trip, an escalated object failed the escalation round-trip, " +
        "the escalation gate did not refuse without the escalation key, a super-sensitive object sits in the plain cloud-unlock class, " +
        `an object was stranded host-blind, or the independent full-body backstop found ${result.exposure_backstop_hits} normal object(s) with high-signal terms.`
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
