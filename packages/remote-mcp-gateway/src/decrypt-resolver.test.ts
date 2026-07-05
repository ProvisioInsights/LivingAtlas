import { describe, expect, it } from "vitest";
import { encryptCloudUnlockObject, encryptEscalatedCloudUnlockObject } from "@living-atlas/remote-crypto";
import { resolveDecrypt } from "./decrypt-resolver";

function key32(seed: number): string {
  let b = "";
  for (let i = 0; i < 32; i++) b += String.fromCharCode((i * 7 + seed) % 256);
  return btoa(b);
}
const t1Key = key32(1);
const escKey = key32(2);
const ts = "2026-07-04T12:00:00.000Z";
const identity = {
  schema_version: 1,
  authority_id: "la_authority_worker0001",
  object_id: "la_object_x",
  object_type: "page",
  version: 1,
  access_class: "cloud-shareable",
  encryption_class: "client-encrypted",
  created_at: ts,
  updated_at: ts,
  key_ref: "la_key_x",
  visible_metadata: { tombstone: false, size_class: "tiny", remote_indexable: true }
} as const;

describe("resolveDecrypt", () => {
  it("denies T1 plaintext under a remote-safe-only ceiling", async () => {
    const object = await encryptCloudUnlockObject({
      envelope: identity as never,
      plaintext: { a: 1 },
      encodedUnlockKey: t1Key
    });
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "remote-safe-only", rate_limit_per_minute: 10 },
      object,
      cloudUnlockKeyB64: t1Key,
      callOracle: async () => {
        throw new Error("must not call oracle");
      },
      signGrant: async () => {
        throw new Error("nope");
      },
      recordT2: async () => {},
      nowIso: ts
    });
    expect(result).toEqual({ ok: false, reason: "above-ceiling", tier: "T1" });
  });

  it("injects the CF T1 secret to decrypt a normal object under a T1 ceiling", async () => {
    const object = await encryptCloudUnlockObject({
      envelope: identity as never,
      plaintext: { a: 1 },
      encodedUnlockKey: t1Key
    });
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "T1", rate_limit_per_minute: 10 },
      object,
      cloudUnlockKeyB64: t1Key,
      callOracle: async () => {
        throw new Error("must not call oracle");
      },
      signGrant: async () => {
        throw new Error("nope");
      },
      recordT2: async () => {},
      nowIso: ts
    });
    expect(result).toEqual({ ok: true, tier: "T1", plaintext: { kind: "plaintext-json", data: { a: 1 } } });
  });

  it("brokers a T2 object to the oracle under a T2 ceiling and records the guardrail", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: identity as never,
      plaintext: { ssn: "x" },
      encodedEscalationKey: escKey
    });
    let recorded = 0;
    const result = await resolveDecrypt({
      policy: { capability_id: "c", tier_ceiling: "T2", rate_limit_per_minute: 10 },
      object,
      cloudUnlockKeyB64: t1Key,
      signGrant: async () => ({ payload: { object_id: object.object_id }, signature: "s" }) as never,
      callOracle: async () => ({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "x" } } }),
      recordT2: async () => {
        recorded += 1;
      },
      nowIso: ts
    });
    expect(result).toEqual({ ok: true, tier: "T2", plaintext: { kind: "plaintext-json", data: { ssn: "x" } } });
    expect(recorded).toBe(1);
  });
});
