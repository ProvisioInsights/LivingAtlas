import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  SyncBatchAcceptedSchema,
  SyncBatchSchema,
  SyncPullResponseSchema,
  SyncStatusSchema,
  canonicalSyncBatchHashPayload,
  type GraphObjectEnvelope,
  type SyncBatch,
  type SyncBatchAccepted,
  type SyncPullResponse,
  type SyncStatus
} from "@living-atlas/contracts";

type FetchLike = typeof fetch;

export type CloudflareLiveConcurrencySmokeConfig = {
  endpoint: string;
  syncToken: string;
  runId: string;
  authorityId: string;
  clientId: string;
  capabilityId: string;
  deviceId: string;
  tokenId?: string;
  concurrency: number;
  requestTimeoutMs: number;
};

export type CloudflareLiveConcurrencySmokeCase = {
  name: string;
  ok: boolean;
  detail?: string;
};

export type CloudflareLiveConcurrencySmokeResult = {
  ok: boolean;
  run_id?: string;
  endpoint?: string;
  authority_id?: string;
  cases: CloudflareLiveConcurrencySmokeCase[];
  errors: string[];
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

type FetchJsonResult = {
  status: number;
  body: unknown;
};

export const liveConcurrencyEnv = {
  endpoint: "LIVING_ATLAS_LIVE_SYNC_ENDPOINT",
  token: "LIVING_ATLAS_LIVE_SYNC_TOKEN",
  acknowledgeMutation: "LIVING_ATLAS_LIVE_CONCURRENCY_ACK",
  clientId: "LIVING_ATLAS_LIVE_SYNC_CLIENT_ID",
  capabilityId: "LIVING_ATLAS_LIVE_SYNC_CAPABILITY_ID",
  deviceId: "LIVING_ATLAS_LIVE_SYNC_DEVICE_ID",
  tokenId: "LIVING_ATLAS_LIVE_SYNC_TOKEN_ID",
  authorityId: "LIVING_ATLAS_LIVE_AUTHORITY_ID",
  runId: "LIVING_ATLAS_LIVE_RUN_ID",
  concurrency: "LIVING_ATLAS_LIVE_CONCURRENCY",
  timeoutMs: "LIVING_ATLAS_LIVE_REQUEST_TIMEOUT_MS",
  allowInsecureEndpoint: "LIVING_ATLAS_LIVE_ALLOW_INSECURE_ENDPOINT"
} as const;

const mutationAcknowledgement = "mutates-deployed-sync-state";
const expectedRaceRejectReasons = new Set([
  "stale-generation",
  "generation-gap",
  "batch-in-flight",
  "batch-conflict",
  "idempotency-conflict"
]);

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
  return `live_${randomBytes(8).toString("hex")}`;
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

function configError(errors: string[]): CloudflareLiveConcurrencySmokeResult {
  return {
    ok: false,
    cases: [],
    errors
  };
}

export function readCloudflareLiveConcurrencySmokeConfig(env: NodeJS.ProcessEnv = process.env): CloudflareLiveConcurrencySmokeConfig | CloudflareLiveConcurrencySmokeResult {
  const errors: string[] = [];
  const endpoint = envValue(env, liveConcurrencyEnv.endpoint);
  const syncToken = envValue(env, liveConcurrencyEnv.token);
  const acknowledgement = envValue(env, liveConcurrencyEnv.acknowledgeMutation);

  if (!endpoint) {
    errors.push(`missing ${liveConcurrencyEnv.endpoint}`);
  }
  if (!syncToken) {
    errors.push(`missing ${liveConcurrencyEnv.token}`);
  }
  if (acknowledgement !== mutationAcknowledgement) {
    errors.push(`${liveConcurrencyEnv.acknowledgeMutation} must equal ${mutationAcknowledgement}`);
  }
  if (errors.length > 0) {
    return configError(errors);
  }

  const runId = envValue(env, liveConcurrencyEnv.runId) ?? randomRunId();
  const authorityId = envValue(env, liveConcurrencyEnv.authorityId) ?? `la_authority_${digest(`authority:${runId}`)}`;
  const clientId = envValue(env, liveConcurrencyEnv.clientId) ?? `la_client_${digest(`client:${runId}`)}`;
  const capabilityId = envValue(env, liveConcurrencyEnv.capabilityId) ?? `la_cap_${digest(`capability:${runId}`)}`;
  const deviceId = envValue(env, liveConcurrencyEnv.deviceId) ?? `la_device_${digest(`device:${runId}`)}`;

  try {
    return {
      endpoint: validateEndpoint(endpoint!, envValue(env, liveConcurrencyEnv.allowInsecureEndpoint) === "1"),
      syncToken: syncToken!,
      runId,
      authorityId,
      clientId,
      capabilityId,
      deviceId,
      tokenId: envValue(env, liveConcurrencyEnv.tokenId),
      concurrency: parsePositiveInteger(envValue(env, liveConcurrencyEnv.concurrency), 4, 2, 8),
      requestTimeoutMs: parsePositiveInteger(envValue(env, liveConcurrencyEnv.timeoutMs), 15_000, 1_000, 120_000)
    };
  } catch (error) {
    return configError([error instanceof Error ? error.message : String(error)]);
  }
}

function isConfig(value: CloudflareLiveConcurrencySmokeConfig | CloudflareLiveConcurrencySmokeResult): value is CloudflareLiveConcurrencySmokeConfig {
  return "syncToken" in value;
}

function syncHeaders(config: CloudflareLiveConcurrencySmokeConfig, batch?: SyncBatch): Record<string, string> {
  return {
    ...(batch ? { "content-type": "application/json" } : {}),
    "x-living-atlas-sync-token": config.syncToken,
    "x-living-atlas-sync-client-id": batch?.client_id ?? config.clientId,
    "x-living-atlas-sync-capability-id": batch?.capability_id ?? config.capabilityId,
    ...(batch?.token_id ?? config.tokenId ? { "x-living-atlas-sync-token-id": batch?.token_id ?? config.tokenId! } : {})
  };
}

function requestUrl(endpoint: string, path: string): URL {
  return new URL(path, endpoint);
}

async function fetchJson(
  fetchImpl: FetchLike,
  config: CloudflareLiveConcurrencySmokeConfig,
  path: string,
  init: RequestInit = {}
): Promise<FetchJsonResult> {
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
      body
    };
  } finally {
    clearTimeout(timeout);
  }
}

