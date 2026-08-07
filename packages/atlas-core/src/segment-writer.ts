import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LogRecord } from "./log-record.js";

/**
 * Segments are named by a zero-padded ordinal so that lexical order IS log
 * order. There is deliberately no manifest file listing them: a manifest is one
 * more thing that can disagree with the directory, and the disagreement is
 * always resolved in favour of whichever one the reader happened to trust. The
 * directory listing is the manifest.
 */
const SEGMENT_DIGITS = 10;
const SEGMENT_SUFFIX = ".ndjson";
const SEGMENT_PATTERN = new RegExp(`^\\d{${SEGMENT_DIGITS}}\\${SEGMENT_SUFFIX}$`);

/**
 * Owner-only. New content defaults to local-private, including its bytes.
 *
 * EXPORTED because the store is not only these segment files. The migration
 * plane writes two sidecar files of its own into the same target root, and it
 * opened both without a mode until they were found at 0644 — the one file
 * holding the owner's outline prose verbatim was the one file in the store
 * anybody on the machine could read. Two octal literals in two packages are two
 * things that drift; a store-wide rule has to be a store-wide constant.
 */
export const LocalPrivateFileMode = 0o600;
export const LocalPrivateDirectoryMode = 0o700;
const FILE_MODE = LocalPrivateFileMode;
const DIRECTORY_MODE = LocalPrivateDirectoryMode;

/**
 * Write every byte, or throw.
 *
 * `writeSync` is allowed to write FEWER bytes than it was handed — a short write
 * from a full disk (ENOSPC), a signal (EINTR) or a pipe — and it reports that by
 * returning the count, not by throwing. Every call site in this repo ignored the
 * return value, so a short write left a half-written line on disk and reported
 * success. In an append-only log that is a torn record welded into the file the
 * moment the next append lands past it.
 *
 * The payload is converted to a Buffer first so the retry can resume at a BYTE
 * offset: re-slicing a string by the byte count returned would cut a multi-byte
 * character in half and write a different line than the caller asked for.
 *
 * `write` is injectable for one reason: a short write cannot be provoked from a
 * test against a real file, so a loop nothing can exercise is a loop nobody
 * knows is correct. No production path passes anything but the default.
 */
export type PartialWrite = (
  handle: number,
  bytes: Buffer,
  offset: number,
  length: number
) => number;

export function writeAllSync(
  handle: number,
  payload: string | Buffer,
  write: PartialWrite = writeSync
): number {
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  let written = 0;
  while (written < bytes.length) {
    const advanced = write(handle, bytes, written, bytes.length - written);
    // A zero-byte write that does not throw would spin this loop forever, so it
    // is a refusal rather than a retry: the file cannot accept the record and
    // pretending otherwise is how a caller is told a write happened.
    if (advanced <= 0) {
      throw new Error(
        `write stalled after ${written} of ${bytes.length} bytes; the record is not durable and ` +
          "the caller must not be told it is"
      );
    }
    written += advanced;
  }
  return bytes.length;
}

/** 8 MiB. A roll HINT, never a write limit — see `appendGroup`. */
export const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

export function segmentFileName(ordinal: number): string {
  return `${String(ordinal).padStart(SEGMENT_DIGITS, "0")}${SEGMENT_SUFFIX}`;
}

export function segmentOrdinalOf(fileName: string): number | undefined {
  if (!SEGMENT_PATTERN.test(fileName)) return undefined;
  const ordinal = Number(fileName.slice(0, SEGMENT_DIGITS));
  return Number.isInteger(ordinal) && ordinal > 0 ? ordinal : undefined;
}

export function serializeRecord(record: SegmentRecord): string {
  return `${JSON.stringify(record)}\n`;
}

/**
 * The only thing this writer needs to know about a record: it is JSON and it
 * declares its kind. Everything above — assertions, entities, alias-ledger rows
 * — supplies its own record union and its own header.
 *
 * The generalisation is not speculative reuse. Atlas keeps two logs whose
 * retention rules are opposites: the assertion log reclaims whole segments once
 * they fall below the history floor, while the identity log is never reclaimed
 * at all, because an id Atlas once returned has to resolve forever. Those must
 * be separate directories with separate record unions, and the one thing they
 * must NOT have separately is this file — a second copy of the fsync-and-roll
 * dance is a second place for durability to be subtly wrong, and the copies
 * drift. (`submissionKey` was already found duplicated across two call sites
 * with two different separators; once is enough.)
 */
