import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AtlasConsumerClient, AtlasToolRefusal, isRedaction } from "@living-atlas/atlas-client";
import { FIXTURE_FEED_EPOCH } from "./fixture.js";
import { E2E_SCENARIO_TIMEOUT_MS, startSharedSession, type SharedSession } from "./harness.js";
// These scenarios spawn real child processes; see E2E_SCENARIO_TIMEOUT_MS.
vi.setConfig({ testTimeout: E2E_SCENARIO_TIMEOUT_MS });


/**
 * The change feed, resumed from a cursor the way a real consumer resumes.
 *
 * The interesting failures here are all silent ones: a page that skips, a page
 * that repeats, a cursor answered against a different total order, and a
 * withheld record dropped out of the sequence so the seqs no longer run
 * contiguously. None of them raise anything on their own — a consumer just ends
 * up with a graph that is quietly wrong — so each is asserted on the seq numbers
 * directly rather than on whether a call succeeded.
 *
 * Every scenario here is a READ, so they share one server process. That is safe
 * precisely because none of them writes: the seqs each one asserts on are the
 * fixture's, and no test in this file can move them.
 */

let shared: SharedSession;

beforeAll(async () => {
  shared = await startSharedSession();
});

afterAll(async () => {
  await shared.dispose();
});

describe("step 6 — the change feed", () => {
  it("delivers every change in seq order, and resuming from the cursor neither skips nor repeats", async () => {
    const whole = await shared.client.readChanges({ cursor_seq: 0, limit: 200 });
    expect(whole.has_more).toBe(false);
    expect(whole.feed_epoch).toBe(FIXTURE_FEED_EPOCH);
    const everySeq = whole.changes.map((change) => change.seq);
    expect(everySeq.length).toBeGreaterThan(2);
    expect([...everySeq].sort((left, right) => left - right)).toEqual(everySeq);

    // Now walk it two at a time, echoing the cursor and the epoch the way a
    // consumer that went offline between pages would.
    const walked: number[] = [];
    let cursor = 0;
    let guard = 0;
    for (;;) {
      const page = await shared.client.readChanges({ cursor_seq: cursor, feed_epoch: whole.feed_epoch, limit: 2 });
      walked.push(...page.changes.map((change) => change.seq));
      cursor = page.next_cursor_seq;
      if (!page.has_more) break;
      guard += 1;
      // A feed that never reports `has_more: false` is a feed a consumer loops
      // on forever, so the loop refuses to be the thing that hides it.
      expect(guard, "the change feed never stopped reporting more").toBeLessThan(50);
    }

    // Exactly the same sequence, once each. A skip and a repeat both show up
    // here and nowhere else.
    expect(walked).toEqual(everySeq);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it("keeps the sequence gapless when a record in it may not be read", async () => {
    const page = await shared.client.readChanges({ cursor_seq: 0, limit: 200, include_records: true });

    const withheld = page.changes.filter((change) => change.record !== undefined && isRedaction(change.record));
    expect(withheld).toHaveLength(1);

    // The withheld change still occupies its seq. Dropping it would leave a hole
    // that is indistinguishable from a compacted range, and a consumer resuming
    // across it could not tell which it had hit.
    const seqs = page.changes.map((change) => change.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    for (let index = 1; index < seqs.length; index += 1) {
      expect(seqs[index]).toBe((seqs[index - 1] ?? 0) + 1);
    }

    // And every change carries an id that is stable across redeliveries, because
    // delivery is at-least-once and a consumer deduplicates on it.
    expect(new Set(page.changes.map((change) => change.change_id)).size).toBe(page.changes.length);
  });

  it("refuses a cursor from another feed epoch rather than resuming into a different total order", async () => {
    const failure = await shared.client
      .readChanges({ cursor_seq: 1, feed_epoch: "e-some-other-epoch" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("feed-epoch-mismatch");
    // The refusal names the way back: re-scan, then resume from the handoff seq
    // the final page carries.
    expect((failure as AtlasToolRefusal).record.remedy?.tool).toBe("atlas.assertion.query.v1");
  });

  it("hands a full scan off to the feed with no gap and no overlap", async () => {
    // Bootstrap-then-follow: the final page of a full scan names the exact seq
    // the scan covered, so the follow starts precisely where the scan stopped.
    const scan = await shared.client.queryAssertions({ full_scan: true, page_size: 200 });
    expect(scan.page.has_more).toBe(false);
    const handoff = scan.page.feed_handoff;
    expect(handoff, "a completed full scan published no feed handoff").toBeDefined();
    if (!handoff) return;
    expect(handoff.tool).toBe("atlas.changes.read.v1");

    const follow = await shared.client.readChanges({ cursor_seq: handoff.cursor_seq, feed_epoch: scan.horizon.feed_epoch });
    // Nothing has been written since the scan — no test in this file writes — so
    // following from the handoff is empty rather than replaying what the scan
    // already delivered.
    expect(follow.changes).toEqual([]);
    expect(follow.has_more).toBe(false);
  });

  it("pages a read only when the cursor and its snapshot travel together", async () => {
    const first = await shared.client.queryAssertions({ page_size: 2 });
    expect(first.page.has_more).toBe(true);
    const next = AtlasConsumerClient.nextPage(first.page);
    expect(next, "a page with more rows published no resumable cursor and snapshot").toBeDefined();
    if (!next) return;

    const second = await shared.client.queryAssertions({ page_size: 2, cursor: next.cursor, snapshot: next.snapshot });
    expect(second.results.length).toBeGreaterThan(0);

    // A cursor WITHOUT its pin is refused. Serving it would answer page 2
    // against newer state, and the resulting sequence silently skips and repeats
    // rows with no way for a consumer to notice.
    const failure = await shared.client.queryAssertions({ page_size: 2, cursor: next.cursor }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    expect((failure as AtlasToolRefusal).code).toBe("snapshot-invalid");
  });
});
