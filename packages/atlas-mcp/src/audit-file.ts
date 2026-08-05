import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditEvent, AuditJournal } from "./audit.js";

/**
 * The audit journal that actually satisfies the port's promise.
 *
 * `AuditJournal.append` is documented as returning only once the event is
 * written, so that "a result can never reach a consumer describing a disclosure
 * the log does not know about". Both CLIs implemented it with `appendFileSync`
 * and a comment saying fsync was skipped because "the log is not the graph".
 * That made the promise false in exactly the case it exists for: `appendFileSync`
 * returns once the bytes are in the page cache, so a crash in the window that
 * follows loses the event while the disclosure has already gone out the door.
 * The surviving state is then a graph that was read and a log that says it was
 * not — the one direction the discrepancy must never point.
 *
 * ADR 0014 OPEN-4 asked whether a disclosure event must be fsync-durable before
 * the disclosure returns. It must, and the conservative reading is applied to
 * EVERY event rather than to reveals alone: a journal that is durable only for
 * the calls someone remembered to mark is a journal whose guarantee nobody can
 * state. Uniform durability also means the reveal path needs no special case —
 * it inherits the property from the port.
 *
 * This is `commit()`'s discipline, deliberately the same shape as
 * `SegmentWriter.appendGroup`: one open handle, `writeSync` then `fsyncSync`,
 * and the call returns only after the sync. The cost is one fsync per tool
 * call, which is the price of an audit trail whose absence of an entry means
 * the call did not happen.
 */

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

export type DurableAuditJournalOptions = {
  /**
   * The sync primitive, injectable so a test can observe that it ran.
   *
   * A durability guarantee nothing exercises is a comment. The default is the
   * real `fsyncSync` and no production path passes anything else.
   */
  fsync?: (handle: number) => void;
};

/**
 * Append-only, one JSON object per line, fsynced before `append` returns.
 *
 * The handle stays open for the process's life rather than being reopened per
 * event: reopening per append would add two syscalls to every tool call and,
 * worse, would make the durability depend on close() semantics that differ
 * across platforms.
 */
export class DurableFileAuditJournal implements AuditJournal {
  private readonly handle: number;
  private readonly fsync: (handle: number) => void;
  private closed = false;

  constructor(path: string, options: DurableAuditJournalOptions = {}) {
    this.fsync = options.fsync ?? fsyncSync;
    mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    this.handle = openSync(path, "a", FILE_MODE);
  }

  /**
   * Returns only once this event is durable.
   *
   * A failure is NOT swallowed. The dispatcher treats a throw here as the call
   * failing, so a disclosure whose event could not be written is a disclosure
   * that does not reach the caller — fail-closed, matching `commit()`, and the
   * reason this method must not "best effort" its way past a full disk.
   */
  append(event: AuditEvent): void {
    if (this.closed) throw new Error("audit journal is closed");
    writeSync(this.handle, `${JSON.stringify(event)}\n`);
    this.fsync(this.handle);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Sync before closing: a buffered write lost at close is the same lost
    // event as one lost to a crash.
    this.fsync(this.handle);
    closeSync(this.handle);
  }
}
