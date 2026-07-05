import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import { DEFAULT_TIERING_RULESET } from "@living-atlas/policy";

import { verifyRetierLossless } from "./local-retier-verify";

const authorityId = "la_authority_retierverify1";
const now = "2026-07-04T00:00:00.000Z";

function primaryKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256))).toString("base64");
}
function escalationKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 41) % 256))).toString("base64");
}

async function localObject(
  kr: LocalKeyringState,
  objectId: string,
  data: Record<string, unknown>
): Promise<GraphObjectEnvelope> {
  const key = kr.keys.find((k) => k.access_class === "local-private")!;
  return encryptPlaintextGraphObjectDraft(
    {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "block",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: now,
      updated_at: now,
      content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      key_ref: key.key_id,
      visible_metadata: { tombstone: false, remote_indexable: false },
      payload: { kind: "plaintext-json", data }
    },
    kr
  );
}

async function syntheticStore(): Promise<{ keyring: LocalKeyringState; objects: GraphObjectEnvelope[] }> {
  const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
  const objects = [
    await localObject(keyring, "la_object_verify_pub01", { text: "public quarterly roadmap" }),
    await localObject(keyring, "la_object_verify_pub02", { text: "notes from a public conference" }),
    await localObject(keyring, "la_object_verify_imm01", { text: "immigration visa timeline" }),
    await localObject(keyring, "la_object_verify_med01", { text: "medical diagnosis notes" })
  ];
  return { keyring, objects };
}

const verifyOptions = () => ({
  ruleset: DEFAULT_TIERING_RULESET,
  unlockKey: primaryKey(),
  escalationKey: escalationKey()
});

describe("verifyRetierLossless", () => {
  it("reports lossless_ok=true when every object round-trips byte-identically", async () => {
    const { keyring, objects } = await syntheticStore();
    const report = await verifyRetierLossless(objects, keyring, verifyOptions());

    expect(report.total).toBe(4);
    expect(report.normal).toBe(2);
    expect(report.escalated).toBe(2);
    expect(report.lossless_ok).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(report.any_decrypt_failure).toBe(false);
  });

  it("flags a deliberately corrupted object in mismatches (proves it catches loss)", async () => {
    const { keyring, objects } = await syntheticStore();
    // Corrupt one object's ciphertext so the ORIGINAL cannot be decrypted:
    // the verifier must NOT silently pass it as lossless.
    const corrupted = objects.map((object) => {
      if (object.object_id !== "la_object_verify_pub02") return object;
      if (object.payload.kind !== "ciphertext-inline") throw new Error("bad fixture");
      const bytes = Buffer.from(object.payload.ciphertext, "base64");
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return {
        ...object,
        payload: { ...object.payload, ciphertext: bytes.toString("base64") }
      } as GraphObjectEnvelope;
    });

    const report = await verifyRetierLossless(corrupted, keyring, verifyOptions());

    expect(report.lossless_ok).toBe(false);
    expect(report.mismatches).toContain("la_object_verify_pub02");
    expect(report.any_decrypt_failure).toBe(true);
  });

  it("is READ-ONLY: it does not mutate the input objects", async () => {
    const { keyring, objects } = await syntheticStore();
    const snapshot = JSON.stringify(objects);
    await verifyRetierLossless(objects, keyring, verifyOptions());
    expect(JSON.stringify(objects)).toBe(snapshot);
  });

  it("catches a re-tier that silently changes the plaintext (byte-level guarantee)", async () => {
    const { keyring, objects } = await syntheticStore();
    // Inject a re-tier that flips one byte of the recovered plaintext for one id.
    const report = await verifyRetierLossless(objects, keyring, {
      ...verifyOptions(),
      __corruptPlaintextForObjectId: "la_object_verify_pub01"
    });
    expect(report.lossless_ok).toBe(false);
    expect(report.mismatches).toContain("la_object_verify_pub01");
  });
});
