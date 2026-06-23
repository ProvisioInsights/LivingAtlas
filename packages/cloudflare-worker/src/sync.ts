import {
  canonicalSyncBatchHashPayload,
  SyncBatchAcceptedSchema,
  SyncBatchSchema,
  type SyncBatch,
  type SyncBatchAccepted,
  type SyncEnvelopePullResponse,
  type SyncPullResponse,
  type SyncStatus
} from "@living-atlas/contracts";
import { verifyClaimToken } from "./bootstrap";
import {
  persistSyncBatch,
  readCommittedBatchByIdempotency,
  readSyncEnvelopePull,
  readSyncPull,
  readSyncStatus,
  validateSyncBatchStorageRefs,
  type CommittedSyncBatch,
  type SyncMetadataStore,
  type SyncStorageBindings
} from "./sync-storage";
import { summarizeSyncBatch, type SyncAuthoritySequencerRpc } from "./sync-sequencer";

export type SyncRuntimeConfig = {
  sync_token_hash?: string;
  sync_client_id?: string;
  sync_capability_id?: string;
  sync_token_id?: string;
  authority_id?: string;
};

export type SyncTokenBinding = {
  client_id?: string;
  capability_id?: string;
  token_id?: string;
};

export type SyncAcceptanceStorageBindings = SyncStorageBindings & {
  sequencer?: SyncAuthoritySequencerRpc;
};

export type SyncBatchAcceptResult =
  | {
      ok: true;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      reason:
        | "sync-disabled"
        | "missing-token"
        | "invalid-token"
        | "malformed-batch"
        | "batch-hash-mismatch"
        | "invalid-token-binding"
        | "idempotency-conflict"
        | "stale-generation"
        | "generation-gap"
        | "batch-in-flight"
        | "batch-conflict";
      status?: SyncStatus;
    };

export type SyncStatusReadResult =
  | {
      ok: true;
      status: SyncStatus;
    }
  | {
      ok: false;
      reason: "sync-disabled" | "missing-token" | "invalid-token" | "invalid-token-binding";
    };

export type SyncPullReadResult =
  | {
      ok: true;
      response: SyncPullResponse;
    }
  | {
      ok: false;
      reason: "sync-disabled" | "missing-token" | "invalid-token" | "invalid-token-binding" | "invalid-pull-request";
    };

export type SyncEnvelopePullReadResult =
  | {
      ok: true;
      response: SyncEnvelopePullResponse;
    }
  | {
      ok: false;
      reason: "sync-disabled" | "missing-token" | "invalid-token" | "invalid-token-binding" | "invalid-pull-request";
    };

type SyncTokenFailure = {
  ok: false;
  reason: "sync-disabled" | "missing-token" | "invalid-token" | "invalid-token-binding";
};

