/**
 * Shared in-memory D1 / R2 test doubles for worker-level tests.
 *
 * Extracted verbatim (behaviour-preserving) from sync.test.ts so multiple test
 * files (sync, escalation, ...) can drive the real worker request handler
 * against the same fake storage without duplicating ~470 lines of D1 SQL
 * emulation. NOT shipped — test-only.
 */
import type { SyncMetadataStore, SyncObjectStore } from "./sync-storage";

const doublesTimestamp = "2026-06-21T12:00:00.000Z";

export type R2PutRecord = {
  key: string;
  value: string;
  options: unknown;
};

export type D1RunRecord = {
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

export class FakePreparedStatement {
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
        predicate: record.bindings[13] === null ? undefined : String(record.bindings[13]),
        recorded_at: String(record.bindings[19])
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
      authority_ref: string;
      status: "staged" | "committed" | "failed";
      response_json: string | null;
      failure_reason: string | null;
      sync_generation: number | null;
      committed_at: string | null;
      created_at: string;
    }>();

    for (const record of this.records) {
      if (record.query.includes("INTO remote_graph_writes")) {
        rows.set(String(record.bindings[0]), {
          idempotency_key: String(record.bindings[0]),
          request_hash: String(record.bindings[1]),
          authority_ref: String(record.bindings[2]),
          status: "staged",
          response_json: null,
          failure_reason: null,
          sync_generation: null,
          committed_at: null,
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
            failure_reason: null,
            sync_generation: Number(record.bindings[1]),
            committed_at: String(record.bindings[3])
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

    if (this.query.includes("FROM remote_graph_writes")) {
      const authorityRef = String(this.bindings[0]);
      const limit = Number(this.bindings[1] ?? 100);
      return fakeD1Result<T>(
        this.remoteGraphWriteRows()
          .filter((row) => row.authority_ref === authorityRef && row.status === "committed")
          .sort((left, right) => (
            (right.sync_generation ?? 0) - (left.sync_generation ?? 0)
            || (right.committed_at ?? "").localeCompare(left.committed_at ?? "")
          ))
          .slice(0, limit)
          .map((row) => ({
            response_json: row.response_json,
            sync_generation: row.sync_generation,
            committed_at: row.committed_at
          })) as T[]
      );
    }

    if (this.query.includes("FROM remote_graph_objects")) {
      const authorityRef = String(this.bindings[0]);
      const limit = Number(this.bindings[1] ?? 1000);
      return fakeD1Result<T>(
        this.remoteGraphRows(authorityRef)
          .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at))
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

export class FakeD1Session {
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

export class FakeD1Database implements SyncMetadataStore {
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

export class FakeR2Bucket implements SyncObjectStore {
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
      uploaded: new Date(doublesTimestamp),
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
    throw new Error("multipart uploads are not used in these tests");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("multipart uploads are not used in these tests");
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
