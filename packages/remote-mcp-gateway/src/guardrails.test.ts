import { describe, expect, it } from "vitest";
import { recordT2Decrypt, isRevoked, assertNotRevoked } from "./guardrails";

describe("recordT2Decrypt", () => {
  it("writes one audit row and fires the alert hook exactly once", async () => {
    const rows: unknown[] = [];
    const alerts: unknown[] = [];
    await recordT2Decrypt(
      {
        appendAudit: async (e) => {
          rows.push(e);
        },
        alert: async (a) => {
          alerts.push(a);
        }
      },
      {
        capability_id: "la_cap_owner0001",
        authority_id: "la_authority_worker0001",
        object_id: "la_object_ssn0001",
        at_iso: "2026-07-04T12:00:00.000Z"
      }
    );
    expect(rows).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    expect((rows[0] as { event_type: string }).event_type).toBe("object.decrypt");
    expect((alerts[0] as { object_id: string }).object_id).toBe("la_object_ssn0001");
  });
});

describe("kill-switch", () => {
  it("treats a capability listed in the revocation set as revoked", () => {
    const revoked = new Set(["la_cap_bad0001"]);
    expect(isRevoked(revoked, "la_cap_bad0001")).toBe(true);
    expect(isRevoked(revoked, "la_cap_owner0001")).toBe(false);
  });

  it("assertNotRevoked throws kill-switch-revoked for a revoked capability", () => {
    expect(() => assertNotRevoked(new Set(["c"]), "c")).toThrow(/kill-switch-revoked/);
  });
});
