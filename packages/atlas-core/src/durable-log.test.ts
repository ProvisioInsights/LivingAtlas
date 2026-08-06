import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssertionDraft } from "./assertion.js";
import { DurableAssertionLog } from "./durable-log.js";
import { mintEntityId, type AssertionId } from "./ids.js";
import { rebuildIndexFromSegments } from "./log-index.js";
import type { CommitResult } from "./store.js";

/**
 * Synthetic fixtures in a throwaway directory, always. Nothing in this file may
 * touch a real graph, and nothing it writes outlives the test.
 */
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-segments-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

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

const SINCE = "2026-01-01T00:00:00.000Z";

/** Small enough that every commit lands in its own segment. */
const TINY_SEGMENT = 700;

describe("round trip through the segments", () => {
  it("reloads every assertion and receipt unchanged", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    const receipts = [];
    for (let index = 0; index < 5; index += 1) {
      clock.advance(1000);
      receipts.push(
        ok(
          first.commit({
            client_id: "praxis",
            idempotency_key: `k${index}`,
            drafts: [draft({ predicate: `p${index}`, valid_from: { kind: "exact", value: "2019-03" } })]
          })
        ).receipt
      );
    }
    const before = receipts.map((receipt) => first.read(receipt.assertion_ids[0] as AssertionId));
    first.close();

    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    expect(reopened.size).toBe(5);
    for (let index = 0; index < receipts.length; index += 1) {
      const receipt = receipts[index];
      if (!receipt) throw new Error("missing receipt");
      const id = receipt.assertion_ids[0] as AssertionId;
      expect(reopened.read(id)).toEqual(before[index]);
    }
    reopened.close();
  });

  it("restores the feed epoch and the history floor rather than re-deriving them", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const first = DurableAssertionLog.open({
      directory,
      clock: clock.now,
      feedEpoch: "e7",
      bitemporalSince: SINCE
    });
    ok(first.commit({ client_id: "c", idempotency_key: "k", drafts: [draft()] }));
    first.close();

    // Reopened with NO options: a restart that had to be told what it already
    // knew would silently raise the floor to "now" and start refusing every
    // historical as-of read.
    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    expect(reopened.log.feedEpoch).toBe("e7");
    expect(reopened.log.bitemporalSince).toBe(SINCE);
    reopened.close();
  });

  it("keeps belief time increasing across a restart under a rewound clock", () => {
    const directory = tempDirectory();
    const clock = fixedClock("2026-08-04T12:00:00.000Z");
    const first = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    const early = ok(first.commit({ client_id: "c", idempotency_key: "a", drafts: [draft()] }));
    first.close();

    const rewound = fixedClock("2026-08-04T11:00:00.000Z");
    const reopened = DurableAssertionLog.open({ directory, clock: rewound.now });
    const later = ok(reopened.commit({ client_id: "c", idempotency_key: "b", drafts: [draft()] }));

    expect(later.receipt.committed_at > early.receipt.committed_at).toBe(true);
    expect(reopened.read(firstId(later))?.seq).toBe(2);
    reopened.close();
  });
});

describe("supersession is appended, never edited in place", () => {
  it("survives a reload and is still write-once afterwards", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    const original = ok(first.commit({ client_id: "praxis", idempotency_key: "a", drafts: [draft()] }));
    const originalId = firstId(original);
    clock.advance(1000);
    const retraction = ok(
      first.commit({
        client_id: "owner",
        idempotency_key: "b",
        drafts: [draft({ lineage_action: "retract", supersedes: [originalId] })]
      })
    );
    first.close();

    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    const restored = reopened.read(originalId);
    expect(restored?.superseded_at).toBe(retraction.receipt.committed_at);
    expect(restored?.superseded_by).toBe(firstId(retraction));

    // A second retraction of the same record must not move the stamp. Write-once
    // has to hold across the reload, not only within one process lifetime.
    clock.advance(1000);
    ok(
      reopened.commit({
        client_id: "owner",
        idempotency_key: "c",
        drafts: [draft({ lineage_action: "retract", supersedes: [originalId] })]
      })
    );
    expect(reopened.read(originalId)?.superseded_by).toBe(firstId(retraction));
    expect(reopened.read(originalId)?.superseded_at).toBe(retraction.receipt.committed_at);
    reopened.close();
  });

  it("leaves the superseded record's original bytes in place", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const log = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    const original = ok(log.commit({ client_id: "c", idempotency_key: "a", drafts: [draft()] }));
    const originalId = firstId(original);
    log.close();

    const bytesBefore = rebuildIndexFromSegments(directory).get(originalId);
    expect(bytesBefore?.superseded_at).toBeNull();

    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    clock.advance(1000);
    ok(
      reopened.commit({
        client_id: "c",
        idempotency_key: "b",
        drafts: [draft({ lineage_action: "retract", supersedes: [originalId] })]
      })
    );
    reopened.close();

    // The folded view says superseded; the stamp arrived as a later record
    // rather than as an edit, so the assertion line itself still reads null.
    const folded = rebuildIndexFromSegments(directory).get(originalId);
    expect(folded?.superseded_at).not.toBeNull();
    expect(bytesBefore?.assertion_id).toBe(folded?.assertion_id);
  });
});

