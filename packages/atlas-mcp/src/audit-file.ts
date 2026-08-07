import { closeSync, fsyncSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  LocalPrivateDirectoryMode,
  LocalPrivateFileMode,
  writeAllSync
} from "@living-atlas/atlas-core";
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

/**
 * The store's own local-private modes rather than two more octal literals. The
 * migration plane already proved what a second copy of these constants costs:
 * it re-typed neither, opened its sidecars with no mode at all, and landed them
 * at 0644 beside a store that was otherwise 0600 throughout.
 */
const FILE_MODE = LocalPrivateFileMode;
const DIRECTORY_MODE = LocalPrivateDirectoryMode;

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
 * The handle stays open across events rather than being reopened per event:
 * reopening per append would add two syscalls to every tool call and, worse,
 * would make the durability depend on close() semantics that differ across
 * platforms.
 *
 * IT DOES REOPEN WHEN THE PATH STOPS NAMING THE FILE IT HOLDS. Log rotation
 * renames the journal out from under this process, and a handle held for the
 * process's life then keeps appending to the unlinked inode — so the documented
 * audit path is empty for the rest of the session and the events land in a file
 * the rotator's own glob no longer matches. Measured over real stdio: after a
 * rename, the live path was ABSENT and the next event was 937 bytes into
 * `...audit.jsonl.1`. The rotation script's comment asserted the writer would
 * "reopen", which was a property nothing implemented. Now something does.
 *
 * One `stat` of the path per event pays for it. That is cheap beside the fsync
 * this class exists to perform, and the alternative — an audit trail that
 * silently relocates — is not a trail.
 */
export class DurableFileAuditJournal implements AuditJournal {
  private readonly path: string;
  private readonly fsync: (handle: number) => void;
  private handle: number;
  /** The inode the open handle points at, so a rename is detectable. */
  private inode: number;
  private closed = false;

  constructor(path: string, options: DurableAuditJournalOptions = {}) {
    this.path = path;
    this.fsync = options.fsync ?? fsyncSync;
    mkdirSync(dirname(path), { recursive: true, mode: DIRECTORY_MODE });
    this.handle = openSync(path, "a", FILE_MODE);
    this.inode = statSync(path).ino;
  }

  /**
   * Point the handle back at the path when the two have diverged.
   *
   * A rename leaves the old inode alive with `nlink` still 1, so checking for
   * unlinking alone would miss exactly the case rotation produces. Comparing the
   * PATH's inode against the handle's catches a rename, a delete and a
   * replacement with the same one check.
   */
  private reopenIfPathMoved(): void {
    let current: number | undefined;
    try {
      current = statSync(this.path).ino;
    } catch {
      // The path is gone — deleted, or renamed with nothing put back. Either
      // way the handle no longer writes anywhere anybody can read.
      current = undefined;
    }
    if (current === this.inode) return;

    // The old handle's bytes are already durable (every append fsynced before it
    // returned), so nothing is lost by closing it.
    closeSync(this.handle);
    this.handle = openSync(this.path, "a", FILE_MODE);
    this.inode = statSync(this.path).ino;
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
    this.reopenIfPathMoved();
    // Every byte, or a throw. A short write would leave half an event on the
    // line and the caller would be told the disclosure was recorded.
    writeAllSync(this.handle, `${JSON.stringify(event)}\n`);
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
