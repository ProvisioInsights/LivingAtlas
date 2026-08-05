import { z } from "zod";

/**
 * Atlas is bitemporal. Two axes, and they are never interchangeable:
 *
 *   BELIEF TIME (`recorded_at`) — when Atlas learned a thing. Assigned by Atlas
 *   at COMMIT, never accepted from a caller, and canonicalised so that string
 *   order equals chronological order.
 *
 *   WORLD TIME (`valid_from`/`valid_to`) — when the thing was true out in the
 *   world. Supplied by the caller, frequently imprecise, and sometimes simply
 *   unknown. Half-open `[valid_from, valid_to)`; an absent `valid_to` means
 *   "still true".
 *
 * The old store conflated these and paid for it: `normalizedDateKey` mapped
 * "unknown" to the literal string "9999", so an unknown start sorted to the far
 * future and silently satisfied any "before X" filter. Nothing here may sort an
 * unknown; unknown is a distinct answer, not a large number.
 */

/** Canonical belief-time instant: RFC 3339, UTC, `Z`, millisecond precision. */
export const RecordedAtSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "recorded_at must be RFC 3339 UTC with milliseconds and a Z suffix"
  );

export type RecordedAt = z.infer<typeof RecordedAtSchema>;

/**
 * The repo's existing `IsoTimestampSchema` accepts any offset, so
 * `2026-01-01T00:00:00+05:00` string-sorts AFTER `2025-12-31T20:00:00Z` despite
 * being the same instant. Belief time is ordered by string comparison in the
 * change feed, so it gets a narrower type and a canonicaliser.
 */
export function canonicalRecordedAt(instant: Date | string): RecordedAt {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  const millis = date.getTime();
  if (!Number.isFinite(millis)) {
    throw new Error(`Not a valid instant: ${String(instant)}`);
  }
  return date.toISOString().replace(/\.(\d{3})\d*Z$/, ".$1Z") as RecordedAt;
}

/** World-time precision, coarsest to finest. Drives interval widening. */
export const WorldTimePrecision = ["year", "month", "day"] as const;
export type WorldTimePrecision = (typeof WorldTimePrecision)[number];

/**
 * A world-time endpoint. `unknown` carries no value and never compares equal or
 * ordered against anything — it is the absence of knowledge, not a date.
 */
export const WorldTimePointSchema = z.union([
  z.object({
    kind: z.literal("unknown")
  }).strict(),
  z.object({
    kind: z.enum(["exact", "approximate"]),
    /** `2019`, `2019-03`, or `2019-03-15`. Precision is inferred from length. */
    value: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/)
  }).strict()
]);

export type WorldTimePoint = z.infer<typeof WorldTimePointSchema>;

export function precisionOf(value: string): WorldTimePrecision {
  if (value.length === 4) return "year";
  if (value.length === 7) return "month";
  return "day";
}

/** Epoch-millisecond half-open span a partial date denotes. */
type Span = { lower: number; upper: number };

/** Split a partial date into concrete parts; absent parts default to the first. */
function partsOf(value: string): { year: number; month: number; day: number } {
  const segments = value.split("-");
  return {
    year: Number(segments[0]),
    month: segments.length > 1 ? Number(segments[1]) : 1,
    day: segments.length > 2 ? Number(segments[2]) : 1
  };
}

function spanOf(value: string): Span {
  const precision = precisionOf(value);
  const { year, month, day } = partsOf(value);
  const lower = Date.UTC(year, month - 1, day);
  const upper =
    precision === "year"
      ? Date.UTC(year + 1, 0, 1)
      : precision === "month"
        ? Date.UTC(year, month, 1)
        : Date.UTC(year, month - 1, day + 1);
  return { lower, upper };
}

/**
 * Widen by one unit of the point's own precision. `~2019` could mean 2018 or
 * 2020, so it spans 2018-01-01 through 2021-01-01. Callers that need certainty
 * read `match_quality`.
 */
function widen(value: string): Span {
  const precision = precisionOf(value);
  const { year, month, day } = partsOf(value);
  if (precision === "year") {
    return { lower: Date.UTC(year - 1, 0, 1), upper: Date.UTC(year + 2, 0, 1) };
  }
  if (precision === "month") {
    return { lower: Date.UTC(year, month - 2, 1), upper: Date.UTC(year, month + 1, 1) };
  }
  return { lower: Date.UTC(year, month - 1, day - 1), upper: Date.UTC(year, month - 1, day + 2) };
}

export function resolvePoint(point: WorldTimePoint): Span | undefined {
  if (point.kind === "unknown") return undefined;
  return point.kind === "approximate" ? widen(point.value) : spanOf(point.value);
}

/** Half-open world-time interval. Absent `to` means ongoing. */
export const WorldTimeIntervalSchema = z
  .object({
    from: WorldTimePointSchema.optional(),
    to: WorldTimePointSchema.optional()
  })
  .strict();

export type WorldTimeInterval = z.infer<typeof WorldTimeIntervalSchema>;

/**
 * How much world time an assertion actually carries. Reported per record so a
 * consumer can tell "true in March 2019" from "we have no idea when".
 */
export const ValidTimeFidelity = ["exact", "approximate", "unknown", "absent"] as const;
export type ValidTimeFidelity = (typeof ValidTimeFidelity)[number];

export function validTimeFidelity(interval: WorldTimeInterval | undefined): ValidTimeFidelity {
  if (!interval || (!interval.from && !interval.to)) return "absent";
  const points = [interval.from, interval.to].filter(Boolean) as WorldTimePoint[];
  if (points.some((point) => point.kind === "unknown")) return "unknown";
  return points.some((point) => point.kind === "approximate") ? "approximate" : "exact";
}

export type MatchQuality = "certain" | "possible";

export type WorldTimeMatch =
  | { matches: false }
  | { matches: true; quality: MatchQuality };

/**
 * Does `[from, to)` contain the instant `at`?
 *
 * Rules that differ from the old store, deliberately:
 *  - An `unknown` endpoint NEVER matches. It is not "9999" and not "beginning
 *    of time"; a caller asking "was this true in March 2019" gets `false`
 *    rather than a confident wrong answer.
 *  - An `approximate` endpoint widens, and any match through a widened bound is
 *    reported `possible`, never `certain`.
 *  - `at` is itself a partial date: matching is interval-overlap, not point
 *    containment, so `as_of_valid = "2019"` asks "true at any point in 2019".
 */
export function intervalContains(
  interval: WorldTimeInterval | undefined,
  at: string
): WorldTimeMatch {
  if (!interval || (!interval.from && !interval.to)) return { matches: false };
  if (interval.from?.kind === "unknown" || interval.to?.kind === "unknown") {
    return { matches: false };
  }

  const probe = spanOf(at);
  const from = interval.from ? resolvePoint(interval.from) : undefined;
  const to = interval.to ? resolvePoint(interval.to) : undefined;

  // Half-open on both sides: the interval starts at from.lower and runs up to
  // to.lower. An absent bound is unbounded in that direction.
  const start = from ? from.lower : Number.NEGATIVE_INFINITY;
  const end = to ? to.lower : Number.POSITIVE_INFINITY;
  if (probe.upper <= start || probe.lower >= end) return { matches: false };

  const approximate =
    interval.from?.kind === "approximate" || interval.to?.kind === "approximate";
  return { matches: true, quality: approximate ? "possible" : "certain" };
}