describe("idempotency survives a restart", () => {
  it("replays the original receipt and ids after a reload", () => {
    const directory = tempDirectory();
    const clock = fixedClock();

    const first = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    const original = ok(first.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] }));
    first.close();

    clock.advance(600_000);
    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    const retry = ok(reopened.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] }));

    expect(retry.replayed).toBe(true);
    expect(retry.receipt).toEqual(original.receipt);
    expect(reopened.size).toBe(1);
    reopened.close();
  });

  it("still refuses the same key with a different payload after a reload", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const first = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    ok(first.commit({ client_id: "praxis", idempotency_key: "k1", drafts: [draft()] }));
    first.close();

    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    const conflict = reopened.commit({
      client_id: "praxis",
      idempotency_key: "k1",
      drafts: [draft({ predicate: "advises" })]
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe("idempotency-key-conflict");
    expect(reopened.size).toBe(1);
    reopened.close();
  });
});

describe("the index is a cache, not a source of truth", () => {
  it("rebuilds from the segments alone and answers identically", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const log = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });

    const ids: AssertionId[] = [];
    for (let index = 0; index < 6; index += 1) {
      clock.advance(1000);
      ids.push(
        firstId(
          ok(
            log.commit({
              client_id: "c",
              idempotency_key: `k${index}`,
              drafts: [draft({ predicate: index % 2 === 0 ? "employed-by" : "advises" })]
            })
          )
        )
      );
    }
    clock.advance(1000);
    const first = ids[0];
    if (!first) throw new Error("expected an id");
    ok(
      log.commit({
        client_id: "c",
        idempotency_key: "retract",
        drafts: [draft({ lineage_action: "retract", supersedes: [first] })]
      })
    );
    log.close();

    const rebuilt = rebuildIndexFromSegments(directory);
    const warm = log.readIndex;

    expect(rebuilt.size).toBe(warm.size);
    for (const id of ids) {
      expect(rebuilt.get(id)).toEqual(warm.get(id));
      const assertion = warm.get(id);
      if (!assertion) throw new Error("expected the warm index to hold the id");
      expect(rebuilt.atSeq(assertion.seq)).toEqual(assertion);
    }
    expect(rebuilt.forSubjectPredicate(alice, "employed-by").map((a) => a.seq)).toEqual(
      warm.forSubjectPredicate(alice, "employed-by").map((a) => a.seq)
    );
    // The supersession stamp has to be folded by the rebuild too, or the
    // rebuilt index would answer with a record the live one calls retracted.
    expect(rebuilt.get(first)?.superseded_at).toBe(warm.get(first)?.superseded_at);
  });
});

