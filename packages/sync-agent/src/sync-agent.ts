import { createHash } from "node:crypto";
import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalSyncBatchHashPayload,
  GraphObjectEnvelopeSchema,
  SyncBatchAcceptedSchema,
  SyncBatchSchema,
  SyncEnvelopePullResponseSchema,
  SyncPullResponseSchema,
  SyncStatusSchema,
  type ClientRecord,
  type GraphObjectEnvelope,
  type LocalControlState,
  type SyncBatch,
  type SyncBatchAccepted,
  type SyncChangeEvent,
  type SyncEnvelopePullObject,
  type SyncEnvelopePullResponse,
  type SyncPullCursor,
  type SyncPullRecovery,
  type SyncPullResponse,
  type SyncStatus
} from "@living-atlas/contracts";
import { syntheticGraphObjects } from "@living-atlas/fixtures";
import type { FileLocalGraphStore, LocalGraphMutationConflictReason } from "@living-atlas/local-graph-store";
import { evaluatePolicy } from "@living-atlas/policy";

export type BuildSyncBatchOptions = {
  controlState: LocalControlState;
  graphObjects?: GraphObjectEnvelope[];
  syncClientId?: string;
  tokenId?: string;
  baseGeneration: number;
  targetGeneration: number;
  now: string;
};

export type BuildSyncBatchResult = {
  batch: SyncBatch;
  included_object_count: number;
  withheld_plaintext_count: number;
};

export type SubmitSyncBatchOptions = {
  endpoint: string;
  batch: SyncBatch;
  syncToken?: string;
  fetchImpl?: typeof fetch;
};

export type SubmitSyncBatchResult =
  | {
      ok: true;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      status: number;
      error: unknown;
    };

export type FetchSyncStatusOptions = {
  endpoint: string;
  syncToken?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
  fetchImpl?: typeof fetch;
};

export type FetchSyncStatusResult =
  | {
      ok: true;
      status: SyncStatus;
    }
  | {
      ok: false;
      status_code: number;
      error: unknown;
    };

export type NextSyncGeneration = {
  base_generation: number;
  target_generation: number;
};

export type FetchSyncPullOptions = {
  endpoint: string;
  authorityId: string;
  afterGeneration: number;
  limit?: number;
  syncToken?: string;
  clientId?: string;
  capabilityId?: string;
  tokenId?: string;
  fetchImpl?: typeof fetch;
};

export type FetchSyncPullResult =
  | {
      ok: true;
      response: SyncPullResponse;
    }
  | {
      ok: false;
      status_code: number;
      error: unknown;
    };

export type FetchSyncEnvelopesOptions = FetchSyncPullOptions;

export type FetchSyncEnvelopesResult =
  | {
      ok: true;
      response: SyncEnvelopePullResponse;
    }
  | {
      ok: false;
      status_code: number;
      error: unknown;
    };

export type ApplyPulledEnvelopesOptions = {
  store: FileLocalGraphStore;
  response: SyncEnvelopePullResponse;
  actorId: string;
};

export type ApplyPulledEnvelopeConflict = {
  object_id: string;
  remote_generation: number;
  remote_version: number;
  local_version?: number;
  reason: "version-gap" | "version-conflict" | "store-conflict";
  store_reason?: LocalGraphMutationConflictReason;
};

export type ApplyPulledEnvelopesResult = {
  ok: boolean;
  applied_count: number;
  skipped_count: number;
  conflict_count: number;
  cursor: SyncPullCursor;
  conflicts: ApplyPulledEnvelopeConflict[];
};

export type SyncOutboxRecord = {
  batch: SyncBatch;
  status: "pending" | "accepted";
  enqueued_at: string;
  accepted_at?: string;
};

export type SyncStatusPlan =
  | {
      action: "idle";
      reason: "current";
      local_generation: number;
      remote_generation: number;
      recovery: SyncPullRecovery;
    }
  | {
      action: "pull";
      reason: "local-cursor-behind" | "cursor-missing";
      local_generation: number;
      remote_generation: number;
      pull_after_generation: number;
      recovery: SyncPullRecovery;
    }
  | {
      action: "push";
      reason: "pending-outbox";
      local_generation: number;
      remote_generation: number;
      next_generation: number;
      recovery: SyncPullRecovery;
    }
  | {
      action: "recover";
      reason: "local-cursor-ahead";
      local_generation: number;
      remote_generation: number;
      recovery: SyncPullRecovery;
    };

export type PlanSyncFromStatusOptions = {
  localCursor?: SyncPullCursor;
  remoteStatus: SyncStatus;
  pendingOutboxCount?: number;
};

type SyncClientRecord = ClientRecord & {
  device_id: string;
};

