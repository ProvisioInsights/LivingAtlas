import { z } from "zod";
import {
  IsoTimestampSchema,
  OperationIdSchema,
  TraceIdSchema
} from "./ids";

export const OperationalSeveritySchema = z.enum(["debug", "info", "warn", "error"]);
export const OperationalPlaneSchema = z.enum(["cloudflare-worker", "local-mcp", "sync-agent", "check"]);
export const OperationalEventKindSchema = z.enum(["request", "dependency", "metric", "error"]);
export const OperationalSpanKindSchema = z.enum(["request", "cloudflare-binding", "internal"]);
export const OperationalBindingKindSchema = z.enum([
  "d1",
  "r2",
  "durable-object",
  "kv",
  "analytics-engine",
  "worker"
]);
export const OperationalOutcomeSchema = z.enum([
  "ok",
  "client-error",
  "auth-denied",
  "conflict",
  "not-found",
  "server-error"
]);

export const OperationalEventSchema = z
  .object({
    event_schema: z.literal("living-atlas-operational-event:v1"),
    event_id: z.string().regex(/^la_observe_[A-Za-z0-9_-]{8,}$/),
    recorded_at: IsoTimestampSchema,
    severity: OperationalSeveritySchema,
    plane: OperationalPlaneSchema,
    event_kind: OperationalEventKindSchema,
    trace_id: TraceIdSchema,
    operation_id: OperationIdSchema,
    route: z.string().min(1).max(128).optional(),
    method: z.string().min(1).max(16).optional(),
    status: z.number().int().min(100).max(599).optional(),
    duration_ms: z.number().nonnegative().optional(),
    outcome: OperationalOutcomeSchema,
    reason_code: z.string().min(1).max(128).optional(),
    counters: z.record(z.string(), z.number().nonnegative()).optional(),
    redaction: z.literal("operational-redacted"),
    sensitive: z.literal(false),
    message: z.string().min(1).max(256)
  })
  .strict();

export type OperationalEvent = z.infer<typeof OperationalEventSchema>;

export const OperationalSpanSchema = z
  .object({
    span_schema: z.literal("living-atlas-operational-span:v1"),
    span_id: z.string().regex(/^la_span_[A-Za-z0-9_-]{8,}$/),
    parent_span_id: z.string().regex(/^la_span_[A-Za-z0-9_-]{8,}$/).optional(),
    trace_id: TraceIdSchema,
    operation_id: OperationIdSchema,
    plane: OperationalPlaneSchema,
    span_kind: OperationalSpanKindSchema,
    name: z.string().min(1).max(128),
    started_at: IsoTimestampSchema,
    ended_at: IsoTimestampSchema.optional(),
    duration_ms: z.number().nonnegative().optional(),
    outcome: OperationalOutcomeSchema,
    reason_code: z.string().min(1).max(128).optional(),
    binding: z
      .object({
        binding_type: OperationalBindingKindSchema,
        binding_name: z.string().min(1).max(64),
        operation: z.string().min(1).max(96),
        target_ref: z.string().min(1).max(128).optional()
      })
      .strict()
      .optional(),
    counters: z.record(z.string(), z.number().nonnegative()).optional(),
    redaction: z.literal("operational-redacted"),
    sensitive: z.literal(false),
    message: z.string().min(1).max(256)
  })
  .strict();

export type OperationalSpan = z.infer<typeof OperationalSpanSchema>;

export const AnalyticsEngineOperationalBlobFieldsSchema = z.tuple([
  z.literal("signal_schema"),
  z.literal("plane"),
  z.literal("signal_kind"),
  z.literal("name"),
  z.literal("route"),
  z.literal("method"),
  z.literal("outcome"),
  z.literal("reason_code"),
  z.literal("binding_type"),
  z.literal("binding_name"),
  z.literal("binding_operation"),
  z.literal("redaction"),
  z.literal("environment")
]);

export const AnalyticsEngineOperationalDoubleFieldsSchema = z.tuple([
  z.literal("duration_ms"),
  z.literal("status"),
  z.literal("http_requests"),
  z.literal("http_2xx"),
  z.literal("http_4xx"),
  z.literal("http_5xx"),
  z.literal("binding_errors")
]);

export const AnalyticsEngineDataPointSchema = z
  .object({
    indexes: z.tuple([TraceIdSchema]),
    blobs: z.tuple([
      z.string().max(96),
      z.string().max(64),
      z.string().max(64),
      z.string().max(128),
      z.string().max(128),
      z.string().max(16),
      OperationalOutcomeSchema,
      z.string().max(128),
      z.string().max(64),
      z.string().max(64),
      z.string().max(96),
      z.literal("operational-redacted"),
      z.string().max(64)
    ]),
    doubles: z.tuple([
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative(),
      z.number().nonnegative()
    ])
  })
  .strict();

