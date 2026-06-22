import { AuthorityIdSchema } from "@living-atlas/contracts";
import { BootstrapClaimBodySchema, verifyClaimToken, type BootstrapRuntimeConfig } from "./bootstrap";
import type { BootstrapClaimLockCore } from "./bootstrap-lock";
import {
  applyWorkerTraceHeaders,
  createWorkerErrorEvent,
  createWorkerObservabilityContext,
  createWorkerRequestEvent,
  emitWorkerOperationalTelemetry,
  type OperationalMetricRetentionStore,
  type WorkerObservabilityEnv
} from "./observability";
import {
  acceptSyncBatch,
  getSyncEnvelopePull,
  getSyncPull,
  getSyncStatus,
  type SyncBatchAcceptResult,
  type SyncRuntimeConfig,
  type SyncTokenBinding
} from "./sync";
import { authoritySequencerName } from "./sync-sequencer";
import { getUsageGate, getUsageStatus, type UsageGateOptions, type UsageRuntimeConfig } from "./usage";

export type BootstrapClaimLockRpc = Pick<BootstrapClaimLockCore, "getStatus" | "claim">;
export type SyncSequencerRpc = {
  acceptBatch(
    input: unknown,
    token: string | undefined,
    config: SyncRuntimeConfig,
    binding?: SyncTokenBinding
  ): Promise<SyncBatchAcceptResult>;
};

export type BootstrapWorkerEnv = {
  BOOTSTRAP_CLAIM_LOCK: {
    getByName(name: string): BootstrapClaimLockRpc;
  };
  SYNC_SEQUENCER?: {
    getByName(name: string): SyncSequencerRpc;
  };
  LA_GRAPH_BUCKET: R2Bucket;
  LA_CONTROL_DB: D1Database & OperationalMetricRetentionStore;
  BOOTSTRAP_CLAIM_TOKEN_HASH?: string;
  BOOTSTRAP_TOKEN_EXPIRES_AT?: string;
  BOOTSTRAP_LOCK_NAME?: string;
  LA_SYNC_TOKEN_HASH?: string;
  LA_SYNC_CLIENT_ID?: string;
  LA_SYNC_CAPABILITY_ID?: string;
  LA_SYNC_TOKEN_ID?: string;
  LA_STEALTH_MODE?: string;
  LA_HEALTH_TOKEN_HASH?: string;
  LA_USAGE_PROVIDER?: string;
  LA_USAGE_PLAN?: string;
  LA_USAGE_WINDOW_HOURS?: string;
  LA_USAGE_BUDGETS_JSON?: string;
} & WorkerObservabilityEnv;

const tokenHeader = "x-living-atlas-bootstrap-token";
const healthTokenHeader = "x-living-atlas-health-token";
const syncTokenHeader = "x-living-atlas-sync-token";
const syncClientHeader = "x-living-atlas-sync-client-id";
const syncCapabilityHeader = "x-living-atlas-sync-capability-id";
const syncTokenIdHeader = "x-living-atlas-sync-token-id";
const forbiddenQueryTokenParams = ["token", "claim_token", "bootstrap_claim_token", "sync_token"];

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init?.headers
    }
  });
}

