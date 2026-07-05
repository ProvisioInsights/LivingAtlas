import { describe, expect, it } from "vitest";
import { signEscalationGrant } from "./grant";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA=="; // 32 bytes b64

describe("signEscalationGrant", () => {
  it("produces a grant with subject, object, ≤900s expiry, nonce, and a base64url signature", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "la_cap_owner0001",
      authority_id: "la_authority_worker0001",
      object_id: "la_object_ssn0001",
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "nonce-abc"
    });
    expect(grant.payload.object_id).toBe("la_object_ssn0001");
    expect(grant.payload.expires_at_ms).toBe(now + 900_000);
    expect(grant.signature).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("refuses to sign a grant with a TTL over 900 seconds", async () => {
    await expect(
      signEscalationGrant(signingKey, {
        capability_id: "c",
        authority_id: "a",
        object_id: "o",
        issued_at_ms: 0,
        ttl_seconds: 901,
        nonce: "n"
      })
    ).rejects.toThrow(/ttl/i);
  });
});
