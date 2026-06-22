import { describe, expect, it, vi } from "vitest";
import type { OperationalEvent, OperationalSpan } from "@living-atlas/contracts";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "./bootstrap-lock";
import {
  createCloudflareBindingSpan,
  createOpenTelemetryTraceExport,
  createWorkerRequestEvent,
  emitWorkerOperationalTelemetry,
  emitWorkerObservability,
  withCloudflareBindingSpan,
  type OperationalMetricRetentionStore,
  type WorkerAnalyticsEngineDataset,
  type WorkerObservabilityContext
} from "./observability";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";

type RetentionRecord = {
  query: string;
  bindings: unknown[];
};

class FakeRetentionStatement {
  constructor(
    private readonly records: RetentionRecord[],
    private readonly query: string,
    private readonly bindings: unknown[] = []
  ) {}

  bind(...values: unknown[]): FakeRetentionStatement {
    return new FakeRetentionStatement(this.records, this.query, values);
  }

  async run(): Promise<unknown> {
    this.records.push({
      query: this.query,
      bindings: this.bindings
    });
    return {};
  }
}

class FakeRetentionStore implements OperationalMetricRetentionStore {
  readonly records: RetentionRecord[] = [];

  prepare(query: string): FakeRetentionStatement {
    return new FakeRetentionStatement(this.records, query);
  }
}

function createEnv(events: OperationalEvent[] = []): BootstrapWorkerEnv {
  return {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage())
    },
    LA_GRAPH_BUCKET: {} as R2Bucket,
    LA_CONTROL_DB: {} as D1Database,
    LA_OBSERVABILITY_LOG_SAMPLE_RATE: "0",
    LA_OBSERVABILITY_SINK: {
      emit: (event) => events.push(event)
    }
  };
}

function eventContext(): WorkerObservabilityContext {
  return {
    event_id: "la_observe_workerobs0001",
    trace_id: "la_trace_workerobs0001",
    operation_id: "la_operation_workerobs0001",
    request_span_id: "la_span_workerobs0001",
    route: "/healthz",
    method: "GET"
  };
}

