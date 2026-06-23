import { describe, expect, it } from "vitest";
import { sha256TokenHash } from "./bootstrap";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";
import type { UsageMetadataStore } from "./usage";

const usageToken = "fixture-usage-token-usage-0001";

type D1RunRecord = {
  query: string;
  bindings: unknown[];
};

function fakeD1Result<T>(results: T[] = []): D1Result<T> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0
    },
    results
  };
}

class FakeUsageStatement {
  constructor(
    private readonly records: D1RunRecord[],
    private readonly query: string,
    private readonly bindings: unknown[] = []
  ) {}

  bind(...values: unknown[]): FakeUsageStatement {
    return new FakeUsageStatement(this.records, this.query, values);
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.records.push({ query: this.query, bindings: this.bindings });
    return fakeD1Result<T>();
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    if (this.query.includes("COUNT(*) AS total_requests")) {
      return {
        total_requests: 7,
        http_2xx: 5,
        http_4xx: 2,
        http_5xx: 0,
        total_duration_ms: 84,
        avg_duration_ms: 12
      } as T;
    }

    if (this.query.includes("COUNT(*) AS retained_metric_rows")) {
      return { retained_metric_rows: 12 } as T;
    }

    if (this.query.includes("FROM sync_objects")) {
      return { count: 40 } as T;
    }

    if (this.query.includes("FROM sync_changes")) {
      return { count: 43 } as T;
    }

    if (this.query.includes("FROM sync_batches") && this.query.includes("submitted_at >= ?")) {
      return {
        committed_batches: 2,
        committed_objects: 9,
        committed_changes: 9,
        estimated_batch_bytes: 4096
      } as T;
    }

    if (this.query.includes("FROM sync_batches") && this.query.includes("SUM(object_count)")) {
      return {
        committed_batches: 4,
        committed_objects: 42,
        committed_changes: 43,
        estimated_batch_bytes: 16384
      } as T;
    }

    if (this.query.includes("FROM sync_batches")) {
      return {
        batch_id: "la_sync_batch_usage0001",
        authority_ref: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        submitted_at: "2026-06-22T12:00:00.000Z",
        target_generation: 4,
        withheld_plaintext_count: 0
      } as T;
    }

    return null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes("GROUP BY route")) {
      return fakeD1Result<T>([
        { route: "/api/sync/status", count: 4 },
        { route: "/healthz", count: 3 }
      ] as T[]);
    }

    return fakeD1Result<T>();
  }
}

class FakeUsageD1 implements UsageMetadataStore {
  readonly records: D1RunRecord[] = [];

  prepare(query: string): FakeUsageStatement {
    return new FakeUsageStatement(this.records, query);
  }
}

class FakeUsageR2Bucket {
  private readonly objects = Array.from({ length: 42 }, (_, index) => ({
    key: `sync/envelopes/${index.toString().padStart(4, "0")}.json`,
    version: "fixture-version",
    size: index < 41 ? 390 : 394,
    etag: "fixture-etag",
    httpEtag: "\"fixture-etag\"",
    uploaded: new Date("2026-06-22T12:00:00.000Z"),
    httpMetadata: {},
    customMetadata: {},
    range: undefined,
    storageClass: "Standard" as const,
    checksums: {
      toJSON: () => ({})
    },
    writeHttpMetadata: (_headers: Headers) => {}
  }));

  async list(options?: R2ListOptions): Promise<R2Objects> {
    const start = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? 1000;
    const page = this.objects.slice(start, start + limit);
    const next = start + page.length;
    if (next < this.objects.length) {
      return {
        objects: page as R2Object[],
        delimitedPrefixes: [],
        truncated: true,
        cursor: String(next)
      };
    }

    return {
      objects: page as R2Object[],
      delimitedPrefixes: [],
      truncated: false
    };
  }
}

async function createEnv(): Promise<BootstrapWorkerEnv> {
  return {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => {
        throw new Error("bootstrap lock should not be used by usage tests");
      }
    },
    LA_GRAPH_BUCKET: new FakeUsageR2Bucket() as unknown as R2Bucket,
    LA_CONTROL_DB: new FakeUsageD1() as unknown as D1Database & UsageMetadataStore,
    LA_USAGE_TOKEN_HASH: await sha256TokenHash(usageToken),
    LA_USAGE_PROVIDER: "cloudflare",
    LA_USAGE_PLAN: "free",
    LA_USAGE_WINDOW_HOURS: "24",
    LA_USAGE_BUDGETS_JSON: JSON.stringify({
      services: {
        workers: {
          requests: 10
        },
        r2: {
          objects: 100,
          estimated_stored_bytes: 20000
        }
      }
    })
  };
}

