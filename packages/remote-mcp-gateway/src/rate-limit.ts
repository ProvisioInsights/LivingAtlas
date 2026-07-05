export interface RateCounter {
  incr(bucketKey: string, windowExpiresAtMs: number): Promise<number>;
}
export class InMemoryRateCounter implements RateCounter {
  // The bucketKey already encodes the (capability, window-start) pair, so a new
  // window is a new key and older keys simply stop being touched. We do not evict
  // against the wall clock here: the window is driven by the caller's now_ms, and
  // consulting Date.now() would make counts non-deterministic when the injected
  // now_ms and the real clock disagree.
  private buckets = new Map<string, { count: number; expiresAtMs: number }>();
  async incr(bucketKey: string, windowExpiresAtMs: number): Promise<number> {
    const existing = this.buckets.get(bucketKey);
    if (!existing) {
      this.buckets.set(bucketKey, { count: 1, expiresAtMs: windowExpiresAtMs });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }
}
export type RateCheckResult = { allowed: true } | { allowed: false; reason: "rate-limited" };
export async function checkRateLimit(
  counter: RateCounter,
  opts: { capability_id: string; limit_per_minute: number; now_ms: number }
): Promise<RateCheckResult> {
  const windowStart = Math.floor(opts.now_ms / 60_000) * 60_000;
  const bucketKey = `${opts.capability_id}:${windowStart}`;
  const count = await counter.incr(bucketKey, windowStart + 60_000);
  return count <= opts.limit_per_minute ? { allowed: true } : { allowed: false, reason: "rate-limited" };
}
