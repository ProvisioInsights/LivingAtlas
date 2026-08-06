import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { independentClaimDigest } from "./corpus-fixture.js";
import { corpusPath, type CorpusFile, type RecordedAnswer } from "./gate-corpus.js";
import { PINNED_QUERIES } from "./corpus-queries.js";

/**
 * The invariants a re-recorded corpus would still have to satisfy.
 *
 * Gate 3 already fails on any changed answer, and the intended reaction to that
 * failure is to stop and think rather than to re-record. But somebody will
 * re-record — under deadline, convinced the change is fine — and these are the
 * rules that survive that. They read the corpus as data and assert the bitemporal
 * laws hold across it, so a re-recording that quietly reintroduced the old
 * store's "unknown sorts to 9999" behaviour fails here even though gate 3 has
 * just been silenced.
 */

function corpus(): CorpusFile {
  return JSON.parse(readFileSync(corpusPath(), "utf8")) as CorpusFile;
}

function answer(id: string): RecordedAnswer {
  const found = corpus().answers.find((candidate) => candidate.query.id === id);
  if (!found) throw new Error(`the corpus has no pinned query ${id}`);
  return found;
}

function claims(id: string): string[] {
  return answer(id).matched.map((match) => match.claim);
}

describe("the recorded corpus obeys the rules it was built to hold", () => {
  it("never matches an unknown world-time endpoint against any as-of point", () => {
    for (const recorded of corpus().answers) {
      if (recorded.query.as_of_valid === undefined) continue;
      expect(
        recorded.matched.map((match) => match.claim),
        `${recorded.query.id} matched a claim whose valid_from is unknown. That is the old store's ` +
          `"9999" defect: an unknown is the absence of knowledge, not a very large date.`
      ).not.toContain("unknown-start");
    }
  });

  it("still returns the unknown-start record when nothing is asked about world time", () => {
    // The other half. Withholding it from as-of queries must not mean losing it:
    // the record exists and a consumer must be able to see that it does.
    expect(claims("present-all")).toContain("unknown-start");
  });

  it("never reports a match through an approximate bound as certain", () => {
    for (const recorded of corpus().answers) {
      // `match_quality` is a property of a world-time COMPARISON, so it is
      // absent when no as-of point was asked about. Absent is the right answer
      // there, and asserting `possible` on it would be asserting that a question
      // nobody asked has an answer.
      if (recorded.query.as_of_valid === undefined) continue;
      for (const match of recorded.matched) {
        if (!match.claim.startsWith("approximate-")) continue;
        expect(
          match.match_quality,
          `${recorded.query.id} reported ${match.claim} as ${String(match.match_quality)}. A widened ` +
            "bound can only ever answer possible."
        ).toBe("possible");
      }
    }
  });

  it("reports an exact span's match as certain, so `possible` is not simply always the answer", () => {
    const match = answer("valid-2019").matched.find((candidate) => candidate.claim === "exact-closed-span");
    expect(match?.match_quality).toBe("certain");
  });

  it("keeps half-open world time half-open, at both precisions", () => {
    // Month precision: the month before valid_to is inside, valid_to is not.
    expect(claims("valid-2021-12")).toContain("exact-closed-span");
    expect(claims("valid-2022")).not.toContain("exact-closed-span");
    // Day precision: the single day is inside, the day named by valid_to is not.
    expect(claims("valid-day-inside")).toContain("exact-single-day");
    expect(claims("valid-day-at-upper-bound")).not.toContain("exact-single-day");
  });

  it("widens an approximate bound by one unit of its OWN precision and no further", () => {
    // ~2020-06 reaches 2020-05 and stops before 2020-04. A widening by a year,
    // or by a fixed number of days, changes exactly one of these two rows.
    expect(claims("valid-month-widened-lower")).toContain("approximate-month");
    expect(claims("valid-month-outside-widening")).not.toContain("approximate-month");
  });

  it("treats an absent valid_to as unbounded rather than as `until now`", () => {
    expect(claims("valid-2025-ongoing")).toContain("approximate-year-ongoing");
    expect(claims("unknown-never-matches-any-probe")).toContain("approximate-year-ongoing");
  });

  it("answers a past belief instant with what was believed THEN", () => {
    expect(claims("belief-at-T7")).toEqual(["belief-v1"]);
    expect(claims("belief-at-T8")).toEqual(["belief-v2"]);
    expect(claims("belief-at-T9")).toEqual(["belief-v2"]);
  });

  it("refuses a belief-time read below the history floor rather than answering it", () => {
    const refusal = answer("belief-before-floor");
    expect(refusal.outcome).toBe("refused");
    expect(refusal.refusal_code).toBe("as-of-before-history-floor");
    expect(refusal.matched).toEqual([]);
  });

  it("composes the two axes instead of letting one imply the other", () => {
    expect(claims("belief-and-world-together")).toEqual(["belief-v1"]);
  });

  it("honours include_superseded on both the present-tense and the as-of path", () => {
    expect(claims("include-superseded-present")).toEqual(["belief-v1", "belief-v2"]);
    expect(claims("include-superseded-at-T8")).toEqual(["belief-v1", "belief-v2"]);
    // ...and does not turn it on by default.
    expect(claims("present-all")).not.toContain("belief-v1");
  });

  it("keeps a withheld record in its row rather than dropping it", () => {
    const sealed = answer("sealed-row-occupies-its-place");
    expect(sealed.matched).toHaveLength(1);
    expect(sealed.matched[0]?.withheld).toBe(true);
    expect(sealed.coverage["matched"]).toBe(1);
    expect(sealed.coverage["returned"]).toBe(1);
    expect(sealed.coverage["withheld"]).toBe(1);
  });

  it("carries the contract that says re-recording is not the remedy", () => {
    expect(corpus().contract).toContain("BREAKING");
    expect(corpus().contract).toContain("new contract revision");
  });

  it("records an answer for every pinned query and no others", () => {
    const recorded = corpus().answers.map((entry) => entry.query.id).sort();
    const pinned = PINNED_QUERIES.map((query) => query.id).sort();
    expect(recorded).toEqual(pinned);
  });
});

