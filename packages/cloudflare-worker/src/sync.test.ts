import { describe, expect, it } from "vitest";
import {
  SyncBatchSchema,
  type GraphObjectEnvelope,
  type SyncBatch
} from "@living-atlas/contracts";
import { sha256TokenHash } from "./bootstrap";
import { CloudUnlockObjectAlgorithm } from "./cloud-unlock";
import { acceptSyncBatch, getSyncStatus } from "./sync";
import { authoritySequencerName, type SyncAuthoritySequencerRpc } from "./sync-sequencer";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";
import { readSyncEnvelopePull, type SyncMetadataStore, type SyncObjectStore } from "./sync-storage";

const syncToken = "fixture-sync-token-0001";
const usageToken = "fixture-usage-token-0001";
const timestamp = "2026-06-21T12:00:00.000Z";
const cloudUnlockCapabilityId = "la_cap_cloudunlock0001";

const ciphertextBatch = {
  batch_id: "la_sync_batch_worker0001",
  authority_id: "la_authority_worker0001",
  device_id: "la_device_worker0001",
  client_id: "la_client_worker0001",
  operation_id: "la_operation_worker0001",
  trace_id: "la_trace_worker0001",
  submitted_at: timestamp,
  base_generation: 0,
  target_generation: 1,
  objects: [
    {
      schema_version: 1,
      authority_id: "la_authority_worker0001",
      object_id: "la_object_worker0001",
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      key_ref: "la_key_worker0001",
      visible_metadata: {
        tombstone: false,
        size_class: "tiny",
        remote_indexable: false
      },
      payload: {
        kind: "ciphertext-ref",
        storage: "r2",
        path: "objects/a=1111111111111111/p=22/s=2222222222222222222222222222222222222222.bin",
        ciphertext_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        byte_size: 512,
        algorithm: "xchacha20-poly1305"
      }
    }
  ],
  changes: [
    {
      change_id: "la_change_worker0001",
      authority_id: "la_authority_worker0001",
      operation_id: "la_operation_worker0001",
      trace_id: "la_trace_worker0001",
      recorded_at: timestamp,
      object_id: "la_object_worker0001",
      operation: "update",
      base_version: 0,
      new_version: 1,
      content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      access_class: "local-private",
      generation: 1,
      actor_id: "la_client_worker0001"
    }
  ],
  withheld_plaintext_count: 0
} as const;

function testBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function testToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function testStableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(testStableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${testStableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function testObjectAdditionalData(object: GraphObjectEnvelope): Uint8Array {
  return new TextEncoder().encode([
    "living-atlas-cloud-unlock-object-payload:v1",
    object.authority_id,
    object.object_id,
    object.object_type,
    String(object.version),
    object.access_class,
    object.encryption_class,
    object.key_ref ?? "",
    object.created_at,
    object.updated_at,
    testStableJson(object.visible_metadata)
  ].join(":"));
}

async function testSha256Hash(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function encryptCloudUnlockFixtureObject(input: {
  rawKey: Uint8Array;
  nonce: Uint8Array;
  object: Omit<GraphObjectEnvelope, "content_hash" | "payload">;
  plaintext: Record<string, unknown>;
}): Promise<GraphObjectEnvelope> {
  const draft: GraphObjectEnvelope = {
    ...input.object,
    content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    payload: {
      kind: "ciphertext-inline",
      ciphertext: "pending",
      nonce: testToBase64(input.nonce),
      algorithm: CloudUnlockObjectAlgorithm
    }
  };
  const key = await crypto.subtle.importKey(
    "raw",
    testBufferSource(input.rawKey),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: testBufferSource(input.nonce),
      additionalData: testBufferSource(testObjectAdditionalData(draft))
    },
    key,
    testBufferSource(new TextEncoder().encode(JSON.stringify({
      kind: "plaintext-json",
      data: input.plaintext
    })))
  ));
  const ciphertextBase64 = testToBase64(ciphertext);

  return {
    ...draft,
    content_hash: await testSha256Hash(ciphertextBase64),
    payload: {
      kind: "ciphertext-inline",
      ciphertext: ciphertextBase64,
      nonce: testToBase64(input.nonce),
      algorithm: CloudUnlockObjectAlgorithm
    }
  };
}

async function cloudUnlockBatch(rawKey: Uint8Array): Promise<SyncBatch> {
  const object = await encryptCloudUnlockFixtureObject({
    rawKey,
    nonce: new Uint8Array([12, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8]),
    object: {
      schema_version: 1,
      authority_id: "la_authority_worker0001",
      object_id: "la_object_cloudunlock0001",
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: timestamp,
      updated_at: timestamp,
      key_ref: "la_key_cloudunlock0001",
      visible_metadata: {
        tombstone: false,
        size_class: "tiny",
        remote_indexable: false
      }
    },
    plaintext: {
      title: "Synthetic sensitive note",
      body: "Cloud unlock plaintext only appears after the transient key is supplied."
    }
  });

  return SyncBatchSchema.parse({
    batch_id: "la_sync_batch_cloudunlock0001",
    authority_id: "la_authority_worker0001",
    device_id: "la_device_worker0001",
    client_id: "la_client_worker0001",
    operation_id: "la_operation_cloudunlock0001",
    trace_id: "la_trace_cloudunlock0001",
    submitted_at: timestamp,
    base_generation: 0,
    target_generation: 1,
    objects: [object],
    changes: [
      {
        change_id: "la_change_cloudunlock0001",
        authority_id: "la_authority_worker0001",
        operation_id: "la_operation_cloudunlock0001",
        trace_id: "la_trace_cloudunlock0001",
        recorded_at: timestamp,
        object_id: object.object_id,
        operation: "update",
        base_version: 0,
        new_version: 1,
        content_hash: object.content_hash,
        access_class: object.access_class,
        generation: 1,
        actor_id: "la_client_worker0001"
      }
    ],
    withheld_plaintext_count: 0
  });
}

const staleCiphertextBatch = {
  ...ciphertextBatch,
  batch_id: "la_sync_batch_worker0002"
} as const;

const gapCiphertextBatch = {
  ...ciphertextBatch,
  batch_id: "la_sync_batch_worker0003",
  base_generation: 3,
  target_generation: 4,
  changes: [
    {
      ...ciphertextBatch.changes[0],
      change_id: "la_change_worker0003",
      generation: 4
    }
  ]
} as const;

type R2PutRecord = {
  key: string;
  value: string;
  options: unknown;
};

type D1RunRecord = {
  query: string;
  bindings: unknown[];
};

function fakeD1Result<T>(results: T[] = []): D1Result<T> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0
    },
    results
  };
}

class FakePreparedStatement {
  constructor(
    private readonly records: D1RunRecord[],
    private readonly query: string,
    private readonly bindings: unknown[] = []
  ) {}

  bind(...values: unknown[]): FakePreparedStatement {
    return new FakePreparedStatement(this.records, this.query, values);
  }

  private committedBatchIds(authorityRef?: string): Set<string> {
    return new Set(this.committedBatches(authorityRef).map((batch) => batch.batch_id));
  }

  private committedBatchIdSet(): Set<string> {
    return new Set(
      this.records
        .filter((record) => record.query.includes("UPDATE sync_batches"))
        .map((record) => String(record.bindings[2]))
    );
  }

  private committedBatches(authorityRef?: string) {
    const committed = this.committedBatchIdSet();
    return this.records
      .filter((record) => record.query.includes("INTO sync_batches"))
      .filter((record) => committed.has(String(record.bindings[0])))
      .map((record) => ({
        batch_id: String(record.bindings[0]),
        idempotency_key: String(record.bindings[1]),
        batch_hash: String(record.bindings[2]),
        authority_ref: String(record.bindings[3]),
        submitted_at: String(record.bindings[10]),
        base_generation: Number(record.bindings[13]),
        target_generation: Number(record.bindings[14]),
        object_count: Number(record.bindings[16]),
        change_count: Number(record.bindings[17]),
        withheld_plaintext_count: Number(record.bindings[19])
      }))
      .filter((batch) => !authorityRef || batch.authority_ref === authorityRef);
  }

