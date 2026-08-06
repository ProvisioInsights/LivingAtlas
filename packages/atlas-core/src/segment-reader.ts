import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { Assertion } from "./assertion.js";
import type { AssertionId } from "./ids.js";
import {
  LOG_FORMAT,
  LogRecordSchema,
  isKnownRecordKind,
  opensCommitGroup,
  type LogRecord,
  type SegmentHeaderRecord
} from "./log-record.js";
import { segmentFileName, segmentOrdinalOf } from "./segment-writer.js";
import { submissionKey, type ReclamationNote, type RestoredLog, type SubmissionReceipt } from "./store.js";
import type { RecordedAt } from "./time.js";

/**
 * Reading the log back is where the honesty is won or lost. Two rules govern
 * everything below:
 *
 *  1. A record that cannot be understood is never guessed at. Parsing a
 *     half-written line into a "mostly right" record is how a corrupt journal
 *     becomes corrupt state.
 *  2. Damage is only ever repaired where damage is POSSIBLE — the tail of the
 *     final segment. Everything earlier was fsynced and closed before the next
 *     byte was written, so a problem there is corruption or tampering, and it
 *     refuses rather than repairs.
 */

export type SegmentLogErrorCode =
  | "empty-segment"
  | "missing-header"
  | "format-mismatch"
  | "feed-epoch-mismatch"
  | "ordinal-mismatch"
  | "corrupt-record"
  | "unknown-record-kind"
  | "torn-record-mid-log"
  | "incomplete-commit-mid-log"
  | "other";

export class SegmentLogError extends Error {
  readonly code: SegmentLogErrorCode;

  constructor(code: SegmentLogErrorCode, message: string) {
    super(message);
    this.name = "SegmentLogError";
    this.code = code;
  }
}

export type RepairNote = {
  segment_ordinal: number;
  reason: "torn-tail" | "incomplete-commit";
  discarded_bytes: number;
  discarded_digest: string;
};

export type SegmentSummary = {
  ordinal: number;
  path: string;
  bytes: number;
  /** Ids of assertions whose bodies live in this segment. */
  assertion_ids: AssertionId[];
  seqs: number[];
  /**
   * Receipts held here. Compaction must re-append these before reclaiming the
   * segment: a receipt is what makes an idempotent retry replay instead of
   * committing a second copy, and it has to outlive the assertions it names.
   */
  receipts: SubmissionReceipt[];
  /** Repair records are damage evidence, and compaction never eats evidence. */
  holds_repair: boolean;
};

export type SegmentScan = {
  feed_epoch: string;
  history_floor: RecordedAt;
  restored: RestoredLog;
  segments: SegmentSummary[];
  /** The segment a writer should resume appending to, if any exists. */
  active: { ordinal: number; bytes: number; records: number } | undefined;
  repairs: RepairNote[];
  /**
   * Files in the directory that are not segments. Reported, never silently
   * skipped: the incident this store is built against left an orphan `.tmp`
   * behind when a snapshot write died at a 44 MiB buffer boundary, and an
   * orphan nobody can see is an orphan nobody investigates.
   */
  ignored_files: string[];
  /**
   * Two different supersession stamps for one assertion. First stamp wins, to
   * match the in-memory write-once rule exactly, but the contradiction is
   * surfaced — a log that contradicts write-once is evidence of a bug or of
   * tampering, and it must not be quietly normalised away.
   */
  conflicting_supersessions: AssertionId[];
};

export type ScanOptions = {
  /** Truncate a repairable tail. Off for read-only inspection. */
  repair?: boolean;
  /** Refuse to open a log written for a different epoch. */
  expectFeedEpoch?: string;
};

/**
 * Exported so the identity log hashes discarded bytes identically. A repair
 * note's digest is how a human confirms which bytes were dropped against a
 * backup; two logs computing it two ways would make that comparison useless.
 */
