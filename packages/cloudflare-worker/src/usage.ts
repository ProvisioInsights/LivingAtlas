import { readSyncStatus, type SyncMetadataStore } from "./sync-storage";

type UsageStatement = {
  bind(...values: unknown[]): UsageStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all?<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type UsageMetadataStore = SyncMetadataStore & {
  prepare(query: string): UsageStatement;
};

export type UsageRuntimeConfig = {
  provider?: string;
  plan?: string;
  default_window_hours?: string;
  budgets_json?: string;
};

export type UsageStatusOptions = {
  now?: string;
  windowHours?: number;
};

export type UsageGateOptions = UsageStatusOptions & {
  maxBudgetRatio?: number;
  minWorkerRequestsRemaining?: number;
  requireZero5xx?: boolean;
};

export type UsageReconciliationOptions = UsageStatusOptions & {
  maxR2Objects?: number;
};

type UsageStatus = Awaited<ReturnType<typeof getUsageStatus>>;

type UsageBudgetEntry = {
  used: number;
  limit: number;
  ratio: number;
};

type UsageGateCheck = {
  name: string;
  ok: boolean;
  reason_code?: string;
  service?: string;
  metric?: string;
  used?: number;
  limit?: number;
  ratio?: number;
  threshold?: number;
  remaining?: number;
};

type UsageScalarRow = {
  total_requests?: number;
  http_2xx?: number;
  http_4xx?: number;
  http_5xx?: number;
  total_duration_ms?: number;
  avg_duration_ms?: number;
  retained_metric_rows?: number;
  committed_batches?: number;
  committed_objects?: number;
  committed_changes?: number;
  estimated_batch_bytes?: number;
};

type UsageRouteRow = {
  route: string;
  count: number;
};

type BudgetMap = Record<string, Record<string, number>>;

const defaultWindowHours = 24;
const maxWindowHours = 720;
const defaultMaxBudgetRatio = 0.8;
const defaultMinWorkerRequestsRemaining = 1_000;
const defaultMaxR2Objects = 10_000;
const maxR2ObjectsHardLimit = 100_000;

const UsageD1SchemaStatements = [
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
  `CREATE TABLE IF NOT EXISTS sync_batches (
    batch_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    batch_hash TEXT NOT NULL,
    authority_ref TEXT NOT NULL,
    device_ref TEXT NOT NULL,
    client_ref TEXT NOT NULL,
    capability_ref TEXT NOT NULL,
    token_id TEXT,
    operation_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    staged_at TEXT NOT NULL,
    committed_at TEXT,
    base_generation INTEGER NOT NULL,
    target_generation INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'failed')),
    object_count INTEGER NOT NULL,
    change_count INTEGER NOT NULL,
    estimated_batch_bytes INTEGER NOT NULL,
    withheld_plaintext_count INTEGER NOT NULL,
    failure_reason TEXT,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_objects (
    object_ref TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    authority_ref TEXT NOT NULL,
    version INTEGER NOT NULL,
    envelope_hash TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    envelope_r2_key TEXT NOT NULL,
    ciphertext_r2_path_hash TEXT,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (object_ref, version)
  )`,
  `CREATE TABLE IF NOT EXISTS sync_changes (
    change_ref TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    authority_ref TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    trace_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    object_ref TEXT NOT NULL,
    operation TEXT NOT NULL,
    base_version INTEGER,
    new_version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    generation INTEGER NOT NULL,
    actor_ref TEXT NOT NULL
  )`
];

function boundedWindowHours(config: UsageRuntimeConfig, override: number | undefined): number {
  const raw = override ?? Number(config.default_window_hours ?? defaultWindowHours);
  if (!Number.isFinite(raw)) {
    return defaultWindowHours;
  }

  return Math.min(Math.max(Math.trunc(raw), 1), maxWindowHours);
}

function addHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

function numberFromRow(row: UsageScalarRow | null, key: keyof UsageScalarRow): number {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseBudgets(config: UsageRuntimeConfig): { budgets: BudgetMap; parse_error?: string } {
  if (!config.budgets_json) {
    return { budgets: {} };
  }

  try {
    const parsed = JSON.parse(config.budgets_json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { budgets: {}, parse_error: "budget-config-not-object" };
    }

    const services = "services" in parsed ? (parsed as { services?: unknown }).services : parsed;
    if (typeof services !== "object" || services === null || Array.isArray(services)) {
      return { budgets: {}, parse_error: "budget-services-not-object" };
    }

    const budgets: BudgetMap = {};
    for (const [service, values] of Object.entries(services)) {
      if (typeof values !== "object" || values === null || Array.isArray(values)) {
        continue;
      }

      budgets[service] = {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
          budgets[service]![key] = value;
        }
      }
    }

    return { budgets };
  } catch {
    return { budgets: {}, parse_error: "budget-config-invalid-json" };
  }
}

function ratio(used: number, limit: number | undefined): number | undefined {
  if (!limit || limit <= 0) {
    return undefined;
  }

  return Number((used / limit).toFixed(6));
}

function budgetView(service: string, observed: Record<string, number>, budgets: BudgetMap) {
  const serviceBudgets = budgets[service] ?? {};
  const limits: Record<string, { used: number; limit: number; ratio: number }> = {};
  for (const [key, limit] of Object.entries(serviceBudgets)) {
    const used = observed[key] ?? 0;
    limits[key] = {
      used,
      limit,
      ratio: ratio(used, limit) ?? 0
    };
  }

  return limits;
}

function boundedBudgetRatio(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultMaxBudgetRatio;
  }

  return Math.min(Math.max(value, 0.01), 1);
}

