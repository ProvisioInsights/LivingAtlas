import { AuthorityIdSchema, PraxisActivityAuditStreamRequestSchema } from "@living-atlas/contracts";
import { SyncBatchSchema } from "@living-atlas/contracts";
import type { AccessMode, GraphObjectEnvelope, SyncBatch, SyncEnvelopePullResponse } from "@living-atlas/contracts";
import type { DurableAuditEvent, Operation } from "@living-atlas/contracts";
import { appendAuditEvent, createAuditId, readPraxisActivityAuditStream } from "./audit-ledger";
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
import { readSyncStatus } from "./sync-storage";
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
  commitRemoteGraphWrite,
  failRemoteGraphWrite,
  findRemoteEdgeObject,
  isExpiredReleaseObject,
  latestRemoteGraphObject,
  listRemoteGraphObjects,
  prepareCreateRemoteEdgeObject,
  prepareCreateRemoteGraphObject,
  prepareDeleteRemoteEdgeObject,
  prepareDeleteRemoteGraphObject,
  prepareUpdateRemoteEdgeObject,
  prepareUpdateRemoteGraphObject,
  queryRemoteTimeline,
  reconcileRemoteGraph,
  searchRemoteGraphObjects,
  stageRemoteGraphWrite,
  storePreparedRemoteGraphMutation,
  traverseRemoteGraph,
  type RemoteGraphMutationResult,
  type RemoteGraphWriteOperation
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
  LA_AUTHORITY_ID?: string;
  LA_SYNC_TOKEN_HASH?: string;
  LA_SYNC_CLIENT_ID?: string;
  LA_SYNC_CAPABILITY_ID?: string;
  LA_SYNC_TOKEN_ID?: string;
  LA_CLOUD_UNLOCK_CLIENT_ID?: string;
  LA_CLOUD_UNLOCK_CAPABILITY_ID?: string;
  LA_CLOUD_UNLOCK_TOKEN_ID?: string;
  LA_STEALTH_MODE?: string;
  LA_HEALTH_TOKEN_HASH?: string;
  LA_USAGE_PROVIDER?: string;
  LA_USAGE_PLAN?: string;
  LA_USAGE_TOKEN_HASH?: string;
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
const remoteWriteIdempotencyHeader = "x-living-atlas-idempotency-key";
const forbiddenQueryTokenParams = ["token", "claim_token", "bootstrap_claim_token", "sync_token", "cloud_unlock_key", "decrypt_key", "encryption_key"];
const forbiddenQueryTokenPattern = /(^|[_-])(authorization|bearer|token|secret|password|api[_-]?key|access[_-]?key|cloud[_-]?unlock[_-]?key|decrypt[_-]?key|encryption[_-]?key|key)($|[_-])/i;

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
    sync_token_id: env.LA_SYNC_TOKEN_ID,
    authority_id: configuredAuthorityId(env)
  };
}

