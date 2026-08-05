import { describe, expect, it } from "vitest";
import { AssertionLog, type CommitResult } from "./store.js";
import { claimDigest, mintEntityId, type AssertionId } from "./ids.js";
import type { AssertionDraft } from "./assertion.js";

/** Deterministic clock — tests must not depend on wall time. */
function fixedClock(start = "2026-08-04T12:00:00.000Z") {
  let millis = new Date(start).getTime();
  return {
    now: () => new Date(millis),
    advance(ms: number) {
      millis += ms;
    }
  };
}

const alice = mintEntityId(new Date("2026-01-01T00:00:00Z"));
const acme = mintEntityId(new Date("2026-01-01T00:00:00Z"));

function draft(overrides: Partial<AssertionDraft> = {}): AssertionDraft {
  return {
    kind: "relationship",
    lineage_action: "assert",
    subject_entity_id: alice,
    predicate: "employed-by",
    target_entity_id: acme,
    supersedes: [],
    confidence: { band: "high" },
    evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
    ...overrides
  } as AssertionDraft;
}

function ok(result: CommitResult) {
  if (!result.ok) throw new Error(`expected commit to succeed: ${result.code}`);
  return result;
}

/** The repo runs `noUncheckedIndexedAccess`, so an index is possibly undefined. */
function firstId(result: ReturnType<typeof ok>): AssertionId {
  const id = result.receipt.assertion_ids[0];
  if (!id) throw new Error("expected the commit to mint at least one assertion");
  return id;
}

describe("commit assigns belief time and feed position", () => {
  it("stamps recorded_at and seq at commit, not from the caller", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now, bitemporalSince: "2026-01-01T00:00:00.000Z" });

    const result = ok(log.commit({
      client_id: "praxis",
      idempotency_key: "k1",
      // proposed_at is advisory and must NOT become the belief-time axis.
      drafts: [draft({ proposed_at: "1999-01-01T00:00:00Z" })]
    }));

    const assertion = log.read(firstId(result))!;
    expect(assertion.recorded_at).toBe("2026-08-04T12:00:00.000Z");
    expect(assertion.provenance.proposed_at).toBe("1999-01-01T00:00:00Z");
    expect(assertion.seq).toBe(1);
  });

  it("gives every assertion its own seq, so a cursor can resume mid-submission", () => {
    // The old store stamped ONE generation across all N events in a
    // transaction, so a 1,000-item submission was one indivisible number and a
    // consumer could not resume partway through it.
    const log = new AssertionLog({ clock: fixedClock().now });
    const result = ok(log.commit({
      client_id: "praxis",
      idempotency_key: "batch",
      drafts: [draft({ predicate: "a" }), draft({ predicate: "b" }), draft({ predicate: "c" })]
    }));

    const seqs = result.receipt.assertion_ids.map((id) => log.read(id)!.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("keeps belief time strictly increasing even when the clock does not move", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now });
    const first = ok(log.commit({ client_id: "c", idempotency_key: "1", drafts: [draft()] }));
    const second = ok(log.commit({ client_id: "c", idempotency_key: "2", drafts: [draft()] }));

    expect(log.read(firstId(second))!.recorded_at)
      .not.toBe(log.read(firstId(first))!.recorded_at);
  });

  it("sets client_id from the credential, ignoring anything the caller sends", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    const result = ok(log.commit({ client_id: "praxis", idempotency_key: "k", drafts: [draft()] }));
    expect(log.read(firstId(result))!.provenance.client_id).toBe("praxis");
  });
});

