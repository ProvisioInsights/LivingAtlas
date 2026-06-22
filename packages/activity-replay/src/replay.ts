import { createHash } from "node:crypto";
import {
  DurableAuditEventSchema,
  IsoTimestampSchema,
  LiveActivityEventSchema,
  ObjectIdSchema,
  OperationIdSchema,
  OperationalEventSchema,
  TraceIdSchema,
  type DurableAuditEvent,
  type LiveActivityEvent,
  type OperationalEvent
} from "@living-atlas/contracts";
import { z } from "zod";

export const ReplayStreamSchema = z.enum(["audit", "activity", "operational"]);
export type ReplayStream = z.infer<typeof ReplayStreamSchema>;

export const ReplayFindingSeveritySchema = z.enum(["info", "warn", "error"]);
export type ReplayFindingSeverity = z.infer<typeof ReplayFindingSeveritySchema>;

export const ReplayRecordSchema = z
  .object({
    stream: ReplayStreamSchema,
    source_event_id: z.string().min(1),
    operation_id: OperationIdSchema,
    trace_id: TraceIdSchema,
    recorded_at: IsoTimestampSchema,
    plane: z.string().min(1),
    action: z.string().min(1),
    touched_objects: z.array(ObjectIdSchema),
    contains_sensitive: z.boolean(),
    redacted: z.boolean(),
    policy_decision: z.enum(["allow", "deny", "partial", "ciphertext-only"]).optional(),
    outcome: z.string().min(1).optional(),
    severity: z.enum(["debug", "info", "warn", "error"]).optional(),
    actor_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    mcp_profile: z.string().min(1).optional(),
    access_class: z.string().min(1).optional(),
    summary_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
  })
  .strict();
export type ReplayRecord = z.infer<typeof ReplayRecordSchema>;

export const ReplayOperationSchema = z
  .object({
    operation_id: OperationIdSchema,
    trace_ids: z.array(TraceIdSchema),
    first_recorded_at: IsoTimestampSchema,
    last_recorded_at: IsoTimestampSchema,
    event_count: z.number().int().nonnegative(),
    streams_present: z.array(ReplayStreamSchema),
    planes: z.array(z.string().min(1)),
    touched_objects: z.array(ObjectIdSchema),
    policy_decisions: z.array(z.enum(["allow", "deny", "partial", "ciphertext-only"])),
    outcomes: z.array(z.string().min(1)),
    contains_sensitive: z.boolean(),
    redacted_record_count: z.number().int().nonnegative(),
    flags: z.array(z.enum([
      "audit-without-activity",
      "activity-without-audit",
      "operational-only",
      "policy-denied",
      "operational-error",
      "remote-sensitive-touch"
    ]))
  })
  .strict();
export type ReplayOperation = z.infer<typeof ReplayOperationSchema>;

export const ReplayFindingSchema = z
  .object({
    severity: ReplayFindingSeveritySchema,
    code: z.enum([
      "missing-durable-audit",
      "audit-without-activity",
      "operational-only",
      "policy-denied",
      "operational-error",
      "remote-sensitive-touch"
    ]),
    operation_id: OperationIdSchema,
    message: z.string().min(1)
  })
  .strict();
export type ReplayFinding = z.infer<typeof ReplayFindingSchema>;