export function digestOf(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type ParsedLine = { record: LogRecord; offset: number };

/**
 * Split a segment into whole lines plus whatever trailing bytes follow the last
 * newline.
 *
 * This works on the Buffer rather than on a decoded string on purpose: a write
 * that died partway through a multi-byte character would decode to a
 * replacement character, and the torn bytes would then look like a legitimate
 * — if strange — line. Splitting on the byte 0x0A keeps the boundary exact.
 *
 * Exported for the identity log: the tear boundary is the subtlest rule in the
 * format, and it exists once.
 */
export function splitLines(bytes: Buffer): { complete: Buffer; torn: Buffer } {
  const lastNewline = bytes.lastIndexOf(0x0a);
  if (lastNewline < 0) return { complete: bytes.subarray(0, 0), torn: bytes };
  return { complete: bytes.subarray(0, lastNewline + 1), torn: bytes.subarray(lastNewline + 1) };
}

function parseLine(line: string, ordinal: number, offset: number): LogRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new SegmentLogError(
      "corrupt-record",
      `Segment ${ordinal} holds a line at byte ${offset} that is not JSON. ` +
        "It is not repaired, because only the tail of the final segment can be " +
        "damaged by a crash; damage anywhere else means the file was altered."
    );
  }

  const kind = (raw as { record?: unknown } | null)?.record;
  if (!isKnownRecordKind(kind)) {
    throw new SegmentLogError(
      "unknown-record-kind",
      `Segment ${ordinal} holds an unrecognised record kind ${JSON.stringify(kind)} at byte ${offset}. ` +
        "This log was written by a newer Atlas. Refusing to load it: a reader " +
        "that skips records it does not understand would serve reads as if they " +
        "were complete, and would then let compaction discard the originals."
    );
  }

  const parsed = LogRecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SegmentLogError(
      "corrupt-record",
      `Segment ${ordinal} holds a malformed ${kind} record at byte ${offset}: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

function readSegment(
  directory: string,
  ordinal: number,
  isLast: boolean,
  expectFeedEpoch: string | undefined
): { lines: ParsedLine[]; complete: Buffer; torn: Buffer; header: SegmentHeaderRecord } {
  const path = join(directory, segmentFileName(ordinal));
  const raw = readFileSync(path);

  if (raw.length === 0) {
    throw new SegmentLogError(
      "empty-segment",
      `Segment ${ordinal} is zero bytes. Every segment is created with a header, ` +
        "so an empty one was truncated rather than written — this is the exact " +
        "shape of the production journal that reads as 0 bytes today and cost " +
        "169,205 mutations. If a crash landed between creating the newest " +
        "segment and writing its header, that file holds no records and can be " +
        "removed; anything else needs a restore."
    );
  }

  const split = splitLines(raw);
  if (split.torn.length > 0 && !isLast) {
    throw new SegmentLogError(
      "torn-record-mid-log",
      `Segment ${ordinal} ends mid-record but is not the final segment. A sealed ` +
        "segment was fsynced and closed before the next one was created, so it " +
        "cannot have been torn by a crash."
    );
  }

  const lines: ParsedLine[] = [];
  let offset = 0;
  const text = split.complete.toString("utf8");
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    lines.push({ record: parseLine(line, ordinal, offset), offset });
    offset += Buffer.byteLength(line, "utf8") + 1;
  }

  const first = lines[0];
  if (!first || first.record.record !== "header") {
    throw new SegmentLogError(
      "missing-header",
      `Segment ${ordinal} does not begin with a header record.`
    );
  }
  if (first.record.log_format !== LOG_FORMAT) {
    throw new SegmentLogError(
      "format-mismatch",
      `Segment ${ordinal} declares log format ${first.record.log_format}, expected ${LOG_FORMAT}.`
    );
  }
  if (first.record.segment_ordinal !== ordinal) {
    throw new SegmentLogError(
      "ordinal-mismatch",
      `Segment file ${segmentFileName(ordinal)} declares ordinal ${first.record.segment_ordinal}. ` +
        "A renamed segment would reorder the log."
    );
  }
  if (expectFeedEpoch !== undefined && first.record.feed_epoch !== expectFeedEpoch) {
    throw new SegmentLogError(
      "feed-epoch-mismatch",
      `Segment ${ordinal} belongs to feed epoch ${first.record.feed_epoch}, not ${expectFeedEpoch}. ` +
        "Two epochs in one directory would make `seq` ambiguous for every consumer."
    );
  }

  return { lines, complete: split.complete, torn: split.torn, header: first.record };
}

/**
 * Rebuild the log from the segment files and nothing else.
 *
 * There is no index file and no snapshot to consult, which is the point: a
 * cached index cannot become a second source of truth if it never outlives the
 * process that built it.
 */
export function scanSegmentLog(directory: string, options: ScanOptions = {}): SegmentScan {
  const repair = options.repair ?? false;
  const entries = existsSync(directory) ? readdirSync(directory) : [];

  const ordinals: number[] = [];
  const ignoredFiles: string[] = [];
  for (const entry of entries) {
    const ordinal = segmentOrdinalOf(entry);
    if (ordinal === undefined) ignoredFiles.push(entry);
    else ordinals.push(ordinal);
  }
  ordinals.sort((left, right) => left - right);

  const assertions: Assertion[] = [];
  const byId = new Map<AssertionId, Assertion>();
  const submissions = new Map<string, SubmissionReceipt>();
  const reclaimed = new Map<AssertionId, ReclamationNote>();
  const segments: SegmentSummary[] = [];
  const repairs: RepairNote[] = [];
  const conflictingSupersessions: AssertionId[] = [];

  let feedEpoch = options.expectFeedEpoch;
  let historyFloor: RecordedAt | undefined;
  let publishedWatermark = 0;
  let highSeq = 0;
  let lastRecordedMillis = 0;
  let active: { ordinal: number; bytes: number; records: number } | undefined;

  const noteInstant = (instant: RecordedAt): void => {
    const millis = new Date(instant).getTime();
    if (Number.isFinite(millis) && millis > lastRecordedMillis) lastRecordedMillis = millis;
  };

  // Supersession stamps are applied after every body is known, because a stamp
  // may be written in an earlier segment than the record it refers to is
  // reachable from, and because a stamp for a body that compaction already
  // reclaimed must be dropped rather than resurrect a shell record.
  const pendingStamps: { assertion_id: AssertionId; superseded_at: RecordedAt; superseded_by: AssertionId }[] = [];

  for (let index = 0; index < ordinals.length; index += 1) {
    const ordinal = ordinals[index];
    if (ordinal === undefined) continue;
    const isLast = index === ordinals.length - 1;
    const segment = readSegment(directory, ordinal, isLast, feedEpoch);

    const header = segment.header;
    feedEpoch = header.feed_epoch;
    // The floor only ever advances, so the newest statement of it wins — and
    // every segment restates it, so reclaiming early segments cannot lower it.
    if (historyFloor === undefined || header.history_floor > historyFloor) {
      historyFloor = header.history_floor;
    }
    noteInstant(header.created_at);

    const summary: SegmentSummary = {
      ordinal,
      path: join(directory, segmentFileName(ordinal)),
      bytes: segment.complete.length,
      assertion_ids: [],
      seqs: [],
      receipts: [],
      holds_repair: false
    };

    // Records of a commit that has not been closed by its receipt yet.
    let openGroup: LogRecord[] = [];
    let openGroupOffset = 0;
    let records = 0;

    for (const line of segment.lines) {
      const record = line.record;
      if (record.record === "header") continue;
      records += 1;

      if (opensCommitGroup(record)) {
        if (openGroup.length === 0) openGroupOffset = line.offset;
        openGroup.push(record);
        continue;
      }

      if (record.record === "submission") {
        for (const member of openGroup) {
          if (member.record === "assertion") {
            const assertion = member.assertion;
            assertions.push(assertion);
            byId.set(assertion.assertion_id, assertion);
            summary.assertion_ids.push(assertion.assertion_id);
            summary.seqs.push(assertion.seq);
            if (assertion.seq > highSeq) highSeq = assertion.seq;
            noteInstant(assertion.recorded_at);
          } else if (member.record === "supersession") {
            pendingStamps.push({
              assertion_id: member.assertion_id,
              superseded_at: member.superseded_at,
              superseded_by: member.superseded_by
            });
            noteInstant(member.superseded_at);
          }
        }
        openGroup = [];
        const receipt = record.receipt;
        submissions.set(submissionKey(receipt.client_id, receipt.idempotency_key), receipt);
        noteInstant(receipt.committed_at);
        summary.receipts.push(receipt);
        continue;
      }

      // Everything below stands alone, so an open group at this point means a
      // commit was interleaved with something else — which the writer cannot do.
      if (openGroup.length > 0) {
        throw new SegmentLogError(
          "incomplete-commit-mid-log",
          `Segment ${ordinal} holds a commit without its receipt at byte ${openGroupOffset}, ` +
            "followed by unrelated records. A commit is written as one group, so " +
            "this cannot be a torn write."
        );
      }

      if (record.record === "watermark") {
        publishedWatermark = Math.max(publishedWatermark, record.published_seq);
        noteInstant(record.published_at);
      } else if (record.record === "history-floor") {
        if (historyFloor === undefined || record.history_floor > historyFloor) {
          historyFloor = record.history_floor;
        }
        noteInstant(record.advanced_at);
      } else if (record.record === "compaction") {
        for (let position = 0; position < record.reclaimed_assertion_ids.length; position += 1) {
          const id = record.reclaimed_assertion_ids[position];
          const seq = record.reclaimed_seqs[position];
          if (id === undefined || seq === undefined) continue;
          reclaimed.set(id, {
            seq,
            reclaimed_at: record.compacted_at,
            reclaimed_from_segment: record.reclaimed_segments[0] ?? ordinal
          });
        }
        publishedWatermark = Math.max(publishedWatermark, record.published_watermark);
        if (record.high_seq > highSeq) highSeq = record.high_seq;
        if (historyFloor === undefined || record.history_floor > historyFloor) {
          historyFloor = record.history_floor;
        }
        noteInstant(record.high_recorded_at);
        noteInstant(record.compacted_at);
      } else if (record.record === "repair") {
        noteInstant(record.repaired_at);
        summary.holds_repair = true;
      }
    }

    let liveBytes = segment.complete.length;

    // A commit left open at end-of-file never returned a receipt to anyone, so
    // it never happened. Replaying it would burn seq values for records the
    // caller does not know about and would make the caller's retry mint a
    // second copy.
    if (openGroup.length > 0) {
      if (!isLast) {
        throw new SegmentLogError(
          "incomplete-commit-mid-log",
          `Segment ${ordinal} ends with a commit that has no receipt, but it is not the final segment.`
        );
      }
      const discarded = segment.complete.subarray(openGroupOffset);
      repairs.push({
        segment_ordinal: ordinal,
        reason: "incomplete-commit",
        discarded_bytes: discarded.length,
        discarded_digest: digestOf(discarded)
      });
      liveBytes = openGroupOffset;
      records -= openGroup.length;
    }

    if (segment.torn.length > 0) {
      repairs.push({
        segment_ordinal: ordinal,
        reason: "torn-tail",
        discarded_bytes: segment.torn.length,
        discarded_digest: digestOf(segment.torn)
      });
    }

    if (repair && (liveBytes !== segment.complete.length || segment.torn.length > 0)) {
      // Truncate for real rather than skipping the bytes at read time. Leaving
      // them in place would weld garbage into the middle of the file the moment
      // the next commit appends past it, turning a repairable tail into
      // permanent mid-log corruption.
      truncateSync(summary.path, liveBytes);
    }

    summary.bytes = liveBytes;
    segments.push(summary);
    if (isLast) active = { ordinal, bytes: liveBytes, records };
  }

  for (const stamp of pendingStamps) {
    const target = byId.get(stamp.assertion_id);
    if (!target) continue;
    if (target.superseded_at !== null) {
      if (target.superseded_by !== stamp.superseded_by) {
        conflictingSupersessions.push(stamp.assertion_id);
      }
      continue;
    }
    target.superseded_at = stamp.superseded_at;
    target.superseded_by = stamp.superseded_by;
  }

  // The compaction record is written BEFORE its segments are unlinked, so a
  // crash in between leaves a record announcing reclamations that did not
  // finish. The bodies are the authority: an id whose assertion is still on
  // disk was not reclaimed, whatever the announcement says. This is what makes
  // the write-then-unlink order safe — a crash leaves a superset of the truth.
  for (const id of [...reclaimed.keys()]) {
    if (byId.has(id)) reclaimed.delete(id);
  }

  assertions.sort((left, right) => left.seq - right.seq);

  return {
    feed_epoch: feedEpoch ?? "e1",
    history_floor: historyFloor ?? "1970-01-01T00:00:00.000Z",
    restored: {
      feed_epoch: feedEpoch ?? "e1",
      history_floor: historyFloor ?? "1970-01-01T00:00:00.000Z",
      assertions,
      submissions,
      reclaimed,
      next_seq: highSeq + 1,
      last_recorded_millis: lastRecordedMillis,
      published_watermark: publishedWatermark
    },
    segments,
    active,
    repairs,
    ignored_files: ignoredFiles,
    conflicting_supersessions: conflictingSupersessions
  };
}
