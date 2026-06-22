import {
  SyncPullResponseSchema,
  SyncStatusSchema,
  type GraphObjectEnvelope,
  type SyncBatch,
  type SyncPullResponse,
  type SyncStatus
} from "@living-atlas/contracts";
import { summarizeSyncBatch, type SyncBatchSequenceSummary } from "./sync-sequencer";

export type SyncObjectStore = {
  put(
    key: string,
    value: string,
    options?: {
      httpMetadata?: {
        contentType?: string;
      };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
};

type RunnableStatement = {
  run(): Promise<unknown>;
};

type BindableStatement = {
  bind(...values: unknown[]): BindableStatement;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all?<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type SyncMetadataStore = {
  prepare(query: string): BindableStatement;
};

export type SyncStorageBindings = {
  graphBucket: SyncObjectStore;
  controlDb: SyncMetadataStore;
};

export type StoredSyncBatch = {
  stored_envelope_count: number;
};

export type PersistSyncBatchOptions = {
  summary?: SyncBatchSequenceSummary;
  staged_at?: string;
  committed_at?: string;
};

export type CommittedSyncBatch = {
  batch_id: string;
  idempotency_key: string;
  batch_hash: string;
  target_generation: number;
  object_count: number;
  change_count: number;
  withheld_plaintext_count: number;
};

type LatestSyncBatchRow = {
  batch_id: string;
  authority_ref: string;
  submitted_at: string;
  target_generation: number;
  withheld_plaintext_count: number;
};

type CountRow = {
  count: number;
};

const SyncBatchTableSql = `
CREATE TABLE IF NOT EXISTS sync_batches (
  batch_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  batch_hash TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  device_ref TEXT NOT NULL,
  client_ref TEXT NOT NULL,
  capability_ref TEXT NOT NULL,
  token_id TEXT,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  staged_at TEXT NOT NULL,
  committed_at TEXT,
  base_generation INTEGER NOT NULL,
  target_generation INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'committed', 'failed')),
  object_count INTEGER NOT NULL,
  change_count INTEGER NOT NULL,
  estimated_batch_bytes INTEGER NOT NULL,
  withheld_plaintext_count INTEGER NOT NULL,
  failure_reason TEXT,
  last_seen_at TEXT NOT NULL
)`;

const SyncObjectTableSql = `
CREATE TABLE IF NOT EXISTS sync_objects (
  object_ref TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  version INTEGER NOT NULL,
  envelope_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  envelope_r2_key TEXT NOT NULL,
  ciphertext_r2_path_hash TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (object_ref, version)
)`;

const SyncChangeTableSql = `
CREATE TABLE IF NOT EXISTS sync_changes (
  change_ref TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  authority_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  object_ref TEXT NOT NULL,
  operation TEXT NOT NULL,
  base_version INTEGER,
  new_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,
  actor_ref TEXT NOT NULL
)`;

const SyncIndexSql = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_batches_idempotency_key ON sync_batches (idempotency_key)",
  "CREATE INDEX IF NOT EXISTS idx_sync_batches_committed_generation ON sync_batches (status, target_generation)",
  "CREATE INDEX IF NOT EXISTS idx_sync_batches_authority_status_generation ON sync_batches (authority_ref, status, target_generation)",
  "CREATE INDEX IF NOT EXISTS idx_sync_objects_batch_id ON sync_objects (batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_sync_objects_authority_batch ON sync_objects (authority_ref, batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_sync_changes_batch_id ON sync_changes (batch_id)",
  "CREATE INDEX IF NOT EXISTS idx_sync_changes_authority_generation ON sync_changes (authority_ref, generation)"
];

export const SyncD1SchemaStatements = [
  SyncBatchTableSql,
  SyncObjectTableSql,
  SyncChangeTableSql,
  ...SyncIndexSql
];

const MaxConcurrentEnvelopeWrites = 8;

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }));

  return results;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

async function envelopeR2Key(batch: SyncBatch, object: GraphObjectEnvelope): Promise<string> {
  const authority = (await sha256Hex(batch.authority_id)).slice(0, 16);
  const segment = (await sha256Hex([
    "sync-envelope:v1",
    batch.batch_id,
    object.object_id,
    String(object.version),
    object.content_hash
  ].join(":"))).slice(0, 40);
  return `objects/a=${authority}/p=${segment.slice(0, 2)}/s=${segment}.bin`;
}

async function ensureSyncTables(controlDb: SyncMetadataStore): Promise<void> {
  for (const statement of SyncD1SchemaStatements) {
    await controlDb.prepare(statement).run();
  }
}

function countFromRow(row: CountRow | null): number {
  return typeof row?.count === "number" ? row.count : 0;
}

async function opaqueRef(value: string): Promise<string> {
  return `sha256:${await sha256Hex(value)}`;
}

