import { AuthorityIdSchema } from "@living-atlas/contracts";
import { BootstrapClaimBodySchema, type BootstrapRuntimeConfig } from "./bootstrap";
import type { BootstrapClaimLockCore } from "./bootstrap-lock";
import {
  applyWorkerTraceHeaders,
  createWorkerErrorEvent,
  createWorkerObservabilityContext,
  createWorkerRequestEvent,
  emitWorkerObservability,
  type WorkerObservabilityEnv
} from "./observability";
import {
  acceptSyncBatch,
  getSyncPull,
  getSyncStatus,
  type SyncBatchAcceptResult,
  type SyncRuntimeConfig,
  type SyncTokenBinding
} from "./sync";
import { authoritySequencerName } from "./sync-sequencer";

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
  LA_CONTROL_DB: D1Database;
  BOOTSTRAP_CLAIM_TOKEN_HASH?: string;
  BOOTSTRAP_TOKEN_EXPIRES_AT?: string;
  BOOTSTRAP_LOCK_NAME?: string;
  LA_SYNC_TOKEN_HASH?: string;
  LA_SYNC_CLIENT_ID?: string;
  LA_SYNC_CAPABILITY_ID?: string;
  LA_SYNC_TOKEN_ID?: string;
} & WorkerObservabilityEnv;

const tokenHeader = "x-living-atlas-bootstrap-token";
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

function getClaimLock(env: BootstrapWorkerEnv): BootstrapClaimLockRpc {
  return env.BOOTSTRAP_CLAIM_LOCK.getByName(env.BOOTSTRAP_LOCK_NAME ?? "living-atlas-bootstrap-claim-lock");
}

function queryContainsToken(url: URL): boolean {
  return forbiddenQueryTokenParams.some((param) => url.searchParams.has(param));
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
    return json({ ok: true, service: "living-atlas-cloudflare-bootstrap" });
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

  return json({ ok: false, error: "not-found" }, { status: 404 });
}

export async function handleBootstrapRequest(request: Request, env: BootstrapWorkerEnv): Promise<Response> {
  const startedAt = Date.now();
  const observability = createWorkerObservabilityContext(request);

  try {
    const response = applyWorkerTraceHeaders(await routeBootstrapRequest(request, env), observability);
    emitWorkerObservability(
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
    emitWorkerObservability(
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