  private remoteGraphRows(authorityRef?: string) {
    return this.records
      .filter((record) => record.query.includes("INTO remote_graph_objects"))
      .map((record) => ({
        object_ref: String(record.bindings[0]),
        authority_ref: String(record.bindings[1]),
        version: Number(record.bindings[2]),
        object_type: String(record.bindings[3]),
        access_class: String(record.bindings[4]),
        envelope_r2_key: String(record.bindings[5]),
        content_hash: String(record.bindings[6]),
        created_at: String(record.bindings[7]),
        updated_at: String(record.bindings[8]),
        tombstone: Number(record.bindings[9]),
        edge_ref: record.bindings[10] === null ? undefined : String(record.bindings[10]),
        source_ref: record.bindings[11] === null ? undefined : String(record.bindings[11]),
        target_ref: record.bindings[12] === null ? undefined : String(record.bindings[12]),
        predicate: record.bindings[13] === null ? undefined : String(record.bindings[13])
      }))
      .filter((row) => !authorityRef || row.authority_ref === authorityRef);
  }

  private auditRows(authorityRef?: string) {
    return this.records
      .filter((record) => record.query.includes("INSERT INTO audit_events"))
      .map((record) => ({
        audit_id: String(record.bindings[0]),
        authority_ref: String(record.bindings[1]),
        operation_id: String(record.bindings[2]),
        trace_id: String(record.bindings[3]),
        recorded_at: String(record.bindings[4]),
        actor_ref: String(record.bindings[5]),
        mcp_profile: String(record.bindings[6]),
        operation: String(record.bindings[7]),
        event_type: String(record.bindings[8]),
        outcome: record.bindings[9] === null ? null : String(record.bindings[9]),
        reason_code: record.bindings[10] === null ? null : String(record.bindings[10]),
        object_ref: record.bindings[11] === null ? null : String(record.bindings[11]),
        release_ref: record.bindings[12] === null ? null : String(record.bindings[12]),
        key_ref: record.bindings[13] === null ? null : String(record.bindings[13]),
        capability_ref: record.bindings[14] === null ? null : String(record.bindings[14]),
        sync_batch_ref: record.bindings[15] === null ? null : String(record.bindings[15]),
        access_class: record.bindings[16] === null ? null : String(record.bindings[16]),
        redaction: String(record.bindings[17]),
        summary: String(record.bindings[18]),
        checkpoint_bucket: String(record.bindings[19]),
        previous_event_hash: record.bindings[20] === null ? null : String(record.bindings[20]),
        event_hash: String(record.bindings[21])
      }))
      .filter((row) => !authorityRef || row.authority_ref === authorityRef);
  }

  private remoteGraphWriteRows() {
    const rows = new Map<string, {
      idempotency_key: string;
      request_hash: string;
      status: "staged" | "committed" | "failed";
      response_json: string | null;
      failure_reason: string | null;
      created_at: string;
    }>();

    for (const record of this.records) {
      if (record.query.includes("INTO remote_graph_writes")) {
        rows.set(String(record.bindings[0]), {
          idempotency_key: String(record.bindings[0]),
          request_hash: String(record.bindings[1]),
          status: "staged",
          response_json: null,
          failure_reason: null,
          created_at: String(record.bindings[10])
        });
      }

      if (record.query.includes("UPDATE remote_graph_writes") && record.query.includes("SET status = 'committed'")) {
        const row = rows.get(String(record.bindings[6]));
        if (row && row.request_hash === String(record.bindings[7])) {
          rows.set(row.idempotency_key, {
            ...row,
            status: "committed",
            response_json: String(record.bindings[2]),
            failure_reason: null
          });
        }
      }

      if (record.query.includes("UPDATE remote_graph_writes") && record.query.includes("SET status = 'failed'")) {
        const row = rows.get(String(record.bindings[3]));
        if (row && row.request_hash === String(record.bindings[4])) {
          rows.set(row.idempotency_key, {
            ...row,
            status: "failed",
            failure_reason: String(record.bindings[0])
          });
        }
      }
    }

    return [...rows.values()];
  }

  async first<T = unknown>(_colName?: string): Promise<T | null> {
    if (this.query.includes("FROM remote_graph_writes")) {
      const idempotencyKey = String(this.bindings.at(-1));
      return (this.remoteGraphWriteRows().find((row) => row.idempotency_key === idempotencyKey) ?? null) as T | null;
    }

    if (this.query.includes("idempotency_key = ?")) {
      const authorityScoped = this.query.includes("authority_ref = ?");
      const authorityRef = authorityScoped ? String(this.bindings[0]) : undefined;
      const idempotencyKey = String(this.bindings[authorityScoped ? 1 : 0]);
      return (this.committedBatches(authorityRef).find((batch) => batch.idempotency_key === idempotencyKey) ?? null) as T | null;
    }

    if (this.query.includes("COUNT(*) AS count") && this.query.includes("FROM sync_objects")) {
      const committed = this.committedBatchIds(this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined);
      return {
        count: this.records
          .filter((record) => record.query.includes("INTO sync_objects"))
          .filter((record) => committed.has(String(record.bindings[1])))
          .length
      } as T;
    }

    if (this.query.includes("COUNT(*) AS count") && this.query.includes("FROM sync_changes")) {
      const committed = this.committedBatchIds(this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined);
      return {
        count: this.records
          .filter((record) => record.query.includes("INTO sync_changes"))
          .filter((record) => committed.has(String(record.bindings[1])))
          .length
      } as T;
    }

    if (this.query.includes("FROM sync_batches")) {
      const batches = this.committedBatches(this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined)
        .sort((left, right) => right.target_generation - left.target_generation || right.submitted_at.localeCompare(left.submitted_at));

      return (batches[0] ?? null) as T | null;
    }

    if (this.query.includes("FROM remote_graph_objects") && this.query.includes("object_ref = ?")) {
      const authorityRef = String(this.bindings[0]);
      const objectRef = String(this.bindings[1]);
      const row = this.remoteGraphRows(authorityRef)
        .filter((candidate) => candidate.object_ref === objectRef)
        .sort((left, right) => right.version - left.version)
        .at(0);
      return (row ?? null) as T | null;
    }

    if (this.query.includes("FROM remote_graph_objects") && this.query.includes("edge_ref = ?")) {
      const authorityRef = String(this.bindings[0]);
      const edgeRef = String(this.bindings[1]);
      const row = this.remoteGraphRows(authorityRef)
        .filter((candidate) => candidate.edge_ref === edgeRef)
        .sort((left, right) => right.version - left.version)
        .at(0);
      return (row ?? null) as T | null;
    }

    if (this.query.includes("SELECT event_hash") && this.query.includes("FROM audit_events")) {
      const authorityRef = String(this.bindings[0]);
      const row = this.auditRows(authorityRef)
        .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at) || right.audit_id.localeCompare(left.audit_id))
        .at(0);
      return (row ? { event_hash: row.event_hash } : null) as T | null;
    }

    return null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.records.push({ query: this.query, bindings: this.bindings });
    const result = fakeD1Result<T>();
    if (this.query.includes("INSERT INTO audit_events")) {
      result.meta.changes = 1;
      result.meta.changed_db = true;
    }
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM sync_objects") && this.query.includes("INNER JOIN sync_batches")) {
      const authorityRef = String(this.bindings[0]);
      const afterGeneration = Number(this.bindings[1]);
      const throughGeneration = Number(this.bindings[2]);
      const batches = new Map(
        this.committedBatches(authorityRef)
          .filter((batch) => batch.target_generation > afterGeneration)
          .filter((batch) => batch.target_generation <= throughGeneration)
          .map((batch) => [batch.batch_id, batch])
      );
      return fakeD1Result<T>(
        this.records
          .filter((record) => record.query.includes("INTO sync_objects"))
          .filter((record) => batches.has(String(record.bindings[1])))
          .map((record) => {
            const batch = batches.get(String(record.bindings[1]))!;
            return {
              batch_id: batch.batch_id,
              target_generation: batch.target_generation,
              submitted_at: batch.submitted_at,
              object_ref: String(record.bindings[0]),
              version: Number(record.bindings[3]),
              envelope_r2_key: String(record.bindings[6])
            };
          })
          .sort((left, right) => (
            left.target_generation - right.target_generation
            || left.object_ref.localeCompare(right.object_ref)
            || left.version - right.version
          )) as T[]
      );
    }

    if (this.query.includes("FROM sync_batches") && this.query.includes("target_generation > ?")) {
      const afterGeneration = Number(this.bindings[1]);
      const limit = Number(this.bindings[2]);
      return fakeD1Result<T>(
        this.committedBatches(String(this.bindings[0]))
          .filter((batch) => batch.target_generation > afterGeneration)
          .sort((left, right) => left.target_generation - right.target_generation)
          .map((batch) => ({
            batch_id: batch.batch_id,
            batch_hash: batch.batch_hash,
            base_generation: batch.base_generation,
            target_generation: batch.target_generation,
            submitted_at: batch.submitted_at,
            object_count: batch.object_count,
            change_count: batch.change_count,
            withheld_plaintext_count: batch.withheld_plaintext_count
          }))
          .slice(0, limit) as T[]
      );
    }

    if (this.query.includes("FROM remote_graph_objects")) {
      const authorityRef = String(this.bindings[0]);
      const limit = Number(this.bindings[1] ?? 1000);
      return fakeD1Result<T>(
        this.remoteGraphRows(authorityRef)
          .sort((left, right) => left.object_ref.localeCompare(right.object_ref) || right.version - left.version)
          .slice(0, limit) as T[]
      );
    }

    if (this.query.includes("FROM audit_events")) {
      const limit = Number(this.bindings.at(-1) ?? 100);
      const authorityRef = this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined;
      return fakeD1Result<T>(
        this.auditRows(authorityRef)
          .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at) || right.audit_id.localeCompare(left.audit_id))
          .slice(0, limit) as T[]
      );
    }

    return fakeD1Result<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    if (options?.columnNames) {
      return [[]] as [string[], ...T[]];
    }

    return [];
  }
}

