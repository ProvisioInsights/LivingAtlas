import { describe, expect, it } from "vitest";
import {
  CloudUnlockEscalatedObjectAlgorithm,
  decryptEscalatedCloudUnlockObject,
  encryptEscalatedCloudUnlockObject
} from "./cloud-unlock-escalated";
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

/** Distinct key material per seed so the escalation key and primary key differ. */
function keyMaterial(seed: number): string {
  return toBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => (index * 7 + seed) % 256)));
}

function baseEnvelope(
  overrides: Partial<Omit<GraphObjectEnvelope, "payload">> = {}
): Omit<GraphObjectEnvelope, "content_hash" | "payload"> {
  return {
    schema_version: 1,
    authority_id: "la_authority_worker0001",
    object_id: "la_object_escalated0001",
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: timestamp,
    updated_at: timestamp,
    key_ref: "la_key_escalated0001",
    visible_metadata: {
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    ...overrides
  };
}

describe("encryptEscalatedCloudUnlockObject", () => {
  it("uses a distinct escalated algorithm class", () => {
    expect(CloudUnlockEscalatedObjectAlgorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");
    expect(CloudUnlockEscalatedObjectAlgorithm).not.toBe(CloudUnlockObjectAlgorithm);
  });

  it("round-trips: encrypt then decrypt returns the original plaintext under the escalation key", async () => {
    const escalationKey = keyMaterial(2);
    const plaintext = {
      title: "SSN and immigration case",
      body: "Super-sensitive plaintext only appears after escalation with the SECOND key."
    };

    const object = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext,
      encodedEscalationKey: escalationKey
    });

    expect(object.payload.kind).toBe("ciphertext-inline");
    if (object.payload.kind !== "ciphertext-inline") throw new Error("expected ciphertext-inline");
    expect(object.payload.algorithm).toBe(CloudUnlockEscalatedObjectAlgorithm);
    // 12-byte nonce
    expect(atob(object.payload.nonce).length).toBe(12);
    expect(object.content_hash.startsWith("sha256:")).toBe(true);

    const decrypted = await decryptEscalatedCloudUnlockObject(object, escalationKey);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) throw new Error(decrypted.reason);
    expect(decrypted.plaintext).toEqual({ kind: "plaintext-json", data: plaintext });
  });

  it("fails to decrypt under a wrong escalation key", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "value" },
      encodedEscalationKey: keyMaterial(2)
    });

    const result = await decryptEscalatedCloudUnlockObject(object, keyMaterial(99));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("wrong escalation key must not decrypt");
    expect(result.reason).toBe("decrypt-failed");
  });

  it("binds the AAD to envelope identity: tampering with the envelope breaks decrypt", async () => {
    const escalationKey = keyMaterial(7);
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "value" },
      encodedEscalationKey: escalationKey
    });

    const tampered: GraphObjectEnvelope = { ...object, object_id: "la_object_escalated9999" };
    const result = await decryptEscalatedCloudUnlockObject(tampered, escalationKey);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("AAD tampering must not decrypt");
    expect(result.reason).toBe("decrypt-failed");
  });

  it("rejects malformed / wrong-length escalation keys without touching crypto", async () => {
    await expect(
      encryptEscalatedCloudUnlockObject({
        envelope: baseEnvelope(),
        plaintext: { secret: "value" },
        encodedEscalationKey: "%%%not-base64-key%%%"
      })
    ).rejects.toThrow(/invalid.*escalation key/i);

    await expect(
      encryptEscalatedCloudUnlockObject({
        envelope: baseEnvelope(),
        plaintext: { secret: "value" },
        encodedEscalationKey: toBase64(new Uint8Array(16)) // 16 bytes, not 32
      })
    ).rejects.toThrow(/invalid.*escalation key/i);
  });

  it("leak-custody invariant: the escalation key never appears in the produced object", async () => {
    const escalationKey = keyMaterial(2);
    const secretMarker = "SUPER-SECRET-ESCALATED-MARKER-7c21";
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { title: "note", body: secretMarker },
      encodedEscalationKey: escalationKey
    });

    const serialized = JSON.stringify(object);
    expect(serialized.includes(escalationKey)).toBe(false);
    const urlSafe = escalationKey.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(serialized.includes(urlSafe)).toBe(false);
    const rawHex = [...atob(escalationKey)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    expect(serialized.toLowerCase().includes(rawHex)).toBe(false);
    expect(serialized.includes(secretMarker)).toBe(false);
  });

  it("produces a distinct nonce and ciphertext per call (no nonce reuse)", async () => {
    const escalationKey = keyMaterial(3);
    const a = await encryptEscalatedCloudUnlockObject({ envelope: baseEnvelope(), plaintext: { x: 1 }, encodedEscalationKey: escalationKey });
    const b = await encryptEscalatedCloudUnlockObject({ envelope: baseEnvelope(), plaintext: { x: 1 }, encodedEscalationKey: escalationKey });
    if (a.payload.kind !== "ciphertext-inline" || b.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.ciphertext).not.toBe(b.payload.ciphertext);
    const da = await decryptEscalatedCloudUnlockObject(a, escalationKey);
    const db = await decryptEscalatedCloudUnlockObject(b, escalationKey);
    expect(da.ok && db.ok).toBe(true);
  });
});

