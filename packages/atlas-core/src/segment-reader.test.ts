import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssertionDraft } from "./assertion.js";
import { DurableAssertionLog } from "./durable-log.js";
import { mintEntityId } from "./ids.js";
import { SegmentLogError, scanSegmentLog, type SegmentLogErrorCode } from "./segment-reader.js";

/** Synthetic fixtures in a throwaway directory. No real graph is ever opened. */
const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "atlas-core-crash-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

const alice = mintEntityId(new Date("2026-01-01T00:00:00Z"));

function draft(predicate: string): AssertionDraft {
  return {
    kind: "fact",
    lineage_action: "assert",
    subject_entity_id: alice,
    predicate,
    supersedes: [],
    confidence: { band: "high" },
    evidence_links: [{ evidence_id: "ev-1", stance: "supports" }]
  } as AssertionDraft;
}

function fixedClock(start = "2026-08-04T12:00:00.000Z") {
  let millis = new Date(start).getTime();
  return {
    now: () => new Date(millis),
    advance(ms: number) {
      millis += ms;
    }
  };
}

const SINCE = "2026-01-01T00:00:00.000Z";

/** Seed `count` commits, each forced into its own segment, then close cleanly. */
function seed(count: number, maxSegmentBytes = 700): string {
  const directory = tempDirectory();
  const clock = fixedClock();
  const log = DurableAssertionLog.open({
    directory,
    clock: clock.now,
    bitemporalSince: SINCE,
    maxSegmentBytes
  });
  for (let index = 0; index < count; index += 1) {
    clock.advance(1000);
    const result = log.commit({
      client_id: "c",
      idempotency_key: `k${index}`,
      drafts: [draft(`p${index}`)]
    });
    if (!result.ok) throw new Error("seed commit failed");
  }
  log.close();
  return directory;
}

function segmentPaths(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .map((name) => join(directory, name));
}

function lastSegment(directory: string): string {
  const paths = segmentPaths(directory);
  const last = paths[paths.length - 1];
  if (!last) throw new Error("expected at least one segment");
  return last;
}

function codeOf(run: () => unknown): SegmentLogErrorCode {
  try {
    run();
  } catch (error) {
    if (error instanceof SegmentLogError) return error.code;
    throw error;
  }
  throw new Error("expected the load to refuse");
}

describe("a torn tail is truncated, and only at the tail", () => {
  it("drops a partial final line and keeps every committed record", () => {
    const directory = seed(3);
    const path = lastSegment(directory);
    const sizeBefore = readFileSync(path).length;

    // A process that died mid-write: bytes with no terminating newline.
    appendFileSync(path, '{"record":"assertion","submission_id":"la_sub');

    const clock = fixedClock("2026-08-04T13:00:00.000Z");
    const reopened = DurableAssertionLog.open({ directory, clock: clock.now });
    expect(reopened.size).toBe(3);
    expect(reopened.report.repairs).toHaveLength(1);
    expect(reopened.report.repairs[0]?.reason).toBe("torn-tail");
    expect(reopened.report.repairs[0]?.discarded_bytes).toBe(45);
    reopened.close();

    // Truncated for real. Leaving the bytes in place would weld them into the
    // middle of the file as soon as the next commit appended past them.
    expect(readFileSync(path).length).toBeGreaterThanOrEqual(sizeBefore);
    const rescan = scanSegmentLog(directory, { repair: false });
    expect(rescan.repairs).toHaveLength(0);
    expect(rescan.restored.assertions).toHaveLength(3);
  });

  it("records the repair in the log, with a digest of what was discarded", () => {
    const directory = seed(2);
    appendFileSync(lastSegment(directory), '{"record":"assert');

    const reopened = DurableAssertionLog.open({ directory, clock: fixedClock().now });
    const digest = reopened.report.repairs[0]?.discarded_digest;
    reopened.close();

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    const rescan = scanSegmentLog(directory, { repair: false });
    expect(rescan.segments.some((segment) => segment.holds_repair)).toBe(true);
  });

  it("refuses a torn record in a sealed segment instead of repairing it", () => {
    const directory = seed(3);
    const paths = segmentPaths(directory);
    const sealed = paths[0];
    if (!sealed) throw new Error("expected a sealed segment");
    appendFileSync(sealed, '{"record":"assertion"');

    expect(codeOf(() => scanSegmentLog(directory, { repair: true }))).toBe("torn-record-mid-log");
  });
});