describe("the independent claim-digest implementation", () => {
  const base = {
    subject_entity_id: "la_entity_01k3zj9m00abcdefghjkmnpqrs",
    predicate: "worked-at",
    value: "Acme Instruments",
    valid_from: { kind: "exact", value: "2019-01" },
    valid_to: { kind: "exact", value: "2022-01" }
  };

  it("ignores everything outside the claim core", () => {
    // Two consumers asserting the same fact at different moments, with different
    // confidence and different evidence, must produce the SAME digest. That is
    // what makes it a contradiction key rather than an identity.
    const withNoise = {
      ...base,
      recorded_at: "2026-08-04T12:00:00.000Z",
      provenance: { client_id: "somebody-else" },
      confidence: { band: "low" },
      seq: 41
    };
    expect(independentClaimDigest(withNoise)).toBe(independentClaimDigest(base));
  });

  it("changes when any one of the five core fields changes", () => {
    const reference = independentClaimDigest(base);
    expect(independentClaimDigest({ ...base, predicate: "advised" })).not.toBe(reference);
    expect(independentClaimDigest({ ...base, value: "Borealis Works" })).not.toBe(reference);
    expect(independentClaimDigest({ ...base, subject_entity_id: "la_entity_01k3zj9m01abcdefghjkmnpqrs" })).not.toBe(
      reference
    );
    expect(independentClaimDigest({ ...base, valid_from: { kind: "approximate", value: "2019" } })).not.toBe(reference);
    expect(independentClaimDigest({ ...base, valid_to: undefined })).not.toBe(reference);
  });

  it("does not depend on the order the fields were written in", () => {
    const reordered = {
      valid_to: base.valid_to,
      value: base.value,
      predicate: base.predicate,
      valid_from: base.valid_from,
      subject_entity_id: base.subject_entity_id
    };
    expect(independentClaimDigest(reordered)).toBe(independentClaimDigest(base));
  });
});
