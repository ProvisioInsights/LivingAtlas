import { z } from "zod";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccessClassSchema,
  McpProfileSchema,
  ObjectIdSchema,
  OperationSchema
} from "@living-atlas/contracts";

export const LocalMcpAuditEventSchema = z
  .object({
    event_type: z.enum(["auth.succeeded", "auth.failed", "tool.allowed", "tool.denied"]),
    recorded_at: z.string().min(1),
    client_id: z.string().optional(),
    profile: McpProfileSchema.optional(),
    operation: OperationSchema.optional(),
    tool_name: z.string().min(1).optional(),
    object_id: ObjectIdSchema.optional(),
    access_class: AccessClassSchema.optional(),
    reason_code: z.string().min(1),
    redaction: z.literal("local-redacted"),
    summary: z.string().min(1)
  })
  .strict();

export type LocalMcpAuditEvent = z.infer<typeof LocalMcpAuditEventSchema>;

export type LocalMcpAuditSink = {
  record(event: LocalMcpAuditEvent): void;
  read?(limit: number): LocalMcpAuditEvent[];
};

export class InMemoryLocalMcpAuditSink implements LocalMcpAuditSink {
  readonly events: LocalMcpAuditEvent[] = [];

  record(event: LocalMcpAuditEvent): void {
    this.events.push(LocalMcpAuditEventSchema.parse(event));
  }

  read(limit: number): LocalMcpAuditEvent[] {
    return this.events.slice(-limit);
  }
}

export class FileLocalMcpAuditSink implements LocalMcpAuditSink {
  constructor(private readonly path: string) {}

  record(event: LocalMcpAuditEvent): void {
    const parsed = LocalMcpAuditEventSchema.parse(event);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
  }

  read(limit: number): LocalMcpAuditEvent[] {
    if (!existsSync(this.path)) {
      return [];
    }
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => LocalMcpAuditEventSchema.parse(JSON.parse(line)))
      .slice(-limit);
  }
}

export function createLocalMcpAuditEvent(
  event: Omit<LocalMcpAuditEvent, "recorded_at" | "redaction">
): LocalMcpAuditEvent {
  return LocalMcpAuditEventSchema.parse({
    ...event,
    recorded_at: new Date().toISOString(),
    redaction: "local-redacted"
  });
}
