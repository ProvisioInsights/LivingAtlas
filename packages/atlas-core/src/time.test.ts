import { describe, expect, it } from "vitest";
import {
  canonicalRecordedAt,
  intervalContains,
  resolvePoint,
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

  it("cannot be handed to resolvePoint at all, so there is no 'no span' value to leak", () => {
    // The guard is the TYPE, not a branch. `resolvePoint` used to accept the
    // whole union and answer `Span | undefined` for the unknown arm — an arm no
    // caller could reach, because every caller ruled unknown out first. A
    // returned "no answer" is the shape the old store abused: unknown became
    // "9999" and satisfied every "before X" filter.
    //
    // Deliberately never invoked: the assertion lives in the type checker, and
    // calling it would only crash on a value the signature already forbids.
    const rejected = () =>
      // @ts-expect-error an unknown endpoint denotes no span, so it is not a
      // KnownWorldTimePoint. If this directive ever reports itself unused, the
      // parameter has widened back and the unreachable branch is back with it —
      // `tsc --noEmit` fails on the unused directive, which is the point.
      resolvePoint({ kind: "unknown" });

    expect(typeof rejected).toBe("function");
  });
});

describe("resolvePoint is total over the endpoints that carry a date", () => {
  it("answers a span for every known point, with no undefined to unwrap", () => {
    // Totality is the property being asserted: each of these returns a Span,
    // never `undefined`, so a caller has nothing optional to mishandle.
    expect(resolvePoint({ kind: "exact", value: "2019" })).toEqual({
      lower: Date.UTC(2019, 0, 1),
      upper: Date.UTC(2020, 0, 1)
    });
    expect(resolvePoint({ kind: "exact", value: "2019-03" })).toEqual({
      lower: Date.UTC(2019, 2, 1),
      upper: Date.UTC(2019, 3, 1)
    });
    expect(resolvePoint({ kind: "exact", value: "2019-03-15" })).toEqual({
      lower: Date.UTC(2019, 2, 15),
      upper: Date.UTC(2019, 2, 16)
    });
  });

  it("widens an approximate point by one unit of its own precision", () => {
    // ~2019 could mean 2018 or 2020, so it spans 2018-01-01 up to 2021-01-01.
    expect(resolvePoint({ kind: "approximate", value: "2019" })).toEqual({
      lower: Date.UTC(2018, 0, 1),
      upper: Date.UTC(2021, 0, 1)
    });
    // Strictly wider than the exact reading of the same string — an approximate
    // point that resolved identically to an exact one is the defect that made
    // "~2019" and "2019" indistinguishable in the old store.
    const exact = resolvePoint({ kind: "exact", value: "2019" });
    const approximate = resolvePoint({ kind: "approximate", value: "2019" });
    expect(approximate.lower).toBeLessThan(exact.lower);
    expect(approximate.upper).toBeGreaterThan(exact.upper);
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