function liveObject(config: CloudflareLiveConcurrencySmokeConfig, label: string, generation: number): GraphObjectEnvelope {
  const seed = `${config.runId}:${label}:${generation}`;
  const objectId = makeId("la_object", `object:${seed}`);
  const ciphertextHash = sha256(`ciphertext:${seed}`);

  return {
    schema_version: 1,
    authority_id: config.authorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content_hash: ciphertextHash,
    key_ref: makeId("la_key", `key:${config.runId}`),
    visible_metadata: {
      schema_namespace: "synthetic/live-concurrency-smoke",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "ciphertext-ref",
      storage: "r2",
      path: opaqueR2Path(seed),
      ciphertext_hash: ciphertextHash,
      byte_size: 512,
      algorithm: "xchacha20-poly1305"
    }
  };
}

export function buildLiveConcurrencyBatch(
  config: CloudflareLiveConcurrencySmokeConfig,
  label: string,
  baseGeneration: number,
  targetGeneration: number
): SyncBatch {
  const object = liveObject(config, label, targetGeneration);
  const operationId = makeId("la_operation", `operation:${config.runId}:${label}:${targetGeneration}`);
  const traceId = makeId("la_trace", `trace:${config.runId}:${label}:${targetGeneration}`);
  const submittedAt = new Date().toISOString();
  const batchWithoutHash = {
    batch_id: makeId("la_sync_batch", `batch:${config.runId}:${label}:${targetGeneration}`),
    authority_id: config.authorityId,
    device_id: config.deviceId,
    client_id: config.clientId,
    capability_id: config.capabilityId,
    operation_id: operationId,
    trace_id: traceId,
    token_id: config.tokenId,
    idempotency_key: makeId("la_idem", `idempotency:${config.runId}:${label}:${targetGeneration}`),
    submitted_at: submittedAt,
    base_generation: baseGeneration,
    target_generation: targetGeneration,
    base_cursor: {
      authority_id: config.authorityId,
      generation: baseGeneration
    },
    pull_recovery: {
      mode: "none",
      reason: "current"
    },
    objects: [object],
    changes: [
      {
        change_id: makeId("la_change", `change:${config.runId}:${label}:${targetGeneration}`),
        authority_id: config.authorityId,
        operation_id: operationId,
        trace_id: traceId,
        recorded_at: submittedAt,
        object_id: object.object_id,
        operation: "update",
        base_version: 0,
        new_version: 1,
        content_hash: object.content_hash,
        access_class: object.access_class,
        generation: targetGeneration,
        actor_id: config.clientId
      }
    ],
    withheld_plaintext_count: 0
  };

  const derived = SyncBatchSchema.parse(batchWithoutHash);
  const { batch_hash: _derivedHash, ...withoutHash } = derived;
  return SyncBatchSchema.parse({
    ...derived,
    batch_hash: sha256(canonicalSyncBatchHashPayload(withoutHash))
  });
}