type SyncCapabilityRecord = LocalControlState["control_plane"]["capabilities"][number];
type PullSyncStatusPlan = Extract<SyncStatusPlan, { action: "pull" }>;

export type QueueCiphertextBatchOptions = {
  graphObjects?: GraphObjectEnvelope[];
  baseGeneration?: number;
  targetGeneration?: number;
  remoteStatus?: SyncStatus;
  now: string;
};

export type QueueCiphertextBatchResult = BuildSyncBatchResult & {
  record: SyncOutboxRecord;
};

export type SyntheticLocalSyncDaemonOptions = {
	  controlState: LocalControlState;
	  endpoint?: string;
	  syncToken?: string;
	  syncClientId?: string;
	  tokenId?: string;
	  fetchImpl?: typeof fetch;
	  outbox?: InMemorySyncOutbox;
	  now?: string;
	};

export type SubmitNextPendingOptions = {
	  acceptedAt?: string;
	  now?: string;
	};

export type SubmitNextPendingResult =
  | {
      ok: true;
      submitted: false;
      reason: "empty-outbox";
    }
  | {
      ok: true;
      submitted: true;
      record: SyncOutboxRecord;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      submitted: true;
      record: SyncOutboxRecord;
      status: number;
      error: unknown;
    };

export type SyncDaemonPlanResult =
  | {
      ok: true;
      status: SyncStatus;
      plan: SyncStatusPlan;
    }
  | {
      ok: false;
      status_code: number;
      error: unknown;
    };

export type FetchPlannedPullResult =
  | {
      ok: true;
      skipped: true;
      reason: "plan-does-not-pull";
      plan: SyncStatusPlan;
    }
  | {
      ok: true;
      skipped: false;
      plan: PullSyncStatusPlan;
      response: SyncPullResponse;
    }
  | {
      ok: false;
      skipped: false;
      plan: PullSyncStatusPlan;
      status_code: number;
      error: unknown;
    };

export type FileOutboxPushHandshakeOptions = {
  outboxDir: string;
  store: FileLocalGraphStore;
  controlState: LocalControlState;
  cursor: SyncPullCursor;
  endpoint: string;
  syncToken?: string;
  syncClientId?: string;
  tokenId?: string;
  fetchImpl?: typeof fetch;
  now?: string;
};

export type FileOutboxPushHandshakeResult =
  | {
      ok: true;
      cursor: SyncPullCursor;
      pushed_batches: number;
      pushed_objects: number;
      applied: number;
      skipped: number;
      conflicts: 0;
      conflict_samples: [];
      outbox_pending: number;
      accepted_files: string[];
    }
  | {
      ok: false;
      cursor: SyncPullCursor;
      pushed_batches: number;
      pushed_objects: number;
      applied: number;
      skipped: number;
      conflicts: number;
      conflict_samples: ApplyPulledEnvelopeConflict[];
      outbox_pending: number;
      accepted_files: string[];
      reason: "remote-status-failed" | "remote-apply-conflict" | "push-failed";
      error?: unknown;
    };

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function makeId(prefix: "la_sync_batch" | "la_operation" | "la_trace" | "la_change", seed: string): string {
  return `${prefix}_${digest(seed)}`;
}

function makeIdempotencyKey(seed: string): string {
  return `la_idem_${digest(seed)}`;
}

function requireIdempotencyKey(batch: SyncBatch): string {
  if (!batch.idempotency_key) {
    throw new Error("Sync outbox records require an idempotency_key");
  }

  return batch.idempotency_key;
}

function requireDaemonEndpoint(endpoint: string | undefined): string {
  if (!endpoint) {
    throw new Error("Synthetic sync daemon remote steps require an endpoint");
  }

  return endpoint;
}

function requireInjectedFetch(fetchImpl: typeof fetch | undefined): typeof fetch {
  if (!fetchImpl) {
    throw new Error("Synthetic sync daemon remote steps require an injected fetchImpl; no network calls are made by default");
  }

  return fetchImpl;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function queuedOutboxFiles(outboxDir: string): Promise<string[]> {
  const entries = await readdir(outboxDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.includes(".accepted.") && !entry.name.includes(".failed."))
    .map((entry) => join(outboxDir, entry.name))
    .sort();
}

async function readQueuedObjects(filePath: string): Promise<GraphObjectEnvelope[]> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  const values = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { objects?: unknown }).objects)
      ? (parsed as { objects: unknown[] }).objects
      : [parsed];
  return values.map((value) => GraphObjectEnvelopeSchema.parse(value));
}

function isExpired(timestamp: string | undefined, now: string): boolean {
  return timestamp !== undefined && Date.parse(timestamp) <= Date.parse(now);
}

