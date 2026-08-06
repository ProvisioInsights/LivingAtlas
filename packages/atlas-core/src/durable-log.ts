import { unlinkSync } from "node:fs";
import type { Assertion } from "./assertion.js";
import type { AssertionId } from "./ids.js";
import { LogIndex, buildIndex } from "./log-index.js";
import { LOG_FORMAT, type LogRecord } from "./log-record.js";
import { scanSegmentLog, type RepairNote, type SegmentSummary } from "./segment-reader.js";
import { SegmentWriter, segmentFileName } from "./segment-writer.js";
import {
  AssertionLog,
  type AsOfQuery,
  type Clock,
  type CommitResult,
  type HistoryFloorAdvance,
  type HistoryFloorRefusal,
  type LogJournal,
  type QueryPage,
  type ReclamationNote
} from "./store.js";
import { canonicalRecordedAt, type RecordedAt } from "./time.js";

export type DurableAssertionLogOptions = {
  directory: string;
  clock?: Clock;
  /** Used only when creating a new log; an existing log's own values win. */
  feedEpoch?: string;
  bitemporalSince?: RecordedAt;
  maxSegmentBytes?: number;
};

/** What the load found and had to do about it. Surfaced, never swallowed. */
export type LoadReport = {
  segments: number;
  assertions: number;
  submissions: number;
  reclaimed: number;
  repairs: RepairNote[];
  ignored_files: string[];
  conflicting_supersessions: AssertionId[];
};

export type CompactionRefusalReason =
  | "active-segment"
  | "above-published-watermark"
  | "still-believed"
  | "within-history-floor"
  | "other";

export type CompactionResult = {
  reclaimed_segments: number[];
  reclaimed_assertion_ids: AssertionId[];
  published_watermark: number;
  history_floor: RecordedAt;
  /** Every candidate that was NOT reclaimed, and the rule that stopped it. */
  refusals: { segment: number; reason: CompactionRefusalReason; detail: string }[];
};

/**
 * An `AssertionLog` whose every commit is on disk before the receipt is
 * returned, and which can be reopened without a consumer noticing.
 */
export class DurableAssertionLog {
  readonly log: AssertionLog;
  readonly directory: string;
  readonly report: LoadReport;

  private readonly writer: SegmentWriter;
  private readonly clock: Clock;
  private index: LogIndex;
  private closed = false;

  private constructor(input: {
    log: AssertionLog;
    writer: SegmentWriter;
    directory: string;
    clock: Clock;
    report: LoadReport;
    index: LogIndex;
  }) {
    this.log = input.log;
    this.writer = input.writer;
    this.directory = input.directory;
    this.clock = input.clock;
    this.report = input.report;
    this.index = input.index;
  }

  static open(options: DurableAssertionLogOptions): DurableAssertionLog {
    const clock = options.clock ?? (() => new Date());
    // Repair on open, and only on open: this is the one moment a torn tail can
    // exist and the one moment no writer is appending.
    const scan = scanSegmentLog(options.directory, { repair: true });
    const existing = scan.active !== undefined;

    const feedEpoch = existing ? scan.feed_epoch : options.feedEpoch ?? "e1";
    const historyFloor = existing
      ? scan.history_floor
      : options.bitemporalSince ?? canonicalRecordedAt(clock());

    let floor = historyFloor;
    const writer = new SegmentWriter<LogRecord>({
      directory: options.directory,
      // Built at segment-creation time, so a segment created after a floor
      // advance records the newer floor rather than the one open() saw.
      makeHeader: (ordinal) => ({
        record: "header",
        log_format: LOG_FORMAT,
        segment_ordinal: ordinal,
        feed_epoch: feedEpoch,
        history_floor: floor,
        created_at: canonicalRecordedAt(clock())
      }),
      maxSegmentBytes: options.maxSegmentBytes,
      resume: scan.active
    });

    const journal: LogJournal = {
      appendCommit(group) {
        const records: LogRecord[] = [];
        for (const assertion of group.assertions) {
          records.push({
            record: "assertion",
            submission_id: group.receipt.submission_id,
            assertion
          });
        }
        for (const stamp of group.supersessions) {
          records.push({
            record: "supersession",
            submission_id: group.receipt.submission_id,
            assertion_id: stamp.assertion_id,
            superseded_at: stamp.superseded_at,
            superseded_by: stamp.superseded_by
          });
        }
        // The receipt goes LAST and closes the group. A crash that lands
        // anywhere earlier leaves records with no receipt, which the reader
        // discards — so a commit is all-or-nothing without a two-phase dance.
        records.push({ record: "submission", receipt: group.receipt });
        writer.appendGroup(records);
      },
      appendWatermark(entry) {
        writer.appendGroup([{ record: "watermark", ...entry }]);
      },
      appendHistoryFloor(entry) {
        writer.appendGroup([{ record: "history-floor", ...entry }]);
        floor = entry.history_floor;
      }
    };

    const log = new AssertionLog({
      clock,
      feedEpoch,
      bitemporalSince: historyFloor,
      journal,
      restored: existing ? scan.restored : undefined
    });

    // The truncation already happened; this records that it happened, so the
    // file carries its own repair history instead of relying on whoever read
    // the return value at the time.
    for (const repair of scan.repairs) {
      writer.appendGroup([
        {
          record: "repair",
          repaired_at: canonicalRecordedAt(clock()),
          segment_ordinal: repair.segment_ordinal,
          reason: repair.reason,
          discarded_bytes: repair.discarded_bytes,
          discarded_digest: repair.discarded_digest
        }
      ]);
    }

    return new DurableAssertionLog({
      log,
      writer,
      directory: options.directory,
      clock,
      index: buildIndex(scan.restored.assertions),
      report: {
        segments: scan.segments.length,
        assertions: scan.restored.assertions.length,
        submissions: scan.restored.submissions.size,
        reclaimed: scan.restored.reclaimed.size,
        repairs: scan.repairs,
        ignored_files: scan.ignored_files,
        conflicting_supersessions: scan.conflicting_supersessions
      }
    });
  }