describe("Worker usage status endpoint", () => {
  it("returns token-gated provider-neutral usage and budget status", async () => {
    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/status?window_hours=6", {
      headers: {
        "x-living-atlas-usage-token": usageToken
      }
    }), await createEnv());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      usage_schema: "living-atlas-usage-status:v1",
      provider: "cloudflare",
      plan: "free",
      window: {
        hours: 6
      },
      budget_config: {
        source: "env:LA_USAGE_BUDGETS_JSON"
      },
      services: {
        workers: {
          observed: {
            requests: 7,
            http_2xx: 5,
            http_4xx: 2,
            http_5xx: 0,
            duration_ms: 84,
            avg_duration_ms: 12
          },
          budgets: {
            requests: {
              used: 7,
              limit: 10,
              ratio: 0.7
            }
          }
        },
        r2: {
          observed: {
            objects: 42,
            estimated_stored_bytes: 16384,
            window_estimated_write_bytes: 4096,
            window_class_a_operations_estimate: 9
          }
        },
        d1: {
          observed: {
            window_estimated_rows_written: 27
          }
        }
      },
      sync: {
        latest_generation: 4,
        latest_batch_id: "la_sync_batch_usage0001",
        object_count: 40,
        change_count: 43
      }
    });
    expect(JSON.stringify(body)).not.toContain(usageToken);
    expect(JSON.stringify(body)).not.toContain("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("returns a tunable safe-to-test or stop-testing usage gate", async () => {
    const safeResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/gate?window_hours=6&max_budget_ratio=0.85&min_worker_requests_remaining=2", {
      headers: {
        "x-living-atlas-usage-token": usageToken
      }
    }), await createEnv());

    expect(safeResponse.status).toBe(200);
    await expect(safeResponse.json()).resolves.toMatchObject({
      ok: true,
      gate_schema: "living-atlas-usage-gate:v1",
      decision: "safe-to-test",
      policy: {
        max_budget_ratio: 0.85,
        min_worker_requests_remaining: 2,
        require_zero_5xx: true
      }
    });

    const stopResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/gate?window_hours=6&max_budget_ratio=0.5&min_worker_requests_remaining=5", {
      headers: {
        "x-living-atlas-usage-token": usageToken
      }
    }), await createEnv());

    expect(stopResponse.status).toBe(200);
    const stopBody = await stopResponse.json();
    expect(stopBody).toMatchObject({
      ok: false,
      gate_schema: "living-atlas-usage-gate:v1",
      decision: "stop-testing",
      reason_codes: expect.arrayContaining([
        "budget-ratio-exceeded",
        "worker-request-headroom-too-low"
      ])
    });
    expect(JSON.stringify(stopBody)).not.toContain(usageToken);
  });

  it("reconciles app-observed usage against provider inventory available to the Worker", async () => {
    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/reconcile?window_hours=6&max_r2_objects=50", {
      headers: {
        "x-living-atlas-usage-token": usageToken
      }
    }), await createEnv());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      reconciliation_schema: "living-atlas-usage-reconciliation:v1",
      decision: "reconciled",
      provider_observed: {
        r2: {
          object_count: 42,
          total_bytes: 16384,
          list_calls: 1,
          truncated: false,
          object_delta_vs_app: 0,
          byte_delta_vs_app_estimate: 0
        }
      },
      app_observed: {
        sync_generation: 4,
        sync_object_count: 40,
        r2_estimated_objects: 42,
        r2_estimated_stored_bytes: 16384
      }
    });
    expect(JSON.stringify(body)).not.toContain(usageToken);
  });

  it("reconciles usage from metadata without scanning provider inventory", async () => {
    const env = await createEnv();
    let listCalls = 0;
    env.LA_GRAPH_BUCKET = {
      ...env.LA_GRAPH_BUCKET,
      list: async () => {
        listCalls += 1;
        throw new Error("metadata mode should not list R2 inventory");
      }
    } as R2Bucket;

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/reconcile?window_hours=6&inventory_mode=metadata", {
      headers: {
        "x-living-atlas-usage-token": usageToken
      }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      decision: "reconciled",
      policy: {
        inventory_mode: "metadata"
      },
      provider_observed: {
        r2: {
          inventory_mode: "metadata",
          object_count: 42,
          total_bytes: 16384,
          list_calls: 0,
          truncated: false,
          object_delta_vs_app: 0,
          byte_delta_vs_app_estimate: 0
        }
      }
    });
    expect(listCalls).toBe(0);
  });

  it("rejects missing auth and token query strings", async () => {
    const missingAuth = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/status"), await createEnv());
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toEqual({
      ok: false,
      error: "missing-or-invalid-usage-token"
    });

    const queryToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/status?sync_token=secret"), await createEnv());
    expect(queryToken.status).toBe(400);
    await expect(queryToken.json()).resolves.toEqual({
      ok: false,
      error: "usage tokens must not be sent in the query string"
    });

    const gateQueryToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/gate?sync_token=secret"), await createEnv());
    expect(gateQueryToken.status).toBe(400);
    await expect(gateQueryToken.json()).resolves.toEqual({
      ok: false,
      error: "usage tokens must not be sent in the query string"
    });

    const reconcileQueryToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/reconcile?sync_token=secret"), await createEnv());
    expect(reconcileQueryToken.status).toBe(400);
    await expect(reconcileQueryToken.json()).resolves.toEqual({
      ok: false,
      error: "usage tokens must not be sent in the query string"
    });
  });
});