function findSyncClient(controlState: LocalControlState, syncClientId: string | undefined, now: string): SyncClientRecord {
  const client = controlState.control_plane.clients.find((candidate) => (
    syncClientId ? candidate.client_id === syncClientId : candidate.allowed_profile === "sync-device"
  ));

  if (!client || client.allowed_profile !== "sync-device") {
    throw new Error("No sync-device client is available in the local control state");
  }

  if (client.revoked_at) {
    throw new Error("Sync-device client is revoked");
  }

  if (isExpired(client.expires_at, now)) {
    throw new Error("Sync-device client is expired");
  }

  if (!client.device_id) {
    throw new Error("Sync-device client must be bound to a local device");
  }

  return {
    ...client,
    device_id: client.device_id
  };
}

function findSyncCapability(controlState: LocalControlState, syncClient: SyncClientRecord, now: string): SyncCapabilityRecord {
  const capability = controlState.control_plane.capabilities.find((candidate) => (
    candidate.client_id === syncClient.client_id && candidate.profile === "sync-device"
  ));

  if (!capability) {
    throw new Error("No sync-device capability is available for the sync client");
  }

  if (capability.revoked_at) {
    throw new Error("Sync-device capability is revoked");
  }

  if (isExpired(capability.expires_at, now)) {
    throw new Error("Sync-device capability is expired");
  }

  return capability;
}

function objectPayloadRefs(objects: GraphObjectEnvelope[]) {
  return objects.map((object) => ({
    object_id: object.object_id,
    version: object.version,
    envelope_hash: sha256(JSON.stringify(object)),
    payload_hash: object.payload.kind === "ciphertext-ref"
      ? object.payload.ciphertext_hash
      : sha256(JSON.stringify(object.payload)),
    byte_size: object.payload.kind === "ciphertext-ref"
      ? object.payload.byte_size
      : new TextEncoder().encode(JSON.stringify(object.payload)).byteLength,
    r2_path_hash: object.payload.kind === "ciphertext-ref" && object.payload.storage === "r2"
      ? sha256(object.payload.path)
      : undefined
  }));
}

function makeChange(input: {
  batchSeed: string;
  authorityId: string;
  object: GraphObjectEnvelope;
  actorId: string;
  operationId: string;
  traceId: string;
  now: string;
  generation: number;
}): SyncChangeEvent {
  return {
    change_id: makeId("la_change", `${input.batchSeed}:${input.object.object_id}`),
    authority_id: input.authorityId,
    operation_id: input.operationId,
    trace_id: input.traceId,
    recorded_at: input.now,
    object_id: input.object.object_id,
    operation: input.object.visible_metadata.tombstone ? "tombstone" : "update",
    base_version: Math.max(input.object.version - 1, 0),
    new_version: input.object.version,
    content_hash: input.object.content_hash,
    access_class: input.object.access_class,
    generation: input.generation,
    actor_id: input.actorId
  };
}

export function buildCiphertextSyncBatch(options: BuildSyncBatchOptions): BuildSyncBatchResult {
	  const syncClient = findSyncClient(options.controlState, options.syncClientId, options.now);
	  const capability = findSyncCapability(options.controlState, syncClient, options.now);

  const objects: GraphObjectEnvelope[] = [];
  let withheldPlaintextCount = 0;
  const graphObjects = options.graphObjects ?? syntheticGraphObjects;

  for (const object of graphObjects) {
    const decision = evaluatePolicy({
      profile: "sync-device",
      operation: "sync-read",
      actor_id: syncClient.client_id,
      capability,
      now: options.now
    }, object);

    if (!decision.allowed) {
      continue;
    }

    if (object.payload.kind === "plaintext-json") {
      withheldPlaintextCount += 1;
      continue;
    }

    objects.push(object);
  }

  const batchSeed = `${options.controlState.authority_id}:${syncClient.client_id}:${options.targetGeneration}:${options.now}`;
  const operationId = makeId("la_operation", `${batchSeed}:operation`);
  const traceId = makeId("la_trace", `${batchSeed}:trace`);
  const batchWithoutHash = {
    batch_id: makeId("la_sync_batch", batchSeed),
    authority_id: options.controlState.authority_id,
    device_id: syncClient.device_id,
    client_id: syncClient.client_id,
    capability_id: capability.capability_id,
    operation_id: operationId,
    trace_id: traceId,
    token_id: options.tokenId,
    idempotency_key: makeIdempotencyKey(`${batchSeed}:idempotency`),
    submitted_at: options.now,
    base_generation: options.baseGeneration,
    target_generation: options.targetGeneration,
    base_cursor: {
      authority_id: options.controlState.authority_id,
      generation: options.baseGeneration
    },
    pull_recovery: {
      mode: "none",
      reason: "current"
    },
    object_payloads: objectPayloadRefs(objects),
    objects,
    changes: objects.map((object) => makeChange({
      batchSeed,
      authorityId: options.controlState.authority_id,
      object,
      actorId: syncClient.client_id,
      operationId,
      traceId,
      now: options.now,
      generation: options.targetGeneration
    })),
    estimated_batch_bytes: new TextEncoder().encode(JSON.stringify(objects)).byteLength,
    limits: {
      max_objects: 250,
      max_changes: 1000,
      max_bytes: 1_000_000
    },
    withheld_plaintext_count: withheldPlaintextCount
  } satisfies Omit<SyncBatch, "batch_hash">;

  const batch: SyncBatch = SyncBatchSchema.parse({
    ...batchWithoutHash,
    batch_hash: sha256(canonicalSyncBatchHashPayload(batchWithoutHash))
  });

  return {
    batch,
    included_object_count: batch.objects.length,
    withheld_plaintext_count: withheldPlaintextCount
  };
}