export const AnalyticsEngineOperationalMetricSchema = z
  .object({
    export_schema: z.literal("living-atlas-analytics-engine-operational-metric:v1"),
    dataset: z.string().min(1).max(128),
    blob_fields: AnalyticsEngineOperationalBlobFieldsSchema,
    double_fields: AnalyticsEngineOperationalDoubleFieldsSchema,
    data_point: AnalyticsEngineDataPointSchema,
    redaction: z.literal("operational-redacted"),
    sensitive: z.literal(false)
  })
  .strict();

export type AnalyticsEngineOperationalMetric = z.infer<typeof AnalyticsEngineOperationalMetricSchema>;

const OtlpStringValueSchema = z.object({ stringValue: z.string() }).strict();
const OtlpIntValueSchema = z.object({ intValue: z.string().regex(/^-?\d+$/) }).strict();
const OtlpDoubleValueSchema = z.object({ doubleValue: z.number() }).strict();
const OtlpBoolValueSchema = z.object({ boolValue: z.boolean() }).strict();

export const OtlpAttributeSchema = z
  .object({
    key: z.string().min(1).max(128),
    value: z.union([
      OtlpStringValueSchema,
      OtlpIntValueSchema,
      OtlpDoubleValueSchema,
      OtlpBoolValueSchema
    ])
  })
  .strict();

export const OpenTelemetryTraceExportSchema = z
  .object({
    export_schema: z.literal("living-atlas-otlp-traces-export:v1"),
    content_type: z.literal("application/json"),
    resourceSpans: z.array(
      z
        .object({
          resource: z
            .object({
              attributes: z.array(OtlpAttributeSchema).min(1)
            })
            .strict(),
          scopeSpans: z.array(
            z
              .object({
                scope: z
                  .object({
                    name: z.string().min(1).max(128),
                    version: z.string().min(1).max(32).optional()
                  })
                  .strict(),
                spans: z.array(
                  z
                    .object({
                      traceId: z.string().regex(/^[a-f0-9]{32}$/),
                      spanId: z.string().regex(/^[a-f0-9]{16}$/),
                      parentSpanId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
                      name: z.string().min(1).max(128),
                      kind: z.enum(["SPAN_KIND_SERVER", "SPAN_KIND_CLIENT", "SPAN_KIND_INTERNAL"]),
                      startTimeUnixNano: z.string().regex(/^\d+$/),
                      endTimeUnixNano: z.string().regex(/^\d+$/),
                      attributes: z.array(OtlpAttributeSchema),
                      status: z
                        .object({
                          code: z.enum(["STATUS_CODE_UNSET", "STATUS_CODE_OK", "STATUS_CODE_ERROR"]),
                          message: z.string().max(128).optional()
                        })
                        .strict()
                    })
                    .strict()
                )
              })
              .strict()
          )
        })
        .strict()
    ),
    redaction: z.literal("operational-redacted"),
    sensitive: z.literal(false)
  })
  .strict();

export type OpenTelemetryTraceExport = z.infer<typeof OpenTelemetryTraceExportSchema>;

export const OperationalMetricRetentionRecordSchema = z
  .object({
    retention_schema: z.literal("living-atlas-operational-metric-retention:v1"),
    record_id: z.string().regex(/^la_(observe|span)_[A-Za-z0-9_-]{8,}$/),
    signal_schema: z.enum([
      "living-atlas-operational-event:v1",
      "living-atlas-operational-span:v1"
    ]),
    recorded_at: IsoTimestampSchema,
    expires_at: IsoTimestampSchema,
    trace_id: TraceIdSchema,
    operation_id: OperationIdSchema,
    plane: OperationalPlaneSchema,
    signal_kind: z.string().min(1).max(64),
    name: z.string().min(1).max(128).optional(),
    route: z.string().min(1).max(128).optional(),
    method: z.string().min(1).max(16).optional(),
    status: z.number().int().min(100).max(599).optional(),
    duration_ms: z.number().nonnegative().optional(),
    outcome: OperationalOutcomeSchema,
    reason_code: z.string().min(1).max(128).optional(),
    counters: z.record(z.string(), z.number().nonnegative()),
    redaction: z.literal("operational-redacted"),
    sensitive: z.literal(false)
  })
  .strict();

export type OperationalMetricRetentionRecord = z.infer<typeof OperationalMetricRetentionRecordSchema>;