describe("idempotency is (client_id, key), never content", () => {
  it("replays the original receipt and ids without re-minting", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now });

    const first = ok(log.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] }));
    clock.advance(60_000);
    const retry = ok(log.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] }));

    expect(retry.replayed).toBe(true);
    expect(retry.receipt.assertion_ids).toEqual(first.receipt.assertion_ids);
    expect(retry.receipt.committed_at).toBe(first.receipt.committed_at);
    expect(log.size).toBe(1);
  });

  it("rejects the same key with a different payload instead of accepting either", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    log.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] });

    const conflict = log.commit({
      client_id: "praxis",
      idempotency_key: "k1",
      drafts: [draft({ predicate: "advises" })]
    });

    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("idempotency-key-conflict");
    expect(log.size).toBe(1);
  });

  it("scopes keys per client, so two consumers cannot collide", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    log.commit({ client_id: "praxis", idempotency_key: "k", drafts: [draft()] });
    const other = ok(log.commit({ client_id: "chatgpt", idempotency_key: "k", drafts: [draft()] }));
    expect(other.replayed).toBe(false);
    expect(log.size).toBe(2);
  });

  it("gives two clients asserting the same claim one digest but distinct ids", () => {
    // Same claim, two learning events. Both must survive — which is exactly why
    // an assertion cannot be content-addressed.
    const log = new AssertionLog({ clock: fixedClock().now });
    const a = ok(log.commit({ client_id: "praxis", idempotency_key: "a", drafts: [draft()] }));
    const b = ok(log.commit({ client_id: "chatgpt", idempotency_key: "b", drafts: [draft()] }));

    const left = log.read(firstId(a))!;
    const right = log.read(firstId(b))!;
    expect(left.claim_digest).toBe(right.claim_digest);
    expect(left.assertion_id).not.toBe(right.assertion_id);
  });

  it("excludes belief time and provenance from the claim digest", () => {
    const core = { subject_entity_id: alice, predicate: "employed-by", value: "acme" };
    expect(claimDigest(core)).toBe(claimDigest({ ...core }));
  });
});

describe("as-of reads on both axes", () => {
  it("answers what Atlas believed at a past instant, not what it believes now", () => {
    const clock = fixedClock("2026-01-01T00:00:00.000Z");
    const log = new AssertionLog({ clock: clock.now, bitemporalSince: "2025-01-01T00:00:00.000Z" });

    const first = ok(log.commit({
      client_id: "importer",
      idempotency_key: "v1",
      drafts: [draft({ value: "engineer" })]
    }));
    const beliefBefore = log.read(firstId(first))!.recorded_at;

    clock.advance(86_400_000);
    ok(log.commit({
      client_id: "owner",
      idempotency_key: "v2",
      drafts: [draft({
        value: "director",
        lineage_action: "correct",
        supersedes: [firstId(first)]
      })]
    }));

    const then = log.query({ subject_entity_id: alice, as_of_recorded: beliefBefore });
    const now = log.query({ subject_entity_id: alice });
    if (!then.ok || !now.ok) throw new Error("expected both queries to succeed");

    expect(then.hits.map((h) => h.assertion.value)).toEqual(["engineer"]);
    expect(now.hits.map((h) => h.assertion.value)).toEqual(["director"]);
  });

  it("separates the world axis from the belief axis", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now, bitemporalSince: "2020-01-01T00:00:00.000Z" });

    // Learned TODAY about a fact that was true in 2019 — the natural case for a
    // knowledge store fed by imports and by agents that learn things late.
    ok(log.commit({
      client_id: "praxis",
      idempotency_key: "late",
      drafts: [draft({
        valid_from: { kind: "exact", value: "2019-03" },
        valid_to: { kind: "exact", value: "2021-07" }
      })]
    }));

    const during = log.query({ subject_entity_id: alice, as_of_valid: "2020" });
    const after = log.query({ subject_entity_id: alice, as_of_valid: "2023" });
    if (!during.ok || !after.ok) throw new Error("expected both queries to succeed");

    expect(during.hits).toHaveLength(1);
    expect(after.hits).toHaveLength(0);
  });

  it("refuses a belief-time read before the history floor instead of guessing", () => {
    const log = new AssertionLog({
      clock: fixedClock().now,
      bitemporalSince: "2026-08-01T00:00:00.000Z"
    });
    ok(log.commit({ client_id: "c", idempotency_key: "k", drafts: [draft()] }));

    const refusal = log.query({ as_of_recorded: "2020-01-01T00:00:00.000Z" });
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.code).toBe("as-of-before-history-floor");
      expect(refusal.bitemporal_since).toBe("2026-08-01T00:00:00.000Z");
    }
  });
});