function plainNotFound(): Response {
  return new Response("Not Found\n", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function truthyFlag(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

function runtimeConfig(env: BootstrapWorkerEnv): BootstrapRuntimeConfig {
  return {
    claim_token_hash: env.BOOTSTRAP_CLAIM_TOKEN_HASH,
    claim_token_expires_at: env.BOOTSTRAP_TOKEN_EXPIRES_AT
  };
}

function syncRuntimeConfig(env: BootstrapWorkerEnv): SyncRuntimeConfig {
  return {
    sync_token_hash: env.LA_SYNC_TOKEN_HASH,
    sync_client_id: env.LA_SYNC_CLIENT_ID,
    sync_capability_id: env.LA_SYNC_CAPABILITY_ID,
    sync_token_id: env.LA_SYNC_TOKEN_ID
  };
}

function usageRuntimeConfig(env: BootstrapWorkerEnv): UsageRuntimeConfig {
  return {
    provider: env.LA_USAGE_PROVIDER,
    plan: env.LA_USAGE_PLAN,
    default_window_hours: env.LA_USAGE_WINDOW_HOURS,
    budgets_json: env.LA_USAGE_BUDGETS_JSON
  };
}

function getClaimLock(env: BootstrapWorkerEnv): BootstrapClaimLockRpc {
  return env.BOOTSTRAP_CLAIM_LOCK.getByName(env.BOOTSTRAP_LOCK_NAME ?? "living-atlas-bootstrap-claim-lock");
}

function queryContainsToken(url: URL): boolean {
  return forbiddenQueryTokenParams.some((param) => url.searchParams.has(param));
}

async function hasValidToken(token: string | undefined, hash: string | undefined): Promise<boolean> {
  return !!token && await verifyClaimToken(token, hash);
}

async function hasValidBootstrapToken(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  return hasValidToken(request.headers.get(tokenHeader) ?? undefined, env.BOOTSTRAP_CLAIM_TOKEN_HASH);
}

async function hasValidHealthToken(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  const token = request.headers.get(healthTokenHeader) ?? undefined;
  return (
    await hasValidToken(token, env.LA_HEALTH_TOKEN_HASH) ||
    await hasValidToken(token, env.LA_SYNC_TOKEN_HASH) ||
    await hasValidToken(token, env.BOOTSTRAP_CLAIM_TOKEN_HASH)
  );
}

async function hasValidSyncToken(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  const token = request.headers.get(syncTokenHeader) ?? undefined;
  if (!(await hasValidToken(token, env.LA_SYNC_TOKEN_HASH))) {
    return false;
  }

  const binding = syncTokenBinding(request);
  if (env.LA_SYNC_CLIENT_ID && binding.client_id !== env.LA_SYNC_CLIENT_ID) {
    return false;
  }

  if (env.LA_SYNC_CAPABILITY_ID && binding.capability_id !== env.LA_SYNC_CAPABILITY_ID) {
    return false;
  }

  if (env.LA_SYNC_TOKEN_ID && binding.token_id !== env.LA_SYNC_TOKEN_ID) {
    return false;
  }

  return true;
}

async function shouldStealthDrop(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  if (!truthyFlag(env.LA_STEALTH_MODE)) {
    return false;
  }

  const url = new URL(request.url);
  if (queryContainsToken(url)) {
    return true;
  }

  if (url.pathname === "/healthz") {
    return !(await hasValidHealthToken(request, env));
  }

  if (url.pathname.startsWith("/api/bootstrap/")) {
    return !(await hasValidBootstrapToken(request, env));
  }

  if (url.pathname.startsWith("/api/sync/")) {
    return !(await hasValidSyncToken(request, env));
  }

  if (url.pathname.startsWith("/api/usage/")) {
    return !(await hasValidHealthToken(request, env));
  }

  if (url.pathname === "/mcp") {
    return !(await hasValidSyncToken(request, env));
  }

  return true;
}

function syncTokenBinding(request: Request): SyncTokenBinding {
  return {
    client_id: request.headers.get(syncClientHeader) ?? undefined,
    capability_id: request.headers.get(syncCapabilityHeader) ?? undefined,
    token_id: request.headers.get(syncTokenIdHeader) ?? undefined
  };
}

function authorityFromBatch(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("authority_id" in input)) {
    return undefined;
  }

  const parsed = AuthorityIdSchema.safeParse((input as { authority_id?: unknown }).authority_id);
  return parsed.success ? parsed.data : undefined;
}

async function getSyncSequencer(env: BootstrapWorkerEnv, authorityId: string): Promise<SyncSequencerRpc | undefined> {
  return env.SYNC_SEQUENCER?.getByName(await authoritySequencerName(authorityId));
}

function syncErrorStatus(reason: "sync-disabled" | "missing-token" | "invalid-token" | "invalid-token-binding" | "invalid-pull-request"): number {
  const statusByReason = {
    "sync-disabled": 423,
    "missing-token": 401,
    "invalid-token": 401,
    "invalid-token-binding": 403,
    "invalid-pull-request": 400
  } satisfies Record<typeof reason, number>;

  return statusByReason[reason];
}

async function emitWorkerTelemetry(env: BootstrapWorkerEnv, event: ReturnType<typeof createWorkerRequestEvent> | ReturnType<typeof createWorkerErrorEvent>): Promise<void> {
  try {
    await emitWorkerOperationalTelemetry(env, event);
  } catch {
    // Telemetry is best-effort and must not change request behavior.
  }
}

async function readClaimBody(request: Request): Promise<{ token?: string; payload?: unknown; malformed?: boolean }> {
  const headerToken = request.headers.get(tokenHeader) ?? undefined;
  let bodyJson: unknown;
  try {
    bodyJson = await request.json();
  } catch {
    return { token: headerToken, malformed: true };
  }

  const parsed = BootstrapClaimBodySchema.safeParse(bodyJson);
  if (!parsed.success) {
    return { token: headerToken, malformed: true };
  }

  const { claim_token, ...payload } = parsed.data;
  return {
    token: headerToken ?? claim_token,
    payload
  };
}

async function routeBootstrapRequest(request: Request, env: BootstrapWorkerEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/healthz") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap/status") {
    const lock = getClaimLock(env);
    const config = runtimeConfig(env);
    return json(await lock.getStatus(config));
  }

  if (request.method === "POST" && url.pathname === "/api/bootstrap/claim") {
    const lock = getClaimLock(env);
    const config = runtimeConfig(env);
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "bootstrap token must not be sent in the query string" }, { status: 400 });
    }

    const { token, payload, malformed } = await readClaimBody(request);
    if (malformed || !payload) {
      return json({ ok: false, error: "malformed bootstrap claim" }, { status: 400 });
    }

    const result = await lock.claim(payload, token, config, new Date().toISOString());
    if (result.ok) {
      return json({ ok: true, status: result.status }, { status: 201 });
    }

    const statusByReason: Record<typeof result.reason, number> = {
      sealed: 423,
      "already-claimed": 409,
      "missing-token": 401,
      "invalid-token": 401,
      "expired-token": 410,
      "malformed-claim": 400
    };

    return json({ ok: false, error: result.reason, status: result.status }, { status: statusByReason[result.reason] });
  }

  if (request.method === "POST" && url.pathname === "/api/sync/batch") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "sync token must not be sent in the query string" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "malformed-batch" }, { status: 400 });
    }

    const authorityId = authorityFromBatch(body);
    const sequencer = authorityId ? await getSyncSequencer(env, authorityId) : undefined;
    const result = sequencer
      ? await sequencer.acceptBatch(
          body,
          request.headers.get(syncTokenHeader) ?? undefined,
          syncRuntimeConfig(env),
          syncTokenBinding(request)
        )
      : await acceptSyncBatch(
          body,
          request.headers.get(syncTokenHeader) ?? undefined,
          syncRuntimeConfig(env),
          {
            graphBucket: env.LA_GRAPH_BUCKET,
            controlDb: env.LA_CONTROL_DB
          },
          syncTokenBinding(request)
        );

    if (result.ok) {
      return json(result.accepted, { status: 202 });
    }

    const statusByReason: Record<typeof result.reason, number> = {
      "sync-disabled": 423,
      "missing-token": 401,
      "invalid-token": 401,
      "invalid-token-binding": 403,
      "malformed-batch": 400,
      "batch-hash-mismatch": 400,
      "idempotency-conflict": 409,
      "stale-generation": 409,
      "generation-gap": 409,
      "batch-in-flight": 409,
      "batch-conflict": 409
    };

    return json({ ok: false, error: result.reason, status: result.status }, { status: statusByReason[result.reason] });
  }

  if (request.method === "GET" && url.pathname === "/api/sync/status") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "sync token must not be sent in the query string" }, { status: 400 });
    }

    const result = await getSyncStatus(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      syncTokenBinding(request)
    );
    if (result.ok) {
      return json(result.status);
    }

    const statusByReason: Record<typeof result.reason, number> = {
      "sync-disabled": 423,
      "missing-token": 401,
      "invalid-token": 401,
      "invalid-token-binding": 403
    };

    return json({ ok: false, error: result.reason }, { status: statusByReason[result.reason] });
  }

  if (request.method === "GET" && url.pathname === "/api/sync/pull") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "sync token must not be sent in the query string" }, { status: 400 });
    }

    const afterGeneration = Number(url.searchParams.get("after_generation"));
    const result = await getSyncPull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      url.searchParams.get("authority_id") ?? undefined,
      Number.isFinite(afterGeneration) ? afterGeneration : undefined,
      syncTokenBinding(request)
    );
    if (result.ok) {
      return json(result.response);
    }

    const statusByReason: Record<typeof result.reason, number> = {
      "sync-disabled": 423,
      "missing-token": 401,
      "invalid-token": 401,
      "invalid-token-binding": 403,
      "invalid-pull-request": 400
    };

    return json({ ok: false, error: result.reason }, { status: statusByReason[result.reason] });
  }

  if (request.method === "GET" && url.pathname === "/api/sync/envelopes") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "sync token must not be sent in the query string" }, { status: 400 });
    }

    const afterGeneration = Number(url.searchParams.get("after_generation"));
    const result = await getSyncEnvelopePull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      {
        graphBucket: env.LA_GRAPH_BUCKET,
        controlDb: env.LA_CONTROL_DB
      },
      url.searchParams.get("authority_id") ?? undefined,
      Number.isFinite(afterGeneration) ? afterGeneration : undefined,
      syncTokenBinding(request)
    );
    if (result.ok) {
      return json(result.response);
    }

    return json({ ok: false, error: result.reason }, { status: syncErrorStatus(result.reason) });
  }

  if (request.method === "GET" && url.pathname === "/api/usage/status") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "usage tokens must not be sent in the query string" }, { status: 400 });
    }

    if (!(await hasValidHealthToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-health-token" }, { status: 401 });
    }

    const windowHours = Number(url.searchParams.get("window_hours"));
    return json(await getUsageStatus(
      env.LA_CONTROL_DB,
      usageRuntimeConfig(env),
      {
        windowHours: Number.isFinite(windowHours) ? windowHours : undefined
      }
    ));
  }

  if (request.method === "GET" && url.pathname === "/api/usage/gate") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "usage tokens must not be sent in the query string" }, { status: 400 });
    }

    if (!(await hasValidHealthToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-health-token" }, { status: 401 });
    }

    return json(await getUsageGate(
      env.LA_CONTROL_DB,
      usageRuntimeConfig(env),
      usageGateOptionsFromUrl(url)
    ));
  }

  if (request.method === "POST" && url.pathname === "/mcp") {
    if (queryContainsToken(url)) {
      return json({ jsonrpc: "2.0", error: { code: -32600, message: "tokens must not be sent in the query string" }, id: null }, { status: 400 });
    }

    return routeRemoteMcpRequest(request, env);
  }

  return plainNotFound();
}

