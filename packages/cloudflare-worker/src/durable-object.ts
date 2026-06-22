import { DurableObject } from "cloudflare:workers";
import { BootstrapClaimLockCore, type BootstrapClaimLockStorage } from "./bootstrap-lock";
import type { BootstrapClaimRecord, BootstrapRuntimeConfig } from "./bootstrap";
import type { BootstrapWorkerEnv } from "./worker";
import {
  SyncAuthoritySequencerCore,
  type SyncAuthoritySequencerStorage,
  type SyncAuthorityStateRecord,
  type SyncBatchSequenceRecord,
  type SyncBatchSequenceSummary
} from "./sync-sequencer";
import { acceptSyncBatch, type SyncBatchAcceptResult, type SyncRuntimeConfig, type SyncTokenBinding } from "./sync";

class DurableObjectStorageAdapter implements BootstrapClaimLockStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async getClaimRecord(): Promise<BootstrapClaimRecord | undefined> {
    return this.storage.get<BootstrapClaimRecord>("bootstrap_claim_record");
  }

  async putClaimRecord(record: BootstrapClaimRecord): Promise<void> {
    await this.storage.put("bootstrap_claim_record", record);
  }
}

export class BootstrapClaimLock extends DurableObject<BootstrapWorkerEnv> {
  private readonly core: BootstrapClaimLockCore;

  constructor(ctx: DurableObjectState, env: BootstrapWorkerEnv) {
    super(ctx, env);
    this.core = new BootstrapClaimLockCore(new DurableObjectStorageAdapter(ctx.storage));
  }

  async getStatus(config: BootstrapRuntimeConfig) {
    return this.core.getStatus(config);
  }

  async claim(input: unknown, token: string | undefined, config: BootstrapRuntimeConfig, nowIso: string) {
    return this.core.claim(input, token, config, nowIso);
  }
}

type SyncAuthorityStateRow = {
  authority_id: string;
  latest_generation: number;
  latest_batch_id: string | null;
  latest_submitted_at: string | null;
  latest_withheld_plaintext_count: number;
  updated_at: string;
};

type SyncBatchSequenceRow = {
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
  state: "staged" | "committed";
  staged_at: string;
  committed_at: string | null;
  last_seen_at: string;
};

const SyncSequencerSchemaSql = [
  `CREATE TABLE IF NOT EXISTS sync_authority_state (
    authority_id TEXT PRIMARY KEY,
    latest_generation INTEGER NOT NULL,
    latest_batch_id TEXT,
    latest_submitted_at TEXT,
    latest_withheld_plaintext_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sync_authority_batches (
    batch_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    batch_hash TEXT NOT NULL,
    authority_id TEXT NOT NULL,
    batch_fingerprint TEXT NOT NULL,
    base_generation INTEGER NOT NULL,
    target_generation INTEGER NOT NULL,
    submitted_at TEXT NOT NULL,
    object_count INTEGER NOT NULL,
    change_count INTEGER NOT NULL,
    withheld_plaintext_count INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('staged', 'committed')),
    staged_at TEXT NOT NULL,
    committed_at TEXT,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_authority_batches_generation
    ON sync_authority_batches (authority_id, target_generation)`,
  `CREATE INDEX IF NOT EXISTS idx_sync_authority_batches_staged
    ON sync_authority_batches (authority_id, state, staged_at)`
];

function stateFromRow(row: SyncAuthorityStateRow): SyncAuthorityStateRecord {
  return {
    authority_id: row.authority_id,
    latest_generation: row.latest_generation,
    latest_batch_id: row.latest_batch_id ?? undefined,
    latest_submitted_at: row.latest_submitted_at ?? undefined,
    latest_withheld_plaintext_count: row.latest_withheld_plaintext_count,
    updated_at: row.updated_at
  };
}

function batchFromRow(row: SyncBatchSequenceRow): SyncBatchSequenceRecord {
  return {
    batch_id: row.batch_id,
    idempotency_key: row.idempotency_key,
    batch_hash: row.batch_hash,
    authority_id: row.authority_id,
    batch_fingerprint: row.batch_fingerprint,
    base_generation: row.base_generation,
    target_generation: row.target_generation,
    submitted_at: row.submitted_at,
    object_count: row.object_count,
    change_count: row.change_count,
    withheld_plaintext_count: row.withheld_plaintext_count,
    state: row.state,
    staged_at: row.staged_at,
    committed_at: row.committed_at ?? undefined,
    last_seen_at: row.last_seen_at
  };
}

class DurableObjectSyncAuthoritySequencerStorage implements SyncAuthoritySequencerStorage {
  constructor(private readonly sql: SqlStorage) {}

  getAuthorityState(authorityId: string): Promise<SyncAuthorityStateRecord | undefined> {
    const row = this.sql.exec<SyncAuthorityStateRow>(`
SELECT
  authority_id,
  latest_generation,
  latest_batch_id,
  latest_submitted_at,
  latest_withheld_plaintext_count,
  updated_at
FROM sync_authority_state
WHERE authority_id = ?`, authorityId).toArray()[0];
    return Promise.resolve(row ? stateFromRow(row) : undefined);
  }

