import { describe, expect, it } from "vitest";
import { encryptEscalatedCloudUnlockObject } from "@living-atlas/remote-crypto";
import { signEscalationGrant } from "@living-atlas/remote-mcp-gateway/grant";
import { createLocalOracle, InMemoryNonceSeen } from "./oracle";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA==";
function key32(seed: number): string {
  let b = "";
  for (let i = 0; i < 32; i++) b += String.fromCharCode((i * 7 + seed) % 256);
  return btoa(b);
}
const escalationKey = key32(2);
const ts = "2026-07-04T12:00:00.000Z";

const envelopeIdentity = {
  schema_version: 1,
  authority_id: "la_authority_worker0001",
  object_id: "la_object_ssn0001",
  object_type: "page",
  version: 1,
  access_class: "super-sensitive",
  encryption_class: "client-encrypted",
  created_at: ts,
  updated_at: ts,
  key_ref: "la_key_esc0001",
  visible_metadata: { tombstone: false, size_class: "tiny", remote_indexable: false }
} as const;

describe("local oracle T2 decrypt", () => {
  it("decrypts a super-sensitive object under a valid grant", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: envelopeIdentity as never,
      plaintext: { ssn: "123-45-6789" },
      encodedEscalationKey: escalationKey
    });
    const now = Date.parse(ts);
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "la_cap_owner0001",
      authority_id: object.authority_id,
      object_id: object.object_id,
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "n-decrypt"
    });
    const oracle = createLocalOracle({
      signingKeyB64: signingKey,
      escalationKeyB64: escalationKey,
      seen: new InMemoryNonceSeen(),
      now: () => now + 1000
    });
    const result = await oracle.decrypt({ grant, object });
    expect(result).toEqual({ ok: true, plaintext: { kind: "plaintext-json", data: { ssn: "123-45-6789" } } });
  });

  it("refuses when the grant is for a different object (fails safe)", async () => {
    const object = await encryptEscalatedCloudUnlockObject({
      envelope: envelopeIdentity as never,
      plaintext: { ssn: "x" },
      encodedEscalationKey: escalationKey
    });
    const now = Date.parse(ts);
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c",
      authority_id: object.authority_id,
      object_id: "la_object_OTHER",
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "n-mismatch"
    });
    const oracle = createLocalOracle({
      signingKeyB64: signingKey,
      escalationKeyB64: escalationKey,
      seen: new InMemoryNonceSeen(),
      now: () => now + 1000
    });
    expect(await oracle.decrypt({ grant, object })).toEqual({ ok: false, reason: "grant-object-mismatch" });
  });
});