  /** Durable before it returns. See `LogJournal`. */
  commit(input: Parameters<AssertionLog["commit"]>[0]): CommitResult {
    const result = this.log.commit(input);
    if (result.ok && !result.replayed) {
      for (const id of result.receipt.assertion_ids) {
        const assertion = this.log.read(id);
        if (assertion) this.index.add(assertion);
      }
    }
    return result;
  }

  query(request: AsOfQuery): QueryPage | HistoryFloorRefusal {
    return this.log.query(request);
  }

  read(assertionId: AssertionId): Assertion | undefined {
    return this.log.read(assertionId);
  }

  readReclamation(assertionId: AssertionId): ReclamationNote | undefined {
    return this.log.readReclamation(assertionId);
  }

  changesSince(cursorSeq: number, limit?: number): ReturnType<AssertionLog["changesSince"]> {
    return this.log.changesSince(cursorSeq, limit);
  }

  advanceHistoryFloor(to: RecordedAt): HistoryFloorAdvance {
    return this.log.advanceHistoryFloor(to);
  }

  /** The read index, rebuilt from the segments at open and kept warm since. */
  get readIndex(): LogIndex {
    return this.index;
  }

  get size(): number {
    return this.log.size;
  }

  /**
   * Reclaim whole segments — and refuse, loudly, to reclaim anything else.
   *
   * The old store's `compact()` was one line: write the snapshot, then
   * `atomicWriteText(journalPath, "")`. It trusted its own in-memory state,
   * rewrote a file it had not read, and took the journal to zero bytes in a
   * single unrecoverable step. Production's journal is 0 bytes today and
   * 169,205 mutations left nothing behind.
   *
   * Every difference here follows from refusing to repeat that:
   *
   *  - It re-reads the segments first. Compaction reasons about the bytes that
   *    exist, never about what the process believes it wrote.
   *  - It works at whole-segment granularity and never rewrites a file. A
   *    surviving record's bytes are never touched, so nothing can be silently
   *    altered while "compacting".
   *  - A segment must be entirely below the published change-feed watermark, so
   *    no consumer is still waiting for anything in it.
   *  - Every assertion in it must be superseded AND have stopped being believed
   *    before the history floor. That is what makes the discard provably
   *    lossless for reads: no permitted as-of query can reach an instant where
   *    the record was still current, because reads below the floor are refused
   *    outright. Reclaiming a merely-superseded record would silently change
   *    the answer to every as-of read between its commit and its supersession.
   *  - The compaction record is appended BEFORE the unlink, so a crash leaves a
   *    superset of the truth, never a subset.
   */
  compact(): CompactionResult {
    const watermark = this.log.publishedWatermark;
    const floor = this.log.bitemporalSince;
    const scan = scanSegmentLog(this.directory, { repair: false });
    const refusals: CompactionResult["refusals"] = [];

    if (scan.repairs.length > 0) {
      // Something is appending, or the last open did not finish. Either way the
      // log is not in a state anyone should be deleting parts of.
      for (const repair of scan.repairs) {
        refusals.push({
          segment: repair.segment_ordinal,
          reason: "other",
          detail: "segment needs repair; compaction never runs against a damaged log"
        });
      }
      return {
        reclaimed_segments: [],
        reclaimed_assertion_ids: [],
        published_watermark: watermark,
        history_floor: floor,
        refusals
      };
    }

    const activeOrdinal = this.writer.activeOrdinal;
    const candidates: SegmentSummary[] = [];
    let highSeq = 0;
    let highRecordedAt = floor;

    const live = new Map<AssertionId, Assertion>();
    for (const assertion of scan.restored.assertions) {
      live.set(assertion.assertion_id, assertion);
      if (assertion.seq > highSeq) highSeq = assertion.seq;
      if (assertion.recorded_at > highRecordedAt) highRecordedAt = assertion.recorded_at;
    }
    highSeq = Math.max(highSeq, scan.restored.next_seq - 1);

    for (const segment of scan.segments) {
      if (segment.ordinal === activeOrdinal) {
        refusals.push({
          segment: segment.ordinal,
          reason: "active-segment",
          detail: "the segment currently being appended to is never reclaimed"
        });
        continue;
      }

      if (segment.holds_repair) {
        refusals.push({
          segment: segment.ordinal,
          reason: "other",
          detail: "holds a repair record; evidence that the log was damaged is never reclaimed"
        });
        continue;
      }

      const aboveWatermark = segment.seqs.filter((seq) => seq > watermark);
      if (aboveWatermark.length > 0) {
        refusals.push({
          segment: segment.ordinal,
          reason: "above-published-watermark",
          detail:
            `holds seq ${aboveWatermark.join(", ")} above the published watermark ${watermark}; ` +
            "a consumer has not been given these changes yet"
        });
        continue;
      }

      const believed: AssertionId[] = [];
      const withinFloor: AssertionId[] = [];
      for (const id of segment.assertion_ids) {
        const assertion = live.get(id);
        if (!assertion) continue;
        if (assertion.superseded_at === null) believed.push(id);
        else if (assertion.superseded_at > floor) withinFloor.push(id);
      }

      if (believed.length > 0) {
        refusals.push({
          segment: segment.ordinal,
          reason: "still-believed",
          detail: `${believed.length} assertion(s) are still current`
        });
        continue;
      }
      if (withinFloor.length > 0) {
        refusals.push({
          segment: segment.ordinal,
          reason: "within-history-floor",
          detail:
            `${withinFloor.length} assertion(s) stopped being believed after the history floor ${floor}; ` +
            "an as-of read in that window would change answer if they were discarded"
        });
        continue;
      }

      candidates.push(segment);
    }

    if (candidates.length === 0) {
      return {
        reclaimed_segments: [],
        reclaimed_assertion_ids: [],
        published_watermark: watermark,
        history_floor: floor,
        refusals
      };
    }

    const compactedAt = canonicalRecordedAt(this.clock());
    const reclaimedSegments = candidates.map((segment) => segment.ordinal);
    const reclaimedIds: AssertionId[] = [];
    const reclaimedSeqs: number[] = [];
    const notes = new Map<AssertionId, ReclamationNote>();

    for (const segment of candidates) {
      for (let position = 0; position < segment.assertion_ids.length; position += 1) {
        const id = segment.assertion_ids[position];
        const seq = segment.seqs[position];
        if (id === undefined || seq === undefined) continue;
        reclaimedIds.push(id);
        reclaimedSeqs.push(seq);
        notes.set(id, {
          seq,
          reclaimed_at: compactedAt,
          reclaimed_from_segment: segment.ordinal
        });
      }
    }

    // Carry forward every receipt the doomed segments hold. A receipt outlives
    // the assertions it names: without it, a client retrying an old
    // idempotency key would be told the key is new and would commit a second
    // copy of a submission it already has a receipt for.
    const carried: LogRecord[] = [];
    for (const segment of candidates) {
      for (const receipt of segment.receipts) {
        carried.push({ record: "submission", receipt });
      }
    }

    // Written first, and carrying everything the doomed segments were the last
    // holders of: the high-water seq so an id can never be reissued, the
    // highest belief instant so belief time cannot go backwards after a
    // restart, the watermark, and the floor.
    this.writer.appendGroup([
      ...carried,
      {
        record: "compaction",
        compacted_at: compactedAt,
        reclaimed_segments: reclaimedSegments,
        reclaimed_assertion_ids: reclaimedIds,
        reclaimed_seqs: reclaimedSeqs,
        high_seq: highSeq,
        high_recorded_at: highRecordedAt,
        published_watermark: watermark,
        history_floor: floor
      }
    ]);

    for (const ordinal of reclaimedSegments) {
      unlinkSync(`${this.directory}/${segmentFileName(ordinal)}`);
    }

    this.log.applyReclamation(notes);
    this.index = buildIndex(
      scan.restored.assertions.filter((assertion) => !notes.has(assertion.assertion_id))
    );

    return {
      reclaimed_segments: reclaimedSegments,
      reclaimed_assertion_ids: reclaimedIds,
      published_watermark: watermark,
      history_floor: floor,
      refusals
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.close();
  }
}
