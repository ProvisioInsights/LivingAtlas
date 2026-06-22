import { pathToFileURL } from "node:url";

type FetchLike = typeof fetch;

type UsageGateBody = {
  ok?: boolean;
  decision?: string;
  reason_codes?: string[];
  policy?: {
    max_budget_ratio?: number;
    min_worker_requests_remaining?: number;
    require_zero_5xx?: boolean;
  };
  usage?: {
    window?: {
      hours?: number;
      from?: string;
      to?: string;
    };
    services?: {
      workers?: {
        observed?: {
          requests?: number;
          http_5xx?: number;
        };
        budgets?: {
          requests?: {
            used?: number;
            limit?: number;
            ratio?: number;
          };
        };
      };
      r2?: {
        observed?: {
          objects?: number;
          estimated_stored_bytes?: number;
        };
      };
      d1?: {
        observed?: {
          window_estimated_rows_written?: number;
        };
      };
    };
    sync?: {
      latest_generation?: number;
      object_count?: number;
      change_count?: number;
    };
  };
};

export type CloudflareLiveUsageGateConfig = {
  endpoint: string;
  healthToken: string;
  windowHours: number;
  maxBudgetRatio: number;
  minWorkerRequestsRemaining: number;
  requireZero5xx: boolean;
  requestTimeoutMs: number;
};

export type CloudflareLiveUsageGateResult = {
  ok: boolean;
  decision?: string;
  endpoint?: string;
  summary?: {
    window_hours?: number;
    worker_requests?: number;
    worker_request_limit?: number;
    worker_request_ratio?: number;
    worker_5xx?: number;
    sync_generation?: number;
    sync_objects?: number;
    sync_changes?: number;
    r2_objects?: number;
    r2_estimated_stored_bytes?: number;
    d1_window_estimated_rows_written?: number;
  };
  reason_codes: string[];
  errors: string[];
};

export const liveUsageGateEnv = {
  endpoint: "LIVING_ATLAS_LIVE_SYNC_ENDPOINT",
  healthToken: "LIVING_ATLAS_LIVE_HEALTH_TOKEN",
  syncToken: "LIVING_ATLAS_LIVE_SYNC_TOKEN",
  windowHours: "LIVING_ATLAS_LIVE_USAGE_WINDOW_HOURS",
  maxBudgetRatio: "LIVING_ATLAS_LIVE_USAGE_MAX_BUDGET_RATIO",
  minWorkerRequestsRemaining: "LIVING_ATLAS_LIVE_USAGE_MIN_WORKER_REQUESTS_REMAINING",
  requireZero5xx: "LIVING_ATLAS_LIVE_USAGE_REQUIRE_ZERO_5XX",
  timeoutMs: "LIVING_ATLAS_LIVE_REQUEST_TIMEOUT_MS",
  allowInsecureEndpoint: "LIVING_ATLAS_LIVE_ALLOW_INSECURE_ENDPOINT"
} as const;

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

function parseNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected ${value} to be a number from ${min} to ${max}`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(value.toLowerCase())) {
    return false;
  }

  throw new Error(`expected boolean-like value, got ${value}`);
}

function validateEndpoint(input: string, allowInsecureEndpoint: boolean): string {
  const url = new URL(input);
  if (url.search) {
    throw new Error("endpoint must not include query parameters");
  }

  if (url.protocol !== "https:" && !(allowInsecureEndpoint && url.protocol === "http:")) {
    throw new Error("endpoint must be https unless LIVING_ATLAS_LIVE_ALLOW_INSECURE_ENDPOINT=1");
  }

  return url.toString();
}

export function readCloudflareLiveUsageGateConfig(env: NodeJS.ProcessEnv = process.env): CloudflareLiveUsageGateConfig | CloudflareLiveUsageGateResult {
  const errors: string[] = [];
  const endpoint = envValue(env, liveUsageGateEnv.endpoint);
  const healthToken = envValue(env, liveUsageGateEnv.healthToken) ?? envValue(env, liveUsageGateEnv.syncToken);

  if (!endpoint) {
    errors.push(`missing ${liveUsageGateEnv.endpoint}`);
  }
  if (!healthToken) {
    errors.push(`missing ${liveUsageGateEnv.healthToken} or ${liveUsageGateEnv.syncToken}`);
  }
  if (errors.length > 0) {
    return { ok: false, reason_codes: [], errors };
  }

  try {
    return {
      endpoint: validateEndpoint(endpoint!, envValue(env, liveUsageGateEnv.allowInsecureEndpoint) === "1"),
      healthToken: healthToken!,
      windowHours: parseInteger(envValue(env, liveUsageGateEnv.windowHours), 24, 1, 720),
      maxBudgetRatio: parseNumber(envValue(env, liveUsageGateEnv.maxBudgetRatio), 0.8, 0.01, 1),
      minWorkerRequestsRemaining: parseInteger(envValue(env, liveUsageGateEnv.minWorkerRequestsRemaining), 1_000, 0, 100_000_000),
      requireZero5xx: parseBoolean(envValue(env, liveUsageGateEnv.requireZero5xx), true),
      requestTimeoutMs: parseInteger(envValue(env, liveUsageGateEnv.timeoutMs), 15_000, 1_000, 120_000)
    };
  } catch (error) {
    return {
      ok: false,
      reason_codes: [],
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

function isConfig(value: CloudflareLiveUsageGateConfig | CloudflareLiveUsageGateResult): value is CloudflareLiveUsageGateConfig {
  return "healthToken" in value;
}

function gateUrl(config: CloudflareLiveUsageGateConfig): URL {
  const url = new URL("/api/usage/gate", config.endpoint);
  url.searchParams.set("window_hours", String(config.windowHours));
  url.searchParams.set("max_budget_ratio", String(config.maxBudgetRatio));
  url.searchParams.set("min_worker_requests_remaining", String(config.minWorkerRequestsRemaining));
  url.searchParams.set("require_zero_5xx", config.requireZero5xx ? "1" : "0");
  return url;
}

function summarize(body: UsageGateBody): CloudflareLiveUsageGateResult["summary"] {
  return {
    window_hours: body.usage?.window?.hours,
    worker_requests: body.usage?.services?.workers?.observed?.requests,
    worker_request_limit: body.usage?.services?.workers?.budgets?.requests?.limit,
    worker_request_ratio: body.usage?.services?.workers?.budgets?.requests?.ratio,
    worker_5xx: body.usage?.services?.workers?.observed?.http_5xx,
    sync_generation: body.usage?.sync?.latest_generation,
    sync_objects: body.usage?.sync?.object_count,
    sync_changes: body.usage?.sync?.change_count,
    r2_objects: body.usage?.services?.r2?.observed?.objects,
    r2_estimated_stored_bytes: body.usage?.services?.r2?.observed?.estimated_stored_bytes,
    d1_window_estimated_rows_written: body.usage?.services?.d1?.observed?.window_estimated_rows_written
  };
}

export async function runCloudflareLiveUsageGate(options: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
} = {}): Promise<CloudflareLiveUsageGateResult> {
  const configOrError = readCloudflareLiveUsageGateConfig(options.env);
  if (!isConfig(configOrError)) {
    return configOrError;
  }

  const config = configOrError;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(gateUrl(config), {
      headers: {
        "x-living-atlas-health-token": config.healthToken
      },
      signal: controller.signal
    });
    const text = await response.text();
    const body = text.trim() ? JSON.parse(text) as UsageGateBody : {};
    if (!response.ok) {
      return {
        ok: false,
        decision: "stop-testing",
        endpoint: config.endpoint,
        reason_codes: [`http-${response.status}`],
        errors: [`usage gate returned HTTP ${response.status}`]
      };
    }

    return {
      ok: body.ok === true,
      decision: body.decision,
      endpoint: config.endpoint,
      summary: summarize(body),
      reason_codes: body.reason_codes ?? [],
      errors: body.ok === true ? [] : [`usage gate decision: ${body.decision ?? "unknown"}`]
    };
  } catch (error) {
    return {
      ok: false,
      decision: "stop-testing",
      endpoint: config.endpoint,
      reason_codes: ["usage-gate-request-failed"],
      errors: [error instanceof Error ? error.message : String(error)]
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function printCloudflareLiveUsageGateResult(result: CloudflareLiveUsageGateResult): void {
  const output = result.ok ? console.log : console.error;
  output(result.ok ? "Living Atlas Cloudflare live usage gate passed" : "Living Atlas Cloudflare live usage gate stopped testing");
  if (result.endpoint) {
    output(`endpoint: ${result.endpoint}`);
  }
  if (result.decision) {
    output(`decision: ${result.decision}`);
  }
  if (result.summary) {
    output(`window_hours=${result.summary.window_hours ?? "unknown"}`);
    output(`worker_requests=${result.summary.worker_requests ?? "unknown"}; worker_request_limit=${result.summary.worker_request_limit ?? "unknown"}; worker_request_ratio=${result.summary.worker_request_ratio ?? "unknown"}`);
    output(`worker_5xx=${result.summary.worker_5xx ?? "unknown"}`);
    output(`sync_generation=${result.summary.sync_generation ?? "unknown"}; sync_objects=${result.summary.sync_objects ?? "unknown"}; sync_changes=${result.summary.sync_changes ?? "unknown"}`);
    output(`r2_objects=${result.summary.r2_objects ?? "unknown"}; r2_estimated_stored_bytes=${result.summary.r2_estimated_stored_bytes ?? "unknown"}`);
    output(`d1_window_estimated_rows_written=${result.summary.d1_window_estimated_rows_written ?? "unknown"}`);
  }
  for (const reason of result.reason_codes) {
    output(`reason: ${reason}`);
  }
  for (const error of result.errors) {
    output(`error: ${error}`);
  }
}

export async function main(): Promise<void> {
  const result = await runCloudflareLiveUsageGate();
  printCloudflareLiveUsageGateResult(result);
  if (!result.ok) {
    process.exitCode = result.errors.length > 0 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