function boundedMinimumRemaining(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultMinWorkerRequestsRemaining;
  }

  return Math.max(Math.trunc(value), 0);
}

function boundedMaxR2Objects(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultMaxR2Objects;
  }

  return Math.min(Math.max(Math.trunc(value), 1), maxR2ObjectsHardLimit);
}

function isBudgetEntry(value: unknown): value is UsageBudgetEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<UsageBudgetEntry>;
  return (
    typeof candidate.used === "number" &&
    typeof candidate.limit === "number" &&
    typeof candidate.ratio === "number"
  );
}

function budgetEntries(status: UsageStatus): Array<{ service: string; metric: string; budget: UsageBudgetEntry }> {
  const entries: Array<{ service: string; metric: string; budget: UsageBudgetEntry }> = [];
  for (const [service, view] of Object.entries(status.services)) {
    for (const [metric, budget] of Object.entries(view.budgets ?? {})) {
      if (isBudgetEntry(budget)) {
        entries.push({ service, metric, budget });
      }
    }
  }

  return entries;
}

export function evaluateUsageGate(status: UsageStatus, options: UsageGateOptions = {}) {
  const maxBudgetRatio = boundedBudgetRatio(options.maxBudgetRatio);
  const minWorkerRequestsRemaining = boundedMinimumRemaining(options.minWorkerRequestsRemaining);
  const requireZero5xx = options.requireZero5xx ?? true;
  const checks: UsageGateCheck[] = [];

  for (const { service, metric, budget } of budgetEntries(status)) {
    const ok = budget.ratio <= maxBudgetRatio;
    checks.push({
      name: "budget-ratio",
      ok,
      reason_code: ok ? undefined : "budget-ratio-exceeded",
      service,
      metric,
      used: budget.used,
      limit: budget.limit,
      ratio: budget.ratio,
      threshold: maxBudgetRatio
    });
  }

  if (checks.length === 0) {
    checks.push({
      name: "budget-configured",
      ok: false,
      reason_code: "no-budget-configured"
    });
  }

  const workerRequestsBudget = status.services.workers.budgets.requests;
  if (isBudgetEntry(workerRequestsBudget)) {
    const remaining = workerRequestsBudget.limit - workerRequestsBudget.used;
    const ok = remaining >= minWorkerRequestsRemaining;
    checks.push({
      name: "worker-request-headroom",
      ok,
      reason_code: ok ? undefined : "worker-request-headroom-too-low",
      service: "workers",
      metric: "requests",
      used: workerRequestsBudget.used,
      limit: workerRequestsBudget.limit,
      remaining,
      threshold: minWorkerRequestsRemaining
    });
  } else if (minWorkerRequestsRemaining > 0) {
    checks.push({
      name: "worker-request-headroom",
      ok: false,
      reason_code: "worker-request-budget-missing",
      service: "workers",
      metric: "requests",
      threshold: minWorkerRequestsRemaining
    });
  }

  if (requireZero5xx) {
    const worker5xx = status.services.workers.observed.http_5xx;
    checks.push({
      name: "worker-5xx",
      ok: worker5xx === 0,
      reason_code: worker5xx === 0 ? undefined : "worker-5xx-observed",
      service: "workers",
      metric: "http_5xx",
      used: worker5xx,
      threshold: 0
    });
  }

  if (status.budget_config.parse_error) {
    checks.push({
      name: "budget-config-valid",
      ok: false,
      reason_code: status.budget_config.parse_error
    });
  }

  const failedChecks = checks.filter((check) => !check.ok);
  return {
    ok: failedChecks.length === 0,
    gate_schema: "living-atlas-usage-gate:v1",
    generated_at: status.generated_at,
    provider: status.provider,
    plan: status.plan,
    decision: failedChecks.length === 0 ? "safe-to-test" : "stop-testing",
    reason_codes: failedChecks.map((check) => check.reason_code ?? check.name),
    policy: {
      max_budget_ratio: maxBudgetRatio,
      min_worker_requests_remaining: minWorkerRequestsRemaining,
      require_zero_5xx: requireZero5xx
    },
    checks,
    usage: {
      window: status.window,
      services: status.services,
      sync: status.sync,
      budget_config: status.budget_config
    }
  };
}

