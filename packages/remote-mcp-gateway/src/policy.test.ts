import { describe, expect, it } from "vitest";
import { decideTierAccess, loadCapabilityPolicy, type CapabilityPolicy } from "./policy";

const safeOnly: CapabilityPolicy = {
  capability_id: "la_cap_remote0001",
  tier_ceiling: "remote-safe-only",
  rate_limit_per_minute: 60
};

describe("decideTierAccess", () => {
  it("remote-safe-only denies T1 and T2 plaintext, allows ciphertext", () => {
    expect(decideTierAccess(safeOnly, "safe")).toEqual({ allowed: true, reason: "within-ceiling" });
    expect(decideTierAccess(safeOnly, "T1")).toEqual({ allowed: false, reason: "above-ceiling" });
    expect(decideTierAccess(safeOnly, "T2")).toEqual({ allowed: false, reason: "above-ceiling" });
  });

  const t1Ceiling: CapabilityPolicy = { capability_id: "c", tier_ceiling: "T1", rate_limit_per_minute: 10 };
  const t2Ceiling: CapabilityPolicy = { capability_id: "c", tier_ceiling: "T2", rate_limit_per_minute: 10 };

  it("T1 ceiling allows safe+T1, denies T2", () => {
    expect(decideTierAccess(t1Ceiling, "safe").allowed).toBe(true);
    expect(decideTierAccess(t1Ceiling, "T1").allowed).toBe(true);
    expect(decideTierAccess(t1Ceiling, "T2")).toEqual({ allowed: false, reason: "above-ceiling" });
  });

  it("T2 ceiling allows every tier", () => {
    for (const tier of ["safe", "T1", "T2"] as const) {
      expect(decideTierAccess(t2Ceiling, tier).allowed).toBe(true);
    }
  });
});

describe("loadCapabilityPolicy", () => {
  it("parses a provider-generic policy map from JSON and applies conservative default", () => {
    const json = JSON.stringify({
      default: { tier_ceiling: "remote-safe-only", rate_limit_per_minute: 30 },
      capabilities: {
        "la_cap_owner0001": { tier_ceiling: "T2", rate_limit_per_minute: 120 }
      }
    });
    const owner = loadCapabilityPolicy(json, "la_cap_owner0001");
    expect(owner.tier_ceiling).toBe("T2");
    const stranger = loadCapabilityPolicy(json, "la_cap_unknown9999");
    expect(stranger.tier_ceiling).toBe("remote-safe-only");
    expect(stranger.rate_limit_per_minute).toBe(30);
  });

  it("defaults to remote-safe-only when config is absent", () => {
    const p = loadCapabilityPolicy(undefined, "whatever");
    expect(p.tier_ceiling).toBe("remote-safe-only");
  });
});