export async function submitSyncBatch(options: SubmitSyncBatchOptions): Promise<SubmitSyncBatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/api/sync/batch", options.endpoint);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.syncToken ? { "x-living-atlas-sync-token": options.syncToken } : {}),
      "x-living-atlas-sync-client-id": options.batch.client_id,
      ...(options.batch.capability_id ? { "x-living-atlas-sync-capability-id": options.batch.capability_id } : {}),
      ...(options.batch.token_id ? { "x-living-atlas-sync-token-id": options.batch.token_id } : {})
    },
    body: JSON.stringify(options.batch)
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: body
    };
  }

  return {
    ok: true,
    accepted: SyncBatchAcceptedSchema.parse(body)
  };
}

export async function fetchSyncStatus(options: FetchSyncStatusOptions): Promise<FetchSyncStatusResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/api/sync/status", options.endpoint);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      ...(options.syncToken ? { "x-living-atlas-sync-token": options.syncToken } : {}),
      ...(options.clientId ? { "x-living-atlas-sync-client-id": options.clientId } : {}),
      ...(options.capabilityId ? { "x-living-atlas-sync-capability-id": options.capabilityId } : {}),
      ...(options.tokenId ? { "x-living-atlas-sync-token-id": options.tokenId } : {})
    }
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    return {
      ok: false,
      status_code: response.status,
      error: body
    };
  }

  return {
    ok: true,
    status: SyncStatusSchema.parse(body)
  };
}

export function nextSyncGenerationFromStatus(status: SyncStatus): NextSyncGeneration {
  return {
    base_generation: status.latest_generation,
    target_generation: status.latest_generation + 1
  };
}

export function planSyncFromStatus(options: PlanSyncFromStatusOptions): SyncStatusPlan {
  const remoteGeneration = options.remoteStatus.latest_generation;
  const localGeneration = options.localCursor?.generation ?? 0;
  const pendingOutboxCount = options.pendingOutboxCount ?? 0;

  if (!options.localCursor && remoteGeneration > 0) {
    return {
      action: "pull",
      reason: "cursor-missing",
      local_generation: localGeneration,
      remote_generation: remoteGeneration,
      pull_after_generation: 0,
      recovery: {
        mode: "snapshot-catchup",
        from_generation: 0,
        reason: "cursor-missing"
      }
    };
  }

  if (localGeneration < remoteGeneration) {
    return {
      action: "pull",
      reason: "local-cursor-behind",
      local_generation: localGeneration,
      remote_generation: remoteGeneration,
      pull_after_generation: localGeneration,
      recovery: {
        mode: "replay",
        from_generation: localGeneration,
        reason: "local-cursor-behind"
      }
    };
  }

  if (localGeneration > remoteGeneration) {
    return {
      action: "recover",
      reason: "local-cursor-ahead",
      local_generation: localGeneration,
      remote_generation: remoteGeneration,
      recovery: {
        mode: "snapshot-catchup",
        from_generation: remoteGeneration,
        reason: "local-cursor-ahead"
      }
    };
  }

  if (pendingOutboxCount > 0) {
    return {
      action: "push",
      reason: "pending-outbox",
      local_generation: localGeneration,
      remote_generation: remoteGeneration,
      next_generation: remoteGeneration + 1,
      recovery: {
        mode: "none",
        reason: "current"
      }
    };
  }

  return {
    action: "idle",
    reason: "current",
    local_generation: localGeneration,
    remote_generation: remoteGeneration,
    recovery: {
      mode: "none",
      reason: "current"
    }
  };
}

