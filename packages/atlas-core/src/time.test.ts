import { describe, expect, it } from "vitest";
import {
  canonicalRecordedAt,
  intervalContains,
  validTimeFidelity,
  type WorldTimeInterval
} from "./time.js";

describe("belief-time canonicalisation", () => {
  it("normalises any offset to UTC so string order equals chronological order", () => {
    // The repo's existing IsoTimestampSchema accepts offsets, so these two —
    // the same instant, four hours apart in text — sort WRONG lexicographically.
    const withOffset = canonicalRecordedAt("2026-01-01T00:00:00+05:00");
    const asUtc = canonicalRecordedAt("2025-12-31T19:00:00Z");
    expect(withOffset).toBe(asUtc);
    expect(withOffset).toBe("2025-12-31T19:00:00.000Z");
  });

  it("always carries millisecond precision", () => {
    expect(canonicalRecordedAt("2026-08-04T13:00:00Z")).toBe("2026-08-04T13:00:00.000Z");
  });

  it("rejects a value that is not an instant", () => {
    expect(() => canonicalRecordedAt("not a date")).toThrow();
  });
});

describe("world time: unknown is not a date", () => {
  const unknownStart: WorldTimeInterval = {
    from: { kind: "unknown" },
    to: { kind: "exact", value: "2020" }
  };

  it("never matches an as-of point", () => {
    // The old store's normalizedDateKey mapped "unknown" to the string "9999",
    // so an unknown start sorted to the far future and quietly satisfied range
    // filters. Unknown is the absence of knowledge; it matches nothing.
    expect(intervalContains(unknownStart, "2019").matches).toBe(false);
    expect(intervalContains(unknownStart, "1900").matches).toBe(false);
    expect(intervalContains(unknownStart, "9999").matches).toBe(false);
  });

  it("is reported as unknown fidelity rather than silently treated as exact", () => {
    expect(validTimeFidelity(unknownStart)).toBe("unknown");
  });

  it("distinguishes absent world time from unknown world time", () => {
    expect(validTimeFidelity(undefined)).toBe("absent");
    expect(validTimeFidelity({})).toBe("absent");
  });
});

describe("world time: approximate widens and degrades match quality", () => {
  it("does not compare ~2019 identically to 2019", () => {
    // The old store stripped "~" before comparing, so an approximate year was
    // indistinguishable from a certain one.
    const exact: WorldTimeInterval = { from: { kind: "exact", value: "2019" } };
    const approximate: WorldTimeInterval = { from: { kind: "approximate", value: "2019" } };

    expect(intervalContains(exact, "2018").matches).toBe(false);
    // ~2019 widens by one unit of its own precision, so 2018 is reachable...
    const widened = intervalContains(approximate, "2018");
    expect(widened.matches).toBe(true);
    // ...but never with certainty.
    expect(widened).toMatchObject({ quality: "possible" });
  });

  it("reports certain only when every bound is exact", () => {
    const interval: WorldTimeInterval = {
      from: { kind: "exact", value: "2019-01" },
      to: { kind: "exact", value: "2019-06" }
    };
    expect(intervalContains(interval, "2019-03")).toEqual({ matches: true, quality: "certain" });
  });
});

describe("world time: half-open intervals", () => {
  const employed: WorldTimeInterval = {
    from: { kind: "exact", value: "2019-03" },
    to: { kind: "exact", value: "2021-07" }
  };

  it("includes the lower bound and excludes the upper", () => {
    expect(intervalContains(employed, "2019-03").matches).toBe(true);
    expect(intervalContains(employed, "2021-06").matches).toBe(true);
    expect(intervalContains(employed, "2021-07").matches).toBe(false);
    expect(intervalContains(employed, "2019-02").matches).toBe(false);
  });

  it("treats an absent upper bound as ongoing", () => {
    const ongoing: WorldTimeInterval = { from: { kind: "exact", value: "2019" } };
    expect(intervalContains(ongoing, "2199").matches).toBe(true);
  });

  it("matches a coarse probe that overlaps the interval at all", () => {
    // "was this true at any point during 2021?" — yes, Jan through June.
    expect(intervalContains(employed, "2021").matches).toBe(true);
  });
});
