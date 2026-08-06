import type { BeliefTimeName } from "./corpus-fixture.js";

/**
 * The pinned queries.
 *
 * Each one names the rule it exists to hold, because a corpus entry whose
 * purpose nobody wrote down is an entry the next person re-records instead of
 * investigating. When one of these changes, the `holds` line is the first thing
 * a reader sees and it says what was just broken.
 *
 * `as_of_recorded` is symbolic — `T2`, not an ISO instant — because the
 * corpus's belief instants are set by the fixture and a query that hard-coded
 * one would drift from it. `as_of_valid` is literal, because world time is
 * caller-supplied and a literal is exactly what a caller sends.
 */

export type PinnedQuery = {
  id: string;
  holds: string;
  predicate?: string;
  as_of_valid?: string;
  as_of_recorded?: BeliefTimeName | "below-history-floor";
  include_superseded?: boolean;
};

export const PINNED_QUERIES: readonly PinnedQuery[] = [
  {
    id: "present-all",
    holds:
      "With no as-of on either axis, the page is present belief about all world time: the superseded " +
      "job title is gone, the sealed note occupies a row, and claims with no world time are still here."
  },
  {
    id: "valid-2019",
    as_of_valid: "2019",
    holds:
      "as_of_valid=2019 matches the exact closed span certainly and the ~2019 span only possibly. " +
      "The unknown start matches NOTHING — it is the absence of knowledge, not the year 9999 — and a " +
      "claim carrying no world time at all cannot answer a question about a year."
  },
  {
    id: "valid-2018",
    as_of_valid: "2018",
    holds:
      "as_of_valid=2018 is BELOW the exact span's start and inside the ~2019 widening. It separates " +
      "the two: a widened bound answers possibly where an exact one answers not at all. Remove the " +
      "widening and this page empties."
  },
  {
    id: "valid-2022",
    as_of_valid: "2022",
    holds:
      "as_of_valid=2022 is exactly the exact span's valid_to. Half-open [from, to) excludes it. An " +
      "off-by-one that made intervals closed shows up here and almost nowhere else."
  },
  {
    id: "valid-2021-12",
    as_of_valid: "2021-12",
    holds: "The month immediately before valid_to is inside the span. The other half of the boundary pair."
  },
  {
    id: "valid-2025-ongoing",
    as_of_valid: "2025",
    holds:
      "An absent valid_to is unbounded above, not 'until today'. The ~2019 claim still answers in " +
      "2025; the closed span does not."
  },
  {
    id: "valid-day-inside",
    predicate: "attended",
    as_of_valid: "2020-06-15",
    holds: "A single-day exact span contains its own start day, certainly."
  },
  {
    id: "valid-day-at-upper-bound",
    predicate: "attended",
    as_of_valid: "2020-06-16",
    holds:
      "A single-day span [2020-06-15, 2020-06-16) does NOT contain 2020-06-16. Day-precision " +
      "half-openness, probed at the one date that can tell."
  },
  {
    id: "valid-month-widened-lower",
    predicate: "attended",
    as_of_valid: "2020-05",
    holds:
      "~2020-06 widens by one MONTH — its own precision — so 2020-05 matches possibly. Widening by a " +
      "year instead, or not at all, changes this row."
  },
  {
    id: "valid-month-outside-widening",
    predicate: "attended",
    as_of_valid: "2020-04",
    holds: "One month further out is outside the widening. The far side of the same boundary."
  },
  {
    id: "belief-at-T7",
    predicate: "job-title",
    as_of_recorded: "T7",
    holds:
      "As of T7 the correction has not happened: the ORIGINAL job title is what Atlas believed, and " +
      "the corrected one does not exist yet. This is the whole promise of belief time."
  },
  {
    id: "belief-at-T8",
    predicate: "job-title",
    as_of_recorded: "T8",
    holds:
      "The correction lands at T8. The superseded record is excluded at the instant it is superseded " +
      "— superseded_at <= as_of_recorded — not at the instant after."
  },
  {
    id: "belief-at-T9",
    predicate: "job-title",
    as_of_recorded: "T9",
    holds: "Later belief instants agree with the present-tense answer."
  },
  {
    id: "belief-before-floor",
    as_of_recorded: "below-history-floor",
    holds:
      "A belief-time read below the history floor is REFUSED with a typed code. It is never quietly " +
      "answered from present state, because a confident wrong answer about what was believed in 2025 " +
      "is worse than a refusal."
  },
  {
    id: "belief-and-world-together",
    predicate: "job-title",
    as_of_valid: "2019",
    as_of_recorded: "T7",
    holds:
      "The two axes are independent and compose: what Atlas believed at T7 about the world in 2019. " +
      "A change that made one axis imply the other collapses this row into one of the two above."
  },
  {
    id: "sealed-row-occupies-its-place",
    predicate: "medical-note",
    holds:
      "A record this credential may not read is withheld, not dropped. It occupies its row as a " +
      "redaction stub so `matched` and `returned` still reconcile — absence is reported, never " +
      "performed."
  },
  {
    id: "include-superseded-at-T8",
    predicate: "job-title",
    as_of_recorded: "T8",
    include_superseded: true,
    holds:
      "include_superseded is a PUBLISHED input, so it must change the answer: at T8 both versions of " +
      "the title come back, the original alongside the correction that replaced it. The handler " +
      "ignored this parameter entirely until this corpus asked it a question whose answer depended " +
      "on it."
  },
  {
    id: "include-superseded-present",
    predicate: "job-title",
    include_superseded: true,
    holds:
      "The same request with no belief instant returns both versions too: superseded is a property " +
      "of a record, not of a past. Without this row, an implementation that honoured " +
      "include_superseded only on the as-of path would still pass."
  },
  {
    id: "unknown-never-matches-any-probe",
    as_of_valid: "2100",
    holds:
      "A far-future as-of matches only the unbounded ~2019 claim. The unknown start still matches " +
      "nothing, at either end of time — which is the exact defect the string \"9999\" caused."
  }
];