function objectPayloadRef(batch: SyncBatch, object: GraphObjectEnvelope) {
  return (batch.object_payloads ?? []).find((payload) => (
    payload.object_id === object.object_id && payload.version === object.version
  ));
}

type ObjectPayloadRef = NonNullable<ReturnType<typeof objectPayloadRef>>;

function metadataByteLength(metadata: Record<string, string>): number {
  return new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
}

function r2CustomMetadata(authorityRef: string, payloadRef: { envelope_hash: string; payload_hash: string }): Record<string, string> {
  const metadata = {
    schema: "la-sync-envelope-v1",
    authority_ref: authorityRef.slice(7, 23),
    envelope_hash: payloadRef.envelope_hash,
    payload_hash: payloadRef.payload_hash
  };

  if (metadataByteLength(metadata) > 512) {
    throw new Error("R2 custom metadata exceeds bounded sync envelope metadata budget");
  }

  return metadata;
}

export async function readCommittedBatchByIdempotency(
  controlDb: SyncMetadataStore,
  idempotencyKey: string
): Promise<CommittedSyncBatch | undefined> {
  await ensureSyncTables(controlDb);

  const row = await controlDb.prepare(`
SELECT
  batch_id,
  idempotency_key,
  batch_hash,
  target_generation,
  object_count,
  change_count,
  withheld_plaintext_count
FROM sync_batches
WHERE idempotency_key = ? AND status = 'committed'
LIMIT 1`).bind(idempotencyKey).first<CommittedSyncBatch>();

  return row ?? undefined;
}

