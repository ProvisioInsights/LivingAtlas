import { mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditRecorder, type AuditEvent } from "./audit.js";
import { DurableFileAuditJournal } from "./audit-file.js";
import { CONSUMER_PRINCIPAL, fixedClock } from "./testing.js";

/**
 * Everything here writes under `os.tmpdir()` and nowhere else. The journal
 * creates parent directories, so a test pointing it anywhere real would create
 * anywhere real.
 */
const directories: string[] = [];

function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), "atlas-audit-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  while (directories.length > 0) {
    const path = directories.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

function anEvent(recorder: AuditRecorder, tool: string): AuditEvent {
  return recorder.record({
    tool,
    principal: CONSUMER_PRINCIPAL,
    plane: "consumer",
    protocolVersion: "2026-07-28",
    outcome: "ok",
    counts: { returned: 1 },
    args: { probe: tool }
  });
}

describe("the durable audit journal", () => {
  it("writes THEN fsyncs THEN returns, so the event is durable before the result is", () => {
    /**
     * The ordering IS the guarantee. `appendFileSync` — what both CLIs used —
     * returns once the bytes reach the page cache, so a crash in the window that
     * follows loses an event whose disclosure had already gone out. ADR 0014
     * OPEN-4 resolves to `writeSync` then `fsyncSync`, returning after the sync.
     *
     * What the injected `fsync` records is the FILE, not merely that it ran. A
     * spy that pushes a bare `"fsync"` cannot tell `write`-then-`fsync` from
     * `fsync`-then-`write`: both produce `["fsync", "append-returned"]`, and the
     * second is precisely the `appendFileSync` defect this class exists to
     * remove. Measured — that mutant survived the whole 1,536-test suite. Asking
     * the filesystem how many bytes are on the file at the instant of the sync
     * makes the two orderings different observations: bytes first, or nothing to
     * sync.
     */
    const order: string[] = [];
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path, {
      fsync: () => {
        order.push(`fsync@${statSync(path).size}`);
      }
    });
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    const event = anEvent(recorder, "atlas.sensitive.reveal.v1");
    order.push("append-returned");

    // The whole serialized event, on the file, before the sync ran.
    const bytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
    expect(bytes).toBeGreaterThan(0);
    expect(order).toEqual([`fsync@${bytes}`, "append-returned"]);
  });

  it("syncs once per event rather than batching them", () => {
    // A journal that synced per batch would make the durability of any one
    // event depend on a later one arriving, which for a disclosure means it
    // depends on somebody else asking for something.
    let syncs = 0;
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path, { fsync: () => (syncs += 1) });
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    anEvent(recorder, "a");
    anEvent(recorder, "b");
    anEvent(recorder, "c");

    expect(syncs).toBe(3);
  });

  it("writes one JSON object per line, appending rather than truncating", () => {
    const path = join(scratch(), "nested", "audit.log");
    const first = new DurableFileAuditJournal(path);
    const recorder = new AuditRecorder({ journal: first, clock: fixedClock() });
    anEvent(recorder, "first");
    first.close();

    // Reopening must not lose what a previous process wrote: an audit log that
    // truncates on restart reports a restart as an absence of activity.
    const second = new DurableFileAuditJournal(path);
    anEvent(new AuditRecorder({ journal: second, clock: fixedClock() }), "second");
    second.close();

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => (JSON.parse(line) as AuditEvent).tool)).toEqual(["first", "second"]);
  });

  it("creates the log private to its owner", () => {
    // The journal names credentials and tools. It is not world-readable.
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path);
    anEvent(new AuditRecorder({ journal, clock: fixedClock() }), "probe");
    journal.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  /**
   * ROTATION IS A RENAME, AND A HELD HANDLE DOES NOT FOLLOW IT.
   *
   * `rotate-atlas-logs.sh` renames the journal and never truncates, on the
   * reasoning that "renaming leaves the open writer appending to the now-unlinked
   * inode until it reopens". Nothing reopened. Measured over a live server: after
   * the rename the documented audit path did not exist, and the next event landed
   * 937 bytes into the `.1` file — outside the rotator's own glob, permanently.
   * The reasoning was right for the launchd stdout/stderr files, which launchd
   * reopens per invocation, and wrong for the one file the script was written for.
   */
  it("follows the path when rotation renames the file out from under it", () => {
    const path = join(scratch(), "audit.jsonl");
    const journal = new DurableFileAuditJournal(path);
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    anEvent(recorder, "before-rotation");
    // Exactly what `rotate_one` does.
    renameSync(path, `${path}.1`);
    anEvent(recorder, "after-rotation");
    journal.close();

    // The live path exists again and holds the event written after the rename.
    const live = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(live.map((line) => (JSON.parse(line) as AuditEvent).tool)).toEqual(["after-rotation"]);
    // And nothing was lost: the rotated generation still holds the earlier one.
    const rotated = readFileSync(`${path}.1`, "utf8").trimEnd().split("\n");
    expect(rotated.map((line) => (JSON.parse(line) as AuditEvent).tool)).toEqual(["before-rotation"]);
  });

  it("reopens the path when the file is deleted rather than renamed", () => {
    // The other half of the same question. A journal appending into an unlinked
    // inode reports every subsequent disclosure into a file nobody can open.
    const path = join(scratch(), "audit.jsonl");
    const journal = new DurableFileAuditJournal(path);
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    anEvent(recorder, "first");
    rmSync(path);
    anEvent(recorder, "second");
    journal.close();

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as AuditEvent).tool)).toEqual(["second"]);
  });

  it("keeps one handle for an untouched path rather than reopening per event", () => {
    // The reopen must be conditional. Reopening on every append would add two
    // syscalls to every tool call and make durability depend on close semantics.
    const path = join(scratch(), "audit.jsonl");
    const journal = new DurableFileAuditJournal(path);
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    anEvent(recorder, "a");
    const inode = statSync(path).ino;
    anEvent(recorder, "b");
    anEvent(recorder, "c");
    journal.close();

    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path, "utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  it("throws rather than degrading once closed, so a lost event is never silent", () => {
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path);
    journal.close();

    // Fail-closed: the dispatcher turns this throw into a failed call, which is
    // what keeps a disclosure from being returned without its event.
    expect(() => anEvent(new AuditRecorder({ journal, clock: fixedClock() }), "after-close")).toThrow();
  });
});
