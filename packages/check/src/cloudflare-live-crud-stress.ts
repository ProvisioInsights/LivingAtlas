import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  SyncBatchAcceptedSchema,
  SyncBatchSchema,
  SyncPullResponseSchema,
  canonicalSyncBatchHashPayload,
  type GraphObjectEnvelope,
  type SyncBatch,
  type SyncBatchAccepted,
  type SyncPullResponse
} from "@living-atlas/contracts";

type FetchLike = typeof fetch;
type CrudOperation = "create" | "update" | "delete" | "restore";

export type CloudflareLiveCrudStressConfig = {
  endpoint: string;
  syncToken: string;
  healthToken?: string;
  runId: string;
  authorityId: string;
  authorityRef: `sha256:${string}`;
  clientId: string;
  capabilityId: string;
  deviceId: string;
  tokenId?: string;
  entryCount: number;
  batchSize: number;
  requestTimeoutMs: number;
};

export type LiveCrudObjectSpec = {
  index: number;
  object_id: string;
};

export type LiveCrudStage = {
  label: string;
  operation: CrudOperation;
  baseGeneration: number;
  targetGeneration: number;
  baseVersion: number;
  newVersion: number;
  tombstone: boolean;
  objects: LiveCrudObjectSpec[];
};

export type CloudflareLiveCrudStressCase = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type CloudflareLiveCrudStressSummary = {
  endpoint: string;
  run_id: string;
  authority_id: string;
  authority_ref: string;
  planned_entries: number;
  created: number;
  updated: number;
  deleted: number;
  restored: number;
  accepted_batches: number;
  accepted_objects: number;
  accepted_changes: number;
  latest_generation: number;
  duration_ms: number;
};

export type CloudflareLiveCrudStressResult = {
  ok: boolean;
  cases: CloudflareLiveCrudStressCase[];
  errors: string[];
  summary?: CloudflareLiveCrudStressSummary;
};

type FetchBody = {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
};

type SubmitBatchResult =
  | {
      ok: true;
      status: number;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      status: number;
      error: unknown;
    };

export const liveCrudStressEnv = {
  endpoint: "LIVING_ATLAS_LIVE_SYNC_ENDPOINT",
  token: "LIVING_ATLAS_LIVE_SYNC_TOKEN",
  healthToken: "LIVING_ATLAS_LIVE_HEALTH_TOKEN",
  acknowledgeMutation: "LIVING_ATLAS_LIVE_CRUD_STRESS_ACK",
  clientId: "LIVING_ATLAS_LIVE_SYNC_CLIENT_ID",
  capabilityId: "LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID",
  deviceId: "LIVING_ATLAS_LIVE_SYNC_DEVICE_ID",
  tokenId: "LIVING_ATLAS_LIVE_SYNC_TOKEN_ID",
  authorityId: "LIVING_ATLAS_LIVE_CRUD_AUTHORITY_ID",
  runId: "LIVING_ATLAS_LIVE_RUN_ID",
  entryCount: "LIVING_ATLAS_LIVE_CRUD_ENTRY_COUNT",
  batchSize: "LIVING_ATLAS_LIVE_CRUD_BATCH_SIZE",
  timeoutMs: "LIVING_ATLAS_LIVE_REQUEST_TIMEOUT_MS",
  allowInsecureEndpoint: "LIVING_ATLAS_LIVE_ALLOW_INSECURE_ENDPOINT"
} as const;

const mutationAcknowledgement = "mutates-deployed-sync-state";

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function randomRunId(): string {
  return `live_crud_${randomBytes(8).toString("hex")}`;
}

function makeId(prefix: string, seed: string): string {
  return `${prefix}_${digest(seed)}`;
}

function opaqueR2Path(seed: string): string {
  const authority = digest(`${seed}:authority`, 16);
  const segment = digest(`${seed}:segment`, 40);
  return `objects/a=${authority}/p=${segment.slice(0, 2)}/s=${segment}.bin`;
}

function parsePositiveInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected an integer from ${min} to ${max}, got ${value}`);
  }

  return parsed;
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

function configError(errors: string[]): CloudflareLiveCrudStressResult {
  return {
    ok: false,
    cases: [],
    errors
  };
}

export function readCloudflareLiveCrudStressConfig(env: NodeJS.ProcessEnv = process.env): CloudflareLiveCrudStressConfig | CloudflareLiveCrudStressResult {
  const errors: string[] = [];
  const endpoint = envValue(env, liveCrudStressEnv.endpoint);
  const syncToken = envValue(env, liveCrudStressEnv.token);
  const acknowledgement = envValue(env, liveCrudStressEnv.acknowledgeMutation);

  if (!endpoint) {
    errors.push(`missing ${liveCrudStressEnv.endpoint}`);
  }
  if (!syncToken) {
    errors.push(`missing ${liveCrudStressEnv.token}`);
  }
  if (acknowledgement !== mutationAcknowledgement) {
    errors.push(`${liveCrudStressEnv.acknowledgeMutation} must equal ${mutationAcknowledgement}`);
  }
  if (errors.length > 0) {
    return configError(errors);
  }

  const runId = envValue(env, liveCrudStressEnv.runId) ?? randomRunId();
  const authorityId = envValue(env, liveCrudStressEnv.authorityId) ?? `la_authority_${digest(`crud-authority:${runId}`)}`;
  const clientId = envValue(env, liveCrudStressEnv.clientId) ?? `la_client_${digest(`crud-client:${runId}`)}`;
  const capabilityId = envValue(env, liveCrudStressEnv.capabilityId) ?? `la_cap_${digest(`crud-capability:${runId}`)}`;
  const deviceId = envValue(env, liveCrudStressEnv.deviceId) ?? `la_device_${digest(`crud-device:${runId}`)}`;

  try {
    return {
      endpoint: validateEndpoint(endpoint!, envValue(env, liveCrudStressEnv.allowInsecureEndpoint) === "1"),
      syncToken: syncToken!,
      healthToken: envValue(env, liveCrudStressEnv.healthToken),
      runId,
      authorityId,
      authorityRef: sha256(authorityId),
      clientId,
      capabilityId,
      deviceId,
      tokenId: envValue(env, liveCrudStressEnv.tokenId),
      entryCount: parsePositiveInteger(envValue(env, liveCrudStressEnv.entryCount), 1_200, 1, 10_000),
      batchSize: parsePositiveInteger(envValue(env, liveCrudStressEnv.batchSize), 50, 1, 250),
      requestTimeoutMs: parsePositiveInteger(envValue(env, liveCrudStressEnv.timeoutMs), 60_000, 1_000, 180_000)
    };
  } catch (error) {
    return configError([error instanceof Error ? error.message : String(error)]);
  }
}

function isConfig(value: CloudflareLiveCrudStressConfig | CloudflareLiveCrudStressResult): value is CloudflareLiveCrudStressConfig {
  return "syncToken" in value;
}

function requestUrl(endpoint: string, path: string): URL {
  return new URL(path, endpoint);
}

function syncHeaders(config: CloudflareLiveCrudStressConfig, batch?: SyncBatch, overrides: {
  token?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
} = {}): Record<string, string> {
  const token = overrides.token ?? config.syncToken;
  const clientId = overrides.clientId ?? batch?.client_id ?? config.clientId;
  const capabilityId = overrides.capabilityId ?? batch?.capability_id ?? config.capabilityId;
  const tokenId = overrides.tokenId ?? batch?.token_id ?? config.tokenId;

  return {
    ...(batch ? { "content-type": "application/json" } : {}),
    "x-living-atlas-sync-token": token,
    "x-living-atlas-sync-client-id": clientId,
    "x-living-atlas-sync-capability-id": capabilityId,
    ...(tokenId ? { "x-living-atlas-sync-token-id": tokenId } : {})
  };
}

function healthHeaders(config: CloudflareLiveCrudStressConfig): Record<string, string> {
  return {
    "x-living-atlas-health-token": config.healthToken ?? config.syncToken
  };
}

async function fetchBody(
  fetchImpl: FetchLike,
  config: CloudflareLiveCrudStressConfig,
  path: string,
  init: RequestInit = {}
): Promise<FetchBody> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchImpl(requestUrl(config.endpoint, path), {
      ...init,
      signal: init.signal ?? controller.signal
    });
    const text = await response.text();
    let body: unknown = undefined;
    if (text.trim()) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

function createLiveCrudObjectSpecs(config: CloudflareLiveCrudStressConfig): LiveCrudObjectSpec[] {
  return Array.from({ length: config.entryCount }, (_, index) => ({
    index: index + 1,
    object_id: makeId("la_object", `crud-object:${config.runId}:${index + 1}`)
  }));
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

export function planLiveCrudStages(config: CloudflareLiveCrudStressConfig): {
  stages: LiveCrudStage[];
  entries: LiveCrudObjectSpec[];
  deleteCount: number;
  restoreCount: number;
} {
  const entries = createLiveCrudObjectSpecs(config);
  const deleteCount = Math.max(1, Math.floor(config.entryCount / 3));
  const restoreCount = Math.max(1, Math.floor(deleteCount / 2));
  const deletedEntries = entries.slice(0, deleteCount);
  const restoredEntries = deletedEntries.slice(0, restoreCount);
  const stages: LiveCrudStage[] = [];
  let generation = 0;

  const addStages = (
    operation: CrudOperation,
    labelPrefix: string,
    objects: LiveCrudObjectSpec[],
    baseVersion: number,
    newVersion: number,
    tombstone: boolean
  ) => {
    for (const [chunkIndex, objectChunk] of chunks(objects, config.batchSize).entries()) {
      generation += 1;
      stages.push({
        label: `${labelPrefix}-${chunkIndex + 1}`,
        operation,
        baseGeneration: generation - 1,
        targetGeneration: generation,
        baseVersion,
        newVersion,
        tombstone,
        objects: objectChunk
      });
    }
  };

  addStages("create", "create", entries, 0, 1, false);
  addStages("update", "update", entries, 1, 2, false);
  addStages("delete", "delete", deletedEntries, 2, 3, true);
  addStages("restore", "restore", restoredEntries, 3, 4, false);

  return {
    stages,
    entries,
    deleteCount,
    restoreCount
  };
}

function liveObject(config: CloudflareLiveCrudStressConfig, stage: LiveCrudStage, spec: LiveCrudObjectSpec): GraphObjectEnvelope {
  const seed = `${config.runId}:${stage.operation}:${stage.targetGeneration}:${spec.object_id}:v${stage.newVersion}`;
  const ciphertextHash = sha256(`ciphertext:${seed}`);
  const now = new Date(Date.now() + stage.targetGeneration * 1000).toISOString();

  return {
    schema_version: 1,
    authority_id: config.authorityId,
    object_id: spec.object_id,
    object_type: spec.index % 7 === 0 ? "edge" : "page",
    version: stage.newVersion,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: stage.operation === "create" ? now : new Date(Date.now()).toISOString(),
    updated_at: now,
    content_hash: ciphertextHash,
    key_ref: makeId("la_key", `crud-key:${config.runId}`),
    visible_metadata: {
      schema_namespace: "synthetic/live-crud-stress",
      tombstone: stage.tombstone,
      size_class: spec.index % 11 === 0 ? "small" : "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-ref",
      storage: "r2",
      path: opaqueR2Path(seed),
      ciphertext_hash: ciphertextHash,
      byte_size: 640 + (spec.index % 1024),
      algorithm: "xchacha20-poly1305"
    }
  };
}

export function buildLiveCrudBatch(config: CloudflareLiveCrudStressConfig, stage: LiveCrudStage): SyncBatch {
  const objects = stage.objects.map((spec) => liveObject(config, stage, spec));
  const seed = `${config.runId}:${stage.label}:${stage.operation}:${stage.targetGeneration}`;
  const operationId = makeId("la_operation", `operation:${seed}`);
  const traceId = makeId("la_trace", `trace:${seed}`);
  const submittedAt = new Date(Date.now() + stage.targetGeneration * 1000).toISOString();
  const batchWithoutHash = {
    batch_id: makeId("la_sync_batch", `batch:${seed}`),
    authority_id: config.authorityId,
    device_id: config.deviceId,
    client_id: config.clientId,
    capability_id: config.capabilityId,
    operation_id: operationId,
    trace_id: traceId,
    token_id: config.tokenId,
    idempotency_key: makeId("la_idem", `idempotency:${seed}`),
    submitted_at: submittedAt,
    base_generation: stage.baseGeneration,
    target_generation: stage.targetGeneration,
    base_cursor: {
      authority_id: config.authorityId,
      generation: stage.baseGeneration
    },
    pull_recovery: {
      mode: "none",
      reason: "current"
    },
    objects,
    changes: objects.map((object, index) => ({
      change_id: makeId("la_change", `change:${seed}:${index + 1}:${object.object_id}`),
      authority_id: config.authorityId,
      operation_id: operationId,
      trace_id: traceId,
      recorded_at: submittedAt,
      object_id: object.object_id,
      operation: stage.operation,
      base_version: stage.baseVersion,
      new_version: stage.newVersion,
      content_hash: object.content_hash,
      access_class: object.access_class,
      generation: stage.targetGeneration,
      actor_id: config.clientId
    })),
    estimated_batch_bytes: new TextEncoder().encode(JSON.stringify(objects)).byteLength,
    limits: {
      max_objects: 250,
      max_changes: 1000,
      max_bytes: 1_000_000
    },
    withheld_plaintext_count: 0
  } satisfies Omit<SyncBatch, "batch_hash" | "object_payloads">;

  const derived = SyncBatchSchema.parse(batchWithoutHash);
  const { batch_hash: _derivedHash, ...withoutHash } = derived;
  return SyncBatchSchema.parse({
    ...derived,
    batch_hash: sha256(canonicalSyncBatchHashPayload(withoutHash))
  });
}

async function submitBatch(
  fetchImpl: FetchLike,
  config: CloudflareLiveCrudStressConfig,
  batch: SyncBatch
): Promise<SubmitBatchResult> {
  const response = await fetchBody(fetchImpl, config, "/api/sync/batch", {
    method: "POST",
    headers: syncHeaders(config, batch),
    body: JSON.stringify(batch)
  });

  if (response.status >= 200 && response.status < 300) {
    return {
      ok: true,
      status: response.status,
      accepted: SyncBatchAcceptedSchema.parse(response.body)
    };
  }

  return {
    ok: false,
    status: response.status,
    error: response.body
  };
}

async function fetchPull(
  fetchImpl: FetchLike,
  config: CloudflareLiveCrudStressConfig,
  afterGeneration: number
): Promise<SyncPullResponse> {
  const response = await fetchBody(fetchImpl, config, `/api/sync/pull?authority_id=${encodeURIComponent(config.authorityId)}&after_generation=${afterGeneration}`, {
    method: "GET",
    headers: syncHeaders(config)
  });
  if (response.status !== 200) {
    throw new Error(`sync pull expected HTTP 200, got ${response.status}: ${JSON.stringify(response.body)}`);
  }

  return SyncPullResponseSchema.parse(response.body);
}

async function fetchAllPullBatches(fetchImpl: FetchLike, config: CloudflareLiveCrudStressConfig): Promise<SyncPullResponse> {
  let afterGeneration = 0;
  let lastResponse: SyncPullResponse | undefined;
  const batches: SyncPullResponse["batches"] = [];

  do {
    lastResponse = await fetchPull(fetchImpl, config, afterGeneration);
    batches.push(...lastResponse.batches);
    afterGeneration = lastResponse.next_cursor.generation;
  } while (lastResponse.has_more);

  return {
    ...lastResponse,
    from_generation: 0,
    batches
  };
}

function addCase(
  cases: CloudflareLiveCrudStressCase[],
  name: string,
  ok: boolean,
  detail?: string
): void {
  cases.push({ name, ok, ...(detail ? { detail } : {}) });
}

function stealthNotFound(response: FetchBody): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  const hasLivingAtlasHeader = [...response.headers.keys()].some((header) => header.toLowerCase().startsWith("x-living-atlas-"));
  return response.status === 404 &&
    contentType.includes("text/plain") &&
    response.text === "Not Found\n" &&
    !hasLivingAtlasHeader;
}

function acceptedError(result: SubmitBatchResult, batch: SyncBatch): string | undefined {
  if (!result.ok) {
    return `expected accepted batch ${batch.batch_id}, got HTTP ${result.status}: ${JSON.stringify(result.error)}`;
  }

  if (result.accepted.batch_id !== batch.batch_id) {
    return `accepted unexpected batch ${result.accepted.batch_id}`;
  }

  if (result.accepted.accepted_objects !== batch.objects.length) {
    return `accepted object count mismatch for ${batch.batch_id}`;
  }

  if (result.accepted.accepted_changes !== batch.changes.length) {
    return `accepted change count mismatch for ${batch.batch_id}`;
  }

  return undefined;
}

function rejectionReason(result: SubmitBatchResult): string | undefined {
  if (result.ok || typeof result.error !== "object" || result.error === null) {
    return undefined;
  }

  const reason = (result.error as { error?: unknown }).error;
  return typeof reason === "string" ? reason : undefined;
}

async function assertAuthSurface(fetchImpl: FetchLike, config: CloudflareLiveCrudStressConfig, cases: CloudflareLiveCrudStressCase[], errors: string[]): Promise<void> {
  const unauthHealth = await fetchBody(fetchImpl, config, "/healthz", { method: "GET" });
  const unauthHealthOk = stealthNotFound(unauthHealth);
  addCase(cases, "unauth-health-stealth", unauthHealthOk, `HTTP ${unauthHealth.status}`);
  if (!unauthHealthOk) {
    errors.push("unauthenticated health check did not return a plain stealth 404");
  }

  const queryToken = await fetchBody(fetchImpl, config, "/api/sync/status?sync_token=redacted", {
    method: "GET",
    headers: syncHeaders(config)
  });
  const queryTokenOk = stealthNotFound(queryToken);
  addCase(cases, "query-token-stealth", queryTokenOk, `HTTP ${queryToken.status}`);
  if (!queryTokenOk) {
    errors.push("query token request did not return a plain stealth 404");
  }

  const missingSync = await fetchBody(fetchImpl, config, "/api/sync/status", { method: "GET" });
  const missingSyncOk = stealthNotFound(missingSync);
  addCase(cases, "missing-sync-token-stealth", missingSyncOk, `HTTP ${missingSync.status}`);
  if (!missingSyncOk) {
    errors.push("missing sync token did not return a plain stealth 404");
  }

  const badBinding = await fetchBody(fetchImpl, config, "/api/sync/status", {
    method: "GET",
    headers: syncHeaders(config, undefined, {
      clientId: makeId("la_client", `bad-binding:${config.runId}`)
    })
  });
  const badBindingOk = stealthNotFound(badBinding);
  addCase(cases, "bad-sync-binding-stealth", badBindingOk, `HTTP ${badBinding.status}`);
  if (!badBindingOk) {
    errors.push("bad sync token binding did not return a plain stealth 404");
  }

  const health = await fetchBody(fetchImpl, config, "/healthz", {
    method: "GET",
    headers: healthHeaders(config)
  });
  const healthOk = health.status === 200 && typeof health.body === "object" && health.body !== null && (health.body as { ok?: unknown }).ok === true;
  addCase(cases, "authenticated-health", healthOk, `HTTP ${health.status}`);
  if (!healthOk) {
    errors.push(`authenticated health expected HTTP 200, got ${health.status}`);
  }

  const status = await fetchBody(fetchImpl, config, "/api/sync/status", {
    method: "GET",
    headers: syncHeaders(config)
  });
  const statusOk = status.status === 200 && typeof status.body === "object" && status.body !== null && (status.body as { ok?: unknown }).ok === true;
  addCase(cases, "authenticated-sync-status", statusOk, `HTTP ${status.status}`);
  if (!statusOk) {
    errors.push(`authenticated sync status expected HTTP 200, got ${status.status}`);
  }
}

function mutateBatchHash(batch: SyncBatch): SyncBatch {
  return {
    ...batch,
    batch_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  };
}

export async function runCloudflareLiveCrudStress(options: {
  env?: NodeJS.ProcessEnv;
  config?: CloudflareLiveCrudStressConfig;
  fetchImpl?: FetchLike;
  onProgress?: (message: string) => void;
} = {}): Promise<CloudflareLiveCrudStressResult> {
  const readConfig = options.config ?? readCloudflareLiveCrudStressConfig(options.env);
  if (!isConfig(readConfig)) {
    return readConfig;
  }

  const config = readConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const progress = options.onProgress ?? (() => undefined);
  const startedAt = Date.now();
  const cases: CloudflareLiveCrudStressCase[] = [];
  const errors: string[] = [];
  const acceptedBatches: SyncBatch[] = [];
  const acceptedCounts = {
    objects: 0,
    changes: 0
  };

  try {
    await assertAuthSurface(fetchImpl, config, cases, errors);
    if (errors.length > 0) {
      return { ok: false, cases, errors };
    }

    const plan = planLiveCrudStages(config);
    progress(`planned ${config.entryCount} entries across ${plan.stages.length} generations`);

    for (const stage of plan.stages) {
      const batch = buildLiveCrudBatch(config, stage);
      const result = await submitBatch(fetchImpl, config, batch);
      const error = acceptedError(result, batch);
      if (error) {
        errors.push(error);
        addCase(cases, `batch-${stage.label}`, false, error);
        break;
      }

      acceptedBatches.push(batch);
      acceptedCounts.objects += batch.objects.length;
      acceptedCounts.changes += batch.changes.length;
      if (acceptedBatches.length === 1 || acceptedBatches.length % 10 === 0 || acceptedBatches.length === plan.stages.length) {
        progress(`accepted generation ${stage.targetGeneration}/${plan.stages.length} (${stage.operation}, ${batch.objects.length} objects)`);
      }
    }

    addCase(
      cases,
      "crud-batches-accepted",
      errors.length === 0 && acceptedBatches.length === plan.stages.length,
      `accepted=${acceptedBatches.length}; planned=${plan.stages.length}`
    );

    if (errors.length === 0 && acceptedBatches[0]) {
      const replay = await submitBatch(fetchImpl, config, acceptedBatches[0]);
      const replayOk = replay.ok && (replay.accepted.idempotent_replay ?? false) === true;
      addCase(cases, "idempotency-replay", replayOk, replay.ok ? `HTTP ${replay.status}` : `HTTP ${replay.status}: ${JSON.stringify(replay.error)}`);
      if (!replayOk) {
        errors.push("first CRUD batch did not replay idempotently");
      }
    }

    if (errors.length === 0) {
      const nextStage: LiveCrudStage = {
        label: "tampered-integrity",
        operation: "update",
        baseGeneration: plan.stages.length,
        targetGeneration: plan.stages.length + 1,
        baseVersion: 2,
        newVersion: 5,
        tombstone: false,
        objects: plan.entries.slice(0, 1)
      };
      const tampered = await submitBatch(fetchImpl, config, mutateBatchHash(buildLiveCrudBatch(config, nextStage)));
      const tamperedOk = !tampered.ok && tampered.status === 400 && rejectionReason(tampered) === "batch-hash-mismatch";
      addCase(cases, "tampered-batch-rejected", tamperedOk, tampered.ok ? "accepted unexpectedly" : `HTTP ${tampered.status}: ${rejectionReason(tampered) ?? "unknown"}`);
      if (!tamperedOk) {
        errors.push("tampered batch was not rejected as batch-hash-mismatch");
      }

      const staleStage: LiveCrudStage = {
        label: "stale-generation",
        operation: "update",
        baseGeneration: 0,
        targetGeneration: 1,
        baseVersion: 1,
        newVersion: 99,
        tombstone: false,
        objects: plan.entries.slice(0, 1)
      };
      const stale = await submitBatch(fetchImpl, config, buildLiveCrudBatch(config, staleStage));
      const staleOk = !stale.ok && stale.status === 409 && rejectionReason(stale) === "stale-generation";
      addCase(cases, "stale-generation-rejected", staleOk, stale.ok ? "accepted unexpectedly" : `HTTP ${stale.status}: ${rejectionReason(stale) ?? "unknown"}`);
      if (!staleOk) {
        errors.push("stale generation was not rejected as stale-generation");
      }

      const gapStage: LiveCrudStage = {
        label: "generation-gap",
        operation: "update",
        baseGeneration: plan.stages.length + 2,
        targetGeneration: plan.stages.length + 3,
        baseVersion: 2,
        newVersion: 100,
        tombstone: false,
        objects: plan.entries.slice(0, 1)
      };
      const gap = await submitBatch(fetchImpl, config, buildLiveCrudBatch(config, gapStage));
      const gapOk = !gap.ok && gap.status === 409 && rejectionReason(gap) === "generation-gap";
      addCase(cases, "generation-gap-rejected", gapOk, gap.ok ? "accepted unexpectedly" : `HTTP ${gap.status}: ${rejectionReason(gap) ?? "unknown"}`);
      if (!gapOk) {
        errors.push("generation gap was not rejected as generation-gap");
      }
    }

    if (errors.length === 0) {
      const pull = await fetchAllPullBatches(fetchImpl, config);
      const expectedGeneration = plan.stages.length;
      const pulledObjects = pull.batches.reduce((sum, batch) => sum + batch.object_count, 0);
      const pulledChanges = pull.batches.reduce((sum, batch) => sum + batch.change_count, 0);
      const generations = pull.batches.map((batch) => batch.target_generation);
      const contiguousGenerations = generations.every((generation, index) => generation === index + 1);
      const pullOk = pull.latest_generation === expectedGeneration &&
        pull.batches.length === expectedGeneration &&
        pulledObjects === acceptedCounts.objects &&
        pulledChanges === acceptedCounts.changes &&
        contiguousGenerations;

      addCase(
        cases,
        "pull-verifies-crud-history",
        pullOk,
        `latest=${pull.latest_generation}; batches=${pull.batches.length}; objects=${pulledObjects}; changes=${pulledChanges}`
      );
      if (!pullOk) {
        errors.push("pull response did not match accepted CRUD history");
      }
    }

    const durationMs = Date.now() - startedAt;
    const summary: CloudflareLiveCrudStressSummary = {
      endpoint: config.endpoint,
      run_id: config.runId,
      authority_id: config.authorityId,
      authority_ref: config.authorityRef,
      planned_entries: config.entryCount,
      created: config.entryCount,
      updated: config.entryCount,
      deleted: Math.max(1, Math.floor(config.entryCount / 3)),
      restored: Math.max(1, Math.floor(Math.max(1, Math.floor(config.entryCount / 3)) / 2)),
      accepted_batches: acceptedBatches.length,
      accepted_objects: acceptedCounts.objects,
      accepted_changes: acceptedCounts.changes,
      latest_generation: acceptedBatches.at(-1)?.target_generation ?? 0,
      duration_ms: durationMs
    };

    return {
      ok: errors.length === 0,
      cases,
      errors,
      summary
    };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      cases,
      errors
    };
  }
}

export function printCloudflareLiveCrudStressResult(result: CloudflareLiveCrudStressResult): void {
  const output = result.ok ? console.log : console.error;
  output(result.ok ? "Living Atlas Cloudflare live CRUD stress passed" : "Living Atlas Cloudflare live CRUD stress failed");
  if (result.summary) {
    output(`endpoint: ${result.summary.endpoint}`);
    output(`authority: ${result.summary.authority_id}`);
    output(`authority_ref: ${result.summary.authority_ref}`);
    output(`run: ${result.summary.run_id}`);
    output(`entries: ${result.summary.planned_entries}`);
    output(`created=${result.summary.created}; updated=${result.summary.updated}; deleted=${result.summary.deleted}; restored=${result.summary.restored}`);
    output(`batches=${result.summary.accepted_batches}; objects=${result.summary.accepted_objects}; changes=${result.summary.accepted_changes}; latest_generation=${result.summary.latest_generation}`);
    output(`duration_ms=${result.summary.duration_ms}`);
  }
  for (const testCase of result.cases) {
    output(`- ${testCase.ok ? "ok" : "fail"} ${testCase.name}${testCase.detail ? ` (${testCase.detail})` : ""}`);
  }
  for (const error of result.errors) {
    output(`error: ${error}`);
  }
}

export async function main(): Promise<void> {
  const result = await runCloudflareLiveCrudStress({
    onProgress: (message) => console.log(`[live-crud-stress] ${message}`)
  });
  printCloudflareLiveCrudStressResult(result);
  if (!result.ok) {
    process.exitCode = result.cases.length === 0 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
