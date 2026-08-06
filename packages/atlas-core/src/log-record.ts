import { z } from "zod";
import { AssertionSchema } from "./assertion.js";
import { AssertionIdSchema } from "./ids.js";
import { RecordedAtSchema } from "./time.js";
import { SubmissionReceiptSchema } from "./store.js";

/**
 * The on-disk log format: newline-delimited JSON, one record per line, appended
 * and never rewritten.
 *
 * The format has exactly one job that a snapshot cannot do — it is EVIDENCE.
 * A committed line stays byte-for-byte where it was written, so "this record
 * was not altered" is checkable by reading the file rather than by trusting the
 * process that wrote it. That is why supersession is a separate appended record
 * instead of an edit to the line it supersedes: an in-place stamp would make
 * every prior line suspect, because a writer that can seek can seek anywhere.
 *
 * The old store's shape was the opposite. It kept `Map<ObjectId, Envelope>`
 * behind a snapshot plus a journal, overwrote the envelope on every mutation,
 * and periodically wrote the journal back to zero bytes. Nothing in the files
 * distinguished "no mutations happened" from "169,205 mutations were erased".
 */
export const LOG_FORMAT = "atlas.segment-log:v1";

/**
 * Every segment opens with a header, and that is load-bearing rather than
 * decorative: it is what makes a zero-byte segment DETECTABLE. Production's
 * `journal.jsonl` is 0 bytes today and reads exactly like a log that was never
 * written to. A segment that must start with a header cannot be confused with
 * an empty one, so truncation announces itself.
 *
 * Each header restates `feed_epoch` and the history floor in effect when the
 * segment was created, so a segment is independently interpretable — which is
 * the precondition for reasoning about segments one at a time during
 * compaction.
 */
export const SegmentHeaderRecordSchema = z
  .object({
    record: z.literal("header"),
    log_format: z.literal(LOG_FORMAT),
    segment_ordinal: z.number().int().positive(),
    feed_epoch: z.string(),
    history_floor: RecordedAtSchema,
    created_at: RecordedAtSchema
  })
  .strict();

/**
 * `submission_id` on every record of a commit is what makes an atomic commit
 * boundary expressible in an append-only file: the receipt is written LAST and
 * closes the group, so a group without its receipt is a commit that died
 * mid-write and was never acknowledged to anyone.
 */
export const AssertionRecordSchema = z
  .object({
    record: z.literal("assertion"),
    submission_id: z.string(),
    assertion: AssertionSchema
  })
  .strict();

export const SupersessionRecordSchema = z
  .object({
    record: z.literal("supersession"),
    submission_id: z.string(),
    assertion_id: AssertionIdSchema,
    superseded_at: RecordedAtSchema,
    superseded_by: AssertionIdSchema
  })
  .strict();

/** The commit marker. Its presence is what makes the preceding records real. */
export const SubmissionRecordSchema = z
  .object({
    record: z.literal("submission"),
    receipt: SubmissionReceiptSchema
  })
  .strict();

/**
 * Publishing a change-feed range is a security-relevant event: it is the only
 * thing that authorises compaction to reclaim that range later. It is journalled
 * for the same reason mutations are — a decision that permits deletion has to be
 * inspectable after the fact.
 */
export const WatermarkRecordSchema = z
  .object({
    record: z.literal("watermark"),
    published_seq: z.number().int().nonnegative(),
    published_at: RecordedAtSchema
  })
  .strict();

export const HistoryFloorRecordSchema = z
  .object({
    record: z.literal("history-floor"),
    history_floor: RecordedAtSchema,
    advanced_at: RecordedAtSchema
  })
  .strict();

/**
 * The proof of what compaction discarded, written BEFORE the segments are
 * unlinked so that a crash mid-compaction leaves a superset of the truth rather
 * than a subset. It also carries forward everything the reclaimed segments were
 * the last holders of: the high-water `seq` (so ids can never be reissued), the
 * highest belief instant (so belief time cannot go backwards), the published
 * watermark, and the history floor.
 */
export const CompactionRecordSchema = z
  .object({
    record: z.literal("compaction"),
    compacted_at: RecordedAtSchema,
    reclaimed_segments: z.array(z.number().int().positive()),
    reclaimed_assertion_ids: z.array(AssertionIdSchema),
    /** Parallel to `reclaimed_assertion_ids`: the seq each one held. */
    reclaimed_seqs: z.array(z.number().int().positive()),
    high_seq: z.number().int().nonnegative(),
    high_recorded_at: RecordedAtSchema,
    published_watermark: z.number().int().nonnegative(),
    history_floor: RecordedAtSchema
  })
  .strict();

/**
 * A torn tail that was truncated on load. The digest lets a human confirm
 * exactly which bytes were dropped against a backup without copying the
 * plaintext of a possibly-sensitive record into the audit trail a second time.
 */
export const RepairRecordSchema = z
  .object({
    record: z.literal("repair"),
    repaired_at: RecordedAtSchema,
    segment_ordinal: z.number().int().positive(),
    reason: z.enum(["torn-tail", "incomplete-commit", "other"]),
    discarded_bytes: z.number().int().nonnegative(),
    discarded_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  })
  .strict();

export const LogRecordSchema = z.discriminatedUnion("record", [
  SegmentHeaderRecordSchema,
  AssertionRecordSchema,
  SupersessionRecordSchema,
  SubmissionRecordSchema,
  WatermarkRecordSchema,
  HistoryFloorRecordSchema,
  CompactionRecordSchema,
  RepairRecordSchema
]);

export type LogRecord = z.infer<typeof LogRecordSchema>;
export type SegmentHeaderRecord = z.infer<typeof SegmentHeaderRecordSchema>;
export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;
export type RepairRecord = z.infer<typeof RepairRecordSchema>;

export const LOG_RECORD_KINDS = [
  "header",
  "assertion",
  "supersession",
  "submission",
  "watermark",
  "history-floor",
  "compaction",
  "repair"
] as const;

export type LogRecordKind = (typeof LOG_RECORD_KINDS)[number];

/**
 * Records that leave a commit OPEN, versus records that stand alone.
 *
 * Only assertions and their supersession stamps are open; everything else is
 * self-closing. At end-of-file an open group is a commit that never finished,
 * and it must be discarded rather than replayed — the caller never received a
 * receipt for it, so replaying it would resurrect a commit nobody was told
 * happened and would make the caller's retry mint a duplicate.
 */
export function opensCommitGroup(record: LogRecord): boolean {
  return record.record === "assertion" || record.record === "supersession";
}

export function isKnownRecordKind(kind: unknown): kind is LogRecordKind {
  return typeof kind === "string" && (LOG_RECORD_KINDS as readonly string[]).includes(kind);
}
