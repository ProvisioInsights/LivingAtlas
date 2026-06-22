import { handleBootstrapRequest, type BootstrapWorkerEnv } from "../../cloudflare-worker/src/worker";
import type { SyncMetadataStore, SyncObjectStore } from "../../cloudflare-worker/src/sync-storage";

export type R2PutRecord = {
  key: string;
  value: string;
  options: unknown;
};

export type D1RunRecord = {
  query: string;
  bindings: unknown[];
};

type StoredBatch = {
  batch_id: string;
  idempotency_key: string;
  batch_hash: string;
  authority_ref: string;
  submitted_at: string;
  base_generation: number;
  target_generation: number;
  object_count: number;
  change_count: number;
  withheld_plaintext_count: number;
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

class LocalPreparedStatement {
  constructor(
    private readonly records: D1RunRecord[],
    private readonly query: string,
    private readonly bindings: unknown[] = []
  ) {}

  bind(...values: unknown[]): LocalPreparedStatement {
    return new LocalPreparedStatement(this.records, this.query, values);
  }

  private committedBatchIdSet(): Set<string> {
    return new Set(
      this.records
        .filter((record) => record.query.includes("UPDATE sync_batches"))
        .map((record) => String(record.bindings[2]))
    );
  }

  private committedBatches(authorityRef?: string): StoredBatch[] {
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

  private committedBatchIds(authorityRef?: string): Set<string> {
    return new Set(this.committedBatches(authorityRef).map((batch) => batch.batch_id));
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.includes("WHERE idempotency_key = ?")) {
      const idempotencyKey = String(this.bindings[0]);
      return (this.committedBatches().find((batch) => batch.idempotency_key === idempotencyKey) ?? null) as T | null;
    }

    if (this.query.includes("COUNT(*) AS count") && this.query.includes("FROM sync_objects")) {
      const authorityRef = this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined;
      const committed = this.committedBatchIds(authorityRef);
      return {
        count: this.records
          .filter((record) => record.query.includes("INTO sync_objects"))
          .filter((record) => committed.has(String(record.bindings[1])))
          .length
      } as T;
    }

    if (this.query.includes("COUNT(*) AS count") && this.query.includes("FROM sync_changes")) {
      const authorityRef = this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined;
      const committed = this.committedBatchIds(authorityRef);
      return {
        count: this.records
          .filter((record) => record.query.includes("INTO sync_changes"))
          .filter((record) => committed.has(String(record.bindings[1])))
          .length
      } as T;
    }

    if (this.query.includes("FROM sync_batches")) {
      const authorityRef = this.query.includes("authority_ref = ?") ? String(this.bindings[0]) : undefined;
      const batches = this.committedBatches(authorityRef)
        .sort((left, right) => right.target_generation - left.target_generation || right.submitted_at.localeCompare(left.submitted_at));

      return (batches[0] ?? null) as T | null;
    }

    return null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.records.push({ query: this.query, bindings: this.bindings });
    return fakeD1Result<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
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

class LocalD1Session {
  constructor(private readonly records: D1RunRecord[]) {}

  prepare(query: string): LocalPreparedStatement {
    return new LocalPreparedStatement(this.records, query);
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }

  getBookmark(): D1SessionBookmark | null {
    return null;
  }
}

export class LocalD1Database implements SyncMetadataStore {
  readonly records: D1RunRecord[] = [];

  prepare(query: string): LocalPreparedStatement {
    return new LocalPreparedStatement(this.records, query);
  }

  async batch<T = unknown>(): Promise<D1Result<T>[]> {
    return [];
  }

  async exec(_query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  withSession(): D1DatabaseSession {
    return new LocalD1Session(this.records) as D1DatabaseSession;
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }
}

export class LocalR2Bucket implements SyncObjectStore {
  readonly puts: R2PutRecord[] = [];

  constructor(private readonly uploadedAt: string) {}

  async put(key: string, value: string, options?: Parameters<SyncObjectStore["put"]>[2]): Promise<R2Object> {
    this.puts.push({ key, value, options });
    return {
      key,
      version: "local-harness-version",
      size: value.length,
      etag: "local-harness-etag",
      httpEtag: "\"local-harness-etag\"",
      uploaded: new Date(this.uploadedAt),
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
}

export function createWorkerFetch(env: BootstrapWorkerEnv): typeof fetch {
  return async (input, init) => handleBootstrapRequest(new Request(input, init), env);
}