export async function persistSyncBatch(
  batch: SyncBatch,
  storage: SyncStorageBindings,
  options: PersistSyncBatchOptions = {}
): Promise<StoredSyncBatch> {
  await ensureSyncTables(storage.controlDb);

  const authorityRef = await opaqueRef(batch.authority_id);
  const summary = options.summary ?? await summarizeSyncBatch(batch);
  const stagedAt = options.staged_at ?? new Date().toISOString();
  const committedAt = options.committed_at ?? new Date().toISOString();

  await storage.controlDb.prepare(`
INSERT OR IGNORE INTO sync_batches (
  batch_id,
  idempotency_key,
  batch_hash,
  authority_ref,
  device_ref,
  client_ref,
  capability_ref,
  token_id,
  operation_id,
  trace_id,
  submitted_at,
  staged_at,
  committed_at,
  base_generation,
  target_generation,
  status,
  object_count,
  change_count,
  estimated_batch_bytes,
  withheld_plaintext_count,
  failure_reason,
  last_seen_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    batch.batch_id,
    batch.idempotency_key,
    summary.batch_hash,
    authorityRef,
    await opaqueRef(batch.device_id),
    await opaqueRef(batch.client_id),
    await opaqueRef(batch.capability_id),
    batch.token_id ?? null,
    batch.operation_id,
    batch.trace_id,
    batch.submitted_at,
    stagedAt,
    null,
    batch.base_generation,
    batch.target_generation,
    "staged",
    batch.objects.length,
    batch.changes.length,
    batch.estimated_batch_bytes,
    batch.withheld_plaintext_count,
    null,
    stagedAt,
  ).run();

  const storedEnvelopes = await mapWithConcurrency(batch.objects, MaxConcurrentEnvelopeWrites, async (object) => {
    const payloadRef = objectPayloadRef(batch, object);
    if (!payloadRef) {
      throw new Error(`Missing payload ref for ${object.object_id}:${object.version}`);
    }

    const key = await envelopeR2Key(batch, object);
    await storage.graphBucket.put(key, JSON.stringify(object), {
      httpMetadata: {
        contentType: "application/json; charset=utf-8"
      },
      customMetadata: {
        ...r2CustomMetadata(authorityRef, payloadRef)
      }
    });

    return { object, payloadRef, key } satisfies {
      object: GraphObjectEnvelope;
      payloadRef: ObjectPayloadRef;
      key: string;
    };
  });

  for (const { object, payloadRef, key } of storedEnvelopes) {
    await storage.controlDb.prepare(`
INSERT OR REPLACE INTO sync_objects (
  object_ref,
  batch_id,
  authority_ref,
  version,
  envelope_hash,
  payload_hash,
  envelope_r2_key,
  ciphertext_r2_path_hash,
  recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      await opaqueRef(object.object_id),
      batch.batch_id,
      authorityRef,
      object.version,
      payloadRef.envelope_hash,
      payloadRef.payload_hash,
      key,
      payloadRef.r2_path_hash ?? null,
      batch.submitted_at
    ).run();
  }

  for (const change of batch.changes) {
    await storage.controlDb.prepare(`
INSERT OR REPLACE INTO sync_changes (
  change_ref,
  batch_id,
  authority_ref,
  operation_id,
  trace_id,
  recorded_at,
  object_ref,
  operation,
  base_version,
  new_version,
  content_hash,
  generation,
  actor_ref
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      await opaqueRef(change.change_id),
      batch.batch_id,
      authorityRef,
      change.operation_id,
      change.trace_id,
      change.recorded_at,
      await opaqueRef(change.object_id),
      change.operation,
      change.base_version ?? null,
      change.new_version,
      change.content_hash,
      change.generation,
      await opaqueRef(change.actor_id)
    ).run();
  }

  await storage.controlDb.prepare(`
UPDATE sync_batches
SET status = 'committed', committed_at = ?, last_seen_at = ?
WHERE batch_id = ? AND status = 'staged'`).bind(
    committedAt,
    committedAt,
    batch.batch_id
  ).run();

  return {
    stored_envelope_count: batch.objects.length
  };
}

export async function readSyncStatus(controlDb: SyncMetadataStore, authorityId?: string): Promise<SyncStatus> {
  await ensureSyncTables(controlDb);
  const authorityRef = authorityId ? await opaqueRef(authorityId) : undefined;

  const latestQuery = `
SELECT
  batch_id,
  authority_ref,
  submitted_at,
  target_generation,
  withheld_plaintext_count
FROM sync_batches
WHERE status = 'committed'
${authorityRef ? "AND authority_ref = ?" : ""}
ORDER BY target_generation DESC, submitted_at DESC
LIMIT 1`;
  const latest = authorityRef
    ? await controlDb.prepare(latestQuery).bind(authorityRef).first<LatestSyncBatchRow>()
    : await controlDb.prepare(latestQuery).first<LatestSyncBatchRow>();

  const objectCountQuery = `
SELECT COUNT(*) AS count
FROM sync_objects
WHERE batch_id IN (SELECT batch_id FROM sync_batches WHERE status = 'committed' ${authorityRef ? "AND authority_ref = ?" : ""})`;
  const objectCount = authorityRef
    ? await controlDb.prepare(objectCountQuery).bind(authorityRef).first<CountRow>()
    : await controlDb.prepare(objectCountQuery).first<CountRow>();
  const changeCountQuery = `
SELECT COUNT(*) AS count
FROM sync_changes
WHERE batch_id IN (SELECT batch_id FROM sync_batches WHERE status = 'committed' ${authorityRef ? "AND authority_ref = ?" : ""})`;
  const changeCount = authorityRef
    ? await controlDb.prepare(changeCountQuery).bind(authorityRef).first<CountRow>()
    : await controlDb.prepare(changeCountQuery).first<CountRow>();

  return SyncStatusSchema.parse({
    ok: true,
    latest_generation: latest?.target_generation ?? 0,
    latest_batch_id: latest?.batch_id,
    latest_submitted_at: latest?.submitted_at,
    object_count: countFromRow(objectCount),
    change_count: countFromRow(changeCount),
    latest_withheld_plaintext_count: latest?.withheld_plaintext_count ?? 0
  });
}

type PullBatchRow = {
  batch_id: string;
  batch_hash: string;
  base_generation: number;
  target_generation: number;
  submitted_at: string;
  object_count: number;
  change_count: number;
  withheld_plaintext_count: number;
};

export async function readSyncPull(
  controlDb: SyncMetadataStore,
  authorityId: string,
  afterGeneration: number,
  limit = 100
): Promise<SyncPullResponse> {
  await ensureSyncTables(controlDb);

  const authorityRef = await opaqueRef(authorityId);
  const latest = await readSyncStatus(controlDb, authorityId);
  const boundedLimit = Math.min(Math.max(limit, 1), 250);
  const statement = controlDb.prepare(`
SELECT
  batch_id,
  batch_hash,
  base_generation,
  target_generation,
  submitted_at,
  object_count,
  change_count,
  withheld_plaintext_count
FROM sync_batches
WHERE status = 'committed' AND authority_ref = ? AND target_generation > ?
ORDER BY target_generation ASC
LIMIT ?`).bind(authorityRef, afterGeneration, boundedLimit + 1);
  const result = statement.all
    ? await statement.all<PullBatchRow>()
    : { results: [] as PullBatchRow[] };
  const rows = result.results ?? [];
  const batches = rows.slice(0, boundedLimit);
  const latestGeneration = latest.latest_generation;
  const nextGeneration = batches.at(-1)?.target_generation ?? afterGeneration;

  return SyncPullResponseSchema.parse({
    ok: true,
    authority_id: authorityId,
    from_generation: afterGeneration,
    latest_generation: latestGeneration,
    batches,
    next_cursor: {
      authority_id: authorityId,
      generation: nextGeneration,
      batch_id: batches.at(-1)?.batch_id
    },
    has_more: rows.length > boundedLimit
  });
}