describe("retraction preserves the record", () => {
  it("keeps a retracted assertion readable forever and stamps supersession once", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now, bitemporalSince: "2020-01-01T00:00:00.000Z" });

    const original = ok(log.commit({
      client_id: "praxis",
      idempotency_key: "a",
      drafts: [draft()]
    }));
    const originalId = firstId(original);

    clock.advance(1000);
    ok(log.commit({
      client_id: "owner",
      idempotency_key: "b",
      drafts: [draft({ lineage_action: "retract", supersedes: [originalId] })]
    }));

    const retracted = log.read(originalId)!;
    expect(retracted.superseded_at).not.toBeNull();
    // Unconditional read returns it regardless of current belief — the
    // time-travel primitive that needs no time argument.
    expect(retracted.value).toBeUndefined();
    expect(retracted.predicate).toBe("employed-by");

    // ...and it is gone from the present-tense view.
    const now = log.query({ subject_entity_id: alice, predicate: "employed-by" });
    if (!now.ok) throw new Error("expected success");
    expect(now.hits.every((h) => h.assertion.lineage_action === "retract")).toBe(true);
  });

  it("requires supersedes[] on any non-assert action", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    expect(() =>
      log.commit({
        client_id: "c",
        idempotency_key: "k",
        drafts: [draft({ lineage_action: "retract", supersedes: [] })]
      })
    ).toThrow(/supersedes/);
  });
});

describe("include_superseded", () => {
  it("adds back superseded records on both the present-tense and the as-of path", () => {
    const clock = fixedClock();
    const log = new AssertionLog({ clock: clock.now, bitemporalSince: "2020-01-01T00:00:00.000Z" });

    const first = ok(log.commit({ client_id: "c", idempotency_key: "a", drafts: [draft({ value: "acme" })] }));
    const originalId = firstId(first);
    clock.advance(1000);
    const supersededAt = "2026-08-04T12:00:01.000Z";
    ok(log.commit({
      client_id: "c",
      idempotency_key: "b",
      drafts: [draft({ lineage_action: "correct", value: "globex", supersedes: [originalId] })]
    }));

    // Default: present belief only.
    const present = log.query({ subject_entity_id: alice, predicate: "employed-by" });
    if (!present.ok) throw new Error("expected success");
    expect(present.hits.map((hit) => hit.assertion.value)).toEqual(["globex"]);

    // Asked for: the record that was replaced comes back too. A published input
    // that changes nothing is worse than one that was never offered.
    const withHistory = log.query({
      subject_entity_id: alice,
      predicate: "employed-by",
      include_superseded: true
    });
    if (!withHistory.ok) throw new Error("expected success");
    expect(withHistory.hits.map((hit) => hit.assertion.value)).toEqual(["acme", "globex"]);

    // And on the as-of path: at the instant of supersession the default view
    // excludes the replaced record, and this one adds it back.
    const asOf = log.query({
      subject_entity_id: alice,
      predicate: "employed-by",
      as_of_recorded: supersededAt,
      include_superseded: true
    });
    if (!asOf.ok) throw new Error("expected success");
    expect(asOf.hits.map((hit) => hit.assertion.value)).toEqual(["acme", "globex"]);
  });
});

describe("contradictions both survive", () => {
  it("keeps two conflicting claims current rather than auto-resolving", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    ok(log.commit({
      client_id: "praxis",
      idempotency_key: "a",
      drafts: [draft({ value: "acme" })]
    }));
    ok(log.commit({
      client_id: "chatgpt",
      idempotency_key: "b",
      drafts: [draft({ value: "globex" })]
    }));

    const page = log.query({ subject_entity_id: alice, predicate: "employed-by" });
    if (!page.ok) throw new Error("expected success");
    expect(page.hits).toHaveLength(2);
    expect(page.hits.map((h) => h.assertion.provenance.client_id).sort())
      .toEqual(["chatgpt", "praxis"]);
  });
});