class FakeD1Session {
  constructor(private readonly records: D1RunRecord[]) {}

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this.records, query);
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }

  getBookmark(): D1SessionBookmark | null {
    return null;
  }
}

class FakeD1Database implements SyncMetadataStore {
  readonly records: D1RunRecord[] = [];

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this.records, query);
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }

  async exec(_query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    return new FakeD1Session(this.records) as D1DatabaseSession;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

class FakeR2Bucket implements SyncObjectStore {
  readonly puts: R2PutRecord[] = [];
  private readonly objects = new Map<string, string>();

  async head(_key: string): Promise<R2Object | null> {
    return null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }

    return {
      text: async () => value
    } as R2ObjectBody;
  }

  async put(key: string, value: string, options?: Parameters<SyncObjectStore["put"]>[2]): Promise<R2Object> {
    this.puts.push({ key, value, options });
    this.objects.set(key, value);
    return {
      key,
      version: "fixture-version",
      size: value.length,
      etag: "fixture-etag",
      httpEtag: "\"fixture-etag\"",
      uploaded: new Date(timestamp),
      httpMetadata: {},
      customMetadata: options?.customMetadata ?? {},
      range: undefined,
      storageClass: "Standard",
      checksums: {
        toJSON: () => ({})
      },
      writeHttpMetadata: (_headers: Headers) => {}
    };
  }

  async createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error("multipart uploads are not used in sync tests");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("multipart uploads are not used in sync tests");
  }

  async delete(): Promise<void> {}

  async list(): Promise<R2Objects> {
    return {
      objects: [],
      delimitedPrefixes: [],
      truncated: false
    };
  }
}

class DelayedFakeR2Bucket extends FakeR2Bucket {
  activePuts = 0;
  maxActivePuts = 0;

  override async put(key: string, value: string, options?: Parameters<SyncObjectStore["put"]>[2]): Promise<R2Object> {
    this.activePuts += 1;
    this.maxActivePuts = Math.max(this.maxActivePuts, this.activePuts);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await super.put(key, value, options);
    } finally {
      this.activePuts -= 1;
    }
  }
}

function ciphertextObject(index: number) {
  const suffix = index.toString().padStart(4, "0");
  const segment = index.toString(16).padStart(40, "0");
  const hash = `sha256:${index.toString(16).padStart(64, "0")}`;

  return {
    ...ciphertextBatch.objects[0],
    object_id: `la_object_workerparallel${suffix}`,
    content_hash: hash,
    payload: {
      ...ciphertextBatch.objects[0].payload,
      path: `objects/a=1111111111111111/p=${segment.slice(0, 2)}/s=${segment}.bin`,
      ciphertext_hash: hash
    }
  };
}

function ciphertextChange(index: number) {
  const suffix = index.toString().padStart(4, "0");
  const object = ciphertextObject(index);

  return {
    ...ciphertextBatch.changes[0],
    change_id: `la_change_workerparallel${suffix}`,
    object_id: object.object_id,
    content_hash: object.content_hash
  };
}

function multiObjectCiphertextBatch(count: number) {
  return {
    ...ciphertextBatch,
    batch_id: "la_sync_batch_workerparallel0001",
    objects: Array.from({ length: count }, (_, index) => ciphertextObject(index + 1)),
    changes: Array.from({ length: count }, (_, index) => ciphertextChange(index + 1))
  };
}

async function createEnv(): Promise<{
  env: BootstrapWorkerEnv;
  graphBucket: FakeR2Bucket;
  controlDb: FakeD1Database;
}> {
  const graphBucket = new FakeR2Bucket();
  const controlDb = new FakeD1Database();
  return {
    graphBucket,
    controlDb,
    env: {
      BOOTSTRAP_CLAIM_LOCK: {
        getByName: () => {
          throw new Error("bootstrap lock should not be used by sync tests");
        }
      },
      LA_GRAPH_BUCKET: graphBucket as R2Bucket,
      LA_CONTROL_DB: controlDb as D1Database,
      LA_AUTHORITY_ID: "la_authority_worker0001",
      LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken),
      LA_CLOUD_UNLOCK_CAPABILITY_ID: cloudUnlockCapabilityId,
      LA_USAGE_TOKEN_HASH: await sha256TokenHash(usageToken),
      LA_USAGE_PROVIDER: "cloudflare",
      LA_USAGE_PLAN: "free",
      LA_USAGE_BUDGETS_JSON: JSON.stringify({
        services: {
          workers: {
            requests: 10_000
          }
        }
      })
    },
  };
}