describe("watermark-safe compaction", () => {
  /** Three commits, each in its own segment; the first is retracted. */
  function seeded() {
    const directory = tempDirectory();
    const clock = fixedClock();
    const log = DurableAssertionLog.open({
      directory,
      clock: clock.now,
      bitemporalSince: SINCE,
      maxSegmentBytes: TINY_SEGMENT
    });

    const a = ok(log.commit({ client_id: "c", idempotency_key: "a", drafts: [draft({ value: "acme" })] }));
    clock.advance(1000);
    const b = ok(
      log.commit({
        client_id: "c",
        idempotency_key: "b",
        drafts: [draft({ value: "globex", lineage_action: "correct", supersedes: [firstId(a)] })]
      })
    );
    clock.advance(1000);
    const c = ok(log.commit({ client_id: "c", idempotency_key: "c", drafts: [draft({ predicate: "advises" })] }));
    return { directory, clock, log, a, b, c };
  }

  it("refuses to discard anything above the published watermark", () => {
    const { clock, log, a, b } = seeded();

    // Only seq 1 has been handed to a consumer.
    expect(log.changesSince(0, 1).changes.map((change) => change.seq)).toEqual([1]);
    clock.advance(1000);
    expect(log.advanceHistoryFloor("2026-08-04T13:00:00.000Z").ok).toBe(true);

    const result = log.compact();
    const above = result.refusals.filter((refusal) => refusal.reason === "above-published-watermark");
    expect(above.length).toBeGreaterThan(0);
    // seq 1 was published AND is superseded below the floor, so its segment goes.
    expect(result.reclaimed_assertion_ids).toEqual([firstId(a)]);
    // seq 2 was never published, so nothing in its segment may be touched.
    expect(log.read(firstId(b))).toBeDefined();
    log.close();
  });

  it("refuses a superseded record whose belief window is still readable", () => {
    const { log, a } = seeded();
    log.changesSince(0, 100);

    // Everything is published and seq 1 is superseded — but the floor has not
    // moved, so an as-of read between its commit and its supersession is still
    // permitted and would change answer if the record were discarded.
    const result = log.compact();
    expect(result.reclaimed_segments).toEqual([]);
    expect(result.refusals.some((refusal) => refusal.reason === "within-history-floor")).toBe(true);
    expect(log.read(firstId(a))).toBeDefined();
    log.close();
  });

  it("never reclaims a record that is still believed", () => {
    const { clock, log, c } = seeded();
    log.changesSince(0, 100);
    clock.advance(1000);
    log.advanceHistoryFloor("2026-08-04T13:00:00.000Z");

    const result = log.compact();
    expect(result.refusals.some((refusal) => refusal.reason === "still-believed")).toBe(true);
    expect(log.read(firstId(c))).toBeDefined();
    log.close();
  });

  it("is lossless when it does run, and stays lossless across a reload", () => {
    const { directory, clock, log, a, b, c } = seeded();
    log.changesSince(0, 100);
    clock.advance(1000);
    log.advanceHistoryFloor("2026-08-04T13:00:00.000Z");

    const before = log.query({ subject_entity_id: alice });
    if (!before.ok) throw new Error("expected the pre-compaction query to succeed");

    const result = log.compact();
    expect(result.reclaimed_assertion_ids).toEqual([firstId(a)]);

    const after = log.query({ subject_entity_id: alice });
    if (!after.ok) throw new Error("expected the post-compaction query to succeed");
    expect(after.hits.map((hit) => hit.assertion.assertion_id)).toEqual(
      before.hits.map((hit) => hit.assertion.assertion_id)
    );

    // A reclaimed id resolves to a note about the reclamation, never to a bare
    // "never existed".
    expect(log.read(firstId(a))).toBeUndefined();
    expect(log.readReclamation(firstId(a))?.seq).toBe(1);

    // The change feed says a hole exists rather than pretending seq 1 was never
    // issued.
    const feed = log.changesSince(0, 100);
    expect(feed.retention_floor_seq).toBe(1);
    expect(feed.cursor_before_retention_floor).toBe(true);

    clock.advance(1000);
    const next = ok(log.commit({ client_id: "c", idempotency_key: "d", drafts: [draft({ predicate: "knows" })] }));
    expect(log.read(firstId(next))?.seq).toBe(4);
    log.close();

    // Everything above survives the restart, including the fact that seq 1 was
    // reclaimed rather than forgotten.
    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    expect(reopened.read(firstId(b))).toEqual(log.read(firstId(b)));
    expect(reopened.read(firstId(c))).toEqual(log.read(firstId(c)));
    expect(reopened.readReclamation(firstId(a))?.seq).toBe(1);
    expect(ok(reopened.commit({ client_id: "c", idempotency_key: "a", drafts: [draft({ value: "acme" })] })).replayed)
      .toBe(true);
    clock.advance(1000);
    const afterReload = ok(
      reopened.commit({ client_id: "c", idempotency_key: "e", drafts: [draft({ predicate: "mentors" })] })
    );
    // seq 1 is gone from the segments; reissuing it would give one consumer two
    // different records at the same feed position.
    expect(reopened.read(firstId(afterReload))?.seq).toBe(5);
    reopened.close();
  });

  it("never lowers the history floor", () => {
    const { clock, log } = seeded();
    clock.advance(1000);
    log.advanceHistoryFloor("2026-08-04T13:00:00.000Z");
    const refusal = log.advanceHistoryFloor(SINCE);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.code).toBe("history-floor-cannot-regress");
    expect(log.log.bitemporalSince).toBe("2026-08-04T13:00:00.000Z");
    log.close();
  });
});

describe("a failed commit leaves nothing behind", () => {
  it("does not burn a seq or half-write a group when supersedes is unresolvable", () => {
    const directory = tempDirectory();
    const clock = fixedClock();
    const log = DurableAssertionLog.open({ directory, clock: clock.now, bitemporalSince: SINCE });
    ok(log.commit({ client_id: "c", idempotency_key: "a", drafts: [draft()] }));

    const ghost = "la_assertion_0000000000000000000000000z" as AssertionId;
    expect(() =>
      log.commit({
        client_id: "c",
        idempotency_key: "b",
        drafts: [draft({ lineage_action: "retract", supersedes: [ghost] })]
      })
    ).toThrow(/unknown assertion/);

    clock.advance(1000);
    const next = ok(log.commit({ client_id: "c", idempotency_key: "c", drafts: [draft({ predicate: "advises" })] }));
    // A gap here would be permanent: gapless-within-an-epoch is what lets a
    // consumer prove its cursor missed nothing.
    expect(log.read(firstId(next))?.seq).toBe(2);
    log.close();

    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    expect(reopened.size).toBe(2);
    reopened.close();
  });
});
