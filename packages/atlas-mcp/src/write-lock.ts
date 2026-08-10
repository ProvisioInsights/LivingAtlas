import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * THE CROSS-PROCESS SINGLE-WRITER GUARD (ADR 0035).
 *
 * `openAtlasStore` already refuses a second read-write handle inside ONE
 * process. Nothing stopped a second PROCESS: the long-lived HTTP service and a
 * `real-data:*` maintenance runner, or two services started twice by an impatient
 * operator, would each open the same segment logs read-write and interleave
 * appends into them. That does not fail loudly — it corrupts the commit groups
 * the reader depends on, in the one store that holds irreplaceable data.
 *
 * So a writer takes a lock file in the store root and holds it for its lifetime.
 *
 * ## Why `wx` and not "check, then create"
 *
 * `openSync(path, "wx")` creates-or-fails in ONE syscall. Testing `existsSync`
 * and then creating is two, and two processes starting together both pass the
 * test before either creates — the classic race, and precisely the case this
 * guard exists for.
 *
 * ## Why a dead holder is reclaimed rather than honoured
 *
 * A machine that loses power mid-write leaves the file behind with nobody
 * holding it. Honouring it forever would mean the service never starts again and
 * the store is unwritable until somebody deletes a file they have to know about
 * — a worse failure than the one being prevented, and one that arrives at the
 * worst moment. So a lock naming a pid that is NOT running is stale and is
 * reclaimed, loudly.
 *
 * `process.kill(pid, 0)` sends no signal; it asks whether the pid can be
 * signalled. `ESRCH` means no such process. `EPERM` means it exists and belongs
 * to somebody else — which is very much alive, so the lock is honoured.
 *
 * A lock file whose contents we cannot parse is NEVER reclaimed: it was not
 * written by this code, and deleting a file we do not understand from inside a
 * data directory is not a repair.
 */

export const WRITE_LOCK_FILENAME = ".atlas-write.lock" as const;

export function writeLockPath(storeDirectory: string): string {
  return join(storeDirectory, WRITE_LOCK_FILENAME);
}

/** What the lock file holds. Diagnostic, and the basis for the liveness check. */
export type WriteLockRecord = {
  pid: number;
  /** Free text naming what took it, for an operator reading the file. */
  holder: string;
  acquired_at: string;
};

export type WriteLock = {
  path: string;
  record: WriteLockRecord;
  /** Reclaimed a stale lock on the way in; the previous holder's pid. */
  reclaimedFrom?: number;
  release(): void;
};

export type WriteLockRefusal = {
  ok: false;
  code: "held" | "unreadable";
  path: string;
  /** Present when the file parsed and named a live process. */
  heldBy?: WriteLockRecord;
  message: string;
};

export type WriteLockOutcome = { ok: true; lock: WriteLock } | WriteLockRefusal;

/** True when a process with this id exists and could be signalled by somebody. */
export function processIsAlive(pid: number, kill: (pid: number, signal: 0) => void = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM: it exists and is not ours. That is alive, and honouring it is the
    // safe answer — reclaiming a lock held by a process we merely cannot signal
    // is how two writers end up on one log.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(path: string): WriteLockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WriteLockRecord>;
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      holder: typeof parsed.holder === "string" ? parsed.holder : "unknown",
      acquired_at: typeof parsed.acquired_at === "string" ? parsed.acquired_at : "unknown"
    };
  } catch {
    return undefined;
  }
}

/**
 * Take the write lock for `storeDirectory`, or report who holds it.
 *
 * Never throws for the expected refusal — a second writer is an operating
 * condition an entrypoint reports and exits on, not an exception it stringifies.
 */
export function acquireWriteLock(
  storeDirectory: string,
  options: { holder?: string; pid?: number; now?: () => Date } = {}
): WriteLockOutcome {
  const path = writeLockPath(storeDirectory);
  const pid = options.pid ?? process.pid;
  const holder = options.holder ?? "atlas-mcp";
  const now = options.now ?? (() => new Date());

  const take = (reclaimedFrom?: number): WriteLockOutcome => {
    const record: WriteLockRecord = { pid, holder, acquired_at: now().toISOString() };
    let handle: number;
    try {
      // `wx`: create exclusively. If somebody won the race between our check and
      // here, this throws EEXIST and we report them rather than overwrite.
      handle = openSync(path, "wx", 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const winner = readRecord(path);
      return {
        ok: false,
        code: "held",
        path,
        ...(winner ? { heldBy: winner } : {}),
        message: `another process took the Atlas write lock at ${path} first`
      };
    }
    try {
      writeSync(handle, JSON.stringify(record));
    } finally {
      closeSync(handle);
    }
    return {
      ok: true,
      lock: {
        path,
        record,
        ...(reclaimedFrom === undefined ? {} : { reclaimedFrom }),
        release: () => {
          // Only ours. A release that unlinked whatever is there would delete a
          // lock somebody else took after we lost ours to a reclaim.
          const current = readRecord(path);
          if (current?.pid === pid) rmSync(path, { force: true });
        }
      }
    };
  };

  if (!existsSync(path)) return take();

  const existing = readRecord(path);
  if (existing === undefined) {
    return {
      ok: false,
      code: "unreadable",
      path,
      message:
        `the Atlas write lock at ${path} cannot be read as a lock record. It is NOT reclaimed: ` +
        "this code did not write it, and deleting an unrecognised file inside a store directory " +
        "is not a repair. Inspect it and remove it by hand if it is debris."
    };
  }
  if (processIsAlive(existing.pid)) {
    return {
      ok: false,
      code: "held",
      path,
      heldBy: existing,
      message:
        `the Atlas store at ${storeDirectory} is already held read-write by pid ${existing.pid} ` +
        `(${existing.holder}, since ${existing.acquired_at}). Two writers appending to one segment ` +
        "log interleave records and corrupt the commit groups the reader depends on."
    };
  }

  // Stale: the holder is gone. Reclaim, and say so — a reclaim is evidence of a
  // previous crash, and an operator who never hears about it never looks.
  rmSync(path, { force: true });
  return take(existing.pid);
}