describe("Worker sync batch acceptance", () => {
  it("accepts a token-gated ciphertext batch", async () => {
    await expect(acceptSyncBatch(ciphertextBatch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    })).resolves.toEqual({
      ok: true,
      accepted: {
        ok: true,
        batch_id: ciphertextBatch.batch_id,
        accepted_objects: 1,
        accepted_changes: 1,
        target_generation: 1,
        withheld_plaintext_count: 0,
        idempotent_replay: false
      }
    });
  });

  it("persists ciphertext object envelopes to R2 and sync metadata to D1", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const result = await acceptSyncBatch(ciphertextBatch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    }, {
      graphBucket,
      controlDb
    });

    expect(result).toMatchObject({ ok: true });
    expect(graphBucket.puts).toHaveLength(1);
    expect(graphBucket.puts[0]!.key).toMatch(/^objects\/a=[a-f0-9]{16}\/p=[a-f0-9]{2}\/s=[a-f0-9]{40}\.bin$/);
    expect(graphBucket.puts[0]!.value).toContain("\"kind\":\"ciphertext-ref\"");
    expect(graphBucket.puts[0]!.value).not.toContain("not allowed");
    expect(JSON.stringify(graphBucket.puts[0]!.options)).not.toContain(ciphertextBatch.authority_id);
    expect(JSON.stringify(graphBucket.puts[0]!.options)).not.toContain(ciphertextBatch.objects[0].payload.path);

    expect(controlDb.records.some((record) => record.query.includes("CREATE TABLE IF NOT EXISTS sync_batches"))).toBe(true);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(true);
    expect(controlDb.records.some((record) => record.query.includes("UPDATE sync_batches"))).toBe(true);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR REPLACE INTO sync_objects"))).toBe(true);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR REPLACE INTO sync_changes"))).toBe(true);
    const serializedWrites = JSON.stringify(controlDb.records);
    expect(serializedWrites).not.toContain(ciphertextBatch.authority_id);
    expect(serializedWrites).not.toContain(ciphertextBatch.objects[0].object_id);
    expect(serializedWrites).not.toContain(ciphertextBatch.changes[0].actor_id);
    expect(serializedWrites).not.toContain(ciphertextBatch.objects[0].payload.path);
    expect(serializedWrites).not.toContain(await testSha256Hash(ciphertextBatch.authority_id));
    expect(serializedWrites).not.toContain(await testSha256Hash(ciphertextBatch.objects[0].object_id));
  });

  it("rejects forged object payload refs before sync storage writes metadata", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const forgedInput = {
      ...ciphertextBatch,
      batch_id: "la_sync_batch_workerforged1",
      idempotency_key: "la_idem_workerforged1",
      object_payloads: [
        {
          ...SyncBatchSchema.parse(ciphertextBatch).object_payloads[0]!,
          payload_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        }
      ],
      batch_hash: undefined
    };
    const forgedBatch = SyncBatchSchema.parse(forgedInput);

    await expect(acceptSyncBatch(forgedBatch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    }, {
      graphBucket,
      controlDb
    })).rejects.toThrow(/payload ref mismatch/);

    expect(graphBucket.puts).toHaveLength(0);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(false);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR REPLACE INTO sync_objects"))).toBe(false);
  });

  it("does not commit graph storage when the sequencer commit rejects the staged batch", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const sequencer: SyncAuthoritySequencerRpc = {
      stageBatch: async (summary) => ({
        ok: true,
        state: "staged",
        should_persist: true,
        duplicate: false,
        accepted: {
          ok: true,
          batch_id: summary.batch_id,
          accepted_objects: summary.object_count,
          accepted_changes: summary.change_count,
          target_generation: summary.target_generation,
          withheld_plaintext_count: summary.withheld_plaintext_count,
          idempotent_replay: false
        }
      }),
      commitBatch: async () => ({
        ok: false,
        reason: "batch-conflict"
      })
    };

    await expect(acceptSyncBatch(ciphertextBatch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    }, {
      graphBucket,
      controlDb,
      sequencer
    })).resolves.toMatchObject({
      ok: false,
      reason: "batch-conflict"
    });

    expect(graphBucket.puts).toHaveLength(0);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(false);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR REPLACE INTO sync_objects"))).toBe(false);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR REPLACE INTO sync_changes"))).toBe(false);
  });

  it("persists batch object envelopes to R2 with bounded parallelism", async () => {
    const graphBucket = new DelayedFakeR2Bucket();
    const controlDb = new FakeD1Database();
    const batch = multiObjectCiphertextBatch(12);
    const result = await acceptSyncBatch(batch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    }, {
      graphBucket,
      controlDb
    });

    expect(result).toMatchObject({ ok: true });
    expect(graphBucket.puts).toHaveLength(12);
    expect(graphBucket.maxActivePuts).toBeGreaterThan(1);
    expect(graphBucket.maxActivePuts).toBeLessThanOrEqual(8);
  });

  it("pulls complete envelope generations instead of truncating inside one batch", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const batch = multiObjectCiphertextBatch(12);
    const result = await acceptSyncBatch(batch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken)
    }, {
      graphBucket,
      controlDb
    });

    expect(result).toMatchObject({ ok: true });
    const pull = await readSyncEnvelopePull({
      graphBucket,
      controlDb
    }, batch.authority_id, 0, 1);

    expect(pull).toMatchObject({
      ok: true,
      latest_generation: 1,
      next_cursor: {
        generation: 1,
        batch_id: batch.batch_id
      },
      has_more: false
    });
    expect(pull.objects).toHaveLength(12);
    expect(pull.objects.map((object) => object.generation)).toEqual(Array(12).fill(1));
  });

  it("reports empty and persisted sync status from D1", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const sync_token_hash = await sha256TokenHash(syncToken);

    await expect(getSyncStatus(syncToken, { sync_token_hash }, controlDb)).resolves.toEqual({
      ok: true,
      status: {
        ok: true,
        latest_generation: 0,
        object_count: 0,
        change_count: 0,
        latest_withheld_plaintext_count: 0
      }
    });

    await acceptSyncBatch(ciphertextBatch, syncToken, { sync_token_hash }, { graphBucket, controlDb });

    await expect(getSyncStatus(syncToken, { sync_token_hash }, controlDb)).resolves.toEqual({
      ok: true,
      status: {
        ok: true,
        latest_generation: 1,
        latest_batch_id: ciphertextBatch.batch_id,
        latest_submitted_at: ciphertextBatch.submitted_at,
        object_count: 1,
        change_count: 1,
        latest_withheld_plaintext_count: 0
      }
    });
  });

  it("rejects stale and future-base generations before writing another batch", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const sync_token_hash = await sha256TokenHash(syncToken);

    await acceptSyncBatch(ciphertextBatch, syncToken, { sync_token_hash }, { graphBucket, controlDb });

    await expect(acceptSyncBatch(staleCiphertextBatch, syncToken, { sync_token_hash }, {
      graphBucket,
      controlDb
    })).resolves.toEqual({
      ok: false,
      reason: "stale-generation",
      status: {
        ok: true,
        latest_generation: 1,
        latest_batch_id: ciphertextBatch.batch_id,
        latest_submitted_at: ciphertextBatch.submitted_at,
        object_count: 1,
        change_count: 1,
        latest_withheld_plaintext_count: 0
      }
    });

    await expect(acceptSyncBatch(gapCiphertextBatch, syncToken, { sync_token_hash }, {
      graphBucket,
      controlDb
    })).resolves.toEqual({
      ok: false,
      reason: "generation-gap",
      status: {
        ok: true,
        latest_generation: 1,
        latest_batch_id: ciphertextBatch.batch_id,
        latest_submitted_at: ciphertextBatch.submitted_at,
        object_count: 1,
        change_count: 1,
        latest_withheld_plaintext_count: 0
      }
    });

    expect(graphBucket.puts).toHaveLength(1);
    expect(controlDb.records.filter((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toHaveLength(1);
  });

  it("replays duplicate idempotency keys without writing another object envelope", async () => {
    const graphBucket = new FakeR2Bucket();
    const controlDb = new FakeD1Database();
    const sync_token_hash = await sha256TokenHash(syncToken);

    await expect(acceptSyncBatch(ciphertextBatch, syncToken, { sync_token_hash }, {
      graphBucket,
      controlDb
    })).resolves.toMatchObject({
      ok: true,
      accepted: {
        idempotent_replay: false
      }
    });

    await expect(acceptSyncBatch(ciphertextBatch, syncToken, { sync_token_hash }, {
      graphBucket,
      controlDb
    })).resolves.toMatchObject({
      ok: true,
      accepted: {
        batch_id: ciphertextBatch.batch_id,
        idempotent_replay: true
      }
    });

    expect(graphBucket.puts).toHaveLength(1);
    expect(controlDb.records.filter((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toHaveLength(1);
  });

  it("rejects sync tokens presented for the wrong bound client or capability", async () => {
    await expect(acceptSyncBatch(ciphertextBatch, syncToken, {
      sync_token_hash: await sha256TokenHash(syncToken),
      sync_client_id: "la_client_worker0001",
      sync_capability_id: "la_cap_worker0001"
    }, undefined, {
      client_id: "la_client_other0001",
      capability_id: "la_cap_worker0001"
    })).resolves.toEqual({
      ok: false,
      reason: "invalid-token-binding"
    });
  });

  it("rejects disabled, missing-token, invalid-token, and plaintext batches", async () => {
    const sync_token_hash = await sha256TokenHash(syncToken);

    await expect(acceptSyncBatch(ciphertextBatch, syncToken, {})).resolves.toEqual({
      ok: false,
      reason: "sync-disabled"
    });

    await expect(acceptSyncBatch(ciphertextBatch, undefined, { sync_token_hash })).resolves.toEqual({
      ok: false,
      reason: "missing-token"
    });

    await expect(acceptSyncBatch(ciphertextBatch, "wrong-token", { sync_token_hash })).resolves.toEqual({
      ok: false,
      reason: "invalid-token"
    });

    await expect(acceptSyncBatch({
      ...ciphertextBatch,
      objects: [
        {
          ...ciphertextBatch.objects[0],
          encryption_class: "plaintext",
          key_ref: undefined,
          payload: {
            kind: "plaintext-json",
            data: { title: "not allowed" }
          }
        }
      ]
    }, syncToken, { sync_token_hash })).resolves.toEqual({
      ok: false,
      reason: "malformed-batch"
    });
  });

  it("serves the Worker sync route without exposing the sync token", async () => {
    const { env, graphBucket, controlDb } = await createEnv();
    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-usage-token": usageToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);

    expect(response.status).toBe(202);
    const text = await response.text();
    expect(text).toContain(ciphertextBatch.batch_id);
    expect(text).not.toContain(syncToken);
    expect(graphBucket.puts).toHaveLength(1);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(true);
  });

  it("routes Worker sync batches through an authority-hashed sequencer when configured", async () => {
    const { env, graphBucket, controlDb } = await createEnv();
    const sequencerNames: string[] = [];
    env.SYNC_SEQUENCER = {
      getByName: (name) => {
        sequencerNames.push(name);
        return {
          acceptBatch: (input, token, config, binding) => acceptSyncBatch(input, token, config, {
            graphBucket,
            controlDb
          }, binding)
        };
      }
    };

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-usage-token": usageToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);

    expect(response.status).toBe(202);
    expect(sequencerNames).toEqual([await authoritySequencerName(ciphertextBatch.authority_id)]);
    expect(sequencerNames[0]).not.toContain(ciphertextBatch.authority_id);
    expect(graphBucket.puts).toHaveLength(1);
  });

  it("serves the Worker sync status route from persisted D1 state", async () => {
    const { env } = await createEnv();
    const batchResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);
    expect(batchResponse.status).toBe(202);

    const statusResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/status", {
      method: "GET",
      headers: {
        "x-living-atlas-sync-token": syncToken
      }
    }), env);

    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({
      ok: true,
      latest_generation: 1,
      latest_batch_id: ciphertextBatch.batch_id,
      latest_submitted_at: ciphertextBatch.submitted_at,
      object_count: 1,
      change_count: 1,
      latest_withheld_plaintext_count: 0
    });
  });

  it("serves generation conflicts from the Worker sync batch route", async () => {
    const { env } = await createEnv();
    await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(staleCiphertextBatch)
    }), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "stale-generation",
      status: {
        latest_generation: 1,
        latest_batch_id: ciphertextBatch.batch_id
      }
    });
  });

  it("serves pull summaries for offline recovery without exposing the sync token", async () => {
    const { env } = await createEnv();
    const batchResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);
    expect(batchResponse.status).toBe(202);

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/pull?authority_id=la_authority_worker0001&after_generation=0", {
      method: "GET",
      headers: {
        "x-living-atlas-sync-token": syncToken
      }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      authority_id: "la_authority_worker0001",
      from_generation: 0,
      latest_generation: 1,
      batches: [
        {
          batch_id: ciphertextBatch.batch_id,
          target_generation: 1
        }
      ],
      next_cursor: {
        generation: 1,
        batch_id: ciphertextBatch.batch_id
      },
      has_more: false
    });
    expect(JSON.stringify(body)).not.toContain(syncToken);
  });

  it("serves ciphertext envelopes for local replay without exposing the sync token", async () => {
    const { env } = await createEnv();
    const batchResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);
    expect(batchResponse.status).toBe(202);

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/envelopes?authority_id=la_authority_worker0001&after_generation=0", {
      method: "GET",
      headers: {
        "x-living-atlas-sync-token": syncToken
      }
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      authority_id: "la_authority_worker0001",
      from_generation: 0,
      latest_generation: 1,
      objects: [
        {
          batch_id: ciphertextBatch.batch_id,
          generation: 1,
          submitted_at: ciphertextBatch.submitted_at,
          object: expect.objectContaining({
            object_id: "la_object_worker0001",
            payload: expect.objectContaining({
              kind: "ciphertext-ref"
            })
          })
        }
      ],
      next_cursor: {
        generation: 1,
        batch_id: ciphertextBatch.batch_id
      },
      has_more: false
    });
    expect(JSON.stringify(body)).not.toContain(syncToken);
  });

  it("rejects caller-selected authorities on sync and usage worker routes", async () => {
    const { env, graphBucket, controlDb } = await createEnv();
    const otherAuthorityBatch = {
      ...ciphertextBatch,
      authority_id: "la_authority_other0001"
    };

    const batchResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(otherAuthorityBatch)
    }), env);

    expect(batchResponse.status).toBe(403);
    await expect(batchResponse.json()).resolves.toMatchObject({
      ok: false,
      error: "sync-authority-mismatch"
    });
    expect(graphBucket.puts).toHaveLength(0);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(false);

    const pullResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/pull?authority_id=la_authority_other0001&after_generation=0", {
      headers: { "x-living-atlas-sync-token": syncToken }
    }), env);
    expect(pullResponse.status).toBe(403);
    await expect(pullResponse.json()).resolves.toMatchObject({ ok: false, error: "sync-authority-mismatch" });

    const envelopeResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/envelopes?authority_id=la_authority_other0001&after_generation=0", {
      headers: { "x-living-atlas-sync-token": syncToken }
    }), env);
    expect(envelopeResponse.status).toBe(403);
    await expect(envelopeResponse.json()).resolves.toMatchObject({ ok: false, error: "sync-authority-mismatch" });

    const usageWithSyncToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/usage/status", {
      headers: { "x-living-atlas-sync-token": syncToken }
    }), env);
    expect(usageWithSyncToken.status).toBe(401);
    await expect(usageWithSyncToken.json()).resolves.toMatchObject({ ok: false, error: "missing-or-invalid-usage-token" });
  });

  it("exposes token-gated remote MCP sync tools", async () => {
    const { env } = await createEnv();
    await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(ciphertextBatch)
    }), env);

    const unauthenticatedToolsResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list"
      })
    }), env);

    expect(unauthenticatedToolsResponse.status).toBe(401);
    await expect(unauthenticatedToolsResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 99,
      error: {
        message: "missing-or-invalid-mcp-token"
      }
    });

    const toolsResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list"
      })
    }), env);

    expect(toolsResponse.status).toBe(200);
    await expect(toolsResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "remote_sync_envelopes" }),
          expect.objectContaining({ name: "remote_access_modes" }),
          expect.objectContaining({ name: "remote_sensitive_decrypt" }),
          expect.objectContaining({ name: "remote_usage_gate" }),
          expect.objectContaining({ name: "remote_usage_reconcile" })
        ])
      }
    });

    const callResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "remote_sync_envelopes",
          arguments: {
            authority_id: "la_authority_worker0001",
            after_generation: 0
          }
        }
      })
    }), env);

    expect(callResponse.status).toBe(200);
    const body = await callResponse.json();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        structuredContent: {
          latest_generation: 1,
          objects: [
            {
              object: expect.objectContaining({
                object_id: "la_object_worker0001"
              })
            }
          ]
        }
      }
    });
    expect(JSON.stringify(body)).not.toContain(syncToken);

    const modesResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "remote_access_modes",
          arguments: {}
        }
      })
    }), env);

    await expect(modesResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 5,
      result: {
        structuredContent: {
          ok: true,
          current_mode: "remote-safe-only",
          modes: expect.arrayContaining([
            expect.objectContaining({
              mode: "remote-safe-only",
              host_blind_sensitive_plaintext: true
            }),
            expect.objectContaining({
              mode: "cloud-unlock-session",
              host_blind_sensitive_plaintext: false,
              required_header: "x-living-atlas-cloud-unlock-key"
            }),
            expect.objectContaining({
              mode: "local-keyholding-only",
              host_blind_sensitive_plaintext: true
            })
          ])
        }
      }
    });

    const deniedDecryptResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            object_id: "la_object_worker0001"
          }
        }
      })
    }), env);

    await expect(deniedDecryptResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 6,
      result: {
        structuredContent: {
          ok: false,
          reason: "cloud-unlock-capability-required",
          current_mode: "remote-safe-only"
        }
      }
    });

    const unlockKey = testToBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1)));
    const unlockedDecryptResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
        "x-living-atlas-cloud-unlock-key": unlockKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            authority_id: "la_authority_worker0001",
            object_id: "la_object_worker0001"
          }
        }
      })
    }), env);

    const unlockedBody = await unlockedDecryptResponse.json();
    expect(unlockedBody).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: {
        structuredContent: {
          ok: false,
          reason: "unsupported-payload",
          current_mode: "cloud-unlock-session",
          authority_id: "la_authority_worker0001",
          object_id: "la_object_worker0001",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: true
        }
      }
    });
    expect(JSON.stringify(unlockedBody)).not.toContain(unlockKey);

    const usageGateResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-usage-token": usageToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "remote_usage_gate",
          arguments: {
            window_hours: 6,
            max_budget_ratio: 0.8,
            min_worker_requests_remaining: 1
          }
        }
      })
    }), env);

    expect(usageGateResponse.status).toBe(200);
    const usageGateBody = await usageGateResponse.json();
    expect(usageGateBody).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        structuredContent: {
          ok: true,
          gate_schema: "living-atlas-usage-gate:v1",
          decision: "safe-to-test"
        }
      }
    });
    expect(JSON.stringify(usageGateBody)).not.toContain(syncToken);

    const usageReconcileResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-usage-token": usageToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "remote_usage_reconcile",
          arguments: {
            window_hours: 6,
            max_r2_objects: 10
          }
        }
      })
    }), env);

    expect(usageReconcileResponse.status).toBe(200);
    const usageReconcileBody = await usageReconcileResponse.json();
    expect(usageReconcileBody).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      result: {
        structuredContent: {
          reconciliation_schema: "living-atlas-usage-reconciliation:v1"
        }
      }
    });
    expect(JSON.stringify(usageReconcileBody)).not.toContain(syncToken);
  });

  it("rejects caller-selected authorities across remote MCP tools before storage, decrypt, or audit", async () => {
    const { env, graphBucket, controlDb } = await createEnv();
    const otherAuthorityId = "la_authority_other0001";
    const unlockKey = testToBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 99)));
    const otherPage = {
      ...ciphertextBatch.objects[0],
      authority_id: otherAuthorityId,
      access_class: "remote-safe",
      encryption_class: "plaintext",
      key_ref: undefined,
      visible_metadata: {
        ...ciphertextBatch.objects[0].visible_metadata,
        remote_indexable: true
      },
      payload: {
        kind: "plaintext-json",
        data: {
          title: "Wrong authority"
        }
      }
    };

    const mcpCall = async (id: number, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) => {
      const response = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-living-atlas-sync-token": syncToken,
          ...headers
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args }
        })
      }), env);
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        result?: {
          structuredContent?: Record<string, unknown>;
        };
        error?: {
          message?: string;
        };
      }>;
    };

    await expect(mcpCall(300, "remote_sensitive_decrypt", {
      authority_id: otherAuthorityId,
      object_id: "la_object_other0001"
    })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: false,
          reason: "cloud-unlock-capability-required"
        }
      }
    });
    expect(controlDb.records.some((record) => record.query.includes("INSERT INTO audit_events"))).toBe(false);

    await expect(mcpCall(301, "remote_sensitive_decrypt", {
      authority_id: otherAuthorityId,
      object_id: "la_object_other0001"
    }, {
      "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
      "x-living-atlas-cloud-unlock-key": unlockKey
    })).resolves.toMatchObject({
      error: { message: "decrypt-authority-mismatch" }
    });

    const mismatchCases: Array<[string, Record<string, unknown>, string]> = [
      ["remote_activity_audit", { authority_id: otherAuthorityId, limit: 5 }, "activity-authority-mismatch"],
      ["remote_graph_status", { authority_id: otherAuthorityId }, "graph-authority-mismatch"],
      ["remote_graph_reconcile", { authority_id: otherAuthorityId }, "graph-authority-mismatch"],
      ["remote_graph_list", { authority_id: otherAuthorityId }, "graph-authority-mismatch"],
      ["remote_graph_read", { authority_id: otherAuthorityId, object_id: "la_object_other0001" }, "graph-authority-mismatch"],
      ["remote_graph_create", { object: otherPage }, "graph-authority-mismatch"],
      ["remote_graph_update", { authority_id: otherAuthorityId, object_id: "la_object_other0001", patch: { visible_metadata: { tombstone: false } } }, "graph-authority-mismatch"],
      ["remote_graph_delete", { authority_id: otherAuthorityId, object_id: "la_object_other0001" }, "graph-authority-mismatch"],
      ["remote_semantic_search", { authority_id: otherAuthorityId, query: "wrong" }, "graph-authority-mismatch"],
      ["remote_graph_traverse", { authority_id: otherAuthorityId, start_object_id: "la_object_other0001" }, "graph-authority-mismatch"],
      ["remote_timeline_query", { authority_id: otherAuthorityId }, "graph-authority-mismatch"],
      ["remote_edge_create", { authority_id: otherAuthorityId, edge: { edge_id: "la_edge_other0001" } }, "graph-authority-mismatch"],
      ["remote_edge_read", { authority_id: otherAuthorityId, edge_id: "la_edge_other0001" }, "graph-authority-mismatch"],
      ["remote_edge_update", { authority_id: otherAuthorityId, edge_id: "la_edge_other0001", patch: { status: "ended" } }, "graph-authority-mismatch"],
      ["remote_edge_delete", { authority_id: otherAuthorityId, edge_id: "la_edge_other0001" }, "graph-authority-mismatch"],
      ["remote_sync_pull", { authority_id: otherAuthorityId, after_generation: 0 }, "sync-authority-mismatch"],
      ["remote_sync_envelopes", { authority_id: otherAuthorityId, after_generation: 0 }, "sync-authority-mismatch"]
    ];

    for (const [name, args, message] of mismatchCases) {
      await expect(mcpCall(400 + mismatchCases.findIndex((entry) => entry[0] === name), name, args)).resolves.toMatchObject({
        error: { message }
      });
    }

    await expect(mcpCall(500, "remote_usage_gate", { window_hours: 6 })).resolves.toMatchObject({
      error: { message: "missing-or-invalid-usage-token" }
    });
    await expect(mcpCall(501, "remote_usage_reconcile", { window_hours: 6 })).resolves.toMatchObject({
      error: { message: "missing-or-invalid-usage-token" }
    });
    expect(graphBucket.puts).toHaveLength(0);
    expect(controlDb.records.some((record) => record.query.includes("INSERT OR IGNORE INTO sync_batches"))).toBe(false);
    expect(controlDb.records.some((record) => record.query.includes("INSERT INTO remote_graph_objects"))).toBe(false);
    expect(controlDb.records.some((record) => record.query.includes("INSERT INTO audit_events"))).toBe(false);
  });

  it("decrypts a cloud-unlock inline ciphertext object with a transient request key", async () => {
    const { env } = await createEnv();
    const rawKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 21));
    const unlockKey = testToBase64(rawKey);
    const wrongUnlockKey = testToBase64(new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 55)));
    const batch = await cloudUnlockBatch(rawKey);

    const syncResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(batch)
    }), env);
    expect(syncResponse.status).toBe(202);

    const wrongKeyResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
        "x-living-atlas-cloud-unlock-key": wrongUnlockKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            authority_id: "la_authority_worker0001",
            object_id: "la_object_cloudunlock0001"
          }
        }
      })
    }), env);

    const wrongKeyBody = await wrongKeyResponse.json();
    expect(wrongKeyBody).toMatchObject({
      jsonrpc: "2.0",
      id: 8,
      result: {
        structuredContent: {
          ok: false,
          reason: "decrypt-failed",
          current_mode: "cloud-unlock-session",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: true
        }
      }
    });
    expect(JSON.stringify(wrongKeyBody)).not.toContain(wrongUnlockKey);

    const missingCapabilityResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-cloud-unlock-key": unlockKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 88,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            authority_id: "la_authority_worker0001",
            object_id: "la_object_cloudunlock0001"
          }
        }
      })
    }), env);

    const missingCapabilityBody = await missingCapabilityResponse.json();
    expect(missingCapabilityBody).toMatchObject({
      jsonrpc: "2.0",
      id: 88,
      result: {
        structuredContent: {
          ok: false,
          reason: "cloud-unlock-capability-required",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: true
        }
      }
    });
    expect(JSON.stringify(missingCapabilityBody)).not.toContain(unlockKey);

    const decryptResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
        "x-living-atlas-cloud-unlock-key": unlockKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            authority_id: "la_authority_worker0001",
            object_id: "la_object_cloudunlock0001"
          }
        }
      })
    }), env);

    const decryptBody = await decryptResponse.json();
    expect(decryptBody).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      result: {
        structuredContent: {
          ok: true,
          current_mode: "cloud-unlock-session",
          authority_id: "la_authority_worker0001",
          object_id: "la_object_cloudunlock0001",
          object_type: "page",
          version: 1,
          access_class: "local-private",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: false,
          payload: {
            kind: "plaintext-json",
            data: {
              title: "Synthetic sensitive note",
              body: "Cloud unlock plaintext only appears after the transient key is supplied."
            }
          }
        }
      }
    });
    expect(JSON.stringify(decryptBody)).not.toContain(unlockKey);
    const encryptedPayload = batch.objects[0]!.payload;
    expect(encryptedPayload.kind).toBe("ciphertext-inline");
    if (encryptedPayload.kind === "ciphertext-inline") {
      expect(JSON.stringify(decryptBody)).not.toContain(encryptedPayload.ciphertext);
    }

    const auditResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: {
          name: "remote_activity_audit",
          arguments: {
            authority_id: "la_authority_worker0001",
            limit: 20
          }
        }
      })
    }), env);

    const auditBody = await auditResponse.json();
    expect(auditBody).toMatchObject({
      jsonrpc: "2.0",
      id: 10,
      result: {
        structuredContent: {
          events: expect.arrayContaining([
            expect.objectContaining({
              audit: expect.objectContaining({
                operation: "decrypt",
                event_type: "object.decrypt",
                outcome: "allowed",
                redaction: "remote-redacted",
                mcp_profile: "remote-cloud-unlock"
              }),
              refs: expect.objectContaining({
                object_ref: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
              })
            })
          ])
        }
      }
    });
    expect(JSON.stringify(auditBody)).not.toContain(unlockKey);
    if (encryptedPayload.kind === "ciphertext-inline") {
      expect(JSON.stringify(auditBody)).not.toContain(encryptedPayload.ciphertext);
    }
    expect(JSON.stringify(auditBody)).not.toContain("Synthetic sensitive note");
  });

  it("allows cloud-unlock MCP credentials through stealth ingress", async () => {
    const { env } = await createEnv();
    const rawKey = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 31));
    const unlockKey = testToBase64(rawKey);
    const batch = await cloudUnlockBatch(rawKey);

    const syncResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify(batch)
    }), env);
    expect(syncResponse.status).toBe(202);

    env.LA_STEALTH_MODE = "1";
    env.LA_SYNC_CAPABILITY_ID = "la_cap_sync0001";

    const decryptResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken,
        "x-living-atlas-sync-capability-id": cloudUnlockCapabilityId,
        "x-living-atlas-cloud-unlock-key": unlockKey
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "tools/call",
        params: {
          name: "remote_sensitive_decrypt",
          arguments: {
            authority_id: "la_authority_worker0001",
            object_id: "la_object_cloudunlock0001"
          }
        }
      })
    }), env);

    expect(decryptResponse.status).toBe(200);
    await expect(decryptResponse.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 91,
      result: {
        structuredContent: {
          ok: true,
          current_mode: "cloud-unlock-session",
          key_persisted_by_cloudflare: false,
          host_blind_sensitive_plaintext: false
        }
      }
    });
  });

  it("supports remote-readable graph CRUD, search, traversal, timeline, and edge CRUD through MCP", async () => {
    const { env } = await createEnv();
    const mcpCall = async (id: number, name: string, args: Record<string, unknown>) => {
      const response = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-living-atlas-sync-token": syncToken
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args }
        })
      }), env);
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        result?: {
          structuredContent?: Record<string, unknown>;
        };
        error?: unknown;
      }>;
    };
    const authorityId = "la_authority_worker0001";
    const sourceId = "la_object_remotecrudsource0001";
    const targetId = "la_object_remotecrudtarget0001";
    const page = {
      schema_version: 1,
      authority_id: authorityId,
      object_id: sourceId,
      object_type: "page",
      version: 1,
      access_class: "remote-safe",
      encryption_class: "plaintext",
      created_at: timestamp,
      updated_at: timestamp,
      content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      visible_metadata: {
        schema_namespace: "synthetic/remote-crud",
        tombstone: false,
        size_class: "tiny",
        remote_indexable: true
      },
      payload: {
        kind: "plaintext-json",
        data: {
          title: "Remote Atlas Knowledge Seed",
          body: "Mercury Atlas search target with timeline context.",
          occurred_on: "2026-06-21"
        }
      }
    };
    const target = {
      ...page,
      object_id: targetId,
      content_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      payload: {
        kind: "plaintext-json",
        data: {
          title: "Remote Atlas Target",
          body: "Traversal target."
        }
      }
    };

    await expect(mcpCall(10, "remote_graph_create", { object: page })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "created",
          object: expect.objectContaining({ object_id: sourceId }),
          sync_generation: 1,
          sync_batch_id: expect.stringMatching(/^la_sync_batch_/)
        }
      }
    });
    await expect(mcpCall(101, "remote_graph_create", { object: page })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "created",
          idempotent_replay: true,
          object: expect.objectContaining({ object_id: sourceId }),
          sync_generation: 1
        }
      }
    });
    await expect(mcpCall(11, "remote_graph_create", { object: target })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          sync_generation: 2
        }
      }
    });

    await expect(mcpCall(110, "remote_sync_envelopes", { authority_id: authorityId, after_generation: 0 })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          latest_generation: 2,
          objects: expect.arrayContaining([
            expect.objectContaining({
              generation: 1,
              object: expect.objectContaining({
                object_id: sourceId,
                payload: expect.objectContaining({ kind: "plaintext-json" })
              })
            }),
            expect.objectContaining({
              generation: 2,
              object: expect.objectContaining({ object_id: targetId })
            })
          ])
        }
      }
    });

    await expect(mcpCall(12, "remote_graph_read", { authority_id: authorityId, object_id: sourceId })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          object: expect.objectContaining({
            object_id: sourceId,
            payload: expect.objectContaining({
              data: expect.objectContaining({ title: "Remote Atlas Knowledge Seed" })
            })
          })
        }
      }
    });

    await expect(mcpCall(13, "remote_semantic_search", { authority_id: authorityId, query: "Mercury Atlas", limit: 5 })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          search_mode: "deterministic-text-v1",
          results: expect.arrayContaining([
            expect.objectContaining({
              object: expect.objectContaining({ object_id: sourceId }),
              score: expect.any(Number)
            })
          ])
        }
      }
    });

    const expiredReleaseId = "la_object_expiredrelease0001";
    const expiredRelease = {
      ...page,
      object_id: expiredReleaseId,
      access_class: "release",
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      visible_metadata: {
        ...page.visible_metadata,
        release_expires_at: "2026-01-01T00:00:00.000Z"
      },
      payload: {
        kind: "plaintext-json",
        data: {
          title: "Expired Release",
          body: "Expired release search target."
        }
      }
    };

    await expect(mcpCall(130, "remote_graph_create", { object: expiredRelease })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          sync_generation: 3
        }
      }
    });
    await expect(mcpCall(131, "remote_graph_read", { authority_id: authorityId, object_id: expiredReleaseId })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: false,
          reason: "release-expired"
        }
      }
    });
    await expect(mcpCall(132, "remote_graph_list", { authority_id: authorityId, limit: 20 })).resolves.not.toMatchObject({
      result: {
        structuredContent: {
          objects: expect.arrayContaining([
            expect.objectContaining({ object_id: expiredReleaseId })
          ])
        }
      }
    });
    await expect(mcpCall(133, "remote_semantic_search", { authority_id: authorityId, query: "Expired Release", limit: 5 })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          results: []
        }
      }
    });

    await expect(mcpCall(14, "remote_graph_update", {
      authority_id: authorityId,
      object_id: sourceId,
      expected_version: 1,
      patch: {
        payload: {
          kind: "plaintext-json",
          data: {
            title: "Remote Atlas Knowledge Seed",
            body: "Mercury Atlas search target updated.",
            occurred_on: "2026-06-22"
          }
        }
      }
    })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "updated",
          object: expect.objectContaining({ version: 2 }),
          sync_generation: 4
        }
      }
    });
    await expect(mcpCall(114, "remote_graph_update", {
      authority_id: authorityId,
      object_id: sourceId,
      expected_version: 1,
      patch: {
        payload: {
          kind: "plaintext-json",
          data: {
            title: "Remote Atlas Knowledge Seed",
            body: "Mercury Atlas search target updated.",
            occurred_on: "2026-06-22"
          }
        }
      }
    })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "updated",
          idempotent_replay: true,
          object: expect.objectContaining({ version: 2 }),
          sync_generation: 4
        }
      }
    });

    const edge = {
      edge_id: "la_edge_remotecrud0001",
      source_object_id: sourceId,
      source_type: "person",
      target_object_id: targetId,
      target_type: "project",
      predicate: "advises",
      valid_from: "2026-06",
      status: "active",
      confidence: "high",
      source: "synthetic remote MCP test",
      attrs: {
        scope: "remote graph traversal"
      }
    };
    await expect(mcpCall(15, "remote_edge_create", { authority_id: authorityId, edge })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "created",
          object: expect.objectContaining({ object_type: "edge" }),
          sync_generation: 5
        }
      }
    });

    await expect(mcpCall(16, "remote_graph_traverse", {
      authority_id: authorityId,
      start_object_id: sourceId,
      direction: "outbound",
      predicates: ["advisor-to"],
      max_depth: 1
    })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          visited_object_ids: expect.arrayContaining([sourceId, targetId]),
          edges: [expect.objectContaining({ object_type: "edge" })]
        }
      }
    });

    await expect(mcpCall(17, "remote_timeline_query", { authority_id: authorityId, from: "2026-06", to: "2026-06-30", predicate: "advises" })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          results: expect.arrayContaining([
            expect.objectContaining({
              field: "edge.valid_from",
              timeline_at: "2026-06"
            })
          ])
        }
      }
    });

    await expect(mcpCall(18, "remote_edge_update", {
      authority_id: authorityId,
      edge_id: "la_edge_remotecrud0001",
      expected_version: 1,
      patch: {
        status: "ended",
        valid_to: "2026-06-22"
      }
    })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "updated",
          object: expect.objectContaining({ version: 2 }),
          sync_generation: 6
        }
      }
    });

    await expect(mcpCall(19, "remote_edge_read", { authority_id: authorityId, edge_id: "la_edge_remotecrud0001" })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          object: expect.objectContaining({
            payload: expect.objectContaining({
              data: expect.objectContaining({ status: "ended" })
            })
          })
        }
      }
    });

    await expect(mcpCall(20, "remote_graph_delete", { authority_id: authorityId, object_id: sourceId, expected_version: 2 })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          mutation: "deleted",
          sync_generation: 7,
          object: expect.objectContaining({
            version: 3,
            visible_metadata: expect.objectContaining({ tombstone: true })
          })
        }
      }
    });

    await expect(mcpCall(200, "remote_graph_read", { authority_id: authorityId, object_id: sourceId })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: false,
          reason: "object-not-found"
        }
      }
    });
    await expect(mcpCall(201, "remote_timeline_query", { authority_id: authorityId, object_id: sourceId, from: "2026-06", to: "2026-06-30" })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          results: []
        }
      }
    });

    await expect(mcpCall(210, "remote_graph_reconcile", { authority_id: authorityId })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          reconciliation_schema: "living-atlas-remote-graph-reconciliation:v1",
          decision: "reconciled",
          remote_graph_index: {
            indexed_versions: 7,
            latest_object_count: 4,
            active_object_count: 2,
            tombstone_count: 1
          },
          sync_envelopes: {
            latest_generation: 7,
            remote_readable_object_versions: 7
          },
          drift: {
            remote_graph_versions_missing_sync_envelope: 0,
            remote_readable_sync_versions_missing_remote_graph_index: 0
          }
        }
      }
    });

    await expect(mcpCall(21, "remote_graph_create", {
      object: ciphertextBatch.objects[0]
    })).resolves.toMatchObject({
      error: {
        message: "remote graph objects must be remote-readable plaintext"
      }
    });

    await expect(mcpCall(22, "remote_activity_audit", { authority_id: authorityId, limit: 50 })).resolves.toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
          events: expect.arrayContaining([
            expect.objectContaining({
              audit: expect.objectContaining({
                event_type: "object.create",
                redaction: "remote-redacted"
              }),
              refs: expect.objectContaining({
                object_ref: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                sync_batch_ref: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
              })
            }),
            expect.objectContaining({
              audit: expect.objectContaining({
                event_type: "object.read",
                redaction: "remote-redacted"
              })
            }),
            expect.objectContaining({
              audit: expect.objectContaining({
                event_type: "object.delete",
                redaction: "remote-redacted"
              })
            })
          ])
        }
      }
    });

    const auditResponse = await mcpCall(23, "remote_activity_audit", { authority_id: authorityId, limit: 50 });
    expect(JSON.stringify(auditResponse)).not.toContain("Remote Atlas Knowledge Seed");
    expect(JSON.stringify(auditResponse)).not.toContain("Mercury Atlas");
    expect(JSON.stringify(auditResponse)).not.toContain(syncToken);
  });

  it("rejects sync tokens in query strings", async () => {
    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/batch?sync_token=fixture-sync-token-0001", {
      method: "POST",
      body: JSON.stringify(ciphertextBatch)
    }), (await createEnv()).env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "sync token must not be sent in the query string"
    });

    const statusResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/status?sync_token=fixture-sync-token-0001", {
      method: "GET"
    }), (await createEnv()).env);

    expect(statusResponse.status).toBe(400);
    await expect(statusResponse.json()).resolves.toEqual({
      ok: false,
      error: "sync token must not be sent in the query string"
    });

    const envelopeResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/api/sync/envelopes?sync_token=fixture-sync-token-0001", {
      method: "GET"
    }), (await createEnv()).env);

    expect(envelopeResponse.status).toBe(400);
    await expect(envelopeResponse.json()).resolves.toEqual({
      ok: false,
      error: "sync token must not be sent in the query string"
    });

    const mcpResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp?sync_token=fixture-sync-token-0001", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    }), (await createEnv()).env);

    expect(mcpResponse.status).toBe(400);
    await expect(mcpResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "tokens must not be sent in the query string"
      },
      id: null
    });

    const cloudUnlockQueryResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp?cloud_unlock_key=synthetic-cloud-unlock-key-0001", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    }), (await createEnv()).env);

    expect(cloudUnlockQueryResponse.status).toBe(400);
    await expect(cloudUnlockQueryResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "tokens must not be sent in the query string"
      },
      id: null
    });

    const accessTokenQueryResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp?access_token=fixture-sync-token-0001", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
    }), (await createEnv()).env);

    expect(accessTokenQueryResponse.status).toBe(400);
    await expect(accessTokenQueryResponse.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message: "tokens must not be sent in the query string"
      },
      id: null
    });
  });
});