export async function fetchSyncPull(options: FetchSyncPullOptions): Promise<FetchSyncPullResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/api/sync/pull", options.endpoint);
  url.searchParams.set("authority_id", options.authorityId);
  url.searchParams.set("after_generation", String(options.afterGeneration));
  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit));
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      ...(options.syncToken ? { "x-living-atlas-sync-token": options.syncToken } : {}),
      ...(options.clientId ? { "x-living-atlas-sync-client-id": options.clientId } : {}),
      ...(options.capabilityId ? { "x-living-atlas-sync-capability-id": options.capabilityId } : {}),
      ...(options.tokenId ? { "x-living-atlas-sync-token-id": options.tokenId } : {})
    }
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    return {
      ok: false,
      status_code: response.status,
      error: body
    };
  }

  return {
    ok: true,
    response: SyncPullResponseSchema.parse(body)
  };
}

export async function fetchSyncEnvelopes(options: FetchSyncEnvelopesOptions): Promise<FetchSyncEnvelopesResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/api/sync/envelopes", options.endpoint);
  url.searchParams.set("authority_id", options.authorityId);
  url.searchParams.set("after_generation", String(options.afterGeneration));
  if (options.limit !== undefined) {
    url.searchParams.set("limit", String(options.limit));
  }
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      ...(options.syncToken ? { "x-living-atlas-sync-token": options.syncToken } : {}),
      ...(options.clientId ? { "x-living-atlas-sync-client-id": options.clientId } : {}),
      ...(options.capabilityId ? { "x-living-atlas-sync-capability-id": options.capabilityId } : {}),
      ...(options.tokenId ? { "x-living-atlas-sync-token-id": options.tokenId } : {})
    }
  });
  const body = await response.json().catch(() => undefined);

  if (!response.ok) {
    return {
      ok: false,
      status_code: response.status,
      error: body
    };
  }

  return {
    ok: true,
    response: SyncEnvelopePullResponseSchema.parse(body)
  };
}

function comparePulledObjects(left: SyncEnvelopePullObject, right: SyncEnvelopePullObject): number {
  return left.generation - right.generation
    || left.object.object_id.localeCompare(right.object.object_id)
    || left.object.version - right.object.version;
}

export async function applyPulledEnvelopes(options: ApplyPulledEnvelopesOptions): Promise<ApplyPulledEnvelopesResult> {
  const conflicts: ApplyPulledEnvelopeConflict[] = [];
  let appliedCount = 0;
  let skippedCount = 0;
  let cursor: SyncPullCursor = {
    authority_id: options.response.authority_id,
    generation: options.response.from_generation
  };
  const objectsByGeneration = new Map<number, SyncEnvelopePullObject[]>();

  for (const pulled of [...options.response.objects].sort(comparePulledObjects)) {
    const generationObjects = objectsByGeneration.get(pulled.generation) ?? [];
    generationObjects.push(pulled);
    objectsByGeneration.set(pulled.generation, generationObjects);
  }

  for (const [generation, generationObjects] of [...objectsByGeneration.entries()].sort((left, right) => left[0] - right[0])) {
    let generationOk = true;
    let generationBatchId: string | undefined;

    for (const pulled of generationObjects) {
      generationBatchId = pulled.batch_id;
      const existing = options.store.readObject(pulled.object.object_id);
      if (existing && existing.version === pulled.object.version && existing.content_hash !== pulled.object.content_hash) {
        conflicts.push({
          object_id: pulled.object.object_id,
          remote_generation: pulled.generation,
          remote_version: pulled.object.version,
          local_version: existing.version,
          reason: "version-conflict"
        });
        generationOk = false;
        break;
      }

      if (existing && existing.version >= pulled.object.version) {
        skippedCount += 1;
        continue;
      }

      if (!existing && pulled.object.version > 1 && options.response.from_generation > 0) {
        conflicts.push({
          object_id: pulled.object.object_id,
          remote_generation: pulled.generation,
          remote_version: pulled.object.version,
          reason: "version-gap"
        });
        generationOk = false;
        break;
      }

      if (existing && pulled.object.version !== existing.version + 1) {
        conflicts.push({
          object_id: pulled.object.object_id,
          remote_generation: pulled.generation,
          remote_version: pulled.object.version,
          local_version: existing.version,
          reason: "version-gap"
        });
        generationOk = false;
        break;
      }

      const mutation = existing
        ? await options.store.updateObject({
            object: pulled.object,
            expected_generation: options.store.status().generation,
            expected_version: existing.version,
            actor_id: options.actorId,
            recorded_at: pulled.submitted_at
          })
        : await options.store.createObject({
            object: pulled.object,
            expected_generation: options.store.status().generation,
            actor_id: options.actorId,
            recorded_at: pulled.submitted_at
          });

      if (!mutation.ok) {
        conflicts.push({
          object_id: pulled.object.object_id,
          remote_generation: pulled.generation,
          remote_version: pulled.object.version,
          local_version: existing?.version,
          reason: "store-conflict",
          store_reason: mutation.reason
        });
        generationOk = false;
        break;
      }

      appliedCount += 1;
    }

    if (!generationOk) {
      break;
    }

    cursor = {
      authority_id: options.response.authority_id,
      generation,
      batch_id: generationBatchId
    };
  }

  return {
    ok: conflicts.length === 0,
    applied_count: appliedCount,
    skipped_count: skippedCount,
    conflict_count: conflicts.length,
    cursor: conflicts.length === 0 ? options.response.next_cursor : cursor,
    conflicts
  };
}

