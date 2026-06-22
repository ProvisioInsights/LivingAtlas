import {
  AnalyticsEngineOperationalMetricSchema,
  OpenTelemetryTraceExportSchema,
  OperationalEventSchema,
  OperationalMetricRetentionRecordSchema,
  OperationalSpanSchema,
  OperationIdSchema,
  TraceIdSchema,
  type AnalyticsEngineOperationalMetric,
  type OperationalEvent,
  type OpenTelemetryTraceExport,
  type OperationalMetricRetentionRecord,
  type OperationalSpan
} from "@living-atlas/contracts";

export type WorkerObservabilitySink = {
  emit(event: OperationalEvent): void;
};

export type WorkerOperationalSpanSink = {
  emit(span: OperationalSpan): void;
};

export type WorkerAnalyticsEngineDataset = Pick<AnalyticsEngineDataset, "writeDataPoint">;

type OperationalMetricRetentionStatement = {
  bind(...values: unknown[]): OperationalMetricRetentionStatement;
  run(): Promise<unknown>;
};

export type OperationalMetricRetentionStore = {
  prepare(query: string): OperationalMetricRetentionStatement;
};

export type WorkerObservabilityEnv = {
  LA_OBSERVABILITY_CONSOLE?: string;
  LA_OBSERVABILITY_LOG_SAMPLE_RATE?: string;
  LA_OBSERVABILITY_ENVIRONMENT?: string;
  LA_OBSERVABILITY_ANALYTICS_DATASET?: string;
  LA_OBSERVABILITY_RETENTION_DAYS?: string;
  LA_OBSERVABILITY_SINK?: WorkerObservabilitySink;
  LA_OBSERVABILITY_SPAN_SINK?: WorkerOperationalSpanSink;
  LA_OPERATIONAL_ANALYTICS?: WorkerAnalyticsEngineDataset;
  LA_OPERATIONAL_METRIC_RETENTION_DB?: OperationalMetricRetentionStore;
  LA_CONTROL_DB?: OperationalMetricRetentionStore;
};

export type WorkerObservabilityContext = {
  event_id: string;
  trace_id: string;
  operation_id: string;
  request_span_id: string;
  route: string;
  method: string;
};

export type WorkerOperationalSignal = OperationalEvent | OperationalSpan;
type OtlpAttribute = OpenTelemetryTraceExport["resourceSpans"][number]["resource"]["attributes"][number];

const traceHeader = "x-living-atlas-trace-id";
const operationHeader = "x-living-atlas-operation-id";
const defaultAnalyticsDataset = "living_atlas_operational_metrics";
const defaultRetentionDays = 30;

