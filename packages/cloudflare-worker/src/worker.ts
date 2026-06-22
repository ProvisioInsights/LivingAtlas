import { AuthorityIdSchema } from "@living-atlas/contracts";
import { SyncBatchSchema } from "@living-atlas/contracts";
import type { AccessMode, GraphObjectEnvelope, SyncBatch, SyncEnvelopePullResponse } from "@living-atlas/contracts";
import { BootstrapClaimBodySchema, verifyClaimToken, type BootstrapRuntimeConfig } from "./bootstrap";
import type { BootstrapClaimLockCore } from "./bootstrap-lock";
import { decryptCloudUnlockObject } from "./cloud-unlock";
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
import {
  getUsageGate,
  getUsageReconciliation,
  getUsageStatus,
  type UsageGateOptions,
  type UsageReconciliationOptions,
  type UsageRuntimeConfig
} from "./usage";
import {
  canonicalPredicate,
  createRemoteEdgeObject,
  createRemoteGraphObject,
  deleteRemoteEdgeObject,
  deleteRemoteGraphObject,
  findRemoteEdgeObject,
  latestRemoteGraphObject,
  listRemoteGraphObjects,
  queryRemoteTimeline,
  searchRemoteGraphObjects,
  traverseRemoteGraph,
  updateRemoteEdgeObject,
  updateRemoteGraphObject
} from "./remote-graph";

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
const cloudUnlockKeyHeader = "x-living-atlas-cloud-unlock-key";
const forbiddenQueryTokenParams = ["token", "claim_token", "bootstrap_claim_token", "sync_token", "cloud_unlock_key", "decrypt_key", "encryption_key"];

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

function cloudUnlockKeyPresented(request: Request): boolean {
  const value = request.headers.get(cloudUnlockKeyHeader);
  return typeof value === "string" && value.trim().length >= 16;
}