function cloudUnlockRuntimeConfig(env: BootstrapWorkerEnv): SyncRuntimeConfig {
  return {
    sync_token_hash: env.LA_SYNC_TOKEN_HASH,
    sync_client_id: env.LA_CLOUD_UNLOCK_CLIENT_ID,
    sync_capability_id: env.LA_CLOUD_UNLOCK_CAPABILITY_ID,
    sync_token_id: env.LA_CLOUD_UNLOCK_TOKEN_ID,
    authority_id: configuredAuthorityId(env)
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
  return [...url.searchParams.keys()].some((param) => (
    forbiddenQueryTokenParams.includes(param) || forbiddenQueryTokenPattern.test(param)
  ));
}

async function hasValidToken(token: string | undefined, hash: string | undefined): Promise<boolean> {
  return !!token && await verifyClaimToken(token, hash);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
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

async function hasValidUsageToken(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  const token = request.headers.get("x-living-atlas-usage-token") ?? undefined;
  return await hasValidToken(token, env.LA_USAGE_TOKEN_HASH);
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

function configuredAuthorityId(env: BootstrapWorkerEnv): string | undefined {
  if (!env.LA_AUTHORITY_ID) {
    return undefined;
  }
  return AuthorityIdSchema.parse(env.LA_AUTHORITY_ID);
}

function requireConfiguredAuthority(env: BootstrapWorkerEnv): string {
  const authorityId = configuredAuthorityId(env);
  if (!authorityId) {
    throw new Error("authority-not-configured");
  }
  return authorityId;
}

function requireBoundAuthority(env: BootstrapWorkerEnv, authorityId: string | undefined, reason: string): string {
  const configured = requireConfiguredAuthority(env);
  if (authorityId !== configured) {
    throw new Error(reason);
  }
  return configured;
}

function jsonAuthorityNotConfigured(): Response {
  return json({ ok: false, error: "authority-not-configured" }, { status: 423 });
}

function jsonAuthorityMismatch(error = "authority-mismatch"): Response {
  return json({ ok: false, error }, { status: 403 });
}

async function hasValidCloudUnlockCapability(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  if (!env.LA_CLOUD_UNLOCK_CAPABILITY_ID) {
    return false;
  }

  const token = request.headers.get(syncTokenHeader) ?? undefined;
  if (!(await hasValidToken(token, env.LA_SYNC_TOKEN_HASH))) {
    return false;
  }

  const binding = syncTokenBinding(request);
  if (env.LA_CLOUD_UNLOCK_CLIENT_ID && binding.client_id !== env.LA_CLOUD_UNLOCK_CLIENT_ID) {
    return false;
  }
  if (binding.capability_id !== env.LA_CLOUD_UNLOCK_CAPABILITY_ID) {
    return false;
  }
  if (env.LA_CLOUD_UNLOCK_TOKEN_ID && binding.token_id !== env.LA_CLOUD_UNLOCK_TOKEN_ID) {
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

  if (url.pathname.startsWith("/api/activity/") || url.pathname.startsWith("/api/audit/")) {
    return !(await hasValidSyncToken(request, env));
  }

  if (url.pathname.startsWith("/api/usage/")) {
    return !(await hasValidUsageToken(request, env));
  }

  if (url.pathname === "/mcp") {
    return !(await hasValidRemoteMcpDiscoveryToken(request, env));
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
  previousVersion: number | undefined,
  write?: {
    idempotency_key: string;
    request_hash: string;
    submitted_at: string;
  }
): Promise<SyncBatch> {
  const submittedAt = write?.submitted_at ?? new Date().toISOString();
  const requestHash = write?.request_hash ?? `sha256:${await sha256Hex([
    "remote-mcp-sync:v1",
    mutation,
    object.authority_id,
    object.object_id,
    String(object.version),
    object.content_hash,
    submittedAt
  ].join(":"))}`;
  const idempotencyKey = write?.idempotency_key ?? remoteMcpSyncBatchId("la_idem", requestHash);
  const baseGeneration = (await readSyncStatus(env.LA_CONTROL_DB, object.authority_id)).latest_generation;
  const seed = [
    "remote-mcp-sync:v1",
    idempotencyKey,
    requestHash,
    object.authority_id,
    object.object_id,
    String(object.version),
    object.content_hash
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
    idempotency_key: idempotencyKey,
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
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "bootstrap token must not be sent in the query string" }, { status: 400 });
    }
    if (!(await hasValidBootstrapToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-bootstrap-token" }, { status: 401 });
    }
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

    if (isRecord(payload)) {
      try {
        requireBoundAuthority(env, stringParam(payload, "authority_id"), "bootstrap-authority-mismatch");
      } catch (error) {
        return error instanceof Error && error.message === "authority-not-configured"
          ? jsonAuthorityNotConfigured()
          : jsonAuthorityMismatch("bootstrap-authority-mismatch");
      }
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

    if (!(await hasValidSyncToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-sync-token" }, { status: 401 });
    }

    const authorityId = authorityFromBatch(body);
    try {
      requireBoundAuthority(env, authorityId, "sync-authority-mismatch");
    } catch (error) {
      return error instanceof Error && error.message === "authority-not-configured"
        ? jsonAuthorityNotConfigured()
        : jsonAuthorityMismatch("sync-authority-mismatch");
    }
    const sequencer = authorityId ? await getSyncSequencer(env, authorityId) : undefined;
    let result = sequencer
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
    if (!result.ok && result.reason === "generation-gap" && sequencer && authorityId) {
      const parsedBatch = SyncBatchSchema.safeParse(body);
      const currentStatus = parsedBatch.success ? await readSyncStatus(env.LA_CONTROL_DB, authorityId) : undefined;
      if (parsedBatch.success && currentStatus?.latest_generation === parsedBatch.data.base_generation) {
        result = await acceptSyncBatch(
          body,
          request.headers.get(syncTokenHeader) ?? undefined,
          syncRuntimeConfig(env),
          {
            graphBucket: env.LA_GRAPH_BUCKET,
            controlDb: env.LA_CONTROL_DB
          },
          syncTokenBinding(request)
        );
      }
    }

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

    try {
      requireConfiguredAuthority(env);
    } catch {
      return jsonAuthorityNotConfigured();
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
    const authorityId = url.searchParams.get("authority_id") ?? undefined;
    if (!(await hasValidSyncToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-sync-token" }, { status: 401 });
    }
    try {
      requireBoundAuthority(env, authorityId, "sync-authority-mismatch");
    } catch (error) {
      return error instanceof Error && error.message === "authority-not-configured"
        ? jsonAuthorityNotConfigured()
        : jsonAuthorityMismatch("sync-authority-mismatch");
    }
    const result = await getSyncPull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      authorityId,
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
    const authorityId = url.searchParams.get("authority_id") ?? undefined;
    if (!(await hasValidSyncToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-sync-token" }, { status: 401 });
    }
    try {
      requireBoundAuthority(env, authorityId, "sync-authority-mismatch");
    } catch (error) {
      return error instanceof Error && error.message === "authority-not-configured"
        ? jsonAuthorityNotConfigured()
        : jsonAuthorityMismatch("sync-authority-mismatch");
    }
    const result = await getSyncEnvelopePull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      {
        graphBucket: env.LA_GRAPH_BUCKET,
        controlDb: env.LA_CONTROL_DB
      },
      authorityId,
      Number.isFinite(afterGeneration) ? afterGeneration : undefined,
      syncTokenBinding(request)
    );
    if (result.ok) {
      return json(result.response);
    }

    return json({ ok: false, error: result.reason }, { status: syncErrorStatus(result.reason) });
  }

  if (request.method === "GET" && (url.pathname === "/api/activity/audit" || url.pathname === "/api/audit/recent")) {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "activity tokens must not be sent in the query string" }, { status: 400 });
    }

    if (!(await hasValidSyncToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-sync-token" }, { status: 401 });
    }

    const options = (() => {
      try {
        return activityAuditStreamOptionsFromUrl(url);
      } catch {
        return undefined;
      }
    })();
    if (!options) {
      return json({ ok: false, error: "invalid-activity-audit-request" }, { status: 400 });
    }
    try {
      const authorityId = requireConfiguredAuthority(env);
      if (options.authority_id && options.authority_id !== authorityId) {
        return jsonAuthorityMismatch("audit-authority-mismatch");
      }
      return json(await readPraxisActivityAuditStream(env.LA_CONTROL_DB, {
        ...options,
        authority_id: authorityId
      }));
    } catch (error) {
      return error instanceof Error && error.message === "authority-not-configured"
        ? jsonAuthorityNotConfigured()
        : jsonAuthorityMismatch("audit-authority-mismatch");
    }
  }

  if (request.method === "GET" && url.pathname === "/api/usage/status") {
    if (queryContainsToken(url)) {
      return json({ ok: false, error: "usage tokens must not be sent in the query string" }, { status: 400 });
    }

    if (!(await hasValidUsageToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-usage-token" }, { status: 401 });
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

    if (!(await hasValidUsageToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-usage-token" }, { status: 401 });
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

    if (!(await hasValidUsageToken(request, env))) {
      return json({ ok: false, error: "missing-or-invalid-usage-token" }, { status: 401 });
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([key]) => key !== "idempotency_key")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

function activityAuditStreamOptionsFromUrl(url: URL) {
  const limit = url.searchParams.get("limit");
  return PraxisActivityAuditStreamRequestSchema.parse({
    authority_id: url.searchParams.get("authority_id") ?? undefined,
    operation_id: url.searchParams.get("operation_id") ?? undefined,
    trace_id: url.searchParams.get("trace_id") ?? undefined,
    event_type: url.searchParams.get("event_type") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: limit === null ? 50 : Number(limit)
  });
}

function activityAuditStreamOptionsFromArgs(args: unknown) {
  return PraxisActivityAuditStreamRequestSchema.parse({
    authority_id: stringParam(args, "authority_id"),
    operation_id: stringParam(args, "operation_id"),
    trace_id: stringParam(args, "trace_id"),
    event_type: stringParam(args, "event_type"),
    cursor: stringParam(args, "cursor"),
    limit: numberParam(args, "limit") ?? 50
  });
}

function requireAuthorityArg(env: BootstrapWorkerEnv, args: unknown, error: string): string {
  return requireBoundAuthority(env, stringParam(args, "authority_id"), error);
}

function remoteGraphStorage(env: BootstrapWorkerEnv) {
  return {
    graphBucket: env.LA_GRAPH_BUCKET,
    controlDb: env.LA_CONTROL_DB
  };
}

function remoteWriteIdempotencyKeyFromRequest(request: Request, args: unknown): string | undefined {
  return request.headers.get(remoteWriteIdempotencyHeader) ?? stringParam(args, "idempotency_key");
}

async function remoteWriteRequestHash(toolName: string, args: unknown): Promise<`sha256:${string}`> {
  return `sha256:${await sha256Hex(stableJson({
    tool: toolName,
    arguments: args
  }))}`;
}

async function remoteWriteIdempotencyKey(request: Request, toolName: string, args: unknown, requestHash: string): Promise<string> {
  const explicitKey = remoteWriteIdempotencyKeyFromRequest(request, args);
  const key = explicitKey ?? `la_idem_${(await sha256Hex(`${toolName}:${requestHash}`)).slice(0, 24)}`;
  if (!/^la_idem_[A-Za-z0-9_-]{8,}$/.test(key)) {
    throw new Error("invalid-remote-write-idempotency-key");
  }
  return key;
}

async function requireRemoteMcpSyncToken(request: Request, env: BootstrapWorkerEnv): Promise<void> {
  if (!(await hasValidSyncToken(request, env))) {
    throw new Error("missing-or-invalid-sync-token");
  }
}

async function hasValidRemoteMcpDiscoveryToken(request: Request, env: BootstrapWorkerEnv): Promise<boolean> {
  return await hasValidSyncToken(request, env) || await hasValidCloudUnlockCapability(request, env);
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

async function commitIdempotentRemoteGraphMutation(
  toolName: string,
  args: unknown,
  request: Request,
  env: BootstrapWorkerEnv,
  input: {
    authority_id: string;
    object_id?: string;
    operation: RemoteGraphWriteOperation;
    prepare: () => Promise<RemoteGraphMutationResult>;
  }
): Promise<Record<string, unknown>> {
  const storage = remoteGraphStorage(env);
  const requestHash = await remoteWriteRequestHash(toolName, args);
  const idempotencyKey = await remoteWriteIdempotencyKey(request, toolName, args, requestHash);
  const stage = await stageRemoteGraphWrite(storage, {
    idempotency_key: idempotencyKey,
    request_hash: requestHash,
    authority_id: input.authority_id,
    object_id: input.object_id,
    operation: input.operation
  });

  if (stage.status === "committed") {
    return {
      ...stage.response,
      idempotent_replay: true
    };
  }

  let syncAccepted = false;
  try {
    const result = await input.prepare();
    const syncBatch = await commitRemoteGraphMutationToSync(
      request,
      env,
      syncMutationFromRemote(result.mutation),
      result.object,
      result.previous_version,
      {
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        submitted_at: stage.created_at
      }
    );
    syncAccepted = true;
    await storePreparedRemoteGraphMutation(storage, result);
    const response = {
      ok: true,
      ...result,
      sync_generation: syncBatch.target_generation,
      sync_batch_id: syncBatch.batch_id,
      idempotency_key: idempotencyKey,
      idempotent_replay: false
    };
    await commitRemoteGraphWrite(storage, {
      authority_id: input.authority_id,
      idempotency_key: idempotencyKey,
      request_hash: requestHash,
      sync_batch_id: syncBatch.batch_id,
      sync_generation: syncBatch.target_generation,
      response
    });
    return response;
  } catch (error) {
    if (!syncAccepted) {
      await failRemoteGraphWrite(storage, {
        authority_id: input.authority_id,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        reason: error instanceof Error ? error.message : "remote-write-failed"
      });
    }
    throw error;
  }
}

function remoteMcpActorId(request: Request): string {
  return request.headers.get(syncClientHeader) ?? "remote-mcp";
}

async function appendRemoteMcpAudit(input: {
  request: Request;
  env: BootstrapWorkerEnv;
  authority_id: string;
  operation: Operation;
  event_type: DurableAuditEvent["event_type"];
  summary: string;
  object_id?: string;
  access_class?: GraphObjectEnvelope["access_class"];
  outcome?: DurableAuditEvent["outcome"];
  reason_code?: string;
  sync_batch_id?: string;
}): Promise<void> {
  await appendAuditEvent(input.env.LA_CONTROL_DB, {
    audit_id: createAuditId(),
    authority_id: input.authority_id,
    operation_id: requestOperationId(input.request),
    trace_id: requestTraceId(input.request),
    recorded_at: new Date().toISOString(),
    actor_id: remoteMcpActorId(input.request),
    mcp_profile: remoteRequestAccessMode(input.request) === "cloud-unlock-session" ? "remote-cloud-unlock" : "remote-safe",
    operation: input.operation,
    event_type: input.event_type,
    outcome: input.outcome ?? "allowed",
    reason_code: input.reason_code,
    object_id: input.object_id,
    access_class: input.access_class,
    sync_batch_id: input.sync_batch_id,
    redaction: "remote-redacted",
    summary: input.summary
  });
}

function requestOperationId(request: Request): string {
  const value = request.headers.get("x-living-atlas-operation-id");
  return value && /^la_operation_[A-Za-z0-9_-]{8,}$/.test(value) ? value : `la_operation_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requestTraceId(request: Request): string {
  const value = request.headers.get("x-living-atlas-trace-id");
  return value && /^la_trace_[A-Za-z0-9_-]{8,}$/.test(value) ? value : `la_trace_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const cloudUnlockConfigured = !!env.LA_CLOUD_UNLOCK_CAPABILITY_ID;
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
          available: cloudUnlockConfigured,
          current: cloudUnlockConfigured && currentMode === "cloud-unlock-session",
          host_blind_sensitive_plaintext: false,
          sensitive_plaintext_available: cloudUnlockConfigured && currentMode === "cloud-unlock-session",
          key_persisted_by_cloudflare: false,
          required_header: cloudUnlockKeyHeader,
          required_capability_header: syncCapabilityHeader
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

  if (name === "remote_activity_audit") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "activity-authority-mismatch");
    return readPraxisActivityAuditStream(env.LA_CONTROL_DB, {
      ...activityAuditStreamOptionsFromArgs(args),
      authority_id: authorityId
    });
  }

  if (name === "remote_sensitive_decrypt") {
    if (!(await hasValidCloudUnlockCapability(request, env))) {
      return {
        ok: false,
        reason: "cloud-unlock-capability-required",
        current_mode: "remote-safe-only",
        key_persisted_by_cloudflare: false,
        host_blind_sensitive_plaintext: true
      };
    }

    const unlockKey = cloudUnlockKey(request);
    const authorityId = requireAuthorityArg(env, args, "decrypt-authority-mismatch");
    if (!unlockKey) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "decrypt",
        event_type: "object.denied",
        outcome: "denied",
        reason_code: "cloud-unlock-required",
        summary: "Remote cloud unlock denied"
      });
      return {
        ok: false,
        reason: "cloud-unlock-required",
        current_mode: "remote-safe-only",
        host_blind_sensitive_plaintext: true
      };
    }

    const objectId = stringParam(args, "object_id");
    if (!objectId) {
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
      cloudUnlockRuntimeConfig(env),
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
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "decrypt",
        event_type: "object.denied",
        outcome: "denied",
        reason_code: "object-not-found",
        object_id: objectId,
        summary: "Remote object unavailable"
      });
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
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "decrypt",
        event_type: "object.denied",
        outcome: "denied",
        reason_code: "quarantine-denied",
        object_id: object.object_id,
        access_class: object.access_class,
        summary: "Remote object unavailable"
      });
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
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "decrypt",
        event_type: "object.denied",
        outcome: "denied",
        reason_code: decryptResult.reason,
        object_id: object.object_id,
        access_class: object.access_class,
        summary: "Remote cloud unlock denied"
      });
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

    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "decrypt",
      event_type: "object.decrypt",
      outcome: "allowed",
      object_id: object.object_id,
      access_class: object.access_class,
      summary: "Remote cloud unlock allowed"
    });

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
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const objects = await listRemoteGraphObjects(remoteGraphStorage(env), authorityId, {
      include_tombstones: booleanParam(args, "include_tombstones"),
      limit: numberParam(args, "limit")
    });
    const reconciliation = await reconcileRemoteGraph(remoteGraphStorage(env), authorityId, {
      limit: numberParam(args, "limit")
    });
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "sync.read",
      summary: "Remote graph status read allowed"
    });
    return {
      ok: true,
      authority_id: authorityId,
      object_count: objects.filter((object) => !object.visible_metadata.tombstone).length,
      tombstone_count: objects.filter((object) => object.visible_metadata.tombstone).length,
      remote_graph: "remote-readable",
      reconciliation
    };
  }

  if (name === "remote_graph_reconcile") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const reconciliation = await reconcileRemoteGraph(remoteGraphStorage(env), authorityId, {
      limit: numberParam(args, "limit")
    });
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "sync.read",
      summary: "Remote graph reconciliation read allowed"
    });
    return reconciliation;
  }

  if (name === "remote_graph_list") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const objects = await listRemoteGraphObjects(remoteGraphStorage(env), authorityId, {
      include_tombstones: booleanParam(args, "include_tombstones"),
      object_type: stringParam(args, "object_type") as never,
      limit: numberParam(args, "limit")
    });
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "object.read",
      summary: "Remote graph list read allowed"
    });
    return {
      ok: true,
      authority_id: authorityId,
      objects
    };
  }

  if (name === "remote_graph_read") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const objectId = stringParam(args, "object_id");
    if (!objectId) {
      throw new Error("invalid-graph-read-request");
    }
    const object = await latestRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId);
    const available = object && !object.visible_metadata.tombstone && !isExpiredReleaseObject(object);
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: available ? "object.read" : "object.denied",
      outcome: available ? "allowed" : "denied",
      reason_code: available ? undefined : object && isExpiredReleaseObject(object) ? "release-expired" : "object-not-found",
      object_id: objectId,
      access_class: object?.access_class,
      summary: available ? "Remote object read allowed" : "Remote object unavailable"
    });
    return available
      ? { ok: true, object }
      : { ok: false, reason: object && isExpiredReleaseObject(object) ? "release-expired" : "object-not-found", authority_id: authorityId, object_id: objectId };
  }

  if (name === "remote_graph_create") {
    await requireRemoteMcpSyncToken(request, env);
    const object = recordParam(args, "object");
    const authorityId = stringParam(object, "authority_id");
    const objectId = stringParam(object, "object_id");
    if (!object || !authorityId || !objectId) {
      throw new Error("invalid-graph-create-request");
    }
    requireBoundAuthority(env, authorityId, "graph-authority-mismatch");
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: objectId,
      operation: "create",
      prepare: () => prepareCreateRemoteGraphObject(remoteGraphStorage(env), object)
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: response.mutation === "restored" ? "restore" : "create",
        event_type: response.mutation === "restored" ? "object.restore" : "object.create",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: response.mutation === "restored" ? "Remote object restored" : "Remote object created"
      });
    }
    return response;
  }

  if (name === "remote_graph_update") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const objectId = stringParam(args, "object_id");
    const patch = recordParam(args, "patch");
    if (!objectId || !patch) {
      throw new Error("invalid-graph-update-request");
    }
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: objectId,
      operation: "update",
      prepare: () => prepareUpdateRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId, patch, numberParam(args, "expected_version"))
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: response.mutation === "deleted" ? "delete" : "update",
        event_type: response.mutation === "deleted" ? "object.delete" : "object.update",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: response.mutation === "deleted" ? "Remote object deleted" : "Remote object updated"
      });
    }
    return response;
  }

  if (name === "remote_graph_delete") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const objectId = stringParam(args, "object_id");
    if (!objectId) {
      throw new Error("invalid-graph-delete-request");
    }
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: objectId,
      operation: "delete",
      prepare: () => prepareDeleteRemoteGraphObject(remoteGraphStorage(env), authorityId, objectId, numberParam(args, "expected_version"))
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "delete",
        event_type: "object.delete",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: "Remote object deleted"
      });
    }
    return response;
  }

  if (name === "remote_semantic_search") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const query = stringParam(args, "query");
    if (!query) {
      throw new Error("invalid-semantic-search-request");
    }
    const results = await searchRemoteGraphObjects(remoteGraphStorage(env), authorityId, query, {
      object_type: stringParam(args, "object_type") as never,
      limit: numberParam(args, "limit")
    });
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "search",
      event_type: "sync.read",
      summary: "Remote search allowed"
    });
    return {
      ok: true,
      authority_id: authorityId,
      query,
      search_mode: "deterministic-text-v1",
      results
    };
  }

  if (name === "remote_graph_traverse") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const startObjectId = stringParam(args, "start_object_id");
    if (!startObjectId) {
      throw new Error("invalid-graph-traverse-request");
    }
    const predicates = isRecord(args) && Array.isArray(args.predicates)
      ? args.predicates.filter((value): value is string => typeof value === "string").map(canonicalPredicate)
      : undefined;
    const traversal = await traverseRemoteGraph(remoteGraphStorage(env), authorityId, startObjectId, {
      direction: stringParam(args, "direction") as never,
      max_depth: numberParam(args, "max_depth"),
      predicates,
      limit: numberParam(args, "limit")
    });
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "traverse",
      event_type: "object.read",
      object_id: startObjectId,
      summary: "Remote traversal allowed"
    });
    return {
      ok: true,
      authority_id: authorityId,
      ...traversal
    };
  }

  if (name === "remote_timeline_query") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const results = (await queryRemoteTimeline(remoteGraphStorage(env), authorityId, {
      from: stringParam(args, "from"),
      to: stringParam(args, "to"),
      object_id: stringParam(args, "object_id"),
      predicate: stringParam(args, "predicate"),
      limit: numberParam(args, "limit")
    })).filter((entry) => !entry.object.visible_metadata.tombstone && !isExpiredReleaseObject(entry.object));
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: stringParam(args, "object_id") ? "object.read" : "sync.read",
      object_id: stringParam(args, "object_id"),
      summary: "Remote timeline read allowed"
    });
    return {
      ok: true,
      authority_id: authorityId,
      results
    };
  }

  if (name === "remote_edge_create") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const edge = recordParam(args, "edge");
    const edgeId = stringParam(edge, "edge_id");
    if (!edge || !edgeId) {
      throw new Error("invalid-edge-create-request");
    }
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: edgeId,
      operation: "edge-create",
      prepare: () => prepareCreateRemoteEdgeObject(remoteGraphStorage(env), authorityId, edge)
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: response.mutation === "restored" ? "restore" : "create",
        event_type: response.mutation === "restored" ? "object.restore" : "object.create",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: response.mutation === "restored" ? "Remote edge restored" : "Remote edge created"
      });
    }
    return response;
  }

  if (name === "remote_edge_read") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const edgeId = stringParam(args, "edge_id");
    if (!edgeId) {
      throw new Error("invalid-edge-read-request");
    }
    const object = await findRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId);
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: object && !object.visible_metadata.tombstone ? "object.read" : "object.denied",
      outcome: object && !object.visible_metadata.tombstone ? "allowed" : "denied",
      reason_code: object && !object.visible_metadata.tombstone ? undefined : "edge-not-found",
      object_id: object?.object_id,
      access_class: object?.access_class,
      summary: object && !object.visible_metadata.tombstone ? "Remote edge read allowed" : "Remote edge unavailable"
    });
    return object && !object.visible_metadata.tombstone
      ? { ok: true, object }
      : { ok: false, reason: "edge-not-found", authority_id: authorityId, edge_id: edgeId };
  }

  if (name === "remote_edge_update") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const edgeId = stringParam(args, "edge_id");
    const patch = recordParam(args, "patch");
    if (!edgeId || !patch) {
      throw new Error("invalid-edge-update-request");
    }
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: edgeId,
      operation: "edge-update",
      prepare: () => prepareUpdateRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId, patch, numberParam(args, "expected_version"))
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: response.mutation === "deleted" ? "delete" : "update",
        event_type: response.mutation === "deleted" ? "object.delete" : "object.update",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: response.mutation === "deleted" ? "Remote edge deleted" : "Remote edge updated"
      });
    }
    return response;
  }

  if (name === "remote_edge_delete") {
    await requireRemoteMcpSyncToken(request, env);
    const authorityId = requireAuthorityArg(env, args, "graph-authority-mismatch");
    const edgeId = stringParam(args, "edge_id");
    if (!edgeId) {
      throw new Error("invalid-edge-delete-request");
    }
    const response = await commitIdempotentRemoteGraphMutation(name, args, request, env, {
      authority_id: authorityId,
      object_id: edgeId,
      operation: "edge-delete",
      prepare: () => prepareDeleteRemoteEdgeObject(remoteGraphStorage(env), authorityId, edgeId, numberParam(args, "expected_version"))
    });
    if (response.idempotent_replay !== true && isRecord(response.object)) {
      await appendRemoteMcpAudit({
        request,
        env,
        authority_id: authorityId,
        operation: "delete",
        event_type: "object.delete",
        object_id: stringParam(response.object, "object_id"),
        access_class: stringParam(response.object, "access_class") as never,
        sync_batch_id: stringParam(response, "sync_batch_id"),
        summary: "Remote edge deleted"
      });
    }
    return response;
  }

  if (name === "remote_sync_status") {
    const authorityId = requireConfiguredAuthority(env);
    const result = await getSyncStatus(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "sync.read",
      summary: "Remote sync status read allowed"
    });
    return result.status;
  }

  if (name === "remote_sync_pull") {
    const authorityId = requireAuthorityArg(env, args, "sync-authority-mismatch");
    const result = await getSyncPull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      env.LA_CONTROL_DB,
      authorityId,
      numberParam(args, "after_generation"),
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "sync.read",
      summary: "Remote sync pull read allowed"
    });
    return result.response;
  }

  if (name === "remote_sync_envelopes") {
    const authorityId = requireAuthorityArg(env, args, "sync-authority-mismatch");
    const result = await getSyncEnvelopePull(
      request.headers.get(syncTokenHeader) ?? undefined,
      syncRuntimeConfig(env),
      {
        graphBucket: env.LA_GRAPH_BUCKET,
        controlDb: env.LA_CONTROL_DB
      },
      authorityId,
      numberParam(args, "after_generation"),
      syncTokenBinding(request)
    );
    if (!result.ok) {
      throw new Error(result.reason);
    }
    await appendRemoteMcpAudit({
      request,
      env,
      authority_id: authorityId,
      operation: "read",
      event_type: "sync.read",
      summary: "Remote sync envelope read allowed"
    });
    return result.response;
  }

  if (name === "remote_usage_gate") {
    if (!(await hasValidUsageToken(request, env))) {
      throw new Error("missing-or-invalid-usage-token");
    }

    return getUsageGate(
      env.LA_CONTROL_DB,
      usageRuntimeConfig(env),
      usageGateOptionsFromArgs(args)
    );
  }

  if (name === "remote_usage_reconcile") {
    if (!(await hasValidUsageToken(request, env))) {
      throw new Error("missing-or-invalid-usage-token");
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
    if (!(await hasValidRemoteMcpDiscoveryToken(request, env))) {
      return jsonRpcError(body.id, -32001, "missing-or-invalid-mcp-token", 401);
    }
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
    if (!(await hasValidRemoteMcpDiscoveryToken(request, env))) {
      return jsonRpcError(body.id, -32001, "missing-or-invalid-mcp-token", 401);
    }
    return jsonRpcResult(body.id, {
      tools: [
        {
          name: "remote_access_modes",
          description: "Describe Living Atlas remote-safe, cloud-unlock, and local-keyholding access modes for this request.",
          inputSchema: { type: "object", additionalProperties: false, properties: {} }
        },
        {
          name: "remote_activity_audit",
          description: "Read recent remote-safe activity and audit events for Praxis. Events expose stable cursors and hashed refs only.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              authority_id: { type: "string" },
              operation_id: { type: "string" },
              trace_id: { type: "string" },
              event_type: { type: "string" },
              cursor: { type: "string" },
              limit: { type: "integer", minimum: 1, maximum: 100 }
            }
          }
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
          description: "Read remote-readable graph object counts and sync-envelope reconciliation for an authority.",
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
          name: "remote_graph_reconcile",
          description: "Compare the remote-readable graph index with committed sync envelope state for an authority.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id"],
            properties: {
              authority_id: { type: "string" },
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
          description: "Create one remote-readable plaintext graph object idempotently. Local-private and quarantine objects are rejected.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["object"],
            properties: {
              object: { type: "object" },
              idempotency_key: { type: "string" }
            }
          }
        },
        {
          name: "remote_graph_update",
          description: "Update one remote-readable graph object idempotently with optimistic version support.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id", "patch"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 },
              idempotency_key: { type: "string" },
              patch: { type: "object" }
            }
          }
        },
        {
          name: "remote_graph_delete",
          description: "Tombstone one remote-readable graph object idempotently with optimistic version support.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "object_id"],
            properties: {
              authority_id: { type: "string" },
              object_id: { type: "string" },
              idempotency_key: { type: "string" },
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
          description: "Create a typed temporal edge idempotently as a remote-readable graph object.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge"],
            properties: {
              authority_id: { type: "string" },
              edge: { type: "object" },
              idempotency_key: { type: "string" }
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
          description: "Update a typed temporal edge idempotently by edge_id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge_id", "patch"],
            properties: {
              authority_id: { type: "string" },
              edge_id: { type: "string" },
              expected_version: { type: "integer", minimum: 0 },
              idempotency_key: { type: "string" },
              patch: { type: "object" }
            }
          }
        },
        {
          name: "remote_edge_delete",
          description: "Tombstone a typed temporal edge idempotently by edge_id.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["authority_id", "edge_id"],
            properties: {
              authority_id: { type: "string" },
              edge_id: { type: "string" },
              idempotency_key: { type: "string" },
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
        },
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
