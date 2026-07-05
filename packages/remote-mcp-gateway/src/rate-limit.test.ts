import { describe, expect, it } from "vitest";
import { checkRateLimit, InMemoryRateCounter } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the configured per-minute limit then blocks", async () => {
    const counter = new InMemoryRateCounter();
    const at = Date.parse("2026-07-04T12:00:00.000Z");
    const opts = { capability_id: "c", limit_per_minute: 3, now_ms: at };
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect((await checkRateLimit(counter, opts)).allowed).toBe(true);
    expect(await checkRateLimit(counter, opts)).toEqual({ allowed: false, reason: "rate-limited" });
  });

  it("resets after the window advances", async () => {
    const counter = new InMemoryRateCounter();
    const at = Date.parse("2026-07-04T12:00:00.000Z");
    await checkRateLimit(counter, { capability_id: "c", limit_per_minute: 1, now_ms: at });
    expect(
      (await checkRateLimit(counter, { capability_id: "c", limit_per_minute: 1, now_ms: at + 60_001 })).allowed
    ).toBe(true);
  });
});
