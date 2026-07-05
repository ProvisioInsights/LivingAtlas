import { z } from "zod";

export type TierCeiling = "remote-safe-only" | "T1" | "T2";
export type RequestedTier = "safe" | "T1" | "T2";

export type CapabilityPolicy = {
  capability_id: string;
  tier_ceiling: TierCeiling;
  rate_limit_per_minute: number;
};

export type TierDecision =
  | { allowed: true; reason: "within-ceiling" }
  | { allowed: false; reason: "above-ceiling" };

const CEILING_RANK: Record<TierCeiling, number> = { "remote-safe-only": 0, T1: 1, T2: 2 };
const TIER_RANK: Record<RequestedTier, number> = { safe: 0, T1: 1, T2: 2 };

export function decideTierAccess(policy: CapabilityPolicy, requested: RequestedTier): TierDecision {
  return TIER_RANK[requested] <= CEILING_RANK[policy.tier_ceiling]
    ? { allowed: true, reason: "within-ceiling" }
    : { allowed: false, reason: "above-ceiling" };
}

const PolicyEntrySchema = z.object({
  tier_ceiling: z.enum(["remote-safe-only", "T1", "T2"]),
  rate_limit_per_minute: z.number().int().positive()
});
const PolicyConfigSchema = z.object({
  default: PolicyEntrySchema,
  capabilities: z.record(z.string(), PolicyEntrySchema).default({})
});

const CONSERVATIVE_DEFAULT: Omit<CapabilityPolicy, "capability_id"> = {
  tier_ceiling: "remote-safe-only",
  rate_limit_per_minute: 30
};

export function loadCapabilityPolicy(configJson: string | undefined, capabilityId: string): CapabilityPolicy {
  if (!configJson) {
    return { capability_id: capabilityId, ...CONSERVATIVE_DEFAULT };
  }
  const parsed = PolicyConfigSchema.safeParse(JSON.parse(configJson));
  if (!parsed.success) {
    return { capability_id: capabilityId, ...CONSERVATIVE_DEFAULT };
  }
  const entry = parsed.data.capabilities[capabilityId] ?? parsed.data.default;
  return {
    capability_id: capabilityId,
    tier_ceiling: entry.tier_ceiling,
    rate_limit_per_minute: entry.rate_limit_per_minute
  };
}