export async function runFileOutboxPushHandshake(options: FileOutboxPushHandshakeOptions): Promise<FileOutboxPushHandshakeResult> {
  const now = options.now ?? new Date().toISOString();
  const syncClient = findSyncClient(options.controlState, options.syncClientId, now);
  const syncCapability = findSyncCapability(options.controlState, syncClient, now);
  const fetchImpl = options.fetchImpl ?? fetch;
  let cursor = options.cursor;
  let pushedBatches = 0;
  let pushedObjects = 0;
  let applied = 0;
  let skipped = 0;
  let conflicts = 0;
  const conflictSamples: ApplyPulledEnvelopeConflict[] = [];
  const acceptedFiles: string[] = [];

  const pendingCount = async () => (await queuedOutboxFiles(options.outboxDir)).length;
  const fail = async (
    reason: Extract<FileOutboxPushHandshakeResult, { ok: false }>["reason"],
    error?: unknown
  ): Promise<FileOutboxPushHandshakeResult> => ({
    ok: false,
    cursor,
    pushed_batches: pushedBatches,
    pushed_objects: pushedObjects,
    applied,
    skipped,
    conflicts,
    conflict_samples: conflictSamples,
    outbox_pending: await pendingCount(),
    accepted_files: acceptedFiles,
    reason,
    ...(error !== undefined ? { error } : {})
  });

  const pullRemoteThrough = async (latestGeneration: number): Promise<true | FileOutboxPushHandshakeResult> => {
    while (latestGeneration > cursor.generation) {
      const pulled = await fetchSyncEnvelopes({
        endpoint: options.endpoint,
        authorityId: options.controlState.authority_id,
        afterGeneration: cursor.generation,
        syncToken: options.syncToken,
        clientId: syncClient.client_id,
        capabilityId: syncCapability.capability_id,
        tokenId: options.tokenId,
        fetchImpl
      });
      if (!pulled.ok) {
        return fail("remote-status-failed", pulled.error);
      }

      const appliedResult = await applyPulledEnvelopes({
        store: options.store,
        response: pulled.response,
        actorId: syncClient.client_id
      });
      applied += appliedResult.applied_count;
      skipped += appliedResult.skipped_count;
      conflicts += appliedResult.conflict_count;
      conflictSamples.push(...appliedResult.conflicts.slice(0, Math.max(0, 10 - conflictSamples.length)));
      cursor = appliedResult.cursor;

      if (!appliedResult.ok) {
        return fail("remote-apply-conflict");
      }

      if (!pulled.response.has_more || pulled.response.next_cursor.generation <= cursor.generation) {
        break;
      }
    }
    return true;
  };

  const initialStatus = await fetchSyncStatus({
    endpoint: options.endpoint,
    syncToken: options.syncToken,
    clientId: syncClient.client_id,
    capabilityId: syncCapability.capability_id,
    tokenId: options.tokenId,
    fetchImpl
  });
  if (!initialStatus.ok) {
    return fail("remote-status-failed", initialStatus.error);
  }

  const initialPull = await pullRemoteThrough(initialStatus.status.latest_generation);
  if (initialPull !== true) {
    return initialPull;
  }

  const filePath = (await queuedOutboxFiles(options.outboxDir))[0];
  if (!filePath) {
    return {
      ok: true,
      cursor,
      pushed_batches: pushedBatches,
      pushed_objects: pushedObjects,
      applied,
      skipped,
      conflicts: 0,
      conflict_samples: [],
      outbox_pending: 0,
      accepted_files: acceptedFiles
    };
  }

  const objects = await readQueuedObjects(filePath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const status = await fetchSyncStatus({
      endpoint: options.endpoint,
      syncToken: options.syncToken,
      clientId: syncClient.client_id,
      capabilityId: syncCapability.capability_id,
      tokenId: options.tokenId,
      fetchImpl
    });
    if (!status.ok) {
      return fail("remote-status-failed", status.error);
    }

    const pull = await pullRemoteThrough(status.status.latest_generation);
    if (pull !== true) {
      return pull;
    }

    const targetGeneration = cursor.generation + 1;
    const built = buildCiphertextSyncBatch({
      controlState: options.controlState,
      graphObjects: objects,
      syncClientId: syncClient.client_id,
      tokenId: options.tokenId,
      baseGeneration: cursor.generation,
      targetGeneration,
      now
    });
    const submitted = await submitSyncBatch({
      endpoint: options.endpoint,
      batch: built.batch,
      syncToken: options.syncToken,
      fetchImpl
    });

    if (submitted.ok) {
      pushedBatches += 1;
      pushedObjects += submitted.accepted.accepted_objects;
      const acceptedPath = `${filePath}.accepted.g${submitted.accepted.target_generation}`;
      await rename(filePath, acceptedPath);
      acceptedFiles.push(acceptedPath);

      const confirmStatus = await fetchSyncStatus({
        endpoint: options.endpoint,
        syncToken: options.syncToken,
        clientId: syncClient.client_id,
        capabilityId: syncCapability.capability_id,
        tokenId: options.tokenId,
        fetchImpl
      });
      if (!confirmStatus.ok) {
        return fail("remote-status-failed", confirmStatus.error);
      }
      const confirmPull = await pullRemoteThrough(confirmStatus.status.latest_generation);
      if (confirmPull !== true) {
        return confirmPull;
      }

      return {
        ok: true,
        cursor,
        pushed_batches: pushedBatches,
        pushed_objects: pushedObjects,
        applied,
        skipped,
        conflicts: 0,
        conflict_samples: [],
        outbox_pending: await pendingCount(),
        accepted_files: acceptedFiles
      };
    }

    if (submitted.status !== 409 || attempt === 1) {
      return fail("push-failed", submitted.error);
    }
  }

  return fail("push-failed");
}