describe("cloud-unlock tier isolation (primary vs escalated)", () => {
  it("rejects an escalated object presented with the wrong algorithm to the primary decrypt path", async () => {
    // Same key value for both to prove isolation is by ALGORITHM CLASS + AAD, not
    // merely by key difference: the primary path must refuse an escalated payload.
    const sharedKey = keyMaterial(5);
    const escalated = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "escalated-body" },
      encodedEscalationKey: sharedKey
    });

    const viaPrimary = await decryptCloudUnlockObject(escalated, sharedKey);
    expect(viaPrimary.ok).toBe(false);
    if (viaPrimary.ok) throw new Error("primary path must refuse escalated payload");
    expect(viaPrimary.reason).toBe("unsupported-algorithm");
  });

  it("rejects a primary cloud-unlock object presented to the escalated decrypt path", async () => {
    const sharedKey = keyMaterial(5);
    const primary = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "primary-body" },
      encodedUnlockKey: sharedKey
    });

    const viaEscalated = await decryptEscalatedCloudUnlockObject(primary, sharedKey);
    expect(viaEscalated.ok).toBe(false);
    if (viaEscalated.ok) throw new Error("escalated path must refuse primary payload");
    expect(viaEscalated.reason).toBe("unsupported-algorithm");
  });

  it("the PRIMARY session key does NOT decrypt an escalated object encrypted under the escalation key", async () => {
    const primaryKey = keyMaterial(1);
    const escalationKey = keyMaterial(2);
    expect(primaryKey).not.toBe(escalationKey);

    const escalated = await encryptEscalatedCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "ssn" },
      encodedEscalationKey: escalationKey
    });

    // Even if a caller forced the escalated algorithm through, the primary key
    // material must not open an escalated object.
    const withPrimaryKey = await decryptEscalatedCloudUnlockObject(escalated, primaryKey);
    expect(withPrimaryKey.ok).toBe(false);
    if (withPrimaryKey.ok) throw new Error("primary key must not open escalated object");
    expect(withPrimaryKey.reason).toBe("decrypt-failed");
  });

  it("the ESCALATION key does NOT decrypt a normal (primary) object encrypted under the primary key", async () => {
    const primaryKey = keyMaterial(1);
    const escalationKey = keyMaterial(2);

    const normal = await encryptCloudUnlockObject({
      envelope: baseEnvelope(),
      plaintext: { secret: "roadmap" },
      encodedUnlockKey: primaryKey
    });

    const withEscalationKey = await decryptCloudUnlockObject(normal, escalationKey);
    expect(withEscalationKey.ok).toBe(false);
    if (withEscalationKey.ok) throw new Error("escalation key must not open normal object");
    expect(withEscalationKey.reason).toBe("decrypt-failed");
  });
});
