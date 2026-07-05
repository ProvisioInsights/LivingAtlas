import { Buffer } from "node:buffer";
import {
  IsoTimestampSchema,
  KeyIdSchema
} from "@living-atlas/contracts";
import {
  LocalKeyringStateSchema,
  type LocalKeyRecord,
  type LocalKeyringState
} from "./local-keyring";

/**
 * TWO-KEY ESCALATION key material — generation, sealing, and local carriage.
 *
 * The two-key model needs two distinct 32-byte secrets:
 *
 *   - PRIMARY cloud-unlock key: decrypts the NORMAL tier
 *     ("AES-GCM-256+cloud-unlock-v1") in a cloud-unlock session. (In the worker
 *     this is a per-request session key; the STABLE key material that objects
 *     are sealed under during re-tiering is carried here.)
 *
 *   - ESCALATION key: decrypts the SUPER-SENSITIVE tier
 *     ("AES-GCM-256+cloud-unlock-escalated-v1"), only after an escalation.
 *
 * KEY STORAGE (proposal, provisioned in a later coordinated phase — NOT here):
 *   - Escalation key  → macOS Keychain generic password service
 *     "io.livingatlas.personal-prod.escalation-key".
 *   - Primary key     → "io.livingatlas.personal-prod.cloud-unlock-key".
 *   Both resolve at use via resolveLocalSecret (env override or keychain),
 *   exactly like the keyring/control-store/mcp-token secrets. NEVER printed.
 *
 * LOCAL CARRIAGE: the local keyring holds BOTH keys (as data-encryption key
 * records). Because a local holder has both, local decrypt of EVERYTHING —
 * normal and super-sensitive — needs no escalation friction. The escalation
 * gate exists only for CLOUD (remote) unlock sessions.
 *
 * This module proves the generation + seal + carriage mechanism on
 * synthetic/temp keyrings; it does NOT touch the real replica keyring.
 */

export const ESCALATION_KEY_KEYCHAIN_SERVICE = "io.livingatlas.personal-prod.escalation-key";
export const PRIMARY_CLOUD_UNLOCK_KEY_KEYCHAIN_SERVICE = "io.livingatlas.personal-prod.cloud-unlock-key";

/** Stable key_ids so re-adding the tiering keys is idempotent (no duplication). */
export const PRIMARY_CLOUD_UNLOCK_KEY_ID = KeyIdSchema.parse("la_key_tiering_primary");
export const ESCALATION_KEY_ID = KeyIdSchema.parse("la_key_tiering_escalation");

export type TieringKeyMaterial = {
  primary_cloud_unlock_key_base64: string;
  escalation_key_base64: string;
};

function randomKeyBase64(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * Generate fresh, DISTINCT 32-byte primary and escalation keys. Uses WebCrypto
 * CSPRNG. The two are independent draws — they are never equal in practice and
 * the caller asserts inequality.
 */
export function generateTieringKeyMaterial(): TieringKeyMaterial {
  let primary = randomKeyBase64();
  let escalation = randomKeyBase64();
  // Astronomically unlikely, but keep them provably distinct.
  while (escalation === primary) {
    escalation = randomKeyBase64();
  }
  return {
    primary_cloud_unlock_key_base64: primary,
    escalation_key_base64: escalation
  };
}

function tieringKeyRecord(
  keyId: string,
  authorityId: string,
  materialBase64: string,
  createdAt: string
): LocalKeyRecord {
  return {
    key_id: KeyIdSchema.parse(keyId),
    authority_id: authorityId as LocalKeyRecord["authority_id"],
    // Tiering keys are DATA-encryption keys (not per-access-class keys); they
    // carry no access_class so they are addressable by key_id only.
    purpose: "data-encryption",
    algorithm: "AES-GCM-256",
    material_base64: materialBase64,
    created_at: IsoTimestampSchema.parse(createdAt),
    cloud_unwrapped: false
  };
}

/**
 * Add (or replace) BOTH tiering keys in the keyring under stable key_ids.
 * Idempotent: re-adding replaces the same two records rather than appending
 * duplicates. Preserves all existing access-class key material untouched.
 */
export function addTieringKeysToKeyring(
  keyring: LocalKeyringState,
  material: TieringKeyMaterial,
  options: { createdAt?: string } = {}
): LocalKeyringState {
  const createdAt = IsoTimestampSchema.parse(options.createdAt ?? new Date().toISOString());
  const withoutTiering = keyring.keys.filter(
    (key) => key.key_id !== PRIMARY_CLOUD_UNLOCK_KEY_ID && key.key_id !== ESCALATION_KEY_ID
  );
  return LocalKeyringStateSchema.parse({
    ...keyring,
    updated_at: createdAt,
    keys: [
      ...withoutTiering,
      tieringKeyRecord(PRIMARY_CLOUD_UNLOCK_KEY_ID, keyring.authority_id, material.primary_cloud_unlock_key_base64, createdAt),
      tieringKeyRecord(ESCALATION_KEY_ID, keyring.authority_id, material.escalation_key_base64, createdAt)
    ]
  });
}

function tieringKeyMaterial(keyring: LocalKeyringState, keyId: string): string | undefined {
  return keyring.keys.find((key) => key.key_id === keyId && !key.revoked_at)?.material_base64;
}

/** The primary cloud-unlock key material carried in the keyring, if present. */
export function primaryCloudUnlockKeyBase64(keyring: LocalKeyringState): string | undefined {
  return tieringKeyMaterial(keyring, PRIMARY_CLOUD_UNLOCK_KEY_ID);
}

/** The escalation key material carried in the keyring, if present. */
export function escalationKeyBase64(keyring: LocalKeyringState): string | undefined {
  return tieringKeyMaterial(keyring, ESCALATION_KEY_ID);
}