export class InMemorySyncOutbox {
  private readonly records = new Map<string, SyncOutboxRecord>();
  private latestAcceptedGeneration = 0;
  private latestAcceptedBatchId: string | undefined;

  enqueue(batch: SyncBatch, now: string): SyncOutboxRecord {
    const idempotencyKey = requireIdempotencyKey(batch);
    const existing = this.records.get(idempotencyKey);
    if (existing) {
      return existing;
    }

    const record: SyncOutboxRecord = {
      batch,
      status: "pending",
      enqueued_at: now
    };
    this.records.set(idempotencyKey, record);
    return record;
  }

  pending(): SyncOutboxRecord[] {
    return [...this.records.values()].filter((record) => record.status === "pending");
  }

  pendingCount(): number {
    return this.pending().length;
  }

  markAccepted(idempotencyKey: string, acceptedAt: string): void {
    const record = this.records.get(idempotencyKey);
    if (!record) {
      throw new Error(`Unknown sync outbox idempotency key: ${idempotencyKey}`);
    }

    record.status = "accepted";
    record.accepted_at = acceptedAt;
    this.latestAcceptedGeneration = Math.max(this.latestAcceptedGeneration, record.batch.target_generation);
    this.latestAcceptedBatchId = record.batch.batch_id;
  }

  cursor(authorityId: string): SyncPullCursor {
    return {
      authority_id: authorityId,
      generation: this.latestAcceptedGeneration,
      batch_id: this.latestAcceptedBatchId
    };
  }

  planFromStatus(status: SyncStatus): SyncStatusPlan {
    return planSyncFromStatus({
      localCursor: this.cursor(status.authority_id ?? "la_authority_unknown0001"),
      remoteStatus: status,
      pendingOutboxCount: this.pendingCount()
    });
  }
}

export class SyntheticLocalSyncDaemon {
  readonly outbox: InMemorySyncOutbox;

  private readonly controlState: LocalControlState;
  private readonly endpoint: string | undefined;
  private readonly syncToken: string | undefined;
  private readonly tokenId: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly syncClient: SyncClientRecord;
  private readonly syncCapability: SyncCapabilityRecord;

  constructor(options: SyntheticLocalSyncDaemonOptions) {
    this.controlState = options.controlState;
    this.endpoint = options.endpoint;
    this.syncToken = options.syncToken;
    this.tokenId = options.tokenId;
    this.fetchImpl = options.fetchImpl;
    this.outbox = options.outbox ?? new InMemorySyncOutbox();
    const now = options.now ?? new Date().toISOString();
    this.syncClient = findSyncClient(options.controlState, options.syncClientId, now);
    this.syncCapability = findSyncCapability(options.controlState, this.syncClient, now);
  }

  private assertSyncIdentityCurrent(now: string = new Date().toISOString()): void {
    findSyncClient(this.controlState, this.syncClient.client_id, now);
    findSyncCapability(this.controlState, this.syncClient, now);
  }

