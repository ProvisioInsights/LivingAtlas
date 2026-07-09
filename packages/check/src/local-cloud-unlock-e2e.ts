import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  CloudUnlockObjectAlgorithm,
  decryptCloudUnlockObject,
  encryptCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  decryptEscalatedCloudUnlockObject,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";

/**
 * Synthetic end-to-end proof for the TWO-KEY ESCALATION cloud-unlock flow.
 *
 * The locally-runnable half of the cloud-unlock e2e story. It creates, with the
 * real primitives, a NORMAL sample (primary key) and an ESCALATED sample
 * (escalation key), and proves the full escalation flow:
 *
 *   - NORMAL decrypts under the PRIMARY key.
 *   - NORMAL still decrypts if mutable envelope bookkeeping is rematerialized
 *     after sealing.
 *   - ESCALATED, offered ONLY the primary key, returns "escalation-required"
 *     (models the worker refusal — the primary path cannot open it).
 *   - ESCALATED decrypts under the ESCALATION key.
 *   - ESCALATED also survives mutable envelope rematerialization after sealing.
 *   - WRONG keys fail for both; a stable-identity AAD-tampered envelope is denied.
 *   - Leak-custody: neither key nor plaintext survives in the produced objects.
 *
 * The LIVE half — push these objects to Cloudflare and unlock them via the
 * remote MCP `sensitive_decrypt` tool (including the escalation header) — lives
 * in `cloudflare-live-cloud-unlock-proof.ts` and takes effect after a worker
 * redeploy. This harness mirrors that object shape so the live run is a drop-in.
 */
const authorityId = "la_authority_e2eproof0001";
const plaintextBait = "CLOUD_UNLOCK_E2E_PROOF_BAIT_DO_NOT_STORE";
const escalatedBait = "ESCALATED_E2E_PROOF_BAIT_DO_NOT_STORE";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

export type CloudUnlockE2eProof = {
  report_schema: "living-atlas-cloud-unlock-e2e:v2";
  tier_model: "two-key-escalation";
  algorithm: string;
  escalated_algorithm: string;
  nonce_bytes: number;
  samples: number;
  // NORMAL tier
  decrypted_ok: number;
  rematerialized_decrypted_ok: number;
  wrong_key_denied: number;
  aad_tamper_denied: number;
  // ESCALATED tier
  escalated_decrypted_ok: number;
  escalated_rematerialized_decrypted_ok: number;
  escalation_required_without_key: number;
  escalated_wrong_key_denied: number;
  escalated_aad_tamper_denied: number;
  // leak custody (both keys, both plaintexts)
  session_key_leaked: boolean;
  escalation_key_leaked: boolean;
  plaintext_leaked: boolean;
  complete: boolean;
};

function envelopeFor(objectId: string): Omit<GraphObjectEnvelope, "content_hash" | "payload"> {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: nowIso(),
    updated_at: nowIso(),
    key_ref: `la_key_${objectId}`,
    visible_metadata: { tombstone: false, remote_indexable: false, size_class: "tiny" }
  };
}