export const ReplayInspectionSchema = z
  .object({
    inspection_schema: z.literal("living-atlas-replay-inspection:v1"),
    generated_at: IsoTimestampSchema,
    summary_policy: z.literal("hash-only"),
    records: z.array(ReplayRecordSchema),
    operations: z.array(ReplayOperationSchema),
    findings: z.array(ReplayFindingSchema),
    counters: z
      .object({
        total_records: z.number().int().nonnegative(),
        audit_records: z.number().int().nonnegative(),
        activity_records: z.number().int().nonnegative(),
        operational_records: z.number().int().nonnegative(),
        operations: z.number().int().nonnegative(),
        denied_operations: z.number().int().nonnegative(),
        operational_error_operations: z.number().int().nonnegative(),
        sensitive_operations: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type ReplayInspection = z.infer<typeof ReplayInspectionSchema>;

export const ReplayReportSchema = z
  .object({
    report_schema: z.literal("living-atlas-replay-report:v1"),
    generated_at: IsoTimestampSchema,
    summary_policy: z.literal("hash-only"),
    totals: ReplayInspectionSchema.shape.counters,
    by_stream: z.record(ReplayStreamSchema, z.number().int().nonnegative()),
    by_plane: z.record(z.string().min(1), z.number().int().nonnegative()),
    by_action: z.record(z.string().min(1), z.number().int().nonnegative()),
    by_outcome: z.record(z.string().min(1), z.number().int().nonnegative()),
    finding_counts: z.record(ReplayFindingSeveritySchema, z.number().int().nonnegative()),
    top_findings: z.array(ReplayFindingSchema).max(25)
  })
  .strict();
export type ReplayReport = z.infer<typeof ReplayReportSchema>;

export type BuildReplayInspectionInput = {
  audit_events?: DurableAuditEvent[];
  activity_events?: LiveActivityEvent[];
  operational_events?: OperationalEvent[];
  generated_at?: string;
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort();
}

function accessClassContainsSensitive(accessClass: string | undefined): boolean {
  return accessClass === "local-private" || accessClass === "quarantine";
}

function normalizeTouchedObjects(values: Array<string | undefined>): string[] {
  return uniqueSorted(values.filter((value): value is string => value !== undefined)).map((value) => ObjectIdSchema.parse(value));
}

export function normalizeAuditEvent(event: DurableAuditEvent): ReplayRecord {
  const parsed = DurableAuditEventSchema.parse(event);
  const containsSensitive = accessClassContainsSensitive(parsed.access_class);
  return ReplayRecordSchema.parse({
    stream: "audit",
    source_event_id: parsed.audit_id,
    operation_id: parsed.operation_id,
    trace_id: parsed.trace_id,
    recorded_at: parsed.recorded_at,
    plane: parsed.mcp_profile.startsWith("remote") ? "remote" : "local",
    action: parsed.event_type,
    touched_objects: normalizeTouchedObjects([parsed.object_id]),
    contains_sensitive: containsSensitive,
    redacted: parsed.redaction !== "none",
    policy_decision: parsed.event_type === "object.denied" ? "deny" : undefined,
    actor_ref: sha256(parsed.actor_id),
    mcp_profile: parsed.mcp_profile,
    access_class: parsed.access_class,
    summary_hash: sha256(parsed.summary)
  });
}

export function normalizeActivityEvent(event: LiveActivityEvent): ReplayRecord {
  const parsed = LiveActivityEventSchema.parse(event);
  return ReplayRecordSchema.parse({
    stream: "activity",
    source_event_id: parsed.event_id,
    operation_id: parsed.operation_id,
    trace_id: parsed.trace_id,
    recorded_at: parsed.recorded_at,
    plane: parsed.plane,
    action: parsed.crud,
    touched_objects: normalizeTouchedObjects([
      ...parsed.graph_touch.objects,
      ...parsed.graph_touch.nodes,
      ...parsed.graph_touch.edges,
      ...parsed.graph_touch.path
    ]),
    contains_sensitive: parsed.visibility.contains_sensitive,
    redacted: parsed.visibility.redacted,
    policy_decision: parsed.policy_decision,
    summary_hash: parsed.summary ? sha256(parsed.summary) : undefined
  });
}

export function normalizeOperationalEvent(event: OperationalEvent): ReplayRecord {
  const parsed = OperationalEventSchema.parse(event);
  return ReplayRecordSchema.parse({
    stream: "operational",
    source_event_id: parsed.event_id,
    operation_id: parsed.operation_id,
    trace_id: parsed.trace_id,
    recorded_at: parsed.recorded_at,
    plane: parsed.plane,
    action: parsed.event_kind,
    touched_objects: [],
    contains_sensitive: false,
    redacted: true,
    outcome: parsed.outcome,
    severity: parsed.severity,
    summary_hash: sha256(parsed.message)
  });
}

function compareRecords(left: ReplayRecord, right: ReplayRecord): number {
  return Date.parse(left.recorded_at) - Date.parse(right.recorded_at)
    || left.operation_id.localeCompare(right.operation_id)
    || left.stream.localeCompare(right.stream)
    || left.source_event_id.localeCompare(right.source_event_id);
}

function operationFlags(records: ReplayRecord[]): ReplayOperation["flags"] {
  const streams = new Set(records.map((record) => record.stream));
  const flags = new Set<ReplayOperation["flags"][number]>();
  const hasDenied = records.some((record) => record.policy_decision === "deny");
  const hasOperationalError = records.some((record) => record.stream === "operational" && (record.severity === "error" || record.outcome === "server-error"));
  const hasRemoteSensitiveTouch = records.some((record) => record.plane === "remote" && record.contains_sensitive && !record.redacted);

  if (streams.has("activity") && !streams.has("audit")) flags.add("activity-without-audit");
  if (streams.has("audit") && !streams.has("activity")) flags.add("audit-without-activity");
  if (streams.size === 1 && streams.has("operational")) flags.add("operational-only");
  if (hasDenied) flags.add("policy-denied");
  if (hasOperationalError) flags.add("operational-error");
  if (hasRemoteSensitiveTouch) flags.add("remote-sensitive-touch");

  return [...flags].sort();
}

function buildOperation(operationId: string, records: ReplayRecord[]): ReplayOperation {
  const sorted = [...records].sort(compareRecords);
  const flags = operationFlags(sorted);
  return ReplayOperationSchema.parse({
    operation_id: OperationIdSchema.parse(operationId),
    trace_ids: uniqueSorted(sorted.map((record) => record.trace_id)),
    first_recorded_at: sorted[0]!.recorded_at,
    last_recorded_at: sorted[sorted.length - 1]!.recorded_at,
    event_count: sorted.length,
    streams_present: uniqueSorted(sorted.map((record) => record.stream)),
    planes: uniqueSorted(sorted.map((record) => record.plane)),
    touched_objects: uniqueSorted(sorted.flatMap((record) => record.touched_objects)),
    policy_decisions: uniqueSorted(sorted.flatMap((record) => record.policy_decision ? [record.policy_decision] : [])),
    outcomes: uniqueSorted(sorted.flatMap((record) => record.outcome ? [record.outcome] : [])),
    contains_sensitive: sorted.some((record) => record.contains_sensitive),
    redacted_record_count: sorted.filter((record) => record.redacted).length,
    flags
  });
}

function findingForFlag(operationId: string, flag: ReplayOperation["flags"][number]): ReplayFinding {
  switch (flag) {
    case "activity-without-audit":
      return ReplayFindingSchema.parse({
        severity: "warn",
        code: "missing-durable-audit",
        operation_id: operationId,
        message: "Activity stream event lacks a matching durable audit event for replay."
      });
    case "audit-without-activity":
      return ReplayFindingSchema.parse({
        severity: "info",
        code: "audit-without-activity",
        operation_id: operationId,
        message: "Durable audit exists without a live activity companion event."
      });
    case "operational-only":
      return ReplayFindingSchema.parse({
        severity: "info",
        code: "operational-only",
        operation_id: operationId,
        message: "Only operational observability records were present for this operation."
      });
    case "policy-denied":
      return ReplayFindingSchema.parse({
        severity: "info",
        code: "policy-denied",
        operation_id: operationId,
        message: "Replay includes a policy denial."
      });
    case "operational-error":
      return ReplayFindingSchema.parse({
        severity: "error",
        code: "operational-error",
        operation_id: operationId,
        message: "Replay includes an operational error outcome."
      });
    case "remote-sensitive-touch":
      return ReplayFindingSchema.parse({
        severity: "error",
        code: "remote-sensitive-touch",
        operation_id: operationId,
        message: "Remote-plane record indicates sensitive graph touch without redaction."
      });
  }
}

export function buildReplayInspection(input: BuildReplayInspectionInput): ReplayInspection {
  const records = [
    ...(input.audit_events ?? []).map(normalizeAuditEvent),
    ...(input.activity_events ?? []).map(normalizeActivityEvent),
    ...(input.operational_events ?? []).map(normalizeOperationalEvent)
  ].sort(compareRecords);

  const recordsByOperation = new Map<string, ReplayRecord[]>();
  for (const record of records) {
    const existing = recordsByOperation.get(record.operation_id) ?? [];
    existing.push(record);
    recordsByOperation.set(record.operation_id, existing);
  }

  const operations = [...recordsByOperation.entries()]
    .map(([operationId, operationRecords]) => buildOperation(operationId, operationRecords))
    .sort((left, right) => Date.parse(left.first_recorded_at) - Date.parse(right.first_recorded_at) || left.operation_id.localeCompare(right.operation_id));

  const findings = operations.flatMap((operation) => operation.flags.map((flag) => findingForFlag(operation.operation_id, flag)));

  return ReplayInspectionSchema.parse({
    inspection_schema: "living-atlas-replay-inspection:v1",
    generated_at: input.generated_at ?? new Date().toISOString(),
    summary_policy: "hash-only",
    records,
    operations,
    findings,
    counters: {
      total_records: records.length,
      audit_records: records.filter((record) => record.stream === "audit").length,
      activity_records: records.filter((record) => record.stream === "activity").length,
      operational_records: records.filter((record) => record.stream === "operational").length,
      operations: operations.length,
      denied_operations: operations.filter((operation) => operation.flags.includes("policy-denied")).length,
      operational_error_operations: operations.filter((operation) => operation.flags.includes("operational-error")).length,
      sensitive_operations: operations.filter((operation) => operation.contains_sensitive).length
    }
  });
}

function incrementCounter(counters: Record<string, number>, key: string): void {
  counters[key] = (counters[key] ?? 0) + 1;
}

export function buildReplayReport(inspection: ReplayInspection): ReplayReport {
  const byStream: Record<ReplayStream, number> = {
    audit: 0,
    activity: 0,
    operational: 0
  };
  const byPlane: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const findingCounts: Record<ReplayFindingSeverity, number> = {
    info: 0,
    warn: 0,
    error: 0
  };

  for (const record of inspection.records) {
    byStream[record.stream] += 1;
    incrementCounter(byPlane, record.plane);
    incrementCounter(byAction, record.action);
    if (record.outcome) {
      incrementCounter(byOutcome, record.outcome);
    }
  }

  for (const finding of inspection.findings) {
    findingCounts[finding.severity] += 1;
  }

  return ReplayReportSchema.parse({
    report_schema: "living-atlas-replay-report:v1",
    generated_at: inspection.generated_at,
    summary_policy: "hash-only",
    totals: inspection.counters,
    by_stream: byStream,
    by_plane: byPlane,
    by_action: byAction,
    by_outcome: byOutcome,
    finding_counts: findingCounts,
    top_findings: inspection.findings.slice(0, 25)
  });
}