  getBatchById(batchId: string): Promise<SyncBatchSequenceRecord | undefined> {
    const row = this.sql.exec<SyncBatchSequenceRow>(`
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  authority_id,
  batch_fingerprint,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count,
  state,
  staged_at,
  committed_at,
  last_seen_at
FROM sync_authority_batches
WHERE batch_id = ?`, batchId).toArray()[0];
    return Promise.resolve(row ? batchFromRow(row) : undefined);
  }

  getBatchByIdempotencyKey(idempotencyKey: string): Promise<SyncBatchSequenceRecord | undefined> {
    const row = this.sql.exec<SyncBatchSequenceRow>(`
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  authority_id,
  batch_fingerprint,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count,
  state,
  staged_at,
  committed_at,
  last_seen_at
FROM sync_authority_batches
WHERE idempotency_key = ?`, idempotencyKey).toArray()[0];
    return Promise.resolve(row ? batchFromRow(row) : undefined);
  }

  getBatchByGeneration(authorityId: string, targetGeneration: number): Promise<SyncBatchSequenceRecord | undefined> {
    const row = this.sql.exec<SyncBatchSequenceRow>(`
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  authority_id,
  batch_fingerprint,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count,
  state,
  staged_at,
  committed_at,
  last_seen_at
FROM sync_authority_batches
WHERE authority_id = ? AND target_generation = ?`, authorityId, targetGeneration).toArray()[0];
    return Promise.resolve(row ? batchFromRow(row) : undefined);
  }

  getStagedBatch(authorityId: string): Promise<SyncBatchSequenceRecord | undefined> {
    const row = this.sql.exec<SyncBatchSequenceRow>(`
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  authority_id,
  batch_fingerprint,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count,
  state,
  staged_at,
  committed_at,
  last_seen_at
FROM sync_authority_batches
WHERE authority_id = ? AND state = 'staged'
ORDER BY staged_at ASC
LIMIT 1`, authorityId).toArray()[0];
    return Promise.resolve(row ? batchFromRow(row) : undefined);
  }

  putStagedBatch(record: SyncBatchSequenceRecord): Promise<void> {
    this.sql.exec(`
INSERT INTO sync_authority_batches (
  batch_id,
  idempotency_key,
  batch_hash,
  authority_id,
  batch_fingerprint,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count,
  state,
  staged_at,
  committed_at,
  last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, NULL, ?)
ON CONFLICT(batch_id) DO UPDATE SET
  last_seen_at = excluded.last_seen_at
WHERE sync_authority_batches.batch_fingerprint = excluded.batch_fingerprint`,
      record.batch_id,
      record.idempotency_key,
      record.batch_hash,
      record.authority_id,
      record.batch_fingerprint,
      record.base_generation,
      record.target_generation,
      record.submitted_at,
      record.object_count,
      record.change_count,
      record.withheld_plaintext_count,
      record.staged_at,
      record.last_seen_at
    );
    return Promise.resolve();
  }

  markBatchCommitted(summary: SyncBatchSequenceSummary, committedAt: string): Promise<void> {
    this.sql.exec(`
UPDATE sync_authority_batches
SET
  state = 'committed',
  committed_at = COALESCE(committed_at, ?),
  last_seen_at = ?
WHERE batch_id = ? AND batch_fingerprint = ?`,
      committedAt,
      committedAt,
      summary.batch_id,
      summary.batch_fingerprint
    );
    this.sql.exec(`
INSERT INTO sync_authority_state (
  authority_id,
  latest_generation,
  latest_batch_id,
  latest_submitted_at,
  latest_withheld_plaintext_count,
  updated_at
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(authority_id) DO UPDATE SET
  latest_generation = excluded.latest_generation,
  latest_batch_id = excluded.latest_batch_id,
  latest_submitted_at = excluded.latest_submitted_at,
  latest_withheld_plaintext_count = excluded.latest_withheld_plaintext_count,
  updated_at = excluded.updated_at`,
      summary.authority_id,
      summary.target_generation,
      summary.batch_id,
      summary.submitted_at,
      summary.withheld_plaintext_count,
      committedAt
    );
    return Promise.resolve();
  }
}

export class SyncAuthoritySequencer extends DurableObject<BootstrapWorkerEnv> {
  private readonly core: SyncAuthoritySequencerCore;

  constructor(ctx: DurableObjectState, env: BootstrapWorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      for (const statement of SyncSequencerSchemaSql) {
        ctx.storage.sql.exec(statement);
      }
    });
    this.core = new SyncAuthoritySequencerCore(new DurableObjectSyncAuthoritySequencerStorage(ctx.storage.sql));
  }

  async stageBatch(summary: SyncBatchSequenceSummary, nowIso: string) {
    return this.core.stageBatch(summary, nowIso);
  }

  async commitBatch(summary: SyncBatchSequenceSummary, nowIso: string) {
    return this.core.commitBatch(summary, nowIso);
  }

  async acceptBatch(
    input: unknown,
    token: string | undefined,
    config: SyncRuntimeConfig,
    binding?: SyncTokenBinding
  ): Promise<SyncBatchAcceptResult> {
    return acceptSyncBatch(input, token, config, {
      graphBucket: this.env.LA_GRAPH_BUCKET,
      controlDb: this.env.LA_CONTROL_DB,
      sequencer: this.core
    }, binding);
  }
}

export class SyncSequencer extends SyncAuthoritySequencer {}
