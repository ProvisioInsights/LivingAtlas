import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  encryptCloudUnlockObject,
  encryptEscalatedCloudUnlockObject
} from "@living-atlas/remote-crypto";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  encryptPlaintextGraphObjectDraft
} from "./local-keyring";
import {
  addTieringKeysToKeyring,
  generateTieringKeyMaterial,
  primaryCloudUnlockKeyBase64,
  escalationKeyBase64,
  PRIMARY_CLOUD_UNLOCK_KEY_ID,
  ESCALATION_KEY_ID,
  type TieringKeyMaterial
} from "./escalation-key";
import type { LocalKeyringState } from "./local-keyring";

const authorityId = "la_authority_tierdecrypt001";
const timestamp = "2026-07-04T00:00:00.000Z";

function fixedTieringMaterial(): TieringKeyMaterial {
  return {
    primary_cloud_unlock_key_base64: Buffer.from(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256))
    ).toString("base64"),
    escalation_key_base64: Buffer.from(
      new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 41) % 256))
    ).toString("base64")
  };
}

function identity(objectId: string): Omit<GraphObjectEnvelope, "content_hash" | "payload"> {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "block",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: timestamp,
    updated_at: timestamp,
    key_ref: undefined,
    visible_metadata: { tombstone: false, remote_indexable: false }
  } as Omit<GraphObjectEnvelope, "content_hash" | "payload">;
}

async function localObject(
  keyring: LocalKeyringState,
  objectId: string,
  data: Record<string, unknown>
): Promise<GraphObjectEnvelope> {
  const key = keyring.keys.find((k) => k.access_class === "local-private")!;
  return encryptPlaintextGraphObjectDraft(
    {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "block",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      key_ref: key.key_id,
      visible_metadata: { tombstone: false, remote_indexable: false },
      payload: { kind: "plaintext-json", data }
    },
    keyring
  );
}

function keyringWithTiering(): { keyring: LocalKeyringState; material: TieringKeyMaterial } {
  const base = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
  const material = fixedTieringMaterial();
  const keyring = addTieringKeysToKeyring(base, material, { createdAt: timestamp });
  return { keyring, material };
}

describe("decryptGraphObjectPayload — tier-aware", () => {
  it("still decrypts a local-keyring-v1 object", async () => {
    const { keyring } = keyringWithTiering();
    const data = { text: "local only note" };
    const object = await localObject(keyring, "la_object_localv1_0001", data);
    if (object.payload.kind !== "ciphertext-inline") throw new Error("bad fixture");
    expect(object.payload.algorithm).toBe("AES-GCM-256+local-keyring-v1");

    const plaintext = await decryptGraphObjectPayload(object, keyring);
    expect(plaintext).toEqual({ kind: "plaintext-json", data });
  });

  it("decrypts a cloud-unlock-v1 object using the primary tiering key in the keyring", async () => {
    const { keyring } = keyringWithTiering();
    const data = { text: "normal tier note" };
    const sealed = await encryptCloudUnlockObject({
      envelope: identity("la_object_cloudv1_0001"),
      plaintext: data,
      encodedUnlockKey: primaryCloudUnlockKeyBase64(keyring)!
    });
    if (sealed.payload.kind !== "ciphertext-inline") throw new Error("bad fixture");
    expect(sealed.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-v1");

    const plaintext = await decryptGraphObjectPayload(sealed, keyring);
    expect(plaintext).toEqual({ kind: "plaintext-json", data });
  });

  it("decrypts a cloud-unlock-escalated-v1 object using the escalation tiering key in the keyring", async () => {
    const { keyring } = keyringWithTiering();
    const data = { text: "super sensitive note" };
    const sealed = await encryptEscalatedCloudUnlockObject({
      envelope: identity("la_object_escv1_0001"),
      plaintext: data,
      encodedEscalationKey: escalationKeyBase64(keyring)!
    });
    if (sealed.payload.kind !== "ciphertext-inline") throw new Error("bad fixture");
    expect(sealed.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");

    const plaintext = await decryptGraphObjectPayload(sealed, keyring);
    expect(plaintext).toEqual({ kind: "plaintext-json", data });
  });

  it("decrypts all three tier classes back to their original plaintext", async () => {
    const { keyring } = keyringWithTiering();
    const localData = { text: "one" };
    const normalData = { text: "two" };
    const escData = { text: "three" };

    const localObj = await localObject(keyring, "la_object_all_local01", localData);
    const normalObj = await encryptCloudUnlockObject({
      envelope: identity("la_object_all_normal1"),
      plaintext: normalData,
      encodedUnlockKey: primaryCloudUnlockKeyBase64(keyring)!
    });
    const escObj = await encryptEscalatedCloudUnlockObject({
      envelope: identity("la_object_all_esc0001"),
      plaintext: escData,
      encodedEscalationKey: escalationKeyBase64(keyring)!
    });

    expect(await decryptGraphObjectPayload(localObj, keyring)).toEqual({ kind: "plaintext-json", data: localData });
    expect(await decryptGraphObjectPayload(normalObj, keyring)).toEqual({ kind: "plaintext-json", data: normalData });
    expect(await decryptGraphObjectPayload(escObj, keyring)).toEqual({ kind: "plaintext-json", data: escData });
  });

  it("returns undefined (no throw) when the required tiering key is missing from the keyring", async () => {
    const { keyring: fullKeyring } = keyringWithTiering();
    const normalData = { text: "normal" };
    const escData = { text: "escalated" };
    const normalObj = await encryptCloudUnlockObject({
      envelope: identity("la_object_miss_normal"),
      plaintext: normalData,
      encodedUnlockKey: primaryCloudUnlockKeyBase64(fullKeyring)!
    });
    const escObj = await encryptEscalatedCloudUnlockObject({
      envelope: identity("la_object_miss_esc01"),
      plaintext: escData,
      encodedEscalationKey: escalationKeyBase64(fullKeyring)!
    });

    // A keyring WITHOUT the tiering keys (only the default access-class keys).
    const bareKeyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
    expect(primaryCloudUnlockKeyBase64(bareKeyring)).toBeUndefined();
    expect(escalationKeyBase64(bareKeyring)).toBeUndefined();

    await expect(decryptGraphObjectPayload(normalObj, bareKeyring)).resolves.toBeUndefined();
    await expect(decryptGraphObjectPayload(escObj, bareKeyring)).resolves.toBeUndefined();
  });

  it("references the stable tiering key_ids it relies on", () => {
    const { keyring } = keyringWithTiering();
    expect(keyring.keys.some((k) => k.key_id === PRIMARY_CLOUD_UNLOCK_KEY_ID)).toBe(true);
    expect(keyring.keys.some((k) => k.key_id === ESCALATION_KEY_ID)).toBe(true);
  });
});