function cloudUnlockKey(request: Request): string | undefined {
  const value = request.headers.get(cloudUnlockKeyHeader);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function remoteRequestAccessMode(request: Request): AccessMode {
  return cloudUnlockKeyPresented(request) ? "cloud-unlock-session" : "remote-safe-only";
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

function hashIdPart(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36).padStart(8, "0");
}

function remoteMcpSyncBatchId(prefix: string, seed: string): string {
  return `${prefix}_${hashIdPart(seed)}${hashIdPart(`${seed}:extra`)}`;
}

async function commitRemoteGraphMutationToSync(
  request: Request,
  env: BootstrapWorkerEnv,
  mutation: "create" | "update" | "delete" | "restore",
  object: GraphObjectEnvelope,
  previousVersion?: number
): Promise<SyncBatch> {
  const statusResult = await getSyncStatus(
    request.headers.get(syncTokenHeader) ?? undefined,
    syncRuntimeConfig(env),
    env.LA_CONTROL_DB,
    syncTokenBinding(request)
  );
  if (!statusResult.ok) {
    throw new Error(statusResult.reason);
  }

  const submittedAt = new Date().toISOString();
  const baseGeneration = statusResult.status.latest_generation;
  const seed = [
    "remote-mcp-sync:v1",
    object.authority_id,
    object.object_id,
    String(object.version),
    object.content_hash,
    submittedAt
  ].join(":");
  const operationId = remoteMcpSyncBatchId("la_operation", seed);
  const traceId = remoteMcpSyncBatchId("la_trace", seed);
  const batch = SyncBatchSchema.parse({
    batch_id: remoteMcpSyncBatchId("la_sync_batch", seed),
    authority_id: object.authority_id,
    device_id: "la_device_remote_mcp",
    client_id: request.headers.get(syncClientHeader) ?? "la_client_remote_mcp",
    capability_id: request.headers.get(syncCapabilityHeader) ?? "la_cap_remote_mcp",
    token_id: request.headers.get(syncTokenIdHeader) ?? undefined,
    operation_id: operationId,
    trace_id: traceId,
    idempotency_key: remoteMcpSyncBatchId("la_idem", seed),
    submitted_at: submittedAt,
    base_generation: baseGeneration,
    target_generation: baseGeneration + 1,
    objects: [object],
    changes: [
      {
        change_id: remoteMcpSyncBatchId("la_change", seed),
        authority_id: object.authority_id,
        operation_id: operationId,
        trace_id: traceId,
        recorded_at: submittedAt,
        object_id: object.object_id,
        operation: mutation === "delete" ? "tombstone" : mutation,
        base_version: previousVersion,
        new_version: object.version,
        content_hash: object.content_hash,
        access_class: object.access_class,
        generation: baseGeneration + 1,
        actor_id: request.headers.get(syncClientHeader) ?? "remote-mcp"
      }
    ],
    withheld_plaintext_count: 0
  });

  const result = await acceptSyncBatch(
    batch,
    request.headers.get(syncTokenHeader) ?? undefined,
    syncRuntimeConfig(env),
    {
      graphBucket: env.LA_GRAPH_BUCKET,
      controlDb: env.LA_CONTROL_DB
    },
    syncTokenBinding(request)
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return batch;
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

  if (request.method === "GET" && url.pathname === "/api/usage/reconcile") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "usage tokens must not be sent in the query string" }, { status: 400 });
    }

    if (!(await hasValidHealthToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-health-token" }, { status: 401 });
    }

    return json(await getUsageReconciliation(
      env.LA_CONTROL_DB,
      env.LA_GRAPH_BUCKET,
      usageRuntimeConfig(env),
      usageReconciliationOptionsFromUrl(url)
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

function usageReconciliationOptionsFromUrl(url: URL): UsageReconciliationOptions {
  const windowHours = Number(url.searchParams.get("window_hours"));
  const maxR2Objects = Number(url.searchParams.get("max_r2_objects"));
  return {
    windowHours: Number.isFinite(windowHours) ? windowHours : undefined,
    maxR2Objects: Number.isFinite(maxR2Objects) ? maxR2Objects : undefined
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

function usageReconciliationOptionsFromArgs(args: unknown): UsageReconciliationOptions {
  return {
    windowHours: numberParam(args, "window_hours"),
    maxR2Objects: numberParam(args, "max_r2_objects")
  };
}

function remoteGraphStorage(env: BootstrapWorkerEnv) {
  return {
    graphBucket: env.LA_GRAPH_BUCKET,
    controlDb: env.LA_CONTROL_DB
  };
}

async function requireRemoteMcpSyncToken(request: Request, env: BootstrapWorkerEnv): Promise<void> {
  if (!(await hasValidSyncToken(request, env))) {
    throw new Error("missing-or-invalid-sync-token");
  }
}

function recordParam(params: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const value = params[key];
  return isRecord(value) ? value : undefined;
}

function syncMutationFromRemote(mutation: "created" | "updated" | "deleted" | "restored"): "create" | "update" | "delete" | "restore" {
  const byMutation = {
    created: "create",
    updated: "update",
    deleted: "delete",
    restored: "restore"
  } as const;
  return byMutation[mutation];
}

function latestEnvelopeForObject(response: SyncEnvelopePullResponse, objectId: string): GraphObjectEnvelope | undefined {
  return response.objects
    .filter((entry) => entry.object.object_id === objectId)
    .sort((left, right) => right.generation - left.generation || right.object.version - left.object.version)
    .at(0)?.object;
}

async function callRemoteMcpTool(name: string, args: unknown, request: Request, env: BootstrapWorkerEnv): Promise<unknown> {
  if (name === "remote_access_modes") {
    const currentMode = remoteRequestAccessMode(request);
    return {
      ok: true,
      current_mode: currentMode,
      modes: [
        {
          mode: "remote-safe-only",
          available: true,
          current: currentMode === "remote-safe-only",
          host_blind_sensitive_plaintext: true,
          sensitive_plaintext_available: false,
          key_persisted_by_cloudflare: false
        },
        {
          mode: "cloud-unlock-session",
          available: true,
          current: currentMode === "cloud-unlock-session",
          host_blind_sensitive_plaintext: false,
          sensitive_plaintext_available: currentMode === "cloud-unlock-session",
          key_persisted_by_cloudflare: false,
          required_header: cloudUnlockKeyHeader
        },
        {
          mode: "local-keyholding-only",
          available: false,
          current: false,
          host_blind_sensitive_plaintext: true,
          sensitive_plaintext_available: false,
          key_persisted_by_cloudflare: false,
          remote_note: "Use local MCP or a keyholding client; Cloudflare receives ciphertext or approved projections only."
        }
      ]
    };
  }

  if (name === "remote_sensitive_decrypt") {
    await requireRemoteMcpSyncToken(request, env);

    const unlockKey = cloudUnlockKey(request);
    if (!unlockKey) {
      return {
        ok: false,
        reason: "cloud-unlock-required",
        current_mode: "remote-safe-only",
        host_blind_sensitive_plaintext: true
      };
    }

    const authorityId = stringParam(args, "authority_id");
    const objectId = stringParam(args, "object_id");
    if (!authorityId || !objectId) {
      return {
        ok: false,
        reason: "invalid-decrypt-request",
        current_mode: "cloud-unlock-session",
        required_arguments: ["authority_id", "object_id"],
        key_persisted_by_cloudflare: false
      };
    }

    const pullResult = await getSyncEnvelopePull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      {
        graphBucket: env.LA_GRAPH_BUCKET,
        controlDb: env.LA_CONTROL_DB
      },
      authorityId,
      0,
      syncTokenBinding(request)
    );
    if (!pullResult.ok) {
      throw new Error(pullResult.reason);
    }

    const object = latestEnvelopeForObject(pullResult.response, objectId);
    if (!object) {
      return {
        ok: false,
        reason: "object-not-found",
        current_mode: "cloud-unlock-session",
        authority_id: authorityId,
        object_id: objectId,
        key_persisted_by_cloudflare: false
      };
    }

    if (object.access_class === "quarantine") {
      return {
        ok: false,
        reason: "quarantine-denied",
        current_mode: "cloud-unlock-session",
        authority_id: authorityId,
        object_id: objectId,
        key_persisted_by_cloudflare: false
      };
    }

    const decryptResult = await decryptCloudUnlockObject(object, unlockKey);
    if (!decryptResult.ok) {
      return {
        ok: false,
        reason: decryptResult.reason,
        current_mode: "cloud-unlock-session",
        authority_id: authorityId,
        object_id: objectId,
        key_persisted_by_cloudflare: false,
        host_blind_sensitive_plaintext: true
      };
    }

    return {
      ok: true,
      current_mode: "cloud-unlock-session",
      authority_id: authorityId,
      object_id: object.object_id,
      object_type: object.object_type,
      version: object.version,
      access_class: object.access_class,
      visible_metadata: object.visible_metadata,
      payload: decryptResult.plaintext,
      key_persisted_by_cloudflare: false,
      host_blind_sensitive_plaintext: false
    };
  }

  if (name === "remote_graph_status") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    if (!authorityId) {
      throw new Error("invalid-graph-status-request");
    }
    const objects = await listRemoteGraphObjects(remoteGraphStorage(env), authorityId, {
      include_tombstones: booleanParam(args, "include_tombstones"),
      limit: numberParam(args, "limit")
    });
    return {
      ok: true,
      authority_id: authorityId,
      object_count: objects.filter((object) => !object.visible_metadata.tombstone).length,
      tombstone_count: objects.filter((object) => object.visible_metadata.tombstone).length,
      remote_graph: "remote-readable"
    };
  }

  if (name === "remote_graph_list") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    if (!authorityId) {
      throw new Error("invalid-graph-list-request");
    }
    return {
      ok: true,
      authority_id: authorityId,
      objects: await listRemoteGraphObjects(remoteGraphStorage(env), authorityId, {
        include_tombstones: booleanParam(args, "include_tombstones"),
        object_type: stringParam(args, "object_type") as never,
        limit: numberParam(args, "limit")
      })
    };
  }

  if (name === "remote_graph_read") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const objectId = stringParam(args, "object_id");
    if (!authorityId || !objectId) {
      throw new Error("invalid-graph-read-request");
    }
    const object = await latestRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId);
    return object && !object.visible_metadata.tombstone
      ? { ok: true, object }
      : { ok: false, reason: "object-not-found", authority_id: authorityId, object_id: objectId };
  }

  if (name === "remote_graph_create") {
    await requireRemoteMcpSyncToken(request, env);
    const object = recordParam(args, "object");
    if (!object) {
      throw new Error("invalid-graph-create-request");
    }
    const result = await createRemoteGraphObject(remoteGraphStorage(env), object);
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

  if (name === "remote_graph_update") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const objectId = stringParam(args, "object_id");
    const patch = recordParam(args, "patch");
    if (!authorityId || !objectId || !patch) {
      throw new Error("invalid-graph-update-request");
    }
    const result = await updateRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId, patch, numberParam(args, "expected_version"));
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

  if (name === "remote_graph_delete") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const objectId = stringParam(args, "object_id");
    if (!authorityId || !objectId) {
      throw new Error("invalid-graph-delete-request");
    }
    const result = await deleteRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId, numberParam(args, "expected_version"));
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

  if (name === "remote_semantic_search") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const query = stringParam(args, "query");
    if (!authorityId || !query) {
      throw new Error("invalid-semantic-search-request");
    }
    return {
      ok: true,
      authority_id: authorityId,
      query,
      search_mode: "deterministic-text-v1",
      results: await searchRemoteGraphObjects(remoteGraphStorage(env), authorityId, query, {
        object_type: stringParam(args, "object_type") as never,
        limit: numberParam(args, "limit")
      })
    };
  }

  if (name === "remote_graph_traverse") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const startObjectId = stringParam(args, "start_object_id");
    if (!authorityId || !startObjectId) {
      throw new Error("invalid-graph-traverse-request");
    }
    const predicates = isRecord(args) && Array.isArray(args.predicates)
      ? args.predicates.filter((value): value is string => typeof value === "string").map(canonicalPredicate)
      : undefined;
    return {
      ok: true,
      authority_id: authorityId,
      ...(await traverseRemoteGraph(remoteGraphStorage(env), authorityId, startObjectId, {
        direction: stringParam(args, "direction") as never,
        max_depth: numberParam(args, "max_depth"),
        predicates,
        limit: numberParam(args, "limit")
      }))
    };
  }

  if (name === "remote_timeline_query") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    if (!authorityId) {
      throw new Error("invalid-timeline-query-request");
    }
    return {
      ok: true,
      authority_id: authorityId,
      results: await queryRemoteTimeline(remoteGraphStorage(env), authorityId, {
        from: stringParam(args, "from"),
        to: stringParam(args, "to"),
        object_id: stringParam(args, "object_id"),
        predicate: stringParam(args, "predicate"),
        limit: numberParam(args, "limit")
      })
    };
  }

  if (name === "remote_edge_create") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const edge = recordParam(args, "edge");
    if (!authorityId || !edge) {
      throw new Error("invalid-edge-create-request");
    }
    const result = await createRemoteEdgeObject(remoteGraphStorage(env), authorityId, edge);
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

  if (name === "remote_edge_read") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const edgeId = stringParam(args, "edge_id");
    if (!authorityId || !edgeId) {
      throw new Error("invalid-edge-read-request");
    }
    const object = await findRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId);
    return object && !object.visible_metadata.tombstone
      ? { ok: true, object }
      : { ok: false, reason: "edge-not-found", authority_id: authorityId, edge_id: edgeId };
  }

  if (name === "remote_edge_update") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const edgeId = stringParam(args, "edge_id");
    const patch = recordParam(args, "patch");
    if (!authorityId || !edgeId || !patch) {
      throw new Error("invalid-edge-update-request");
    }
    const result = await updateRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId, patch, numberParam(args, "expected_version"));
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

  if (name === "remote_edge_delete") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = stringParam(args, "authority_id");
    const edgeId = stringParam(args, "edge_id");
    if (!authorityId || !edgeId) {
      throw new Error("invalid-edge-delete-request");
    }
    const result = await deleteRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId, numberParam(args, "expected_version"));
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version
    );
    return {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id
    };
  }

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

  if (name === "remote_usage_reconcile") {
    if (!(await hasValidHealthToken(request, env))) {
      throw new Error("missing-or-invalid-health-token");
    }

    return getUsageReconciliation(
      env.LA_CONTROL_DB,
      env.LA_GRAPH_BUCKET,
      usageRuntimeConfig(env),
      usageReconciliationOptionsFromArgs(args)
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
          name: "remote_access_modes",
          description: "Describe Living Atlas remote-safe, cloud-unlock, and local-keyholding access modes for this request.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        },
        {
          name: "remote_sensitive_decrypt",
          description: "Decrypt a synced cloud-unlock ciphertext object with a transient request key. The key must be supplied in the x-living-atlas-cloud-unlock-key header and is not persisted.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" }
            }
          }
        },
        {
          name: "remote_graph_status",
          description: "Read remote-readable graph object counts for an authority.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id"],
            properties: {
              authority_id: { type: "string" },
              include_tombstones: { type: "boolean" },
              limit: { type: "integer", minimum: 1, maximum: 1000 }
            }
          }
        },
        {
          name: "remote_graph_list",
          description: "List remote-readable graph objects for an authority.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id"],
            properties: {
              authority_id: { type: "string" },
              object_type: { type: "string" },
              include_tombstones: { type: "boolean" },
              limit: { type: "integer", minimum: 1, maximum: 1000 }
            }
          }
        },
        {
          name: "remote_graph_read",
          description: "Read one remote-readable graph object by id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" }
            }
          }
        },
        {
          name: "remote_graph_create",
          description: "Create one remote-readable plaintext graph object. Local-private and quarantine objects are rejected.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["object"],
            properties: {
              object: { type: "object" }
            }
          }
        },
        {
          name: "remote_graph_update",
          description: "Update one remote-readable graph object with optimistic version support.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id", "patch"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 },
              patch: { type: "object" }
            }
          }
        },
        {
          name: "remote_graph_delete",
          description: "Tombstone one remote-readable graph object with optimistic version support.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 }
            }
          }
        },
        {
          name: "remote_semantic_search",
          description: "Search remote-readable graph object text and metadata. Current mode is deterministic text scoring; embedding/vector search can replace the scorer later.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "query"],
            properties: {
              authority_id: { type: "string" },
              query: { type: "string" },
              object_type: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 1000 }
            }
          }
        },
        {
          name: "remote_graph_traverse",
          description: "Traverse remote-readable edge objects from a start object.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "start_object_id"],
            properties: {
              authority_id: { type: "string" },
              start_object_id: { type: "string" },
              direction: { type: "string", enum: ["outbound", "inbound", "both"] },
              max_depth: { type: "integer", minimum: 1, maximum: 5 },
              predicates: { type: "array", items: { type: "string" } },
              limit: { type: "integer", minimum: 1, maximum: 1000 }
            }
          }
        },
        {
          name: "remote_timeline_query",
          description: "Query remote-readable graph objects by created/updated, edge valid dates, or event dates.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id"],
            properties: {
              authority_id: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              object_id: { type: "string" },
              predicate: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 1000 }
            }
          }
        },
        {
          name: "remote_edge_create",
          description: "Create a typed temporal edge as a remote-readable graph object.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge"],
            properties: {
              authority_id: { type: "string" },
              edge: { type: "object" }
            }
          }
        },
        {
          name: "remote_edge_read",
          description: "Read a remote-readable typed edge by edge_id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge_id"],
            properties: {
              authority_id: { type: "string" },
              edge_id: { type: "string" }
            }
          }
        },
        {
          name: "remote_edge_update",
          description: "Update a typed temporal edge by edge_id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge_id", "patch"],
            properties: {
              authority_id: { type: "string" },
              edge_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 },
              patch: { type: "object" }
            }
          }
        },
        {
          name: "remote_edge_delete",
          description: "Tombstone a typed temporal edge by edge_id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge_id"],
            properties: {
              authority_id: { type: "string" },
              edge_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 }
            }
          }
        },
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
          description: "Read committed sync envelopes after a generation. Sensitive objects remain ciphertext; remote-readable objects may be plaintext.",
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
        },
        {
          name: "remote_usage_reconcile",
          description: "Compare app-observed usage with provider-native inventory exposed through bound Cloudflare services.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              window_hours: { type: "integer", minimum: 1, maximum: 720 },
              max_r2_objects: { type: "integer", minimum: 1, maximum: 100000 }
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