describe("Worker operational observability", () => {
  it("emits redacted request metrics and trace headers without query tokens", async () => {
    const events: OperationalEvent[] = [];
    const response = await handleBootstrapRequest(
      new Request("https://living-atlas.example/healthz?sync_token=secret-sync-token&claim_token=secret-claim-token"),
      createEnv(events)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-living-atlas-trace-id")).toMatch(/^la_trace_[A-Za-z0-9_-]{8,}$/);
    expect(response.headers.get("x-living-atlas-operation-id")).toMatch(/^la_operation_[A-Za-z0-9_-]{8,}$/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_schema: "living-atlas-operational-event:v1",
      severity: "info",
      plane: "cloudflare-worker",
      event_kind: "request",
      route: "/healthz",
      method: "GET",
      status: 200,
      outcome: "ok",
      redaction: "operational-redacted",
      sensitive: false,
      counters: {
        http_requests: 1,
        http_2xx: 1,
        http_4xx: 0,
        http_5xx: 0
      }
    });
    expect(JSON.stringify(events)).not.toContain("secret-sync-token");
    expect(JSON.stringify(events)).not.toContain("secret-claim-token");
  });

  it("retains Worker request metrics through the D1 control binding", async () => {
    const events: OperationalEvent[] = [];
    const store = new FakeRetentionStore();
    const response = await handleBootstrapRequest(
      new Request("https://living-atlas.example/healthz"),
      {
        ...createEnv(events),
        LA_CONTROL_DB: store as unknown as D1Database
      }
    );

    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(store.records.some((record) => record.query.includes("CREATE TABLE IF NOT EXISTS operational_metrics"))).toBe(true);
    expect(store.records.some((record) => record.query.includes("INSERT INTO operational_metrics"))).toBe(true);
    expect(JSON.stringify(store.records)).not.toContain("secret");
  });

  it("propagates valid incoming trace and operation ids", async () => {
    const events: OperationalEvent[] = [];
    const response = await handleBootstrapRequest(
      new Request("https://living-atlas.example/healthz", {
        headers: {
          "x-living-atlas-trace-id": "la_trace_existing0001",
          "x-living-atlas-operation-id": "la_operation_existing0001"
        }
      }),
      createEnv(events)
    );

    expect(response.headers.get("x-living-atlas-trace-id")).toBe("la_trace_existing0001");
    expect(response.headers.get("x-living-atlas-operation-id")).toBe("la_operation_existing0001");
    expect(events[0]?.trace_id).toBe("la_trace_existing0001");
    expect(events[0]?.operation_id).toBe("la_operation_existing0001");
  });

  it("emits structured JSON logs when console observability sampling is enabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const event = createWorkerRequestEvent({
      context: eventContext(),
      status: 200,
      durationMs: 3
    });

    emitWorkerObservability({
      LA_OBSERVABILITY_CONSOLE: "1",
      LA_OBSERVABILITY_LOG_SAMPLE_RATE: "1"
    }, event);

    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(log.mock.calls[0]?.[0])) as OperationalEvent;
    log.mockRestore();
    expect(parsed).toMatchObject({
      event_schema: "living-atlas-operational-event:v1",
      trace_id: "la_trace_workerobs0001",
      status: 200,
      outcome: "ok"
    });
  });

  it("writes redacted custom metric rows to Analytics Engine", () => {
    const points: NonNullable<Parameters<WorkerAnalyticsEngineDataset["writeDataPoint"]>[0]>[] = [];
    const event = createWorkerRequestEvent({
      context: eventContext(),
      status: 409,
      durationMs: 12,
      reasonCode: "stale-generation"
    });

    emitWorkerObservability({
      LA_OBSERVABILITY_ENVIRONMENT: "test",
      LA_OBSERVABILITY_ANALYTICS_DATASET: "living_atlas_operational_metrics_test",
      LA_OPERATIONAL_ANALYTICS: {
        writeDataPoint: (point) => {
          if (point) {
            points.push(point);
          }
        }
      }
    }, event);

    expect(points).toHaveLength(1);
    const point = points[0]!;
    expect(point.indexes).toEqual(["la_trace_workerobs0001"]);
    expect(point.blobs).toEqual([
      "living-atlas-operational-event:v1",
      "cloudflare-worker",
      "request",
      "GET /healthz",
      "/healthz",
      "GET",
      "conflict",
      "stale-generation",
      "",
      "",
      "",
      "operational-redacted",
      "test"
    ]);
    expect(point.doubles).toEqual([12, 409, 1, 0, 1, 0, 0]);
    expect(JSON.stringify(point)).not.toContain("sync_token");
  });

  it("exports request and binding spans through a redacted OTLP JSON contract", async () => {
    const event = createWorkerRequestEvent({
      context: eventContext(),
      status: 200,
      durationMs: 3
    });
    const span = createCloudflareBindingSpan({
      context: eventContext(),
      bindingType: "d1",
      bindingName: "LA_CONTROL_DB",
      operation: "prepare.run",
      durationMs: 4,
      outcome: "ok"
    });

    const payload = await createOpenTelemetryTraceExport({
      environment: "test",
      signals: [event, span]
    });

    const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(2);
    expect(spans[0]!.traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[a-f0-9]{16}$/);
    expect(spans[0]!.kind).toBe("SPAN_KIND_SERVER");
    expect(spans[1]!.kind).toBe("SPAN_KIND_CLIENT");
    expect(spans[1]!.attributes).toContainEqual({
      key: "cloudflare.binding.name",
      value: { stringValue: "LA_CONTROL_DB" }
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("emits custom Cloudflare binding spans without retaining unsafe target paths", async () => {
    const spans: OperationalSpan[] = [];
    const result = await withCloudflareBindingSpan({
      env: {
        LA_OBSERVABILITY_SPAN_SINK: {
          emit: (span) => spans.push(span)
        }
      },
      context: eventContext(),
      bindingType: "r2",
      bindingName: "LA_GRAPH_BUCKET",
      operation: "put",
      targetRef: "objects/a=raw-private-path/p=secret/s=secret.bin",
      run: async () => "stored"
    });

    expect(result).toBe("stored");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      span_schema: "living-atlas-operational-span:v1",
      span_kind: "cloudflare-binding",
      outcome: "ok",
      binding: {
        binding_type: "r2",
        binding_name: "LA_GRAPH_BUCKET",
        operation: "put"
      },
      redaction: "operational-redacted",
      sensitive: false
    });
    expect(spans[0]!.binding?.target_ref).toBeUndefined();
    expect(JSON.stringify(spans)).not.toContain("raw-private-path");
    expect(JSON.stringify(spans)).not.toContain("secret");
  });

  it("retains operational metrics durably in D1-shaped storage", async () => {
    const events: OperationalEvent[] = [];
    const points: NonNullable<Parameters<WorkerAnalyticsEngineDataset["writeDataPoint"]>[0]>[] = [];
    const store = new FakeRetentionStore();
    const event = createWorkerRequestEvent({
      context: eventContext(),
      status: 500,
      durationMs: 19,
      reasonCode: "synthetic-error"
    });

    const retained = await emitWorkerOperationalTelemetry({
      LA_OBSERVABILITY_SINK: {
        emit: (emitted) => events.push(emitted)
      },
      LA_OPERATIONAL_ANALYTICS: {
        writeDataPoint: (point) => {
          if (point) {
            points.push(point);
          }
        }
      },
      LA_OPERATIONAL_METRIC_RETENTION_DB: store,
      LA_OBSERVABILITY_RETENTION_DAYS: "7"
    }, event);

    expect(events).toEqual([event]);
    expect(points).toHaveLength(1);
    expect(retained).toMatchObject({
      retention_schema: "living-atlas-operational-metric-retention:v1",
      record_id: "la_observe_workerobs0001",
      signal_schema: "living-atlas-operational-event:v1",
      trace_id: "la_trace_workerobs0001",
      operation_id: "la_operation_workerobs0001",
      outcome: "server-error",
      redaction: "operational-redacted",
      sensitive: false
    });
    expect(store.records.some((record) => record.query.includes("CREATE TABLE IF NOT EXISTS operational_metrics"))).toBe(true);
    expect(store.records.some((record) => record.query.includes("INSERT INTO operational_metrics"))).toBe(true);
    expect(store.records.some((record) => record.query.includes("DELETE FROM operational_metrics WHERE expires_at"))).toBe(true);
    expect(JSON.stringify(store.records)).not.toContain("sync_token");
    expect(JSON.stringify(store.records)).not.toContain("secret");
  });

  it("turns unexpected Worker failures into redacted 500 observability events", async () => {
    const events: OperationalEvent[] = [];
    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/bootstrap/status"), {
      ...createEnv(events),
      BOOTSTRAP_CLAIM_LOCK: {
        getByName: () => {
          throw new Error("synthetic secret implementation detail");
        }
      }
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "internal-error" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      severity: "error",
      event_kind: "error",
      status: 500,
      outcome: "server-error",
      redaction: "operational-redacted",
      sensitive: false
    });
    expect(JSON.stringify(events)).not.toContain("synthetic secret implementation detail");
  });
});