export async function runCloudUnlockE2eProof(options: { sampleCount?: number } = {}): Promise<CloudUnlockE2eProof> {
  const sampleCount = options.sampleCount ?? 5;
  const sessionKey = toBase64(randomBytes(32));
  let escalationKey = toBase64(randomBytes(32));
  while (escalationKey === sessionKey) escalationKey = toBase64(randomBytes(32));
  const wrongKey = toBase64(randomBytes(32));

  let decryptedOk = 0;
  let rematerializedDecryptedOk = 0;
  let wrongKeyDenied = 0;
  let aadTamperDenied = 0;
  let escalatedDecryptedOk = 0;
  let escalatedRematerializedDecryptedOk = 0;
  let escalationRequiredWithoutKey = 0;
  let escalatedWrongKeyDenied = 0;
  let escalatedAadTamperDenied = 0;
  let sessionKeyLeaked = false;
  let escalationKeyLeaked = false;
  let plaintextLeaked = false;
  let nonceBytes = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const suffix = String(index).padStart(8, "0");

    // NORMAL sample.
    const normal = await encryptCloudUnlockObject({
      envelope: envelopeFor(`la_object_e2enormal${suffix}`),
      plaintext: { title: "Synthetic cloud-unlock e2e", body: plaintextBait, sample: index },
      encodedUnlockKey: sessionKey
    });

    // ESCALATED sample (super-sensitive tier).
    const escalated = await encryptEscalatedCloudUnlockObject({
      envelope: envelopeFor(`la_object_e2eesc${suffix}`),
      plaintext: { title: "Synthetic escalated e2e", body: escalatedBait, sample: index },
      encodedEscalationKey: escalationKey
    });

    if (normal.payload.kind === "ciphertext-inline") {
      nonceBytes = Buffer.from(normal.payload.nonce, "base64").length;
    }

    // Leak-custody across BOTH objects: neither key nor plaintext bait appears.
    const serialized = JSON.stringify([normal, escalated]);
    if (serialized.includes(sessionKey)) sessionKeyLeaked = true;
    if (serialized.includes(escalationKey)) escalationKeyLeaked = true;
    if (serialized.includes(plaintextBait) || serialized.includes(escalatedBait)) plaintextLeaked = true;

    // NORMAL decrypts under the PRIMARY key.
    const normalDecrypted = await decryptCloudUnlockObject(normal, sessionKey);
    if (normalDecrypted.ok && JSON.stringify(normalDecrypted.plaintext).includes(plaintextBait)) {
      decryptedOk += 1;
    }
    const normalRematerialized: GraphObjectEnvelope = {
      ...normal,
      version: normal.version + 10,
      updated_at: nowIso(1000),
      key_ref: `la_key_e2erematerialized${suffix}`,
      visible_metadata: { tombstone: false, remote_indexable: false, size_class: "small" }
    };
    const normalRematerializedDecrypted = await decryptCloudUnlockObject(normalRematerialized, sessionKey);
    if (normalRematerializedDecrypted.ok && JSON.stringify(normalRematerializedDecrypted.plaintext).includes(plaintextBait)) {
      rematerializedDecryptedOk += 1;
    }
    const normalWrong = await decryptCloudUnlockObject(normal, wrongKey);
    if (!normalWrong.ok) wrongKeyDenied += 1;
    const normalTampered: GraphObjectEnvelope = { ...normal, object_id: `la_object_e2etampered${suffix}` };
    if (!(await decryptCloudUnlockObject(normalTampered, sessionKey)).ok) aadTamperDenied += 1;

    // ESCALATED offered ONLY the primary key → escalation-required (the primary
    // path cannot open an escalated object; the worker translates this into the
    // "escalation-required" response).
    const escViaPrimary = await decryptCloudUnlockObject(escalated, sessionKey);
    if (!escViaPrimary.ok && escViaPrimary.reason === "unsupported-algorithm") {
      escalationRequiredWithoutKey += 1;
    }

    // ESCALATED decrypts under the ESCALATION key.
    const escDecrypted = await decryptEscalatedCloudUnlockObject(escalated, escalationKey);
    if (escDecrypted.ok && JSON.stringify(escDecrypted.plaintext).includes(escalatedBait)) {
      escalatedDecryptedOk += 1;
    }
    const escRematerialized: GraphObjectEnvelope = {
      ...escalated,
      version: escalated.version + 10,
      updated_at: nowIso(2000),
      key_ref: `la_key_e2erematerializedesc${suffix}`,
      visible_metadata: { tombstone: false, remote_indexable: false, size_class: "small" }
    };
    const escRematerializedDecrypted = await decryptEscalatedCloudUnlockObject(escRematerialized, escalationKey);
    if (escRematerializedDecrypted.ok && JSON.stringify(escRematerializedDecrypted.plaintext).includes(escalatedBait)) {
      escalatedRematerializedDecryptedOk += 1;
    }
    // Wrong escalation key fails.
    const escWrong = await decryptEscalatedCloudUnlockObject(escalated, wrongKey);
    if (!escWrong.ok) escalatedWrongKeyDenied += 1;
    // Stable-identity AAD-tampered escalated envelope denied.
    const escTampered: GraphObjectEnvelope = { ...escalated, object_id: `la_object_e2etamperedesc${suffix}` };
    if (!(await decryptEscalatedCloudUnlockObject(escTampered, escalationKey)).ok) escalatedAadTamperDenied += 1;
  }

  return {
    report_schema: "living-atlas-cloud-unlock-e2e:v2",
    tier_model: "two-key-escalation",
    algorithm: CloudUnlockObjectAlgorithm,
    escalated_algorithm: CloudUnlockEscalatedObjectAlgorithm,
    nonce_bytes: nonceBytes,
    samples: sampleCount,
    decrypted_ok: decryptedOk,
    rematerialized_decrypted_ok: rematerializedDecryptedOk,
    wrong_key_denied: wrongKeyDenied,
    aad_tamper_denied: aadTamperDenied,
    escalated_decrypted_ok: escalatedDecryptedOk,
    escalated_rematerialized_decrypted_ok: escalatedRematerializedDecryptedOk,
    escalation_required_without_key: escalationRequiredWithoutKey,
    escalated_wrong_key_denied: escalatedWrongKeyDenied,
    escalated_aad_tamper_denied: escalatedAadTamperDenied,
    session_key_leaked: sessionKeyLeaked,
    escalation_key_leaked: escalationKeyLeaked,
    plaintext_leaked: plaintextLeaked,
    complete:
      decryptedOk === sampleCount &&
      rematerializedDecryptedOk === sampleCount &&
      wrongKeyDenied === sampleCount &&
      aadTamperDenied === sampleCount &&
      escalatedDecryptedOk === sampleCount &&
      escalatedRematerializedDecryptedOk === sampleCount &&
      escalationRequiredWithoutKey === sampleCount &&
      escalatedWrongKeyDenied === sampleCount &&
      escalatedAadTamperDenied === sampleCount &&
      !sessionKeyLeaked &&
      !escalationKeyLeaked &&
      !plaintextLeaked
  };
}

async function main(): Promise<void> {
  const proof = await runCloudUnlockE2eProof({ sampleCount: 5 });
  console.log(JSON.stringify(proof, null, 2));
  if (!proof.complete) {
    console.error("cloud-unlock e2e proof FAILED");
    process.exitCode = 1;
    return;
  }
  console.log("Living Atlas synthetic cloud-unlock e2e proof passed");
  console.log(
    "LIVE e2e (push to Cloudflare + remote MCP unlock) is available via cloudflare:live-cloud-unlock-proof once the remote-push fix lands."
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
