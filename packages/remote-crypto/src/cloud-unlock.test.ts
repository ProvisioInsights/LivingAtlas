import { describe, expect, it } from "vitest";
import {
  CloudUnlockObjectAlgorithm,
  decryptCloudUnlockObject,
  encryptCloudUnlockObject
} from "./cloud-unlock";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";

const timestamp = "2026-07-04T00:00:00.000Z";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function sessionKey(seed: number): string {
  return toBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => (index + seed) % 256)));
}

function baseEnvelope(
  overrides: Partial<Omit<GraphObjectEnvelope, "payload">> = {}
): Omit<GraphObjectEnvelope, "content_hash" | "payload"> {
  return {
    schema_version: 1,
    authority_id: "la_authority_worker0001",
    object_id: "la_object_cloudunlock0001",
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: timestamp,
    updated_at: timestamp,
    key_ref: "la_key_cloudunlock0001",
    visible_metadata: {
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    ...overrides
  };
}

describe("encryptCloudUnlockObject", () => {
  it("round-trips: encrypt then decrypt returns the original plaintext under the same session key", async () => {
    const key = sessionKey(1);
    const plaintext = {
      title: "Synthetic sensitive note",
      body: "Cloud unlock plaintext only appears after the transient key is supplied."
    };

    const object = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext,
      encodedUnlockKey: key
    });

    expect(object.payload.kind).toBe("ciphertext-inline");
    if (object.payload.kind !== "ciphertext-inline") throw new Error("expected ciphertext-inline");
    expect(object.payload.algorithm).toBe(CloudUnlockObjectAlgorithm);
    expect(CloudUnlockObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    // 12-byte nonce
    expect(atob(object.payload.nonce).length).toBe(12);
    // content_hash binds the ciphertext, not the plaintext
    expect(object.content_hash.startsWith("sha256:")).toBe(true);

    const decrypted = await decryptCloudUnlockObject(object, key);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) throw new Error(decrypted.reason);
    expect(decrypted.plaintext).toEqual({ kind: "plaintext-json", data: plaintext });
  });

  it("fails to decrypt under a wrong session key", async () => {
    const object = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "value" },
      encodedUnlockKey: sessionKey(1)
    });

    const result = await decryptCloudUnlockObject(object, sessionKey(99));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("wrong key must not decrypt");
    expect(result.reason).toBe("decrypt-failed");
  });

  it("binds the AAD to envelope identity: tampering with the envelope breaks decrypt", async () => {
    const key = sessionKey(7);
    const object = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "value" },
      encodedUnlockKey: key
    });

    // Same ciphertext, but a different object_id in the AAD must fail authentication.
    const tampered: GraphObjectEnvelope = { ...object, object_id: "la_object_cloudunlock9999" };
    const result = await decryptCloudUnlockObject(tampered, key);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("AAD tampering must not decrypt");
    expect(result.reason).toBe("decrypt-failed");
  });

  it("rejects malformed / wrong-length session keys without touching crypto", async () => {
    await expect(
      encryptCloudUnlockObject({
        envelope: baseEnvelope(),
        plaintext: { secret: "value" },
        encodedUnlockKey: "%%%not-base64-key%%%"
      })
    ).rejects.toThrow(/invalid.*unlock key/i);

    await expect(
      encryptCloudUnlockObject({
        envelope: baseEnvelope(),
        plaintext: { secret: "value" },
        encodedUnlockKey: toBase64(new Uint8Array(16)) // 16 bytes, not 32
      })
    ).rejects.toThrow(/invalid.*unlock key/i);
  });

  it("leak-custody invariant: the session key never appears in the produced object", async () => {
    const key = sessionKey(1);
    const secretMarker = "SUPER-SECRET-PLAINTEXT-MARKER-9f3a";
    const object = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { title: "note", body: secretMarker },
      encodedUnlockKey: key
    });

    const serialized = JSON.stringify(object);
    expect(serialized.includes(key)).toBe(false);
    // Also not in any base64/url-safe/hex form.
    const urlSafe = key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(serialized.includes(urlSafe)).toBe(false);
    const rawHex = [...atob(key)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(serialized.toLowerCase().includes(rawHex)).toBe(false);
    // And the plaintext must not be present in cleartext either.
    expect(serialized.includes(secretMarker)).toBe(false);
  });

  it("produces a distinct nonce and ciphertext per call (no nonce reuse)", async () => {
    const key = sessionKey(3);
    const a = await encryptCloudUnlockObject({ envelope: baseEnvelope(), plaintext: { x: 1 }, encodedUnlockKey: key });
    const b = await encryptCloudUnlockObject({ envelope: baseEnvelope(), plaintext: { x: 1 }, encodedUnlockKey: key });
    if (a.payload.kind !== "ciphertext-inline" || b.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.ciphertext).not.toBe(b.payload.ciphertext);
    // Both still decrypt.
    const da = await decryptCloudUnlockObject(a, key);
    const db = await decryptCloudUnlockObject(b, key);
    expect(da.ok && db.ok).toBe(true);
  });
});