async function submitBatch(
  fetchImpl: FetchLike,
  config: CloudflareLiveConcurrencySmokeConfig,
  batch: SyncBatch
): Promise<SubmitBatchResult> {
  const response = await fetchJson(fetchImpl, config, "/api/sync/batch", {
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

async function fetchStatus(fetchImpl: FetchLike, config: CloudflareLiveConcurrencySmokeConfig): Promise<SyncStatus> {
  const response = await fetchJson(fetchImpl, config, "/api/sync/status", {
    method: "GET",
    headers: syncHeaders(config)
  });
  if (response.status !== 200) {
    throw new Error(`sync status expected HTTP 200, got ${response.status}: ${JSON.stringify(response.body)}`);
  }

  return SyncStatusSchema.parse(response.body);
}

async function fetchPull(
  fetchImpl: FetchLike,
  config: CloudflareLiveConcurrencySmokeConfig,
  afterGeneration: number
): Promise<SyncPullResponse> {
  const path = `/api/sync/pull?authority_id=${encodeURIComponent(config.authorityId)}&after_generation=${afterGeneration}`;
  const response = await fetchJson(fetchImpl, config, path, {
    method: "GET",
    headers: syncHeaders(config)
  });
  if (response.status !== 200) {
    throw new Error(`sync pull expected HTTP 200, got ${response.status}: ${JSON.stringify(response.body)}`);
  }

  return SyncPullResponseSchema.parse(response.body);
}

function errorReason(result: SubmitBatchResult): string | undefined {
  if (result.ok || !result.error || typeof result.error !== "object") {
    return undefined;
  }

  const error = (result.error as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

function addCase(
  cases: CloudflareLiveConcurrencySmokeCase[],
  name: string,
  ok: boolean,
  detail?: string
): void {
  cases.push({ name, ok, ...(detail ? { detail } : {}) });
}

function expectAccepted(result: SubmitBatchResult, batch: SyncBatch, replay: boolean): string | undefined {
  if (!result.ok) {
    return `expected accepted batch ${batch.batch_id}, got HTTP ${result.status}: ${JSON.stringify(result.error)}`;
  }

  if (result.accepted.batch_id !== batch.batch_id) {
    return `accepted unexpected batch ${result.accepted.batch_id}`;
  }

  if ((result.accepted.idempotent_replay ?? false) !== replay) {
    return `expected idempotent_replay=${replay}, got ${result.accepted.idempotent_replay ?? false}`;
  }

  return undefined;
}

export async function runCloudflareLiveConcurrencySmoke(options: {
  env?: NodeJS.ProcessEnv;
  config?: CloudflareLiveConcurrencySmokeConfig;
  fetchImpl?: FetchLike;
} = {}): Promise<CloudflareLiveConcurrencySmokeResult> {
  const readConfig = options.config ?? readCloudflareLiveConcurrencySmokeConfig(options.env);
  if (!isConfig(readConfig)) {
    return readConfig;
  }

  const config = readConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cases: CloudflareLiveConcurrencySmokeCase[] = [];
  const errors: string[] = [];

  try {
    const health = await fetchJson(fetchImpl, config, "/healthz", { method: "GET" });
    addCase(cases, "healthz", health.status === 200, `HTTP ${health.status}`);
    if (health.status !== 200) {
      errors.push(`healthz expected HTTP 200, got ${health.status}`);
    }

    await fetchStatus(fetchImpl, config);
    addCase(cases, "sync-token-status", true);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    addCase(cases, "sync-token-status", false);
    return {
      ok: false,
      run_id: config.runId,
      endpoint: config.endpoint,
      authority_id: config.authorityId,
      cases,
      errors
    };
  }

  const first = buildLiveConcurrencyBatch(config, "initial", 0, 1);
  const firstResult = await submitBatch(fetchImpl, config, first);
  const firstError = expectAccepted(firstResult, first, false);
  addCase(cases, "initial-batch", !firstError, firstError);
  if (firstError) {
    errors.push(firstError);
  }

  const replayResult = await submitBatch(fetchImpl, config, first);
  const replayError = expectAccepted(replayResult, first, true);
  addCase(cases, "idempotency-replay", !replayError, replayError);
  if (replayError) {
    errors.push(replayError);
  }

  const stale = buildLiveConcurrencyBatch(config, "stale-after-initial", 0, 1);
  const staleResult = await submitBatch(fetchImpl, config, stale);
  const staleOk = !staleResult.ok && staleResult.status === 409 && errorReason(staleResult) === "stale-generation";
  addCase(cases, "stale-generation", staleOk, staleOk ? undefined : `got HTTP ${staleResult.status}: ${JSON.stringify(staleResult.ok ? staleResult.accepted : staleResult.error)}`);
  if (!staleOk) {
    errors.push("stale-generation case did not return HTTP 409 stale-generation");
  }

  const raceBatches = Array.from({ length: config.concurrency }, (_, index) => (
    buildLiveConcurrencyBatch(config, `race-${index + 1}`, 1, 2)
  ));
  const raceResults = await Promise.all(raceBatches.map((batch) => submitBatch(fetchImpl, config, batch)));
  const acceptedRaceResults = raceResults
    .map((result, index) => ({ result, batch: raceBatches[index]! }))
    .filter((entry): entry is { result: Extract<SubmitBatchResult, { ok: true }>; batch: SyncBatch } => entry.result.ok);
  const rejectedRaceResults = raceResults.filter((result) => !result.ok);
  const rejectedReasons = rejectedRaceResults.map((result) => errorReason(result)).filter((reason): reason is string => Boolean(reason));
  const raceOk = acceptedRaceResults.length === 1 &&
    rejectedRaceResults.length === config.concurrency - 1 &&
    rejectedRaceResults.every((result) => result.status === 409 && expectedRaceRejectReasons.has(errorReason(result) ?? ""));
  addCase(
    cases,
    "same-generation-race",
    raceOk,
    raceOk
      ? `winner=${acceptedRaceResults[0]!.batch.batch_id}; rejected=${rejectedReasons.join(",")}`
      : `accepted=${acceptedRaceResults.length}; rejected=${rejectedRaceResults.length}; reasons=${rejectedReasons.join(",")}`
  );
  if (!raceOk) {
    errors.push("same-generation race accepted more than one batch or rejected with unexpected reasons");
  }

  const winningRaceBatch = acceptedRaceResults[0]?.batch;
  if (winningRaceBatch) {
    const raceReplay = await submitBatch(fetchImpl, config, winningRaceBatch);
    const raceReplayError = expectAccepted(raceReplay, winningRaceBatch, true);
    addCase(cases, "race-winner-idempotency", !raceReplayError, raceReplayError);
    if (raceReplayError) {
      errors.push(raceReplayError);
    }
  } else {
    addCase(cases, "race-winner-idempotency", false, "no race winner");
    errors.push("race winner idempotency could not run because there was no race winner");
  }

  const gap = buildLiveConcurrencyBatch(config, "generation-gap", 4, 5);
  const gapResult = await submitBatch(fetchImpl, config, gap);
  const gapOk = !gapResult.ok && gapResult.status === 409 && errorReason(gapResult) === "generation-gap";
  addCase(cases, "generation-gap", gapOk, gapOk ? undefined : `got HTTP ${gapResult.status}: ${JSON.stringify(gapResult.ok ? gapResult.accepted : gapResult.error)}`);
  if (!gapOk) {
    errors.push("generation-gap case did not return HTTP 409 generation-gap");
  }

  try {
    const pull = await fetchPull(fetchImpl, config, 0);
    const targetTwoBatches = pull.batches.filter((batch) => batch.target_generation === 2);
    const pullOk = pull.latest_generation === 2 && pull.batches.length === 2 && targetTwoBatches.length === 1;
    addCase(
      cases,
      "pull-after-race",
      pullOk,
      `latest=${pull.latest_generation}; batches=${pull.batches.length}; target2=${targetTwoBatches.length}`
    );
    if (!pullOk) {
      errors.push("pull-after-race did not show exactly two committed batches with one target_generation=2");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addCase(cases, "pull-after-race", false, message);
    errors.push(message);
  }

  return {
    ok: errors.length === 0,
    run_id: config.runId,
    endpoint: config.endpoint,
    authority_id: config.authorityId,
    cases,
    errors
  };
}

export function printCloudflareLiveConcurrencySmokeResult(result: CloudflareLiveConcurrencySmokeResult): void {
  const output = result.ok ? console.log : console.error;
  output(result.ok ? "Living Atlas Cloudflare live concurrency smoke passed" : "Living Atlas Cloudflare live concurrency smoke failed");
  if (result.endpoint) {
    output(`endpoint: ${result.endpoint}`);
  }
  if (result.authority_id) {
    output(`authority: ${result.authority_id}`);
  }
  if (result.run_id) {
    output(`run: ${result.run_id}`);
  }
  for (const testCase of result.cases) {
    output(`- ${testCase.ok ? "ok" : "fail"} ${testCase.name}${testCase.detail ? ` (${testCase.detail})` : ""}`);
  }
  for (const error of result.errors) {
    output(`error: ${error}`);
  }
}

export async function main(): Promise<void> {
  const result = await runCloudflareLiveConcurrencySmoke();
  printCloudflareLiveConcurrencySmokeResult(result);
  if (!result.ok) {
    process.exitCode = result.cases.length === 0 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
