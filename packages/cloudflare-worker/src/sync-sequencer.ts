import { SyncBatchAcceptedSchema, type SyncBatch, type SyncBatchAccepted } from "@living-atlas/contracts";

export type SyncBatchSequenceState = "staged" | "committed";

export type SyncBatchSequenceSummary = {
  batch_id: string;
  idempotency_key: string;
  batch_hash: string;
  authority_id: string;
  batch_fingerprint: string;
  base_generation: number;
  target_generation: number;
  submitted_at: string;
  object_count: number;
  change_count: number;
  withheld_plaintext_count: number;
};

export type SyncBatchSequenceRecord = SyncBatchSequenceSummary & {
  state: SyncBatchSequenceState;
  staged_at: string;
  committed_at?: string;
  last_seen_at: string;
};

export type SyncAuthorityStateRecord = {
  authority_id: string;
  latest_generation: number;
  latest_batch_id?: string;
  latest_submitted_at?: string;
  latest_withheld_plaintext_count: number;
  updated_at: string;
};

export type SyncBatchStageResult =
  | {
      ok: true;
      state: SyncBatchSequenceState;
      should_persist: boolean;
      duplicate: boolean;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      reason: "stale-generation" | "generation-gap" | "batch-in-flight" | "batch-conflict";
    };

export type SyncBatchCommitResult =
  | {
      ok: true;
      duplicate: boolean;
      accepted: SyncBatchAccepted;
    }
  | {
      ok: false;
      reason: "unknown-batch" | "stale-generation" | "generation-gap" | "batch-conflict";
    };

export type SyncAuthoritySequencerStorage = {
  getAuthorityState(authorityId: string): Promise<SyncAuthorityStateRecord | undefined>;
  getBatchById(batchId: string): Promise<SyncBatchSequenceRecord | undefined>;
  getBatchByIdempotencyKey(idempotencyKey: string): Promise<SyncBatchSequenceRecord | undefined>;
  getBatchByGeneration(authorityId: string, targetGeneration: number): Promise<SyncBatchSequenceRecord | undefined>;
  getStagedBatch(authorityId: string): Promise<SyncBatchSequenceRecord | undefined>;
  putStagedBatch(record: SyncBatchSequenceRecord): Promise<void>;
  markBatchCommitted(summary: SyncBatchSequenceSummary, committedAt: string): Promise<void>;
};

export type SyncAuthoritySequencerRpc = Pick<SyncAuthoritySequencerCore, "stageBatch" | "commitBatch">;

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }

  return value;
}

export async function authoritySequencerName(authorityId: string): Promise<string> {
  return `authority-${(await sha256Hex(`living-atlas:authority:${authorityId}`)).slice(0, 32)}`;
}

export async function summarizeSyncBatch(batch: SyncBatch): Promise<SyncBatchSequenceSummary> {
  return {
    batch_id: batch.batch_id,
    idempotency_key: batch.idempotency_key,
    batch_hash: batch.batch_hash,
    authority_id: batch.authority_id,
    batch_fingerprint: batch.batch_hash,
    base_generation: batch.base_generation,
    target_generation: batch.target_generation,
    submitted_at: batch.submitted_at,
    object_count: batch.objects.length,
    change_count: batch.changes.length,
    withheld_plaintext_count: batch.withheld_plaintext_count
  };
}

function acceptedFromSummary(summary: SyncBatchSequenceSummary, replay = false): SyncBatchAccepted {
  return SyncBatchAcceptedSchema.parse({
    ok: true,
    batch_id: summary.batch_id,
    accepted_objects: summary.object_count,
    accepted_changes: summary.change_count,
    target_generation: summary.target_generation,
    withheld_plaintext_count: summary.withheld_plaintext_count,
    idempotent_replay: replay
  });
}

function emptyAuthorityState(authorityId: string, nowIso: string): SyncAuthorityStateRecord {
  return {
    authority_id: authorityId,
    latest_generation: 0,
    latest_withheld_plaintext_count: 0,
    updated_at: nowIso
  };
}

function cloneBatch(record: SyncBatchSequenceRecord): SyncBatchSequenceRecord {
  return {
    ...record
  };
}

function cloneState(record: SyncAuthorityStateRecord): SyncAuthorityStateRecord {
  return {
    ...record
  };
}

export class SyncAuthoritySequencerCore {
  constructor(private readonly storage: SyncAuthoritySequencerStorage) {}

