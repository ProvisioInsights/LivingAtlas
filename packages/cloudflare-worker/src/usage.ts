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
