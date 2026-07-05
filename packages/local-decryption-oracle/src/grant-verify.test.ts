import { describe, expect, it } from "vitest";
import { signEscalationGrant } from "@living-atlas/remote-mcp-gateway/grant";
import { verifyEscalationGrant, InMemoryNonceSeen } from "./grant-verify";

const signingKey = "c2lnbmluZy1rZXktMzItYnl0ZXMtZm9yLWhtYWMtdGVzdA==";

describe("verifyEscalationGrant", () => {
  it("accepts a fresh, correctly-signed grant once and rejects the replay", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c",
      authority_id: "a",
      object_id: "o",
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "n1"
    });
    const seen = new InMemoryNonceSeen();
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 1000, seen })).toEqual({ ok: true });
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 2000, seen })).toEqual({
      ok: false,
      reason: "replayed"
    });
  });

  it("rejects an expired grant and a tampered signature", async () => {
    const now = Date.parse("2026-07-04T12:00:00.000Z");
    const grant = await signEscalationGrant(signingKey, {
      capability_id: "c",
      authority_id: "a",
      object_id: "o",
      issued_at_ms: now,
      ttl_seconds: 900,
      nonce: "n2"
    });
    const seen = new InMemoryNonceSeen();
    expect(await verifyEscalationGrant(signingKey, grant, { now_ms: now + 901_000, seen })).toEqual({
      ok: false,
      reason: "expired"
    });
    const tampered = { ...grant, payload: { ...grant.payload, object_id: "o-evil" } };
    expect(
      await verifyEscalationGrant(signingKey, tampered, { now_ms: now + 1000, seen: new InMemoryNonceSeen() })
    ).toEqual({ ok: false, reason: "bad-signature" });
  });
});