async function listR2Inventory(bucket: Pick<R2Bucket, "list">, maxObjects: number) {
  let cursor: string | undefined;
  let truncated = false;
  let objectCount = 0;
  let totalBytes = 0;
  let listCalls = 0;

  do {
    const remaining = maxObjects - objectCount;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    const page = await bucket.list({
      cursor,
      limit: Math.min(remaining, 1000)
    });
    listCalls += 1;
    objectCount += page.objects.length;
    totalBytes += page.objects.reduce((sum, object) => sum + object.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
    truncated = page.truncated;
  } while (cursor);

  return {
    ok: true,
    object_count: objectCount,
    total_bytes: totalBytes,
    list_calls: listCalls,
    truncated
  };
}

async function ensureUsageTables(store: UsageMetadataStore): Promise<void> {
  for (const statement of UsageD1SchemaStatements) {
    await store.prepare(statement).run();
  }
}

export async function getUsageStatus(
  store: UsageMetadataStore,
  config: UsageRuntimeConfig,
  options: UsageStatusOptions = {}
) {
  await ensureUsageTables(store);

  const now = options.now ?? new Date().toISOString();
  const windowHours = boundedWindowHours(config, options.windowHours);
  const windowStart = addHours(now, -windowHours);
  const { budgets, parse_error } = parseBudgets(config);

  const requestRow = await store.prepare(`
SELECT
  COUNT(*) AS total_requests,
  SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS http_2xx,
  SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) AS http_4xx,
  SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS http_5xx,
  COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
  COALESCE(AVG(duration_ms), 0) AS avg_duration_ms
FROM operational_metrics
WHERE signal_kind = 'request' AND recorded_at >= ?`).bind(windowStart).first<UsageScalarRow>();

  const retainedRow = await store.prepare("SELECT COUNT(*) AS retained_metric_rows FROM operational_metrics")
    .first<UsageScalarRow>();

  const routeStatement = store.prepare(`
SELECT route, COUNT(*) AS count
FROM operational_metrics
WHERE signal_kind = 'request' AND recorded_at >= ? AND route IS NOT NULL
GROUP BY route
ORDER BY count DESC, route ASC
LIMIT 25`).bind(windowStart);
  const routeRows = routeStatement.all
    ? await routeStatement.all<UsageRouteRow>()
    : { results: [] as UsageRouteRow[] };

  const syncWindowRow = await store.prepare(`
SELECT
  COUNT(*) AS committed_batches,
  COALESCE(SUM(object_count), 0) AS committed_objects,
  COALESCE(SUM(change_count), 0) AS committed_changes,
  COALESCE(SUM(estimated_batch_bytes), 0) AS estimated_batch_bytes
FROM sync_batches
WHERE status = 'committed' AND submitted_at >= ?`).bind(windowStart).first<UsageScalarRow>();

  const syncTotalRow = await store.prepare(`
SELECT
  COUNT(*) AS committed_batches,
  COALESCE(SUM(object_count), 0) AS committed_objects,
  COALESCE(SUM(change_count), 0) AS committed_changes,
  COALESCE(SUM(estimated_batch_bytes), 0) AS estimated_batch_bytes
FROM sync_batches
WHERE status = 'committed'`).first<UsageScalarRow>();

  const syncStatus = await readSyncStatus(store);
  const workersObserved = {
    requests: numberFromRow(requestRow, "total_requests"),
    http_2xx: numberFromRow(requestRow, "http_2xx"),
    http_4xx: numberFromRow(requestRow, "http_4xx"),
    http_5xx: numberFromRow(requestRow, "http_5xx"),
    duration_ms: Number(numberFromRow(requestRow, "total_duration_ms").toFixed(3)),
    avg_duration_ms: Number(numberFromRow(requestRow, "avg_duration_ms").toFixed(3))
  };
  const d1Observed = {
    retained_metric_rows: numberFromRow(retainedRow, "retained_metric_rows"),
    committed_batches: numberFromRow(syncTotalRow, "committed_batches"),
    committed_objects: numberFromRow(syncTotalRow, "committed_objects"),
    committed_changes: numberFromRow(syncTotalRow, "committed_changes"),
    window_estimated_rows_written:
      numberFromRow(syncWindowRow, "committed_batches")
      + numberFromRow(syncWindowRow, "committed_objects")
      + numberFromRow(syncWindowRow, "committed_changes")
      + numberFromRow(requestRow, "total_requests")
  };
  const r2Observed = {
    objects: syncStatus.object_count,
    estimated_stored_bytes: numberFromRow(syncTotalRow, "estimated_batch_bytes"),
    window_estimated_write_bytes: numberFromRow(syncWindowRow, "estimated_batch_bytes"),
    window_class_a_operations_estimate: numberFromRow(syncWindowRow, "committed_objects")
  };

  return {
    ok: true,
    usage_schema: "living-atlas-usage-status:v1",
    generated_at: now,
    provider: config.provider ?? "cloudflare",
    plan: config.plan ?? "unspecified",
    window: {
      hours: windowHours,
      from: windowStart,
      to: now
    },
    budget_config: {
      source: config.budgets_json ? "env:LA_USAGE_BUDGETS_JSON" : "unset",
      parse_error
    },
    services: {
      workers: {
        observed: workersObserved,
        top_routes: routeRows.results ?? [],
        budgets: budgetView("workers", workersObserved, budgets),
        notes: ["App-observed request counts from retained operational metrics; not a billing authority."]
      },
      d1: {
        observed: {
          ...d1Observed,
          window_committed_batches: numberFromRow(syncWindowRow, "committed_batches"),
          window_committed_objects: numberFromRow(syncWindowRow, "committed_objects"),
          window_committed_changes: numberFromRow(syncWindowRow, "committed_changes")
        },
        budgets: budgetView("d1", d1Observed, budgets),
        notes: ["D1 storage and read/write billing totals are not directly visible to the Worker."]
      },
      r2: {
        observed: r2Observed,
        budgets: budgetView("r2", r2Observed, budgets),
        notes: ["R2 object count and bytes are estimated from accepted sync envelopes, not Cloudflare billing totals."]
      },
      kv: {
        observed: {},
        budgets: budgetView("kv", {}, budgets),
        notes: ["No KV app-operation counters are emitted yet."]
      },
      durable_objects: {
        observed: {},
        budgets: budgetView("durable_objects", {}, budgets),
        notes: ["Durable Object request/storage usage is not directly visible to this Worker endpoint yet."]
      }
    },
    sync: {
      latest_generation: syncStatus.latest_generation,
      latest_batch_id: syncStatus.latest_batch_id,
      object_count: syncStatus.object_count,
      change_count: syncStatus.change_count,
      latest_withheld_plaintext_count: syncStatus.latest_withheld_plaintext_count
    },
    portability: {
      contract: "Return this same shape from other deployment providers; populate observed and budgets for provider-native services.",
      tunable_env: [
        "LA_USAGE_PROVIDER",
        "LA_USAGE_PLAN",
        "LA_USAGE_WINDOW_HOURS",
        "LA_USAGE_BUDGETS_JSON"
      ]
    }
  };
}

export async function getUsageGate(
  store: UsageMetadataStore,
  config: UsageRuntimeConfig,
  options: UsageGateOptions = {}
) {
  return evaluateUsageGate(await getUsageStatus(store, config, options), options);
}

export async function getUsageReconciliation(
  store: UsageMetadataStore,
  bucket: Pick<R2Bucket, "list">,
  config: UsageRuntimeConfig,
  options: UsageReconciliationOptions = {}
) {
  const status = await getUsageStatus(store, config, options);
  const maxR2Objects = boundedMaxR2Objects(options.maxR2Objects);
  const r2Inventory = await listR2Inventory(bucket, maxR2Objects);
  const metadataObjectCount = status.sync.object_count;
  const estimatedObjectCount = status.services.r2.observed.objects;
  const r2ObjectDelta = r2Inventory.object_count - estimatedObjectCount;
  const r2ByteDelta = r2Inventory.total_bytes - status.services.r2.observed.estimated_stored_bytes;
  const r2Matched = !r2Inventory.truncated && r2ObjectDelta === 0;

  return {
    ok: r2Matched,
    reconciliation_schema: "living-atlas-usage-reconciliation:v1",
    generated_at: status.generated_at,
    provider: status.provider,
    plan: status.plan,
    decision: r2Matched ? "reconciled" : "needs-review",
    reason_codes: r2Matched ? [] : [
      ...(r2Inventory.truncated ? ["r2-inventory-truncated"] : []),
      ...(r2ObjectDelta !== 0 ? ["r2-object-count-mismatch"] : [])
    ],
    policy: {
      max_r2_objects: maxR2Objects
    },
    app_observed: {
      sync_generation: status.sync.latest_generation,
      sync_object_count: metadataObjectCount,
      sync_change_count: status.sync.change_count,
      r2_estimated_objects: estimatedObjectCount,
      r2_estimated_stored_bytes: status.services.r2.observed.estimated_stored_bytes,
      d1_retained_metric_rows: status.services.d1.observed.retained_metric_rows,
      d1_committed_batches: status.services.d1.observed.committed_batches,
      d1_committed_objects: status.services.d1.observed.committed_objects,
      d1_committed_changes: status.services.d1.observed.committed_changes
    },
    provider_observed: {
      r2: {
        object_count: r2Inventory.object_count,
        total_bytes: r2Inventory.total_bytes,
        list_calls: r2Inventory.list_calls,
        truncated: r2Inventory.truncated,
        object_delta_vs_app: r2ObjectDelta,
        byte_delta_vs_app_estimate: r2ByteDelta
      },
      d1: {
        note: "D1 counts are read from the Cloudflare D1 binding tables; billing row-read/write counters remain provider metrics."
      },
      workers: {
        note: "Workers invocation billing counters are not exposed to this Worker; use Cloudflare analytics/dashboard for billing truth."
      },
      kv: {
        note: "KV operation counters are not emitted by the app yet."
      },
      durable_objects: {
        note: "Durable Object billing counters are not exposed to this Worker endpoint."
      }
    }
  };
}