type JsonRpcRequest = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function jsonRpcResult(id: unknown, result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringParam(params: unknown, key: string): string | undefined {
  return isRecord(params) && typeof params[key] === "string" ? params[key] : undefined;
}

function numberParam(params: unknown, key: string): number | undefined {
  return isRecord(params) && typeof params[key] === "number" && Number.isInteger(params[key]) ? params[key] : undefined;
}

function finiteNumberParam(params: unknown, key: string): number | undefined {
  return isRecord(params) && typeof params[key] === "number" && Number.isFinite(params[key]) ? params[key] : undefined;
}

function booleanParam(params: unknown, key: string): boolean | undefined {
  return isRecord(params) && typeof params[key] === "boolean" ? params[key] : undefined;
}

function usageGateOptionsFromUrl(url: URL): UsageGateOptions {
  const windowHours = Number(url.searchParams.get("window_hours"));
  const maxBudgetRatio = Number(url.searchParams.get("max_budget_ratio"));
  const minWorkerRequestsRemaining = Number(url.searchParams.get("min_worker_requests_remaining"));
  const requireZero5xx = url.searchParams.get("require_zero_5xx");
  return {
    windowHours: Number.isFinite(windowHours) ? windowHours : undefined,
    maxBudgetRatio: Number.isFinite(maxBudgetRatio) ? maxBudgetRatio : undefined,
    minWorkerRequestsRemaining: Number.isFinite(minWorkerRequestsRemaining) ? minWorkerRequestsRemaining : undefined,
    requireZero5xx: requireZero5xx === null ? undefined : requireZero5xx !== "0"
  };
}

function usageGateOptionsFromArgs(args: unknown): UsageGateOptions {
  return {
    windowHours: numberParam(args, "window_hours"),
    maxBudgetRatio: finiteNumberParam(args, "max_budget_ratio"),
    minWorkerRequestsRemaining: numberParam(args, "min_worker_requests_remaining"),
    requireZero5xx: booleanParam(args, "require_zero_5xx")
  };
}

async function callRemoteMcpTool(name: string, args: unknown, request: Request, env: BootstrapWorkerEnv): Promise<unknown> {
  if (name === "remote_sync_status") {
    const result = await getSyncStatus(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.status;
  }

  if (name === "remote_sync_pull") {
    const result = await getSyncPull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      stringParam(args, "authority_id"),
      numberParam(args, "after_generation"),
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.response;
  }

  if (name === "remote_sync_envelopes") {
    const result = await getSyncEnvelopePull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      {
        graphBucket: env.LA_GRAPH_BUCKET,
        controlDb: env.LA_CONTROL_DB
      },
      stringParam(args, "authority_id"),
      numberParam(args, "after_generation"),
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.response;
  }

  if (name === "remote_usage_gate") {
    if (!(await hasValidHealthToken(request, env))) {
      throw new Error("missing-or-invalid-health-token");
    }

    return getUsageGate(
      env.LA_CONTROL_DB,
      usageRuntimeConfig(env),
      usageGateOptionsFromArgs(args)
    );
  }

  throw new Error("unknown-tool");
}

async function routeRemoteMcpRequest(request: Request, env: BootstrapWorkerEnv): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "parse-error", 400);
  }

  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body.id, -32600, "invalid-request", 400);
  }

  if (body.method === "initialize") {
    return jsonRpcResult(body.id, {
      protocolVersion: "2025-06-18",
      serverInfo: {
        name: "living-atlas-cloudflare-remote",
        version: "0.1.0"
      },
      capabilities: {
        tools: {}
      }
    });
  }

  if (body.method === "tools/list") {
    return jsonRpcResult(body.id, {
      tools: [
        {
          name: "remote_sync_status",
          description: "Read remote sync cursor and counts for the authenticated authority.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        },
        {
          name: "remote_sync_pull",
          description: "Read committed sync batch summaries after a generation.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "after_generation"],
            properties: {
              authority_id: { type: "string" },
              after_generation: { type: "integer", minimum: 0 }
            }
          }
        },
        {
          name: "remote_sync_envelopes",
          description: "Read committed ciphertext envelopes after a generation.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "after_generation"],
            properties: {
              authority_id: { type: "string" },
              after_generation: { type: "integer", minimum: 0 }
            }
          }
        },
        {
          name: "remote_usage_gate",
          description: "Read observed usage and return a safe-to-test or stop-testing decision before live validation.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              window_hours: { type: "integer", minimum: 1, maximum: 720 },
              max_budget_ratio: { type: "number", minimum: 0.01, maximum: 1 },
              min_worker_requests_remaining: { type: "integer", minimum: 0 },
              require_zero_5xx: { type: "boolean" }
            }
          }
        }
      ]
    });
  }

  if (body.method === "tools/call") {
    const params = body.params;
    if (!isRecord(params) || typeof params.name !== "string") {
      return jsonRpcError(body.id, -32602, "invalid-tool-call");
    }

    try {
      const result = await callRemoteMcpTool(params.name, params.arguments, request, env);
      return jsonRpcResult(body.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2)
          }
        ],
        structuredContent: result
      });
    } catch (error) {
      return jsonRpcError(body.id, -32000, error instanceof Error ? error.message : "tool-error");
    }
  }

  return jsonRpcError(body.id, -32601, "method-not-found");
}

export async function handleBootstrapRequest(request: Request, env: BootstrapWorkerEnv): Promise<Response> {
  if (await shouldStealthDrop(request, env)) {
    return plainNotFound();
  }

  const startedAt = Date.now();
  const observability = createWorkerObservabilityContext(request);

  try {
    const response = applyWorkerTraceHeaders(await routeBootstrapRequest(request, env), observability);
    await emitWorkerTelemetry(
      env,
      createWorkerRequestEvent({
        context: observability,
        status: response.status,
        durationMs: Date.now() - startedAt
      })
    );
    return response;
  } catch (error) {
    const response = applyWorkerTraceHeaders(
      json({ ok: false, error: "internal-error" }, { status: 500 }),
      observability
    );
    await emitWorkerTelemetry(
      env,
      createWorkerErrorEvent({
        context: observability,
        durationMs: Date.now() - startedAt,
        error
      })
    );
    return response;
  }
}

export default {
  async fetch(request: Request, env: BootstrapWorkerEnv): Promise<Response> {
    return handleBootstrapRequest(request, env);
  }
};
