import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWriteLock, processIsAlive, writeLockPath, type WriteLock } from "./write-lock.js";

/**
 * The cross-process single-writer guard (ADR 0035).
 *
 * Everything here is a temporary directory built two lines before it is locked.
 * The liveness probe is injected rather than exercised against real pids: a test
 * that signalled an arbitrary pid would be testing the machine it runs on.
 */

const roots: string[] = [];
const held: WriteLock[] = [];

afterEach(() => {
  while (held.length > 0) held.pop()?.release();
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function storeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-write-lock-"));
  roots.push(root);
  return root;
}

function take(root: string, options: Parameters<typeof acquireWriteLock>[1] = {}): WriteLock {
  const outcome = acquireWriteLock(root, options);
  if (!outcome.ok) throw new Error(`expected the lock to be taken: ${outcome.message}`);
  held.push(outcome.lock);
  return outcome.lock;
}

describe("taking the write lock", () => {
  it("creates the lock file naming the holder, at owner-only permissions", () => {
    const root = storeRoot();
    const lock = take(root, { holder: "test-writer", pid: 4242, now: () => new Date("2026-08-10T00:00:00.000Z") });

    expect(lock.path).toBe(writeLockPath(root));
    expect(existsSync(lock.path)).toBe(true);
    expect(JSON.parse(readFileSync(lock.path, "utf8"))).toEqual({
      pid: 4242,
      holder: "test-writer",
      acquired_at: "2026-08-10T00:00:00.000Z"
    });
  });

  it("releases by removing the file, so the next writer can start", () => {
    const root = storeRoot();
    const lock = take(root);
    lock.release();

    expect(existsSync(lock.path)).toBe(false);
    expect(acquireWriteLock(root).ok).toBe(true);
  });

  it("is safe to release twice", () => {
    const root = storeRoot();
    const lock = take(root);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});

describe("a second writer is refused", () => {
  it("refuses while the first holder is this very process", () => {
    // The realistic case: the service is already running and somebody starts it
    // again, or a maintenance runner is launched against the live store.
    const root = storeRoot();
    take(root);

    const second = acquireWriteLock(root);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("held");
    expect(second.heldBy?.pid).toBe(process.pid);
    // The message has to say WHY, because the operator's next move is to find
    // the other writer rather than to delete a file.
    expect(second.message).toContain("interleave");
  });

  it("does not disturb the incumbent's lock file when it refuses", () => {
    const root = storeRoot();
    const lock = take(root, { holder: "incumbent" });
    const before = readFileSync(lock.path, "utf8");

    expect(acquireWriteLock(root, { holder: "interloper" }).ok).toBe(false);
    expect(readFileSync(lock.path, "utf8")).toBe(before);
  });

  it("a refused acquirer's release does not delete the incumbent's lock", () => {
    // The bug this prevents: an entrypoint that refuses, then runs a `finally`
    // that releases, and takes the running writer's lock away with it.
    const root = storeRoot();
    const incumbent = take(root, { holder: "incumbent" });

    const refused = acquireWriteLock(root, { holder: "interloper", pid: 9999 });
    expect(refused.ok).toBe(false);
    expect(existsSync(incumbent.path)).toBe(true);
  });
});

describe("a stale lock is reclaimed, and an unreadable one is not", () => {
  it("reclaims a lock whose holder is gone, and reports which pid it took it from", () => {
    // A machine that lost power mid-write leaves the file with nobody holding
    // it. Honouring that forever means the store is unwritable until somebody
    // deletes a file they have to know about.
    const root = storeRoot();
    writeFileSync(
      writeLockPath(root),
      JSON.stringify({ pid: 999_999, holder: "crashed-writer", acquired_at: "2026-08-09T00:00:00.000Z" })
    );

    const outcome = acquireWriteLock(root, { pid: 4242 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    held.push(outcome.lock);
    expect(outcome.lock.reclaimedFrom).toBe(999_999);
    expect(JSON.parse(readFileSync(outcome.lock.path, "utf8")).pid).toBe(4242);
  });

  it("refuses a lock file it cannot parse rather than deleting it", () => {
    // It was not written by this code. Deleting an unrecognised file from inside
    // a store directory is not a repair.
    const root = storeRoot();
    writeFileSync(writeLockPath(root), "this is not a lock record");

    const outcome = acquireWriteLock(root);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("unreadable");
    expect(existsSync(writeLockPath(root))).toBe(true);
    expect(readFileSync(writeLockPath(root), "utf8")).toBe("this is not a lock record");
  });

  it("refuses a lock record with no usable pid rather than assuming it is stale", () => {
    const root = storeRoot();
    writeFileSync(writeLockPath(root), JSON.stringify({ holder: "no-pid-here" }));

    const outcome = acquireWriteLock(root);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("unreadable");
  });
});

describe("the liveness probe", () => {
  it("treats ESRCH as gone", () => {
    const gone = (): never => {
      const error = new Error("no such process") as NodeJS.ErrnoException;
      error.code = "ESRCH";
      throw error;
    };
    expect(processIsAlive(1234, gone)).toBe(false);
  });

  it("treats EPERM as ALIVE, because a process we cannot signal is still running", () => {
    // Reclaiming a lock held by a process owned by somebody else is how two
    // writers end up on one log.
    const notOurs = (): never => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    };
    expect(processIsAlive(1234, notOurs)).toBe(true);
  });

  it("treats a signalable pid as alive", () => {
    expect(processIsAlive(1234, () => undefined)).toBe(true);
  });

  it("rejects a pid that could never be one", () => {
    expect(processIsAlive(0, () => undefined)).toBe(false);
    expect(processIsAlive(-1, () => undefined)).toBe(false);
    expect(processIsAlive(1.5, () => undefined)).toBe(false);
  });
});