export type SegmentRecord = { record: string };

/**
 * Directory entries are only durable once the directory itself is synced.
 * Not every filesystem allows syncing a directory handle, and the file's own
 * fsync still gives the durable path on the local disks this store targets, so
 * a refusal here is tolerated rather than fatal.
 */
function fsyncDirectory(directory: string): void {
  let handle: number | undefined;
  try {
    handle = openSync(directory, "r");
    fsyncSync(handle);
  } catch {
    // Best effort; see above.
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // Best effort; see above.
      }
    }
  }
}

export type SegmentWriterOptions<R extends SegmentRecord> = {
  directory: string;
  /**
   * Called when a segment is created, never earlier. A header states the log's
   * state at the moment the file began — the assertion log's floor advances, so
   * a segment created after an advance has to record the newer one.
   */
  makeHeader: (ordinal: number) => R;
  maxSegmentBytes?: number;
  /** Continue an existing segment instead of starting a new one. */
  resume?: { ordinal: number; bytes: number; records: number };
};

/**
 * The append side of the log. Synchronous and fsync-per-group, because the
 * receipt a caller receives is a statement that the bytes are on disk.
 */
export class SegmentWriter<R extends SegmentRecord = LogRecord> {
  private readonly directory: string;
  private readonly makeHeader: (ordinal: number) => R;
  private readonly maxSegmentBytes: number;

  private handle: number;
  private ordinal: number;
  private activeBytes: number;
  /** Records beyond the header. Guards against rolling an empty segment. */
  private activeRecords: number;
  private closed = false;

  constructor(options: SegmentWriterOptions<R>) {
    this.directory = options.directory;
    this.makeHeader = options.makeHeader;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;

    mkdirSync(this.directory, { recursive: true, mode: DIRECTORY_MODE });

    const resume = options.resume;
    if (resume) {
      this.ordinal = resume.ordinal;
      this.activeBytes = resume.bytes;
      this.activeRecords = resume.records;
      this.handle = openSync(join(this.directory, segmentFileName(resume.ordinal)), "a", FILE_MODE);
      return;
    }
    this.ordinal = 1;
    this.activeBytes = 0;
    this.activeRecords = 0;
    this.handle = this.createSegment(1);
  }

  get activeOrdinal(): number {
    return this.ordinal;
  }

  private createSegment(ordinal: number): number {
    const path = join(this.directory, segmentFileName(ordinal));
    // "ax" so an existing segment is never reopened as if it were new. Silently
    // adopting a file we did not create is how two writers end up interleaving
    // into one log.
    const handle = openSync(path, "ax", FILE_MODE);
    const header = serializeRecord(this.makeHeader(ordinal));
    writeAllSync(handle, header);
    fsyncSync(handle);
    fsyncDirectory(this.directory);
    this.activeBytes = Buffer.byteLength(header, "utf8");
    this.activeRecords = 0;
    return handle;
  }

  private roll(): void {
    fsyncSync(this.handle);
    closeSync(this.handle);
    this.ordinal += 1;
    this.handle = this.createSegment(this.ordinal);
  }

  /**
   * Append one group as an indivisible unit.
   *
   * Two invariants come out of writing the whole group in a single call:
   *
   *  1. A record is never split across segments, so every segment parses on its
   *     own.
   *  2. A SEGMENT BOUNDARY IS ALWAYS A COMMIT BOUNDARY. The roll decision
   *     happens between groups, never inside one. That is what confines a
   *     half-written commit to the final segment, and it is what makes
   *     segment-granular compaction sound in the first place.
   *
   * The size bound is therefore a hint. A group larger than the bound gets its
   * own oversized segment rather than being refused: declining to persist a
   * legal write in order to honour a tuning constant would be the store
   * choosing its own convenience over the caller's data.
   */
  appendGroup(records: R[]): void {
    if (this.closed) throw new Error("segment writer is closed");
    if (records.length === 0) return;

    const payload = records.map(serializeRecord).join("");
    const bytes = Buffer.byteLength(payload, "utf8");

    if (this.activeRecords > 0 && this.activeBytes + bytes > this.maxSegmentBytes) {
      this.roll();
    }

    writeAllSync(this.handle, payload);
    fsyncSync(this.handle);
    this.activeBytes += bytes;
    this.activeRecords += records.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    fsyncSync(this.handle);
    closeSync(this.handle);
  }
}
