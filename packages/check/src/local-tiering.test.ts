import { describe, expect, it } from "vitest";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft,
  decryptGraphObjectPayload
} from "@living-atlas/local-keyring";
import { DEFAULT_TIERING_RULESET } from "@living-atlas/policy";
import {
  decryptCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock";
import {
  decryptEscalatedCloudUnlockObject
} from "@living-atlas/cloudflare-worker/cloud-unlock-escalated";
import {
  classifyObjectTier,
  planTiering,
  reencryptToCloudUnlock,
  reencryptToTier,
  type TieringOptions
} from "./local-tiering";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import type { LocalKeyringState } from "@living-atlas/local-keyring";

const authorityId = "la_authority_tieringtest001";
const timestamp = "2026-07-04T00:00:00.000Z";

function sessionKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256))).toString("base64");
}

function escalationKeyMaterial(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 41) % 256))).toString("base64");
}

async function localObject(
  keyring: LocalKeyringState,
  objectId: string,
  data: Record<string, unknown>,
  accessClass: "local-private" | "quarantine" = "local-private"
): Promise<GraphObjectEnvelope> {
  const key = keyring.keys.find((k) => k.access_class === accessClass)!;
  return encryptPlaintextGraphObjectDraft(
    {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "block",
      version: 1,
      access_class: accessClass,
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

async function fixture(): Promise<{ keyring: LocalKeyringState; objects: GraphObjectEnvelope[]; options: TieringOptions }> {
  const keyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
  const objects = [
    await localObject(keyring, "la_object_public0001", { text: "notes about a public conference" }),
    await localObject(keyring, "la_object_public0002", { text: "roadmap planning for the quarter" }),
    await localObject(keyring, "la_object_immig0001", { text: "immigration visa timeline", endpoint: JSON.stringify({ name: "Globex Legal", aliases: [] }) }),
    await localObject(keyring, "la_object_health0001", { text: "medical diagnosis notes" })
  ];
  const options: TieringOptions = {
    keyring,
    ruleset: DEFAULT_TIERING_RULESET,
    unlockKey: sessionKey(),
    escalationKey: escalationKeyMaterial()
  };
  return { keyring, objects, options };
}

describe("classifyObjectTier", () => {
  it("classifies a decrypted local object using extracted content", async () => {
    const { keyring, objects, options } = await fixture();
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;
    const decision = await classifyObjectTier(immig, options);
    expect(decision.tier).toBe("super-sensitive");
    expect(decision.matched_rules).toContain("immigration-legal");
  });

  it("defaults undecryptable-content-free objects to cloud-unlockable", async () => {
    const { objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    const decision = await classifyObjectTier(pub, options);
    expect(decision.tier).toBe("cloud-unlockable");
  });
});

describe("planTiering (dry-run)", () => {
  it("counts tiers and lists every super-sensitive match with reasons — no plaintext leak", async () => {
    const { objects, options } = await fixture();
    const plan = await planTiering(objects, options);
    expect(plan.total_objects).toBe(4);
    expect(plan.cloud_unlockable).toBe(2);
    expect(plan.super_sensitive).toBe(2);
    expect(plan.super_sensitive_matches).toHaveLength(2);
    const ids = plan.super_sensitive_matches.map((m) => m.object_id).sort();
    expect(ids).toEqual(["la_object_health0001", "la_object_immig0001"]);
    // The report must carry WHY, but not decrypted plaintext bodies.
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain("medical diagnosis notes");
    expect(serialized).not.toContain("immigration visa timeline");
    // But entity names + matched terms are surfaced for eyeballing.
    const immigMatch = plan.super_sensitive_matches.find((m) => m.object_id === "la_object_immig0001")!;
    expect(immigMatch.matched_rules).toContain("immigration-legal");
    expect(immigMatch.entity_names).toContain("Globex Legal");
  });

  it("is dry-run by default: no re-encrypted objects are produced unless applied", async () => {
    const { objects, options } = await fixture();
    const plan = await planTiering(objects, options);
    expect("reencrypted_objects" in plan).toBe(false);
  });
});

describe("reencryptToCloudUnlock (apply)", () => {
  it("re-encrypts cloud-unlockable objects local-keyring-v1 -> cloud-unlock-v1, losslessly", async () => {
    const { keyring, objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    const original = await decryptGraphObjectPayload(pub, keyring);

    const result = await reencryptToCloudUnlock(pub, options);
    expect(result.action).toBe("reencrypted");
    if (result.action !== "reencrypted") throw new Error("expected reencrypt");
    const out = result.object;
    expect(out.payload.kind).toBe("ciphertext-inline");
    if (out.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(out.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    // Identity preserved (lossless).
    expect(out.object_id).toBe(pub.object_id);
    expect(out.version).toBe(pub.version);
    expect(out.access_class).toBe(pub.access_class);

    // Round-trips under the cloud-unlock session key back to the ORIGINAL plaintext.
    const roundtrip = await decryptCloudUnlockObject(out, options.unlockKey!);
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) throw new Error(roundtrip.reason);
    expect(roundtrip.plaintext).toEqual(original);
  });

  it("leaves super-sensitive objects UNTOUCHED (stays local-keyring-v1)", async () => {
    const { objects, options } = await fixture();
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;
    const result = await reencryptToCloudUnlock(immig, options);
    expect(result.action).toBe("skipped-super-sensitive");
    if (result.action !== "skipped-super-sensitive") throw new Error("expected skip");
    expect(result.object).toBe(immig); // exact same object, no re-encryption
  });

  it("is idempotent: an already cloud-unlock-v1 object is skipped", async () => {
    const { objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    const once = await reencryptToCloudUnlock(pub, options);
    if (once.action !== "reencrypted") throw new Error("expected reencrypt");
    const twice = await reencryptToCloudUnlock(once.object, options);
    expect(twice.action).toBe("skipped-already-cloud-unlock");
  });

  it("requires an unlock key to actually re-encrypt", async () => {
    const { objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    await expect(reencryptToCloudUnlock(pub, { ...options, unlockKey: undefined })).rejects.toThrow(/unlock session key/i);
  });
});

describe("reencryptToTier (two-key apply)", () => {
  it("routes NORMAL objects to cloud-unlock-v1 under the PRIMARY key, losslessly", async () => {
    const { keyring, objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    const original = await decryptGraphObjectPayload(pub, keyring);

    const result = await reencryptToTier(pub, options);
    expect(result.action).toBe("reencrypted-normal");
    expect(result.tier).toBe("normal");
    const out = result.object;
    if (out.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(out.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-v1");
    expect(out.object_id).toBe(pub.object_id);

    // Decrypts under the PRIMARY key back to the original plaintext.
    const roundtrip = await decryptCloudUnlockObject(out, options.unlockKey!);
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) throw new Error(roundtrip.reason);
    expect(roundtrip.plaintext).toEqual(original);

    // The ESCALATION key must NOT open a normal object.
    const wrongTier = await decryptCloudUnlockObject(out, options.escalationKey!);
    expect(wrongTier.ok).toBe(false);
  });

  it("routes SUPER-SENSITIVE objects to cloud-unlock-escalated-v1 under the ESCALATION key, losslessly", async () => {
    const { keyring, objects, options } = await fixture();
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;
    const original = await decryptGraphObjectPayload(immig, keyring);

    const result = await reencryptToTier(immig, options);
    expect(result.action).toBe("reencrypted-escalated");
    expect(result.tier).toBe("super-sensitive");
    const out = result.object;
    if (out.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(out.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");
    expect(out.object_id).toBe(immig.object_id);

    // Decrypts under the ESCALATION key back to the original plaintext.
    const roundtrip = await decryptEscalatedCloudUnlockObject(out, options.escalationKey!);
    expect(roundtrip.ok).toBe(true);
    if (!roundtrip.ok) throw new Error(roundtrip.reason);
    expect(roundtrip.plaintext).toEqual(original);

    // The PRIMARY key must NOT open an escalated object.
    const wrongTier = await decryptEscalatedCloudUnlockObject(out, options.unlockKey!);
    expect(wrongTier.ok).toBe(false);
  });

  it("nothing stays local-keyring-only: both a normal and a super-sensitive object leave local-keyring-v1", async () => {
    const { objects, options } = await fixture();
    for (const object of objects) {
      const result = await reencryptToTier(object, options);
      expect(result.action).toMatch(/^reencrypted-/);
      if (result.object.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
      expect(result.object.payload.algorithm).not.toBe("AES-GCM-256+local-keyring-v1");
    }
  });

  it("is idempotent: re-tiering an already-normal or already-escalated object is skipped", async () => {
    const { objects, options } = await fixture();
    const pub = objects.find((o) => o.object_id === "la_object_public0001")!;
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;

    const normalOnce = await reencryptToTier(pub, options);
    if (normalOnce.action !== "reencrypted-normal") throw new Error("expected normal");
    expect((await reencryptToTier(normalOnce.object, options)).action).toBe("skipped-already-normal");

    const escOnce = await reencryptToTier(immig, options);
    if (escOnce.action !== "reencrypted-escalated") throw new Error("expected escalated");
    expect((await reencryptToTier(escOnce.object, options)).action).toBe("skipped-already-escalated");
  });

  it("requires the escalation key to re-encrypt a super-sensitive object", async () => {
    const { objects, options } = await fixture();
    const immig = objects.find((o) => o.object_id === "la_object_immig0001")!;
    await expect(reencryptToTier(immig, { ...options, escalationKey: undefined })).rejects.toThrow(/escalation key required/i);
  });
});
