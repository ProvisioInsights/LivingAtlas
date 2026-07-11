import { z } from "zod";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccessClassSchema,
  CanonicalResearchConnectorKindSchema,
  McpProfileSchema,
  ObjectIdSchema,
  OperationIdSchema,
  OperationSchema,
  Sha256HashSchema
} from "@living-atlas/contracts";

export const LocalMcpResearchAuditSummarySchema = z.object({
  connector_kinds: z.array(CanonicalResearchConnectorKindSchema).min(1).max(4),
  outcome: z.enum(["auto-apply", "owner-review", "research"]),
  independence_group_count: z.number().int().nonnegative(),
  result_set_hash: Sha256HashSchema
}).strict().superRefine((summary, context) => {
  const normalized = [...new Set(summary.connector_kinds)].sort();
  if (JSON.stringify(summary.connector_kinds) !== JSON.stringify(normalized)) {
    context.addIssue({
      code: "custom",
      path: ["connector_kinds"],
      message: "research connector kinds must be sorted and unique"
    });
  }
});
export type LocalMcpResearchAuditSummary = z.infer<typeof LocalMcpResearchAuditSummarySchema>;

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
    research: LocalMcpResearchAuditSummarySchema.optional(),
    reason_code: z.string().min(1),
    redaction: z.literal("local-redacted"),
    summary: z.string().min(1)
  })
  .strict()
  .superRefine((event, context) => {
    if (event.research && (
      event.tool_name !== "resolution_apply"
      || !event.operation_id
      || !event.idempotency_key
    )) {
      context.addIssue({
        code: "custom",
        path: ["research"],
        message: "research audit metadata requires a resolution operation and idempotency key"
      });
    }
  });

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
    event.reason_code,
    event.research?.connector_kinds.join(",") ?? "",
    event.research?.outcome ?? "",
    event.research?.independence_group_count ?? "",
    event.research?.result_set_hash ?? ""
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
  private readonly chmod: typeof chmodSync;

  constructor(
    private readonly path: string,
    options: { chmod?: typeof chmodSync } = {}
  ) {
    this.chmod = options.chmod ?? chmodSync;
  }

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
    if (identity && this.identities.has(identity)) {
      this.chmod(this.path, 0o600);
      return;
    }
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.chmod(directory, 0o700);
    appendFileSync(this.path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
    if (identity) this.identities.add(identity);
    this.chmod(this.path, 0o600);
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