  async stageBatch(summary: SyncBatchSequenceSummary, nowIso: string): Promise<SyncBatchStageResult> {
    const accepted = acceptedFromSummary(summary);
    const existingById = await this.storage.getBatchById(summary.batch_id);
    if (existingById) {
      if (existingById.batch_fingerprint !== summary.batch_fingerprint) {
        return { ok: false, reason: "batch-conflict" };
      }

      return {
        ok: true,
        state: existingById.state,
        should_persist: existingById.state === "staged",
        duplicate: true,
        accepted: acceptedFromSummary(summary, true)
      };
    }

    const existingByIdempotency = await this.storage.getBatchByIdempotencyKey(summary.idempotency_key);
    if (existingByIdempotency) {
      if (existingByIdempotency.batch_fingerprint !== summary.batch_fingerprint) {
        return { ok: false, reason: "batch-conflict" };
      }

      return {
        ok: true,
        state: existingByIdempotency.state,
        should_persist: existingByIdempotency.state === "staged",
        duplicate: true,
        accepted: acceptedFromSummary(summary, true)
      };
    }

    const state = (await this.storage.getAuthorityState(summary.authority_id)) ?? emptyAuthorityState(summary.authority_id, nowIso);
    if (summary.base_generation < state.latest_generation) {
      return { ok: false, reason: "stale-generation" };
    }

    if (summary.base_generation > state.latest_generation) {
      return { ok: false, reason: "generation-gap" };
    }

    const staged = await this.storage.getStagedBatch(summary.authority_id);
    if (staged) {
      return { ok: false, reason: staged.target_generation === summary.target_generation ? "batch-in-flight" : "generation-gap" };
    }

    const existingByGeneration = await this.storage.getBatchByGeneration(summary.authority_id, summary.target_generation);
    if (existingByGeneration) {
      return { ok: false, reason: existingByGeneration.state === "staged" ? "batch-in-flight" : "batch-conflict" };
    }

    await this.storage.putStagedBatch({
      ...summary,
      state: "staged",
      staged_at: nowIso,
      last_seen_at: nowIso
    });

    return {
      ok: true,
      state: "staged",
      should_persist: true,
      duplicate: false,
      accepted
    };
  }

  async commitBatch(summary: SyncBatchSequenceSummary, nowIso: string): Promise<SyncBatchCommitResult> {
    const accepted = acceptedFromSummary(summary);
    const existing = await this.storage.getBatchById(summary.batch_id);
    if (!existing) {
      return { ok: false, reason: "unknown-batch" };
    }

    if (existing.batch_fingerprint !== summary.batch_fingerprint) {
      return { ok: false, reason: "batch-conflict" };
    }

    if (existing.state === "committed") {
      return {
        ok: true,
        duplicate: true,
        accepted: acceptedFromSummary(summary, true)
      };
    }

    const state = (await this.storage.getAuthorityState(summary.authority_id)) ?? emptyAuthorityState(summary.authority_id, nowIso);
    if (summary.base_generation < state.latest_generation) {
      return { ok: false, reason: "stale-generation" };
    }

    if (summary.base_generation > state.latest_generation) {
      return { ok: false, reason: "generation-gap" };
    }

    await this.storage.markBatchCommitted(summary, nowIso);
    return {
      ok: true,
      duplicate: false,
      accepted
    };
  }
}

export class InMemorySyncAuthoritySequencerStorage implements SyncAuthoritySequencerStorage {
  private readonly authorityStates = new Map<string, SyncAuthorityStateRecord>();
  private readonly batchesById = new Map<string, SyncBatchSequenceRecord>();

  async getAuthorityState(authorityId: string): Promise<SyncAuthorityStateRecord | undefined> {
    const record = this.authorityStates.get(authorityId);
    return record ? cloneState(record) : undefined;
  }

  async getBatchById(batchId: string): Promise<SyncBatchSequenceRecord | undefined> {
    const record = this.batchesById.get(batchId);
    return record ? cloneBatch(record) : undefined;
  }

  async getBatchByIdempotencyKey(idempotencyKey: string): Promise<SyncBatchSequenceRecord | undefined> {
    for (const record of this.batchesById.values()) {
      if (record.idempotency_key === idempotencyKey) {
        return cloneBatch(record);
      }
    }

    return undefined;
  }

  async getBatchByGeneration(authorityId: string, targetGeneration: number): Promise<SyncBatchSequenceRecord | undefined> {
    for (const record of this.batchesById.values()) {
      if (record.authority_id === authorityId && record.target_generation === targetGeneration) {
        return cloneBatch(record);
      }
    }

    return undefined;
  }

  async getStagedBatch(authorityId: string): Promise<SyncBatchSequenceRecord | undefined> {
    for (const record of this.batchesById.values()) {
      if (record.authority_id === authorityId && record.state === "staged") {
        return cloneBatch(record);
      }
    }

    return undefined;
  }

  async putStagedBatch(record: SyncBatchSequenceRecord): Promise<void> {
    this.batchesById.set(record.batch_id, cloneBatch(record));
  }

  async markBatchCommitted(summary: SyncBatchSequenceSummary, committedAt: string): Promise<void> {
    const existing = this.batchesById.get(summary.batch_id);
    if (!existing) {
      return;
    }

    this.batchesById.set(summary.batch_id, {
      ...existing,
      state: "committed",
      committed_at: existing.committed_at ?? committedAt,
      last_seen_at: committedAt
    });
    this.authorityStates.set(summary.authority_id, {
      authority_id: summary.authority_id,
      latest_generation: summary.target_generation,
      latest_batch_id: summary.batch_id,
      latest_submitted_at: summary.submitted_at,
      latest_withheld_plaintext_count: summary.withheld_plaintext_count,
      updated_at: committedAt
    });
  }
}
