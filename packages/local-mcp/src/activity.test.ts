import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalMcpLiveActivityEvent, FileLocalMcpActivitySink } from "./activity";

describe("FileLocalMcpActivitySink", () => {
  it("reads a bounded tail without loading a large activity log as one string", () => {
    const directory = process.env.TMPDIR ?? "/tmp";
    const path = join(directory, `living-atlas-activity-${crypto.randomUUID()}.jsonl`);
    const event = createLocalMcpLiveActivityEvent({
      operation: "read",
      tool_name: "status",
      allowed: true,
      reason_code: "allowed"
    });
    const lines = Array.from({ length: 6_000 }, (_, index) => JSON.stringify({
      ...event,
      event_id: `la_event_activitytest${String(index).padStart(8, "0")}`,
      operation_id: `la_operation_activitytest${String(index).padStart(8, "0")}`,
      trace_id: `la_trace_activitytest${String(index).padStart(8, "0")}`,
      cursor: String(index).padStart(20, "0")
    }));
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });

    const recent = new FileLocalMcpActivitySink(path).read(3);

    expect(recent).toHaveLength(3);
    expect(recent.map((item) => item.event_id)).toEqual([
      "la_event_activitytest00005997",
      "la_event_activitytest00005998",
      "la_event_activitytest00005999"
    ]);
  });
});
