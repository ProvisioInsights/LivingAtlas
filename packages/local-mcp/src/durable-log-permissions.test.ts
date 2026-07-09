import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLocalMcpActivitySink, createLocalMcpLiveActivityEvent } from "./activity";
import { FileLocalMcpAuditSink, createLocalMcpAuditEvent } from "./audit";

describe("durable local MCP logs", () => {
  it("creates activity and audit logs as owner-only files in an owner-only directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-local-log-permissions-"));
    const directory = join(root, "logs");
    const activityPath = join(directory, "activity.jsonl");
    const auditPath = join(directory, "audit.jsonl");
    try {
      new FileLocalMcpActivitySink(activityPath).record(createLocalMcpLiveActivityEvent({
        operation: "read",
        tool_name: "object_read",
        allowed: true,
        reason_code: "allowed"
      }));
      new FileLocalMcpAuditSink(auditPath).record(createLocalMcpAuditEvent({
        event_type: "tool.allowed",
        reason_code: "allowed",
        summary: "Local MCP tool call allowed"
      }));

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(activityPath)).mode & 0o777).toBe(0o600);
      expect((await stat(auditPath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
