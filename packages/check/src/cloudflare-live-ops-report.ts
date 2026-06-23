import { pathToFileURL } from "node:url";
import {
  readCloudflareLiveUsageGateConfig,
  runCloudflareLiveUsageGate,
  type CloudflareLiveUsageGateConfig,
  type CloudflareLiveUsageGateResult
} from "./cloudflare-live-usage-gate";

type FetchLike = typeof fetch;
const defaultReadRetryCount = 3;

type ReconciliationBody = {
  ok?: boolean;
  decision?: string;
  reason_codes?: string[];
  app_observed?: {
    sync_generation?: number;
    sync_object_count?: number;
    sync_change_count?: number;
    r2_estimated_objects?: number;
    r2_estimated_stored_bytes?: number;
    d1_retained_metric_rows?: number;
    d1_committed_batches?: number;
  };
  provider_observed?: {
    r2?: {
      inventory_mode?: string;
      object_count?: number;
      total_bytes?: number;
      list_calls?: number;
      truncated?: boolean;
      object_delta_vs_app?: number;
      byte_delta_vs_app_estimate?: number;
    };
  };
};

export type CloudflareLiveOpsReportResult = {
  ok: boolean;
  gate: CloudflareLiveUsageGateResult;
  reconciliation?: {
    ok: boolean;
    decision?: string;
    reason_codes: string[];
    r2_object_count?: number;
    r2_total_bytes?: number;
    r2_list_calls?: number;
    r2_truncated?: boolean;
    r2_inventory_mode?: string;
    r2_object_delta_vs_app?: number;
    r2_byte_delta_vs_app_estimate?: number;
    sync_generation?: number;
    sync_object_count?: number;
    sync_change_count?: number;
    d1_retained_metric_rows?: number;
    d1_committed_batches?: number;
  };
  errors: string[];
};

function isGateConfig(value: ReturnType<typeof readCloudflareLiveUsageGateConfig>): value is CloudflareLiveUsageGateConfig {
  return "usageToken" in value;
}

function reconciliationUrl(config: CloudflareLiveUsageGateConfig): URL {
  const url = new URL("/api/usage/reconcile", config.endpoint);
  url.searchParams.set("window_hours", String(config.windowHours));
  url.searchParams.set("max_r2_objects", process.env.LIVING_ATLAS_LIVE_RECONCILE_MAX_R2_OBJECTS ?? "10000");
  url.searchParams.set("inventory_mode", process.env.LIVING_ATLAS_LIVE_RECONCILE_INVENTORY_MODE ?? "full");
  return url;
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected ${value} to be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientReadStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
}

