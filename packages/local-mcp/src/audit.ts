import { z } from "zod";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccessClassSchema,
  McpProfileSchema,
  ObjectIdSchema,
  OperationIdSchema,
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
    operation_id: OperationIdSchema.optional(),
    idempotency_key: z.string().min(1).optional(),
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

function auditEventIdentity(event: LocalMcpAuditEvent): string | undefined {
  if (!event.operation_id || !event.idempotency_key) return undefined;
  return JSON.stringify([
    event.operation_id,
    event.idempotency_key,
    event.event_type,
    event.tool_name ?? "",
    event.reason_code
  ]);
}

export class InMemoryLocalMcpAuditSink implements LocalMcpAuditSink {
  readonly events: LocalMcpAuditEvent[] = [];
  private readonly identities = new Set<string>();

  record(event: LocalMcpAuditEvent): void {
    const parsed = LocalMcpAuditEventSchema.parse(event);
    const identity = auditEventIdentity(parsed);
    if (identity && this.identities.has(identity)) return;
    this.events.push(parsed);
    if (identity) this.identities.add(identity);
  }

  read(limit: number): LocalMcpAuditEvent[] {
    return this.events.slice(-limit);
  }
}

export class FileLocalMcpAuditSink implements LocalMcpAuditSink {
  private readonly identities = new Set<string>();
  private identitiesLoaded = false;

  constructor(private readonly path: string) {}

  private loadIdentities(): void {
    if (this.identitiesLoaded) return;
    this.identitiesLoaded = true;
    if (!existsSync(this.path)) return;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const identity = auditEventIdentity(LocalMcpAuditEventSchema.parse(JSON.parse(line)));
      if (identity) this.identities.add(identity);
    }
  }

  record(event: LocalMcpAuditEvent): void {
    const parsed = LocalMcpAuditEventSchema.parse(event);
    this.loadIdentities();
    const identity = auditEventIdentity(parsed);
    if (identity && this.identities.has(identity)) return;
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(this.path, 0o600);
    if (identity) this.identities.add(identity);
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