  queueCiphertextBatch(options: QueueCiphertextBatchOptions): QueueCiphertextBatchResult {
    this.assertSyncIdentityCurrent(options.now);
    const generations = this.resolveBatchGenerations(options);
    const result = buildCiphertextSyncBatch({
      controlState: this.controlState,
      graphObjects: options.graphObjects,
      syncClientId: this.syncClient.client_id,
      tokenId: this.tokenId,
      baseGeneration: generations.base_generation,
      targetGeneration: generations.target_generation,
      now: options.now
    });
    const record = this.outbox.enqueue(result.batch, options.now);

    return {
      ...result,
      record
    };
  }

  async submitNextPending(options: SubmitNextPendingOptions = {}): Promise<SubmitNextPendingResult> {
    this.assertSyncIdentityCurrent(options.now ?? options.acceptedAt);
    const record = this.outbox.pending()[0];
    if (!record) {
      return {
        ok: true,
        submitted: false,
        reason: "empty-outbox"
      };
    }

    const result = await submitSyncBatch({
      endpoint: requireDaemonEndpoint(this.endpoint),
      batch: record.batch,
      syncToken: this.syncToken,
      fetchImpl: requireInjectedFetch(this.fetchImpl)
    });

    if (!result.ok) {
      return {
        ok: false,
        submitted: true,
        record,
        status: result.status,
        error: result.error
      };
    }

    this.outbox.markAccepted(record.batch.idempotency_key, options.acceptedAt ?? record.batch.submitted_at);

    return {
      ok: true,
      submitted: true,
      record,
      accepted: result.accepted
    };
  }

	  async fetchRemoteStatus(): Promise<FetchSyncStatusResult> {
	    this.assertSyncIdentityCurrent();
	    return fetchSyncStatus({
      endpoint: requireDaemonEndpoint(this.endpoint),
      syncToken: this.syncToken,
      clientId: this.syncClient.client_id,
      capabilityId: this.syncCapability.capability_id,
      tokenId: this.tokenId,
      fetchImpl: requireInjectedFetch(this.fetchImpl)
    });
  }

  planFromStatus(status: SyncStatus): SyncStatusPlan {
    return planSyncFromStatus({
      localCursor: this.outbox.cursor(status.authority_id ?? this.controlState.authority_id),
      remoteStatus: status,
      pendingOutboxCount: this.outbox.pendingCount()
    });
  }

  async planFromRemoteStatus(): Promise<SyncDaemonPlanResult> {
    const status = await this.fetchRemoteStatus();
    if (!status.ok) {
      return status;
    }

    return {
      ok: true,
      status: status.status,
      plan: this.planFromStatus(status.status)
    };
  }

	  async fetchPlannedPull(planResult: Extract<SyncDaemonPlanResult, { ok: true }>): Promise<FetchPlannedPullResult> {
	    this.assertSyncIdentityCurrent();
	    if (planResult.plan.action !== "pull") {
      return {
        ok: true,
        skipped: true,
        reason: "plan-does-not-pull",
        plan: planResult.plan
      };
    }

    const result = await fetchSyncPull({
      endpoint: requireDaemonEndpoint(this.endpoint),
      authorityId: planResult.status.authority_id ?? this.controlState.authority_id,
      afterGeneration: planResult.plan.pull_after_generation,
      syncToken: this.syncToken,
      clientId: this.syncClient.client_id,
      capabilityId: this.syncCapability.capability_id,
      tokenId: this.tokenId,
      fetchImpl: requireInjectedFetch(this.fetchImpl)
    });

    if (!result.ok) {
      return {
        ok: false,
        skipped: false,
        plan: planResult.plan,
        status_code: result.status_code,
        error: result.error
      };
    }

    return {
      ok: true,
      skipped: false,
      plan: planResult.plan,
      response: result.response
    };
  }

  private resolveBatchGenerations(options: QueueCiphertextBatchOptions): NextSyncGeneration {
    const hasBase = options.baseGeneration !== undefined;
    const hasTarget = options.targetGeneration !== undefined;

    if (hasBase || hasTarget) {
      if (!hasBase || !hasTarget) {
        throw new Error("Queueing a sync batch requires both baseGeneration and targetGeneration when either is provided");
      }

      return {
        base_generation: options.baseGeneration!,
        target_generation: options.targetGeneration!
      };
    }

    if (options.remoteStatus) {
      return nextSyncGenerationFromStatus(options.remoteStatus);
    }

    const localCursor = this.outbox.cursor(this.controlState.authority_id);
    return {
      base_generation: localCursor.generation,
      target_generation: localCursor.generation + 1
    };
  }
}