async function fetchReconciliation(config: CloudflareLiveUsageGateConfig, fetchImpl: FetchLike): Promise<NonNullable<CloudflareLiveOpsReportResult["reconciliation"]>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchImpl(reconciliationUrl(config), {
      headers: {
        "x-living-atlas-usage-token": config.usageToken
      },
      signal: controller.signal
    });
    const text = await response.text();
    const body = text.trim() ? JSON.parse(text) as ReconciliationBody : {};
    return {
      ok: response.ok && body.ok === true,
      decision: body.decision,
      reason_codes: body.reason_codes ?? (response.ok ? [] : [`http-${response.status}`]),
      r2_object_count: body.provider_observed?.r2?.object_count,
      r2_total_bytes: body.provider_observed?.r2?.total_bytes,
      r2_list_calls: body.provider_observed?.r2?.list_calls,
      r2_truncated: body.provider_observed?.r2?.truncated,
      r2_inventory_mode: body.provider_observed?.r2?.inventory_mode,
      r2_object_delta_vs_app: body.provider_observed?.r2?.object_delta_vs_app,
      r2_byte_delta_vs_app_estimate: body.provider_observed?.r2?.byte_delta_vs_app_estimate,
      sync_generation: body.app_observed?.sync_generation,
      sync_object_count: body.app_observed?.sync_object_count,
      sync_change_count: body.app_observed?.sync_change_count,
      d1_retained_metric_rows: body.app_observed?.d1_retained_metric_rows,
      d1_committed_batches: body.app_observed?.d1_committed_batches
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReconciliationWithRetry(config: CloudflareLiveUsageGateConfig, fetchImpl: FetchLike, env: NodeJS.ProcessEnv): Promise<NonNullable<CloudflareLiveOpsReportResult["reconciliation"]>> {
  const retries = parseInteger(envValue(env, "LIVING_ATLAS_LIVE_USAGE_READ_RETRIES"), defaultReadRetryCount, 0, 10);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await fetchReconciliation(config, fetchImpl);
      const transientHttp = result.reason_codes.some((reason) => reason.startsWith("http-") && isTransientReadStatus(Number(reason.slice(5))));
      if (result.ok || !transientHttp || attempt >= retries) {
        return result;
      }
      const delayMs = 500 * (attempt + 1);
      console.warn(`usage reconciliation read returned ${result.reason_codes.join(",")}; retry ${attempt + 1}/${retries} in ${delayMs}ms`);
      await sleep(delayMs);
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }
      const delayMs = 500 * (attempt + 1);
      console.warn(`usage reconciliation read failed; retry ${attempt + 1}/${retries} in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

export async function runCloudflareLiveOpsReport(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
} = {}): Promise<CloudflareLiveOpsReportResult> {
  const gate = await runCloudflareLiveUsageGate(options);
  const config = readCloudflareLiveUsageGateConfig(options.env);
  if (!isGateConfig(config)) {
    return {
      ok: false,
      gate,
      errors: config.errors
    };
  }

  try {
    const reconciliation = await fetchReconciliationWithRetry(config, options.fetchImpl ?? fetch, options.env ?? process.env);
    return {
      ok: gate.ok && reconciliation.ok,
      gate,
      reconciliation,
      errors: [
        ...gate.errors,
        ...(reconciliation.ok ? [] : [`usage reconciliation decision: ${reconciliation.decision ?? "unknown"}`])
      ]
    };
  } catch (error) {
    return {
      ok: false,
      gate,
      errors: [
        ...gate.errors,
        error instanceof Error ? error.message : String(error)
      ]
    };
  }
}

export function printCloudflareLiveOpsReport(result: CloudflareLiveOpsReportResult): void {
  const output = result.ok ? console.log : console.error;
  output(result.ok ? "Living Atlas Cloudflare ops report passed" : "Living Atlas Cloudflare ops report needs review");
  output(`gate_decision=${result.gate.decision ?? "unknown"}`);
  if (result.gate.summary) {
    output(`worker_requests=${result.gate.summary.worker_requests ?? "unknown"}; worker_ratio=${result.gate.summary.worker_request_ratio ?? "unknown"}; worker_5xx=${result.gate.summary.worker_5xx ?? "unknown"}`);
  }
  if (result.reconciliation) {
    output(`reconciliation_decision=${result.reconciliation.decision ?? "unknown"}`);
    output(`sync_generation=${result.reconciliation.sync_generation ?? "unknown"}; sync_objects=${result.reconciliation.sync_object_count ?? "unknown"}; sync_changes=${result.reconciliation.sync_change_count ?? "unknown"}`);
    output(`r2_objects=${result.reconciliation.r2_object_count ?? "unknown"}; r2_bytes=${result.reconciliation.r2_total_bytes ?? "unknown"}; r2_delta=${result.reconciliation.r2_object_delta_vs_app ?? "unknown"}; r2_list_calls=${result.reconciliation.r2_list_calls ?? "unknown"}; r2_truncated=${result.reconciliation.r2_truncated ?? "unknown"}; r2_inventory_mode=${result.reconciliation.r2_inventory_mode ?? "unknown"}`);
    output(`d1_metric_rows=${result.reconciliation.d1_retained_metric_rows ?? "unknown"}; d1_batches=${result.reconciliation.d1_committed_batches ?? "unknown"}`);
    for (const reason of result.reconciliation.reason_codes) {
      output(`reconciliation_reason=${reason}`);
    }
  }
  for (const reason of result.gate.reason_codes) {
    output(`gate_reason=${reason}`);
  }
  for (const error of result.errors) {
    output(`error: ${error}`);
  }
}

export async function main(): Promise<void> {
  const result = await runCloudflareLiveOpsReport();
  printCloudflareLiveOpsReport(result);
  if (!result.ok) {
    process.exitCode = result.errors.length > 0 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
