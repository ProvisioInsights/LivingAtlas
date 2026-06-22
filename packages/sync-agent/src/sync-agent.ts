import { createHash } from "node:crypto";
import {
  canonicalSyncBatchHashPayload,
  SyncBatchAcceptedSchema,
  SyncBatchSchema,
  SyncPullResponseSchema,
  SyncStatusSchema,
  type ClientRecord,
  type GraphObjectEnvelope,
  type LocalControlState,
  type SyncBatch,
  type SyncBatchAccepted,
  type SyncChangeEvent,
  type SyncPullCursor,
  type SyncPullRecovery,
  type SyncPullResponse,
  type SyncStatus
} from "@living-atlas/contracts";
import { syntheticGraphObjects } from "@living-atlas/fixtures";
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
};

export type SubmitNextPendingOptions = {
  acceptedAt?: string;
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

function findSyncClient(controlState: LocalControlState, syncClientId: string | undefined): SyncClientRecord {
  const client = controlState.control_plane.clients.find((candidate) => (
    syncClientId ? candidate.client_id === syncClientId : candidate.allowed_profile === "sync-device"
  ));

  if (!client || client.allowed_profile !== "sync-device") {
    throw new Error("No sync-device client is available in the local control state");
  }

  if (client.revoked_at) {
    throw new Error("Sync-device client is revoked");
  }

  if (!client.device_id) {
    throw new Error("Sync-device client must be bound to a local device");
  }

  return {
    ...client,
    device_id: client.device_id
  };
}

function findSyncCapability(controlState: LocalControlState, syncClient: SyncClientRecord): SyncCapabilityRecord {
  const capability = controlState.control_plane.capabilities.find((candidate) => (
    candidate.client_id === syncClient.client_id && candidate.profile === "sync-device"
  ));

  if (!capability) {
    throw new Error("No sync-device capability is available for the sync client");
  }

  if (capability.revoked_at) {
    throw new Error("Sync-device capability is revoked");
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
  const syncClient = findSyncClient(options.controlState, options.syncClientId);
  const capability = findSyncCapability(options.controlState, syncClient);

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
    this.syncClient = findSyncClient(options.controlState, options.syncClientId);
    this.syncCapability = findSyncCapability(options.controlState, this.syncClient);
  }

  queueCiphertextBatch(options: QueueCiphertextBatchOptions): QueueCiphertextBatchResult {
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
