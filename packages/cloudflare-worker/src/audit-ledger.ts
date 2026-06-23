import {
  DurableAuditEventSchema,
  PraxisActivityAuditEventSchema,
  PraxisActivityAuditStreamRequestSchema,
  PraxisActivityAuditStreamResponseSchema,
  type DurableAuditEvent,
  type PraxisActivityAuditEvent,
  type PraxisActivityAuditStreamRequest,
  type PraxisActivityAuditStreamResponse
} from "@living-atlas/contracts";
import { opaquePersistenceHash, opaquePersistenceRef } from "./opaque-ref";

type BindableStatement = {
  bind(...values: unknown[]): BindableStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all?<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type AuditLedgerMetadataStore = {
  prepare(query: string): BindableStatement;
};

export type StoredAuditLedgerEvent = {
  audit_id: string;
  authority_ref: string;
  operation_id: string;
  trace_id: string;
  recorded_at: string;
  actor_ref: string;
  mcp_profile: string;
  operation: string;
  event_type: string;
  outcome: string | null;
  reason_code: string | null;
  object_ref: string | null;
  release_ref: string | null;
  key_ref: string | null;
  capability_ref: string | null;
  sync_batch_ref: string | null;
  access_class: string | null;
  redaction: string;
  summary: string;
  checkpoint_bucket: string;
  previous_event_hash: string | null;
  event_hash: string;
};

export type AppendAuditEventResult = {
  audit_id: string;
  authority_ref: string;
  event_hash: string;
  checkpoint_bucket: string;
  previous_event_hash?: string;
};

export type ReadAuditLedgerOptions = {
  authority_id?: string;
  operation_id?: string;
  trace_id?: string;
  event_type?: DurableAuditEvent["event_type"];
  cursor?: string;
  limit?: number;
};

type LatestAuditHashRow = {
  event_hash: string;
};

type MutationResult = {
  meta?: {
    changes?: number;
  };
};

const MaxAuditReadLimit = 250;
const DefaultActivityAuditStreamLimit = 50;

const AuditEventsTableSql = `
CREATE TABLE IF NOT EXISTS audit_events (
  audit_id TEXT PRIMARY KEY,
  authority_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  mcp_profile TEXT NOT NULL,
  operation TEXT NOT NULL,
  event_type TEXT NOT NULL,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('allowed', 'denied', 'withheld', 'released', 'changed')),
  reason_code TEXT,
  object_ref TEXT,
  release_ref TEXT,
  key_ref TEXT,
  capability_ref TEXT,
  sync_batch_ref TEXT,
  access_class TEXT,
  redaction TEXT NOT NULL CHECK (redaction IN ('remote-redacted', 'generic-unavailable')),
  summary TEXT NOT NULL,
  checkpoint_bucket TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE
)`;

const AuditEventsNoUpdateTriggerSql = `
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END`;

const AuditEventsNoDeleteTriggerSql = `
CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events are append-only');
END`;

const AuditEventsIndexSql = [
  "CREATE INDEX IF NOT EXISTS idx_audit_events_authority_recorded ON audit_events (authority_ref, recorded_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_events_authority_previous_hash ON audit_events (authority_ref, previous_event_hash)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_operation ON audit_events (operation_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_trace ON audit_events (trace_id)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_type_recorded ON audit_events (event_type, recorded_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_actor_recorded ON audit_events (actor_ref, recorded_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_object_recorded ON audit_events (object_ref, recorded_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_release_recorded ON audit_events (release_ref, recorded_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_events_key_recorded ON audit_events (key_ref, recorded_at)"
];

export const AuditLedgerD1SchemaStatements = [
  AuditEventsTableSql,
  AuditEventsNoUpdateTriggerSql,
  AuditEventsNoDeleteTriggerSql,
  ...AuditEventsIndexSql
];

let auditIdCounter = 0;
const GenesisAuditHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

async function scopedOpaqueRef(scope: string, value: string): Promise<string> {
  return opaquePersistenceRef(`audit:${scope}`, value);
}

async function ensureAuditLedgerTables(controlDb: AuditLedgerMetadataStore): Promise<void> {
  for (const statement of AuditLedgerD1SchemaStatements) {
    await controlDb.prepare(statement).run();
  }
}

function checkpointBucket(recordedAt: string): string {
  return recordedAt.slice(0, 10);
}

export function activityAuditCursorFor(row: Pick<StoredAuditLedgerEvent, "recorded_at" | "audit_id">): string {
  return `${String(Date.parse(row.recorded_at)).padStart(13, "0")}:${row.audit_id}`;
}

function parseActivityAuditCursor(cursor: string): { recorded_at: string; audit_id: string } {
  const [recordedAtMs, auditId] = cursor.split(":");
  if (!recordedAtMs || !auditId) {
    throw new Error("invalid-activity-audit-cursor");
  }

  return {
    recorded_at: new Date(Number(recordedAtMs)).toISOString(),
    audit_id: auditId
  };
}

function assertRemoteLedgerRedaction(event: DurableAuditEvent): void {
  if (event.redaction === "none") {
    throw new Error("Cloudflare audit ledger stores only redacted audit events");
  }
}

function canonicalAuditHashPayload(event: Omit<StoredAuditLedgerEvent, "event_hash">): string {
  return JSON.stringify({
    audit_id: event.audit_id,
    authority_ref: event.authority_ref,
    operation_id: event.operation_id,
    trace_id: event.trace_id,
    recorded_at: event.recorded_at,
    actor_ref: event.actor_ref,
    mcp_profile: event.mcp_profile,
    operation: event.operation,
    event_type: event.event_type,
    outcome: event.outcome,
    reason_code: event.reason_code,
    object_ref: event.object_ref,
    release_ref: event.release_ref,
    key_ref: event.key_ref,
    capability_ref: event.capability_ref,
    sync_batch_ref: event.sync_batch_ref,
    access_class: event.access_class,
    redaction: event.redaction,
    summary: event.summary,
    checkpoint_bucket: event.checkpoint_bucket,
    previous_event_hash: event.previous_event_hash
  });
}

function activityCrudFor(eventType: DurableAuditEvent["event_type"]): PraxisActivityAuditEvent["crud"] {
  if (eventType === "sync.read") {
    return "sync-pull";
  }

  if (eventType === "sync.denied" || eventType === "sync.conflict") {
    return "sync-push";
  }

  if (eventType.startsWith("release.")) {
    return "release";
  }

  if (eventType.startsWith("policy.") || eventType.startsWith("key.") || eventType.startsWith("device.") || eventType.startsWith("client.")) {
    return "policy-allow";
  }

  const crudByEventType: Partial<Record<DurableAuditEvent["event_type"], PraxisActivityAuditEvent["crud"]>> = {
    "object.read": "read",
    "object.denied": "read",
    "object.decrypt": "decrypt",
    "object.create": "create",
    "object.update": "update",
    "object.delete": "delete",
    "object.restore": "restore",
    "bootstrap.claimed": "policy-allow"
  };

  return crudByEventType[eventType] ?? "read";
}

function activityDecisionFor(row: StoredAuditLedgerEvent): PraxisActivityAuditEvent["policy_decision"] {
  if (row.outcome === "denied" || row.event_type === "object.denied" || row.event_type === "sync.denied") {
    return "deny";
  }

  if (row.outcome === "withheld") {
    return "ciphertext-only";
  }

  if (row.event_type === "sync.conflict") {
    return "partial";
  }

  return "allow";
}

function toPraxisActivityAuditEvent(row: StoredAuditLedgerEvent): PraxisActivityAuditEvent {
  return PraxisActivityAuditEventSchema.parse({
    event_schema: "living-atlas-praxis-activity-audit-event:v1",
    event_id: row.audit_id.replace(/^la_audit_/, "la_event_"),
    cursor: activityAuditCursorFor(row),
    recorded_at: row.recorded_at,
    plane: "remote",
    crud: activityCrudFor(row.event_type as DurableAuditEvent["event_type"]),
    policy_decision: activityDecisionFor(row),
    operation_id: row.operation_id,
    trace_id: row.trace_id,
    summary: row.summary,
    visibility: {
      mode: "remote_safe",
      contains_sensitive: false,
      redacted: true
    },
    audit: {
      audit_id: row.audit_id,
      event_type: row.event_type,
      outcome: row.outcome,
      reason_code: row.reason_code,
      mcp_profile: row.mcp_profile,
      operation: row.operation,
      access_class: row.access_class,
      redaction: row.redaction,
      event_hash: row.event_hash,
      previous_event_hash: row.previous_event_hash
    },
    refs: {
      authority_ref: row.authority_ref,
      actor_ref: row.actor_ref,
      object_ref: row.object_ref,
      release_ref: row.release_ref,
      key_ref: row.key_ref,
      capability_ref: row.capability_ref,
      sync_batch_ref: row.sync_batch_ref
    }
  });
}

async function toStoredAuditLedgerEvent(
  event: DurableAuditEvent,
  previousEventHash: string
): Promise<StoredAuditLedgerEvent> {
  const storedWithoutHash = {
    audit_id: event.audit_id,
    authority_ref: await scopedOpaqueRef("authority", event.authority_id),
    operation_id: event.operation_id,
    trace_id: event.trace_id,
    recorded_at: event.recorded_at,
    actor_ref: await scopedOpaqueRef("actor", event.actor_id),
    mcp_profile: event.mcp_profile,
    operation: event.operation,
    event_type: event.event_type,
    outcome: event.outcome ?? null,
    reason_code: event.reason_code ?? null,
    object_ref: event.object_id ? await scopedOpaqueRef("object", event.object_id) : null,
    release_ref: event.release_id ? await scopedOpaqueRef("release", event.release_id) : event.event_type.startsWith("release.") && event.object_id ? await scopedOpaqueRef("release", event.object_id) : null,
    key_ref: event.key_id ? await scopedOpaqueRef("key", event.key_id) : null,
    capability_ref: event.capability_id ? await scopedOpaqueRef("capability", event.capability_id) : null,
    sync_batch_ref: event.sync_batch_id ? await scopedOpaqueRef("sync-batch", event.sync_batch_id) : null,
    access_class: event.access_class ?? null,
    redaction: event.redaction,
    summary: event.summary,
    checkpoint_bucket: checkpointBucket(event.recorded_at),
    previous_event_hash: previousEventHash
  } satisfies Omit<StoredAuditLedgerEvent, "event_hash">;

  return {
    ...storedWithoutHash,
    event_hash: await opaquePersistenceHash("audit:event-chain", canonicalAuditHashPayload(storedWithoutHash))
  };
}

async function latestAuditHash(controlDb: AuditLedgerMetadataStore, authorityRef: string): Promise<string | null> {
  const row = await controlDb.prepare(`
SELECT event_hash
FROM audit_events
WHERE authority_ref = ?
ORDER BY recorded_at DESC, audit_id DESC
LIMIT 1`).bind(authorityRef).first<LatestAuditHashRow>();

  return row?.event_hash ?? null;
}

export function createAuditId(now = Date.now()): string {
  auditIdCounter += 1;
  return `la_audit_${now.toString(36)}${auditIdCounter.toString(36).padStart(4, "0")}`;
}

function changedRows(result: unknown): number | undefined {
  const meta = (result as MutationResult | undefined)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : undefined;
}

export async function appendAuditEvent(
  controlDb: AuditLedgerMetadataStore,
  input: DurableAuditEvent
): Promise<AppendAuditEventResult> {
  const event = DurableAuditEventSchema.parse(input);
  assertRemoteLedgerRedaction(event);

  await ensureAuditLedgerTables(controlDb);

  const authorityRef = await scopedOpaqueRef("authority", event.authority_id);
  const previousEventHash = await latestAuditHash(controlDb, authorityRef) ?? GenesisAuditHash;
  const stored = await toStoredAuditLedgerEvent(event, previousEventHash);

  const insertResult = await controlDb.prepare(`
INSERT INTO audit_events (
  audit_id,
  authority_ref,
  operation_id,
  trace_id,
  recorded_at,
  actor_ref,
  mcp_profile,
  operation,
  event_type,
  outcome,
  reason_code,
  object_ref,
  release_ref,
  key_ref,
  capability_ref,
  sync_batch_ref,
  access_class,
  redaction,
  summary,
  checkpoint_bucket,
  previous_event_hash,
  event_hash
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (
  (? IS NULL OR ? = ?)
  AND NOT EXISTS (
    SELECT 1 FROM audit_events WHERE authority_ref = ?
  )
) OR (
  ? IS NOT NULL
  AND ? <> ?
  AND ? = (
    SELECT event_hash
    FROM audit_events
    WHERE authority_ref = ?
    ORDER BY recorded_at DESC, audit_id DESC
    LIMIT 1
  )
)`).bind(
    stored.audit_id,
    stored.authority_ref,
    stored.operation_id,
    stored.trace_id,
    stored.recorded_at,
    stored.actor_ref,
    stored.mcp_profile,
    stored.operation,
    stored.event_type,
    stored.outcome,
    stored.reason_code,
    stored.object_ref,
    stored.release_ref,
    stored.key_ref,
    stored.capability_ref,
    stored.sync_batch_ref,
    stored.access_class,
    stored.redaction,
    stored.summary,
    stored.checkpoint_bucket,
    stored.previous_event_hash,
    stored.event_hash,
    stored.previous_event_hash,
    stored.previous_event_hash,
    GenesisAuditHash,
    stored.authority_ref,
    stored.previous_event_hash,
    stored.previous_event_hash,
    GenesisAuditHash,
    stored.previous_event_hash,
    stored.authority_ref
  ).run();

  if (changedRows(insertResult) === 0) {
    throw new Error("audit-ledger-chain-race");
  }

  return {
    audit_id: stored.audit_id,
    authority_ref: stored.authority_ref,
    event_hash: stored.event_hash,
    checkpoint_bucket: stored.checkpoint_bucket,
    ...(stored.previous_event_hash ? { previous_event_hash: stored.previous_event_hash } : {})
  };
}

export async function readAuditLedgerEvents(
  controlDb: AuditLedgerMetadataStore,
  options: ReadAuditLedgerOptions = {}
): Promise<StoredAuditLedgerEvent[]> {
  await ensureAuditLedgerTables(controlDb);

  const filters: string[] = [];
  const values: unknown[] = [];
  if (options.authority_id) {
    filters.push("authority_ref = ?");
    values.push(await scopedOpaqueRef("authority", options.authority_id));
  }

  if (options.operation_id) {
    filters.push("operation_id = ?");
    values.push(options.operation_id);
  }

  if (options.trace_id) {
    filters.push("trace_id = ?");
    values.push(options.trace_id);
  }

  if (options.event_type) {
    filters.push("event_type = ?");
    values.push(options.event_type);
  }

  if (options.cursor) {
    const cursor = parseActivityAuditCursor(options.cursor);
    filters.push("(recorded_at < ? OR (recorded_at = ? AND audit_id < ?))");
    values.push(cursor.recorded_at, cursor.recorded_at, cursor.audit_id);
  }

  const limit = Math.min(Math.max(options.limit ?? 100, 1), MaxAuditReadLimit);
  const statement = controlDb.prepare(`
SELECT
  audit_id,
  authority_ref,
  operation_id,
  trace_id,
  recorded_at,
  actor_ref,
  mcp_profile,
  operation,
  event_type,
  outcome,
  reason_code,
  object_ref,
  release_ref,
  key_ref,
  capability_ref,
  sync_batch_ref,
  access_class,
  redaction,
  summary,
  checkpoint_bucket,
  previous_event_hash,
  event_hash
FROM audit_events
${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
ORDER BY recorded_at DESC, audit_id DESC
LIMIT ?`).bind(...values, limit);
  const result = statement.all
    ? await statement.all<StoredAuditLedgerEvent>()
    : { results: [] as StoredAuditLedgerEvent[] };

  return result.results ?? [];
}

export async function readPraxisActivityAuditStream(
  controlDb: AuditLedgerMetadataStore,
  options: Partial<PraxisActivityAuditStreamRequest> = {}
): Promise<PraxisActivityAuditStreamResponse> {
  const parsedOptions = PraxisActivityAuditStreamRequestSchema.parse({
    limit: DefaultActivityAuditStreamLimit,
    ...options
  });
  const rows = await readAuditLedgerEvents(controlDb, {
    ...parsedOptions,
    limit: parsedOptions.limit + 1
  });
  const visibleRows = rows.slice(0, parsedOptions.limit);
  const hasMore = rows.length > parsedOptions.limit;

  return PraxisActivityAuditStreamResponseSchema.parse({
    stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
    ok: true,
    events: visibleRows.map(toPraxisActivityAuditEvent),
    limit: parsedOptions.limit,
    next_cursor: hasMore && visibleRows.length > 0 ? activityAuditCursorFor(visibleRows[visibleRows.length - 1]!) : null,
    has_more: hasMore
  });
}
