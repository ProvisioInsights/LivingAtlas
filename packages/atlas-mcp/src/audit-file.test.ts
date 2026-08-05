import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  it("fsyncs before append returns, so the event is durable before the result is", () => {
    // The ordering IS the guarantee. `appendFileSync` — what both CLIs used —
    // returns once the bytes reach the page cache, so a crash in the window
    // that follows loses an event whose disclosure had already gone out.
    const order: string[] = [];
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path, {
      fsync: () => {
        order.push("fsync");
      }
    });
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    anEvent(recorder, "atlas.sensitive.reveal.v1");
    order.push("append-returned");

    expect(order).toEqual(["fsync", "append-returned"]);
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

  it("throws rather than degrading once closed, so a lost event is never silent", () => {
    const path = join(scratch(), "audit.log");
    const journal = new DurableFileAuditJournal(path);
    journal.close();

    // Fail-closed: the dispatcher turns this throw into a failed call, which is
    // what keeps a disclosure from being returned without its event.
    expect(() => anEvent(new AuditRecorder({ journal, clock: fixedClock() }), "after-close")).toThrow();
  });
});