export const OperationalMetricRetentionD1SchemaStatements = [
  `CREATE TABLE IF NOT EXISTS operational_metrics (
    record_id TEXT PRIMARY KEY,
    signal_schema TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    plane TEXT NOT NULL,
    signal_kind TEXT NOT NULL,
    name TEXT,
    route TEXT,
    method TEXT,
    status INTEGER,
    duration_ms REAL,
    outcome TEXT NOT NULL,
    reason_code TEXT,
    counters_json TEXT NOT NULL,
    redaction TEXT NOT NULL,
    sensitive INTEGER NOT NULL CHECK (sensitive = 0)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_operational_metrics_recorded_at ON operational_metrics (recorded_at)",
  "CREATE INDEX IF NOT EXISTS idx_operational_metrics_expires_at ON operational_metrics (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_operational_metrics_operation_id ON operational_metrics (operation_id)"
];

function generatedId(prefix: "la_observe" | "la_trace" | "la_operation" | "la_span"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function validTraceId(value: string | null): string | undefined {
  const parsed = TraceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function validOperationId(value: string | null): string | undefined {
  const parsed = OperationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function boundedSampleRate(value: string | undefined): number {
  if (value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(Math.max(parsed, 0), 1);
}

function deterministicSample(traceId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) {
    return false;
  }

  if (sampleRate >= 1) {
    return true;
  }

  const seed = traceId.slice(-8);
  const bucket = Number.parseInt(seed, 16);
  if (!Number.isFinite(bucket)) {
    return false;
  }

  return bucket / 0xffffffff <= sampleRate;
}

function outcomeForStatus(status: number): OperationalEvent["outcome"] {
  if (status >= 500) {
    return "server-error";
  }

  if (status === 401 || status === 403 || status === 423) {
    return "auth-denied";
  }

  if (status === 404) {
    return "not-found";
  }

  if (status === 409) {
    return "conflict";
  }

  if (status >= 400) {
    return "client-error";
  }

  return "ok";
}

function severityForStatus(status: number): OperationalEvent["severity"] {
  if (status >= 500) {
    return "error";
  }

  if (status >= 400) {
    return "warn";
  }

  return "info";
}

function countersForStatus(status: number): Record<string, number> {
  return {
    http_requests: 1,
    http_2xx: status >= 200 && status < 300 ? 1 : 0,
    http_4xx: status >= 400 && status < 500 ? 1 : 0,
    http_5xx: status >= 500 ? 1 : 0
  };
}

export function createWorkerObservabilityContext(request: Request): WorkerObservabilityContext {
  const url = new URL(request.url);
  return {
    event_id: generatedId("la_observe"),
    trace_id: validTraceId(request.headers.get(traceHeader)) ?? generatedId("la_trace"),
    operation_id: validOperationId(request.headers.get(operationHeader)) ?? generatedId("la_operation"),
    request_span_id: generatedId("la_span"),
    route: url.pathname,
    method: request.method
  };
}

export function applyWorkerTraceHeaders(response: Response, context: WorkerObservabilityContext): Response {
  response.headers.set(traceHeader, context.trace_id);
  response.headers.set(operationHeader, context.operation_id);
  return response;
}

export function createWorkerRequestEvent(input: {
  context: WorkerObservabilityContext;
  status: number;
  durationMs: number;
  reasonCode?: string;
}): OperationalEvent {
  return OperationalEventSchema.parse({
    event_schema: "living-atlas-operational-event:v1",
    event_id: input.context.event_id,
    recorded_at: new Date().toISOString(),
    severity: severityForStatus(input.status),
    plane: "cloudflare-worker",
    event_kind: "request",
    trace_id: input.context.trace_id,
    operation_id: input.context.operation_id,
    route: input.context.route,
    method: input.context.method,
    status: input.status,
    duration_ms: input.durationMs,
    outcome: outcomeForStatus(input.status),
    reason_code: input.reasonCode,
    counters: countersForStatus(input.status),
    redaction: "operational-redacted",
    sensitive: false,
    message: "Cloudflare Worker request completed"
  });
}

export function createWorkerErrorEvent(input: {
  context: WorkerObservabilityContext;
  durationMs: number;
  error: unknown;
}): OperationalEvent {
  return OperationalEventSchema.parse({
    event_schema: "living-atlas-operational-event:v1",
    event_id: generatedId("la_observe"),
    recorded_at: new Date().toISOString(),
    severity: "error",
    plane: "cloudflare-worker",
    event_kind: "error",
    trace_id: input.context.trace_id,
    operation_id: input.context.operation_id,
    route: input.context.route,
    method: input.context.method,
    status: 500,
    duration_ms: input.durationMs,
    outcome: "server-error",
    reason_code: input.error instanceof Error ? input.error.name : "unknown-error",
    counters: countersForStatus(500),
    redaction: "operational-redacted",
    sensitive: false,
    message: "Cloudflare Worker request failed"
  });
}

function isOperationalSpan(signal: WorkerOperationalSignal): signal is OperationalSpan {
  return "span_schema" in signal;
}

function signalSchema(signal: WorkerOperationalSignal): "living-atlas-operational-event:v1" | "living-atlas-operational-span:v1" {
  return isOperationalSpan(signal) ? signal.span_schema : signal.event_schema;
}

function signalId(signal: WorkerOperationalSignal): string {
  return isOperationalSpan(signal) ? signal.span_id : signal.event_id;
}

function signalKind(signal: WorkerOperationalSignal): string {
  return isOperationalSpan(signal) ? signal.span_kind : signal.event_kind;
}

function signalName(signal: WorkerOperationalSignal): string {
  if (isOperationalSpan(signal)) {
    return signal.name;
  }

  if (signal.method && signal.route) {
    return `${signal.method} ${signal.route}`;
  }

  return signal.event_kind;
}

function signalRoute(signal: WorkerOperationalSignal): string | undefined {
  return isOperationalSpan(signal) ? undefined : signal.route;
}

function signalMethod(signal: WorkerOperationalSignal): string | undefined {
  return isOperationalSpan(signal) ? undefined : signal.method;
}

function signalStatus(signal: WorkerOperationalSignal): number | undefined {
  return isOperationalSpan(signal) ? undefined : signal.status;
}

function signalCounters(signal: WorkerOperationalSignal): Record<string, number> {
  return signal.counters ?? {};
}

function analyticsEnvironment(env: WorkerObservabilityEnv): string {
  return env.LA_OBSERVABILITY_ENVIRONMENT?.slice(0, 64) || "unknown";
}

function analyticsDataset(env: WorkerObservabilityEnv): string {
  return env.LA_OBSERVABILITY_ANALYTICS_DATASET?.slice(0, 128) || defaultAnalyticsDataset;
}

function bindingErrorCount(signal: WorkerOperationalSignal): number {
  return isOperationalSpan(signal) && signal.binding && signal.outcome !== "ok" ? 1 : 0;
}

export function createAnalyticsEngineOperationalMetric(
  signal: WorkerOperationalSignal,
  options: {
    dataset?: string;
    environment?: string;
  } = {}
): AnalyticsEngineOperationalMetric {
  const counters = signalCounters(signal);
  const binding = isOperationalSpan(signal) ? signal.binding : undefined;

  return AnalyticsEngineOperationalMetricSchema.parse({
    export_schema: "living-atlas-analytics-engine-operational-metric:v1",
    dataset: options.dataset ?? defaultAnalyticsDataset,
    blob_fields: [
      "signal_schema",
      "plane",
      "signal_kind",
      "name",
      "route",
      "method",
      "outcome",
      "reason_code",
      "binding_type",
      "binding_name",
      "binding_operation",
      "redaction",
      "environment"
    ],
    double_fields: [
      "duration_ms",
      "status",
      "http_requests",
      "http_2xx",
      "http_4xx",
      "http_5xx",
      "binding_errors"
    ],
    data_point: {
      indexes: [signal.trace_id],
      blobs: [
        signalSchema(signal),
        signal.plane,
        signalKind(signal),
        signalName(signal),
        signalRoute(signal) ?? "",
        signalMethod(signal) ?? "",
        signal.outcome,
        signal.reason_code ?? "",
        binding?.binding_type ?? "",
        binding?.binding_name ?? "",
        binding?.operation ?? "",
        "operational-redacted",
        options.environment ?? "unknown"
      ],
      doubles: [
        signal.duration_ms ?? 0,
        signalStatus(signal) ?? 0,
        counters.http_requests ?? 0,
        counters.http_2xx ?? 0,
        counters.http_4xx ?? 0,
        counters.http_5xx ?? 0,
        bindingErrorCount(signal)
      ]
    },
    redaction: "operational-redacted",
    sensitive: false
  });
}

export function emitAnalyticsEngineMetric(env: WorkerObservabilityEnv, signal: WorkerOperationalSignal): void {
  const dataset = env.LA_OPERATIONAL_ANALYTICS;
  if (!dataset) {
    return;
  }

  const metric = createAnalyticsEngineOperationalMetric(signal, {
    dataset: analyticsDataset(env),
    environment: analyticsEnvironment(env)
  });
  dataset.writeDataPoint(metric.data_point);
}

type OperationalSpanBinding = NonNullable<OperationalSpan["binding"]>;

function safeTargetRef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (/^(opaque|sha256):[A-Za-z0-9:_-]{8,}$/.test(value)) {
    return value.slice(0, 128);
  }

  return undefined;
}

export function createCloudflareBindingSpan(input: {
  context: Pick<WorkerObservabilityContext, "trace_id" | "operation_id" | "request_span_id">;
  bindingType: OperationalSpanBinding["binding_type"];
  bindingName: string;
  operation: string;
  targetRef?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  outcome: OperationalSpan["outcome"];
  reasonCode?: string;
  counters?: Record<string, number>;
}): OperationalSpan {
  const startedAt = input.startedAt ?? new Date().toISOString();
  const endedAt = input.endedAt ?? new Date(Date.parse(startedAt) + input.durationMs).toISOString();

  return OperationalSpanSchema.parse({
    span_schema: "living-atlas-operational-span:v1",
    span_id: generatedId("la_span"),
    parent_span_id: input.context.request_span_id,
    trace_id: input.context.trace_id,
    operation_id: input.context.operation_id,
    plane: "cloudflare-worker",
    span_kind: "cloudflare-binding",
    name: `${input.bindingType}.${input.operation}`.slice(0, 128),
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: input.durationMs,
    outcome: input.outcome,
    reason_code: input.reasonCode,
    binding: {
      binding_type: input.bindingType,
      binding_name: input.bindingName.slice(0, 64),
      operation: input.operation.slice(0, 96),
      target_ref: safeTargetRef(input.targetRef)
    },
    counters: input.counters,
    redaction: "operational-redacted",
    sensitive: false,
    message: "Cloudflare binding operation completed"
  });
}

export async function withCloudflareBindingSpan<T>(input: {
  env: WorkerObservabilityEnv;
  context: Pick<WorkerObservabilityContext, "trace_id" | "operation_id" | "request_span_id">;
  bindingType: OperationalSpanBinding["binding_type"];
  bindingName: string;
  operation: string;
  targetRef?: string;
  run(): Promise<T> | T;
}): Promise<T> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    const result = await input.run();
    emitWorkerSpanObservability(
      input.env,
      createCloudflareBindingSpan({
        context: input.context,
        bindingType: input.bindingType,
        bindingName: input.bindingName,
        operation: input.operation,
        targetRef: input.targetRef,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        outcome: "ok",
        counters: {
          binding_operations: 1,
          binding_errors: 0
        }
      })
    );
    return result;
  } catch (error) {
    emitWorkerSpanObservability(
      input.env,
      createCloudflareBindingSpan({
        context: input.context,
        bindingType: input.bindingType,
        bindingName: input.bindingName,
        operation: input.operation,
        targetRef: input.targetRef,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        outcome: "server-error",
        reasonCode: error instanceof Error && error.name ? error.name : "unknown-error",
        counters: {
          binding_operations: 1,
          binding_errors: 1
        }
      })
    );
    throw error;
  }
}

function retentionDaysFromEnv(env: WorkerObservabilityEnv): number {
  const parsed = Number(env.LA_OBSERVABILITY_RETENTION_DAYS);
  if (!Number.isFinite(parsed)) {
    return defaultRetentionDays;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 90);
}

function retentionRecordedAt(signal: WorkerOperationalSignal): string {
  if (isOperationalSpan(signal)) {
    return signal.ended_at ?? signal.started_at;
  }

  return signal.recorded_at;
}

function addRetentionDays(recordedAt: string, retentionDays: number): string {
  return new Date(Date.parse(recordedAt) + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

function createOperationalMetricRetentionRecord(input: {
  signal: WorkerOperationalSignal;
  retentionDays: number;
}): OperationalMetricRetentionRecord {
  const signal = input.signal;
  const recordedAt = retentionRecordedAt(signal);

  return OperationalMetricRetentionRecordSchema.parse({
    retention_schema: "living-atlas-operational-metric-retention:v1",
    record_id: signalId(signal),
    signal_schema: signalSchema(signal),
    recorded_at: recordedAt,
    expires_at: addRetentionDays(recordedAt, input.retentionDays),
    trace_id: signal.trace_id,
    operation_id: signal.operation_id,
    plane: signal.plane,
    signal_kind: signalKind(signal),
    name: signalName(signal),
    route: signalRoute(signal),
    method: signalMethod(signal),
    status: signalStatus(signal),
    duration_ms: signal.duration_ms,
    outcome: signal.outcome,
    reason_code: signal.reason_code,
    counters: signalCounters(signal),
    redaction: "operational-redacted",
    sensitive: false
  });
}

export async function retainOperationalMetric(input: {
  store: OperationalMetricRetentionStore;
  signal: WorkerOperationalSignal;
  retentionDays?: number;
  nowIso?: string;
}): Promise<OperationalMetricRetentionRecord> {
  const record = createOperationalMetricRetentionRecord({
    signal: input.signal,
    retentionDays: input.retentionDays ?? defaultRetentionDays
  });

  for (const statement of OperationalMetricRetentionD1SchemaStatements) {
    await input.store.prepare(statement).run();
  }

  await input.store.prepare(`
INSERT INTO operational_metrics (
  record_id,
  signal_schema,
  recorded_at,
  expires_at,
  trace_id,
  operation_id,
  plane,
  signal_kind,
  name,
  route,
  method,
  status,
  duration_ms,
  outcome,
  reason_code,
  counters_json,
  redaction,
  sensitive
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(record_id) DO UPDATE SET
  recorded_at = excluded.recorded_at,
  expires_at = excluded.expires_at,
  duration_ms = excluded.duration_ms,
  outcome = excluded.outcome,
  reason_code = excluded.reason_code,
  counters_json = excluded.counters_json,
  redaction = excluded.redaction,
  sensitive = 0`).bind(
    record.record_id,
    record.signal_schema,
    record.recorded_at,
    record.expires_at,
    record.trace_id,
    record.operation_id,
    record.plane,
    record.signal_kind,
    record.name ?? null,
    record.route ?? null,
    record.method ?? null,
    record.status ?? null,
    record.duration_ms ?? null,
    record.outcome,
    record.reason_code ?? null,
    JSON.stringify(record.counters),
    record.redaction
  ).run();

  await input.store.prepare("DELETE FROM operational_metrics WHERE expires_at < ?")
    .bind(input.nowIso ?? new Date().toISOString())
    .run();

  return record;
}

function retentionStore(env: WorkerObservabilityEnv): OperationalMetricRetentionStore | undefined {
  return env.LA_OPERATIONAL_METRIC_RETENTION_DB ?? env.LA_CONTROL_DB;
}

export async function emitWorkerOperationalTelemetry(
  env: WorkerObservabilityEnv,
  event: OperationalEvent
): Promise<OperationalMetricRetentionRecord | undefined> {
  emitWorkerObservability(env, event);
  const store = retentionStore(env);
  if (!store) {
    return undefined;
  }

  return retainOperationalMetric({
    store,
    signal: event,
    retentionDays: retentionDaysFromEnv(env)
  });
}

export async function emitWorkerSpanTelemetry(
  env: WorkerObservabilityEnv,
  span: OperationalSpan
): Promise<OperationalMetricRetentionRecord | undefined> {
  emitWorkerSpanObservability(env, span);
  const store = retentionStore(env);
  if (!store) {
    return undefined;
  }

  return retainOperationalMetric({
    store,
    signal: span,
    retentionDays: retentionDaysFromEnv(env)
  });
}

function signalStartIso(signal: WorkerOperationalSignal): string {
  if (isOperationalSpan(signal)) {
    return signal.started_at;
  }

  return new Date(Date.parse(signal.recorded_at) - (signal.duration_ms ?? 0)).toISOString();
}

function signalEndIso(signal: WorkerOperationalSignal): string {
  if (isOperationalSpan(signal)) {
    return signal.ended_at ?? new Date(Date.parse(signal.started_at) + (signal.duration_ms ?? 0)).toISOString();
  }

  return signal.recorded_at;
}

function unixNanoFromIso(value: string): string {
  return (BigInt(Date.parse(value)) * 1_000_000n).toString();
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function otlpTraceId(traceId: string): Promise<string> {
  return (await sha256Hex(`trace:${traceId}`)).slice(0, 32);
}

async function otlpSpanId(spanSourceId: string): Promise<string> {
  return (await sha256Hex(`span:${spanSourceId}`)).slice(0, 16);
}

function attrString(key: string, value: string): OtlpAttribute {
  return {
    key,
    value: {
      stringValue: value
    }
  };
}

function attrInt(key: string, value: number): OtlpAttribute {
  return {
    key,
    value: {
      intValue: String(Math.trunc(value))
    }
  };
}

function attrDouble(key: string, value: number): OtlpAttribute {
  return {
    key,
    value: {
      doubleValue: value
    }
  };
}

function attrBool(key: string, value: boolean): OtlpAttribute {
  return {
    key,
    value: {
      boolValue: value
    }
  };
}

function otlpKind(signal: WorkerOperationalSignal): "SPAN_KIND_SERVER" | "SPAN_KIND_CLIENT" | "SPAN_KIND_INTERNAL" {
  if (!isOperationalSpan(signal) && signal.event_kind === "request") {
    return "SPAN_KIND_SERVER";
  }

  if (isOperationalSpan(signal) && signal.span_kind === "cloudflare-binding") {
    return "SPAN_KIND_CLIENT";
  }

  return "SPAN_KIND_INTERNAL";
}

function otlpStatus(signal: WorkerOperationalSignal) {
  if (signal.outcome === "ok") {
    return {
      code: "STATUS_CODE_OK" as const
    };
  }

  return {
    code: "STATUS_CODE_ERROR" as const,
    message: signal.reason_code ?? signal.outcome
  };
}

function otlpAttributes(signal: WorkerOperationalSignal) {
  const counters = signalCounters(signal);
  const attributes: OtlpAttribute[] = [
    attrString("la.signal_schema", signalSchema(signal)),
    attrString("la.trace_id", signal.trace_id),
    attrString("la.operation_id", signal.operation_id),
    attrString("la.redaction", "operational-redacted"),
    attrBool("la.sensitive", false),
    attrString("la.outcome", signal.outcome),
    attrString("la.signal_kind", signalKind(signal)),
    attrDouble("la.duration_ms", signal.duration_ms ?? 0)
  ];

  if (signal.reason_code) {
    attributes.push(attrString("la.reason_code", signal.reason_code));
  }

  if (!isOperationalSpan(signal)) {
    if (signal.route) {
      attributes.push(attrString("http.route", signal.route));
    }
    if (signal.method) {
      attributes.push(attrString("http.request.method", signal.method));
    }
    if (signal.status) {
      attributes.push(attrInt("http.response.status_code", signal.status));
    }
  }

  if (isOperationalSpan(signal) && signal.binding) {
    attributes.push(
      attrString("cloudflare.binding.type", signal.binding.binding_type),
      attrString("cloudflare.binding.name", signal.binding.binding_name),
      attrString("cloudflare.binding.operation", signal.binding.operation)
    );
  }

  for (const [key, value] of Object.entries(counters).sort(([left], [right]) => left.localeCompare(right))) {
    attributes.push(attrDouble(`la.counter.${key}`, value));
  }

  return attributes;
}

export async function createOpenTelemetryTraceExport(input: {
  serviceName?: string;
  serviceVersion?: string;
  environment?: string;
  signals: WorkerOperationalSignal[];
}): Promise<OpenTelemetryTraceExport> {
  const spans = await Promise.all(input.signals.map(async (signal) => ({
    traceId: await otlpTraceId(signal.trace_id),
    spanId: await otlpSpanId(signalId(signal)),
    parentSpanId: isOperationalSpan(signal) && signal.parent_span_id
      ? await otlpSpanId(signal.parent_span_id)
      : undefined,
    name: signalName(signal),
    kind: otlpKind(signal),
    startTimeUnixNano: unixNanoFromIso(signalStartIso(signal)),
    endTimeUnixNano: unixNanoFromIso(signalEndIso(signal)),
    attributes: otlpAttributes(signal),
    status: otlpStatus(signal)
  })));

  return OpenTelemetryTraceExportSchema.parse({
    export_schema: "living-atlas-otlp-traces-export:v1",
    content_type: "application/json",
    resourceSpans: [
      {
        resource: {
          attributes: [
            attrString("service.name", input.serviceName ?? "living-atlas-cloudflare-worker"),
            attrString("service.namespace", "living-atlas"),
            attrString("deployment.environment", input.environment ?? "unknown"),
            attrString("la.redaction", "operational-redacted"),
            attrBool("la.sensitive", false)
          ]
        },
        scopeSpans: [
          {
            scope: {
              name: "living-atlas.worker.observability",
              version: input.serviceVersion ?? "0.1.0"
            },
            spans
          }
        ]
      }
    ],
    redaction: "operational-redacted",
    sensitive: false
  });
}

function logOperationalSignal(env: WorkerObservabilityEnv, signal: WorkerOperationalSignal): void {
  const sampleRate = boundedSampleRate(env.LA_OBSERVABILITY_LOG_SAMPLE_RATE);
  if (env.LA_OBSERVABILITY_CONSOLE !== "1" || !deterministicSample(signal.trace_id, sampleRate)) {
    return;
  }

  const serialized = JSON.stringify(signal);
  if (isOperationalSpan(signal)) {
    if (signal.outcome === "server-error") {
      console.error(serialized);
    } else if (signal.outcome !== "ok") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
    return;
  }

  if (signal.severity === "error") {
    console.error(serialized);
  } else if (signal.severity === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}

export function emitWorkerObservability(env: WorkerObservabilityEnv, event: OperationalEvent): void {
  env.LA_OBSERVABILITY_SINK?.emit(event);
  emitAnalyticsEngineMetric(env, event);
  logOperationalSignal(env, event);
}

export function emitWorkerSpanObservability(env: WorkerObservabilityEnv, span: OperationalSpan): void {
  env.LA_OBSERVABILITY_SPAN_SINK?.emit(span);
  emitAnalyticsEngineMetric(env, span);
  logOperationalSignal(env, span);
}