async function verifySyncToken(
  token: string | undefined,
  config: SyncRuntimeConfig,
  binding?: SyncTokenBinding,
  authorityId?: string
): Promise<SyncTokenFailure | undefined> {
  if (!config.sync_token_hash) {
    return { ok: false, reason: "sync-disabled" };
  }

  if (!token) {
    return { ok: false, reason: "missing-token" };
  }

  if (!(await verifyClaimToken(token, config.sync_token_hash))) {
    return { ok: false, reason: "invalid-token" };
  }

  if (config.sync_client_id && binding?.client_id !== config.sync_client_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  if (config.sync_capability_id && binding?.capability_id !== config.sync_capability_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  if (config.sync_token_id && binding?.token_id !== config.sync_token_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  if (config.authority_id && authorityId !== config.authority_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  return undefined;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${toHex(new Uint8Array(digest))}`;
}

async function syncBatchHash(batch: SyncBatch): Promise<string> {
  const { batch_hash: _batchHash, ...batchWithoutHash } = batch;
  return sha256(canonicalSyncBatchHashPayload(batchWithoutHash));
}

function acceptedFromBatch(batch: SyncBatch, replay = false): SyncBatchAccepted {
  return SyncBatchAcceptedSchema.parse({
    ok: true,
    batch_id: batch.batch_id,
    accepted_objects: batch.objects.length,
    accepted_changes: batch.changes.length,
    target_generation: batch.target_generation,
    withheld_plaintext_count: batch.withheld_plaintext_count,
    idempotent_replay: replay
  });
}

function acceptedFromCommitted(batch: CommittedSyncBatch): SyncBatchAccepted {
  return SyncBatchAcceptedSchema.parse({
    ok: true,
    batch_id: batch.batch_id,
    accepted_objects: batch.object_count,
    accepted_changes: batch.change_count,
    target_generation: batch.target_generation,
    withheld_plaintext_count: batch.withheld_plaintext_count,
    idempotent_replay: true
  });
}

function sequencerReason(
  reason: "stale-generation" | "generation-gap" | "batch-in-flight" | "batch-conflict" | "unknown-batch"
): "stale-generation" | "generation-gap" | "batch-in-flight" | "batch-conflict" {
  return reason === "unknown-batch" ? "batch-in-flight" : reason;
}

export async function acceptSyncBatch(
  input: unknown,
  token: string | undefined,
  config: SyncRuntimeConfig,
  storage?: SyncAcceptanceStorageBindings,
  binding?: SyncTokenBinding
): Promise<SyncBatchAcceptResult> {
  const parsed = SyncBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "malformed-batch" };
  }

  if (binding?.client_id && binding.client_id !== parsed.data.client_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  if (binding?.capability_id && binding.capability_id !== parsed.data.capability_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  if (binding?.token_id && parsed.data.token_id && binding.token_id !== parsed.data.token_id) {
    return { ok: false, reason: "invalid-token-binding" };
  }

  const tokenFailure = await verifySyncToken(token, config, {
    client_id: parsed.data.client_id,
    capability_id: parsed.data.capability_id,
    token_id: parsed.data.token_id ?? binding?.token_id
  }, parsed.data.authority_id);
  if (tokenFailure) {
    return tokenFailure;
  }

  if (parsed.data.batch_hash !== await syncBatchHash(parsed.data)) {
    return { ok: false, reason: "batch-hash-mismatch" };
  }

  await validateSyncBatchStorageRefs(parsed.data);

  if (storage) {
    const committed = await readCommittedBatchByIdempotency(storage.controlDb, parsed.data.idempotency_key, parsed.data.authority_id);
    if (committed) {
      if (committed.batch_hash !== parsed.data.batch_hash) {
        return { ok: false, reason: "idempotency-conflict", status: await readSyncStatus(storage.controlDb, parsed.data.authority_id) };
      }

      return {
        ok: true,
        accepted: acceptedFromCommitted(committed)
      };
    }

    const summary = await summarizeSyncBatch(parsed.data);
    if (storage.sequencer) {
      const stagedAt = new Date().toISOString();
      const stage = await storage.sequencer.stageBatch(summary, stagedAt);
      if (!stage.ok) {
        return { ok: false, reason: sequencerReason(stage.reason), status: await readSyncStatus(storage.controlDb, parsed.data.authority_id) };
      }

      if (!stage.should_persist) {
        return {
          ok: true,
          accepted: stage.accepted
        };
      }

      const committedAt = new Date().toISOString();
      const commit = await storage.sequencer.commitBatch(summary, committedAt);
      if (!commit.ok) {
        return { ok: false, reason: sequencerReason(commit.reason), status: await readSyncStatus(storage.controlDb, parsed.data.authority_id) };
      }

      await persistSyncBatch(parsed.data, storage, { summary, staged_at: stagedAt, committed_at: committedAt });

      return {
        ok: true,
        accepted: commit.accepted
      };
    }

    const currentStatus = await readSyncStatus(storage.controlDb, parsed.data.authority_id);
    if (parsed.data.base_generation < currentStatus.latest_generation) {
      return { ok: false, reason: "stale-generation", status: currentStatus };
    }

    if (parsed.data.base_generation > currentStatus.latest_generation) {
      return { ok: false, reason: "generation-gap", status: currentStatus };
    }

    await persistSyncBatch(parsed.data, storage, { summary });
  }

  return {
    ok: true,
    accepted: acceptedFromBatch(parsed.data)
  };
}

export async function getSyncStatus(
  token: string | undefined,
  config: SyncRuntimeConfig,
  controlDb: SyncMetadataStore,
  binding?: SyncTokenBinding
): Promise<SyncStatusReadResult> {
  const tokenFailure = await verifySyncToken(token, config, binding, config.authority_id);
  if (tokenFailure) {
    return tokenFailure;
  }

  return {
    ok: true,
    status: await readSyncStatus(controlDb, config.authority_id)
  };
}

export async function getSyncPull(
  token: string | undefined,
  config: SyncRuntimeConfig,
  controlDb: SyncMetadataStore,
  authorityId: string | undefined,
  afterGeneration: number | undefined,
  limit?: number,
  binding?: SyncTokenBinding
): Promise<SyncPullReadResult> {
  const tokenFailure = await verifySyncToken(token, config, binding, authorityId);
  if (tokenFailure) {
    return tokenFailure;
  }

  if (
    !authorityId
    || afterGeneration === undefined
    || !Number.isInteger(afterGeneration)
    || afterGeneration < 0
    || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
  ) {
    return { ok: false, reason: "invalid-pull-request" };
  }

  return {
    ok: true,
    response: await readSyncPull(controlDb, authorityId, afterGeneration, limit)
  };
}

export async function getSyncEnvelopePull(
  token: string | undefined,
  config: SyncRuntimeConfig,
  storage: SyncStorageBindings,
  authorityId: string | undefined,
  afterGeneration: number | undefined,
  limit?: number,
  binding?: SyncTokenBinding
): Promise<SyncEnvelopePullReadResult> {
  const tokenFailure = await verifySyncToken(token, config, binding, authorityId);
  if (tokenFailure) {
    return tokenFailure;
  }

  if (
    !authorityId
    || afterGeneration === undefined
    || !Number.isInteger(afterGeneration)
    || afterGeneration < 0
    || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
  ) {
    return { ok: false, reason: "invalid-pull-request" };
  }

  return {
    ok: true,
    response: await readSyncEnvelopePull(storage, authorityId, afterGeneration, limit)
  };
}
