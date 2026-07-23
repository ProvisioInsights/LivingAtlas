import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLocalMcpAuditSink, createLocalMcpAuditEvent } from "./audit";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileLocalMcpAuditSink bounded JSONL reads", () => {
  it("streams an audit ledger larger than one read chunk and tails only requested events", () => {
    const directory = mkdtempSync(join(tmpdir(), "living-atlas-audit-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "audit.jsonl");
    const oldEvent = createLocalMcpAuditEvent({
      event_type: "tool.allowed",
      client_id: "test-client",
      profile: "local-full",
      operation: "read",
      tool_name: "status",
      reason_code: "allowed",
      summary: "x".repeat(256)
    });
    writeFileSync(path, `${JSON.stringify(oldEvent)}\n`.repeat(6_000), { mode: 0o600 });
    const sink = new FileLocalMcpAuditSink(path);
    sink.record(createLocalMcpAuditEvent({
      event_type: "tool.allowed",
      client_id: "test-client",
      profile: "local-full",
      operation: "read",
      tool_name: "review_list",
      reason_code: "review-read-allowed",
      summary: "Local review projection read"
    }));
    const recent = sink.read(2);
    expect(recent).toHaveLength(2);
    expect(recent.at(-1)?.tool_name).toBe("review_list");
  });
});