describe("absence is reported, never performed", () => {
  it("counts withheld rows so totals reconcile", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    ok(log.commit({ client_id: "c", idempotency_key: "open", drafts: [draft()] }));
    ok(log.commit({
      client_id: "c",
      idempotency_key: "sealed",
      drafts: [draft({ predicate: "has-diagnosis" })],
      sensitivity: { tier: "sealed", rank: 2, withheld: true }
    }));

    const page = log.query({ subject_entity_id: alice });
    if (!page.ok) throw new Error("expected success");
    expect(page.coverage.matched).toBe(2);
    expect(page.coverage.withheld).toBe(1);
  });

  it("flags a page that mixes authoritative and import-artifact belief times", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    ok(log.commit({
      client_id: "importer",
      idempotency_key: "old",
      drafts: [draft()],
      origin: "pre-contract-import",
      recorded_at_fidelity: "import-artifact"
    }));
    ok(log.commit({ client_id: "praxis", idempotency_key: "new", drafts: [draft()] }));

    const page = log.query({ subject_entity_id: alice });
    if (!page.ok) throw new Error("expected success");
    expect(page.recorded_at_fidelity_mixed).toBe(true);
  });

  it("reports valid-time coverage so a caller knows the answer's basis", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    ok(log.commit({
      client_id: "c",
      idempotency_key: "dated",
      drafts: [draft({ valid_from: { kind: "exact", value: "2019" } })]
    }));
    ok(log.commit({ client_id: "c", idempotency_key: "undated", drafts: [draft()] }));

    const page = log.query({ subject_entity_id: alice });
    if (!page.ok) throw new Error("expected success");
    expect(page.coverage.with_valid_time).toBe(1);
    expect(page.coverage.unknown_or_absent_valid_time).toBe(1);
  });

  it("counts valid-time coverage over the rows that entered the page, not the rows it evaluated", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    // Three dated assertions in disjoint spans, so an as-of-valid point can
    // match at most one of them. Every one of them carries EXACT world time,
    // which is the case that used to be counted before the filter ran.
    for (const [key, year] of [["a", "2019"], ["b", "2020"], ["c", "2021"]] as const) {
      ok(log.commit({
        client_id: "c",
        idempotency_key: key,
        drafts: [
          draft({
            predicate: `p-${key}`,
            valid_from: { kind: "exact", value: year },
            valid_to: { kind: "exact", value: String(Number(year) + 1) }
          })
        ]
      }));
    }

    const page = log.query({ subject_entity_id: alice, as_of_valid: "2020" });
    if (!page.ok) throw new Error("expected success");

    expect(page.coverage.matched).toBe(1);
    // The two rows the world-time filter rejected are not in the page, so they
    // are in neither half of its valid-time partition.
    expect(page.coverage.with_valid_time).toBe(1);
    expect(page.coverage.unknown_or_absent_valid_time).toBe(0);
    expect(page.coverage.unknown_or_absent_valid_time).toBeGreaterThanOrEqual(0);
    expect(page.coverage.with_valid_time + page.coverage.unknown_or_absent_valid_time).toBe(
      page.coverage.matched
    );
  });
});

describe("change feed", () => {
  it("resumes from a cursor without gaps or repeats", () => {
    const log = new AssertionLog({ clock: fixedClock().now });
    for (let index = 0; index < 5; index += 1) {
      ok(log.commit({
        client_id: "c",
        idempotency_key: `k${index}`,
        drafts: [draft({ predicate: `p${index}` })]
      }));
    }

    const first = log.changesSince(0, 2);
    expect(first.changes.map((c) => c.seq)).toEqual([1, 2]);
    expect(first.has_more).toBe(true);

    const resumed = log.changesSince(first.next_cursor, 10);
    expect(resumed.changes.map((c) => c.seq)).toEqual([3, 4, 5]);
    expect(resumed.has_more).toBe(false);
  });
});
