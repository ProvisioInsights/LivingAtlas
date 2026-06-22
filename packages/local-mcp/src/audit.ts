import { z } from "zod";
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
};

export class InMemoryLocalMcpAuditSink implements LocalMcpAuditSink {
  readonly events: LocalMcpAuditEvent[] = [];

  record(event: LocalMcpAuditEvent): void {
    this.events.push(LocalMcpAuditEventSchema.parse(event));
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