describe("a commit without its receipt never happened", () => {
  it("discards a trailing group that died before the commit marker", () => {
    const directory = seed(3);
    const path = lastSegment(directory);
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    const assertionLine = lines.find((line) => line.includes('"record":"assertion"'));
    if (!assertionLine) throw new Error("expected an assertion record in the final segment");

    // The 44 MiB-buffer-boundary shape: the write died having flushed whole
    // lines, so the tail is syntactically perfect and semantically a commit
    // that no caller was ever told about.
    appendFileSync(path, `${assertionLine}\n`);

    const reopened = DurableAssertionLog.open({ directory, clock: fixedClock().now });
    expect(reopened.report.repairs[0]?.reason).toBe("incomplete-commit");
    expect(reopened.size).toBe(3);
    reopened.close();

    expect(scanSegmentLog(directory, { repair: false }).repairs).toHaveLength(0);
  });

  it("refuses an unclosed commit that is followed by unrelated records", () => {
    const directory = seed(2);
    const path = lastSegment(directory);
    const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    const assertionLine = lines.find((line) => line.includes('"record":"assertion"'));
    if (!assertionLine) throw new Error("expected an assertion record");

    appendFileSync(path, `${assertionLine}\n`);
    appendFileSync(
      path,
      `${JSON.stringify({
        record: "watermark",
        published_seq: 1,
        published_at: "2026-08-04T12:00:05.000Z"
      })}\n`
    );

    expect(codeOf(() => scanSegmentLog(directory, { repair: true }))).toBe("incomplete-commit-mid-log");
  });
});

describe("the log refuses what it cannot honestly read", () => {
  it("refuses a zero-byte segment rather than reading it as an empty log", () => {
    // The exact production shape: journal.jsonl is 0 bytes and 169,205
    // mutations left nothing behind. A header-first format makes the
    // difference between "truncated" and "nothing happened" checkable.
    const directory = seed(2);
    const paths = segmentPaths(directory);
    const first = paths[0];
    if (!first) throw new Error("expected a segment");
    truncateSync(first, 0);

    expect(codeOf(() => scanSegmentLog(directory, { repair: true }))).toBe("empty-segment");
  });

  it("refuses a record kind it does not understand", () => {
    const directory = seed(1);
    appendFileSync(lastSegment(directory), `${JSON.stringify({ record: "telepathy", value: 1 })}\n`);

    // Skipping it would serve reads as complete and then let compaction discard
    // the originals of records this build cannot even name.
    expect(codeOf(() => scanSegmentLog(directory, { repair: true }))).toBe("unknown-record-kind");
  });

  it("refuses a malformed record that is still valid JSON", () => {
    const directory = seed(1);
    appendFileSync(
      lastSegment(directory),
      `${JSON.stringify({ record: "watermark", published_seq: -4, published_at: "yesterday" })}\n`
    );

    expect(codeOf(() => scanSegmentLog(directory, { repair: true }))).toBe("corrupt-record");
  });

  it("refuses a segment whose declared ordinal does not match its file name", () => {
    const directory = seed(2);
    const paths = segmentPaths(directory);
    const second = paths[1];
    const first = paths[0];
    if (!second || !first) throw new Error("expected two segments");
    writeFileSync(second, readFileSync(first));

    expect(codeOf(() => scanSegmentLog(directory, { repair: false }))).toBe("ordinal-mismatch");
  });

  it("refuses a log written for another feed epoch", () => {
    const directory = seed(1);
    expect(codeOf(() => scanSegmentLog(directory, { expectFeedEpoch: "e9" }))).toBe(
      "feed-epoch-mismatch"
    );
  });
});

describe("files nobody claims are reported, not ignored", () => {
  it("surfaces an orphan tmp file left behind by a dead writer", () => {
    // The incident this store is built against left an orphan .tmp when a
    // snapshot write died at a 44 MiB buffer boundary. An orphan nobody can see
    // is an orphan nobody investigates.
    const directory = seed(1);
    writeFileSync(join(directory, "0000000001.ndjson.tmp-4821"), "partial");

    const scan = scanSegmentLog(directory, { repair: false });
    expect(scan.ignored_files).toContain("0000000001.ndjson.tmp-4821");
    expect(scan.restored.assertions).toHaveLength(1);
  });
});
