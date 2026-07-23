import { z } from "zod";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync
} from "node:fs";
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

const AuditReadChunkBytes = 1024 * 1024;
const AuditMaximumLineBytes = 1024 * 1024;

function forEachAuditLine(path: string, callback: (line: string) => void): void {
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(AuditReadChunkBytes);
  let pending = "";
  try {
    for (;;) {
      const bytesRead = readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      pending += buffer.toString("utf8", 0, bytesRead);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) callback(line);
      }
      if (Buffer.byteLength(pending, "utf8") > AuditMaximumLineBytes) {
        throw new Error("local-mcp-audit-line-too-large");
      }
    }
    if (pending.trim()) callback(pending);
  } finally {
    closeSync(handle);
  }
}

function recentAuditLines(path: string, limit: number): string[] {
  if (limit <= 0) return [];
  const handle = openSync(path, "r");
  try {
    const size = fstatSync(handle).size;
    let position = size;
    let newlineCount = 0;
    let bufferedBytes = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= limit) {
      const bytes = Math.min(AuditReadChunkBytes, position);
      position -= bytes;
      const chunk = Buffer.allocUnsafe(bytes);
      readSync(handle, chunk, 0, bytes, position);
      chunks.unshift(chunk);
      bufferedBytes += bytes;
      for (const byte of chunk) {
        if (byte === 0x0a) newlineCount += 1;
      }
      if (bufferedBytes > Math.max(AuditMaximumLineBytes, AuditReadChunkBytes * 16)) {
        throw new Error("local-mcp-audit-tail-window-too-large");
      }
    }
    return Buffer.concat(chunks).toString("utf8")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-limit);
  } finally {
    closeSync(handle);
  }
}

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
    forEachAuditLine(this.path, (line) => {
      const identity = auditEventIdentity(LocalMcpAuditEventSchema.parse(JSON.parse(line)));
      if (identity) this.identities.add(identity);
    });
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
    return recentAuditLines(this.path, limit)
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
