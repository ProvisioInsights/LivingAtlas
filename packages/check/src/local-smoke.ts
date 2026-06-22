import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { fixtureAuthorityId, fixtureDeviceId, fixtureUserId, sensitiveBaitRegistry } from "@living-atlas/fixtures";
import { buildCiphertextSyncBatch } from "@living-atlas/sync-agent";
import { BootstrapClaimLockCore, InMemoryBootstrapClaimLockStorage } from "../../cloudflare-worker/src/bootstrap-lock";
import { sha256TokenHash } from "../../cloudflare-worker/src/bootstrap";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "../../cloudflare-worker/src/worker";
import type { SyncMetadataStore, SyncObjectStore } from "../../cloudflare-worker/src/sync-storage";

type R2PutRecord = {
  key: string;
  value: string;
  options: unknown;
};

type D1RunRecord = {
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

type JsonObject = Record<string, unknown>;

const baseUrl = "https://living-atlas.local";
const bootstrapToken = "synthetic-bootstrap-token-local-smoke-0001";
const syncToken = "synthetic-sync-token-local-smoke-0001";
const syncTokenId = "la_sync_token_smoke0001";
const now = "2026-06-22T12:00:00.000Z";

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

class LocalD1Database implements SyncMetadataStore {
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

class LocalR2Bucket implements SyncObjectStore {
  readonly puts: R2PutRecord[] = [];

  async put(key: string, value: string, options?: Parameters<SyncObjectStore["put"]>[2]): Promise<R2Object> {
    this.puts.push({ key, value, options });
    return {
      key,
      version: "local-smoke-version",
      size: value.length,
      etag: "local-smoke-etag",
      httpEtag: "\"local-smoke-etag\"",
      uploaded: new Date(now),
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function expectJson<T extends JsonObject>(
  label: string,
  response: Response,
  expectedStatus: number,
  outputs: string[]
): Promise<T> {
  const text = await response.text();
  outputs.push(text);
  assert(response.status === expectedStatus, `${label} expected HTTP ${expectedStatus}, got ${response.status}: ${text}`);
  const body = JSON.parse(text) as T;
  console.log(`ok ${label} -> ${response.status}`);
  return body;
}

function workerRequest(env: BootstrapWorkerEnv, path: string, init?: RequestInit): Promise<Response> {
  return handleBootstrapRequest(new Request(new URL(path, baseUrl), init), env);
}

function syncHeaders(batch: { client_id: string; capability_id?: string; token_id?: string }): HeadersInit {
  return {
    "content-type": "application/json",
    "x-living-atlas-sync-token": syncToken,
    "x-living-atlas-sync-client-id": batch.client_id,
    ...(batch.capability_id ? { "x-living-atlas-sync-capability-id": batch.capability_id } : {}),
    ...(batch.token_id ? { "x-living-atlas-sync-token-id": batch.token_id } : {})
  };
}

function assertNoLeak(outputs: string[], graphBucket: LocalR2Bucket): void {
  const combined = [
    ...outputs,
    ...graphBucket.puts.map((record) => record.value),
    ...graphBucket.puts.map((record) => JSON.stringify(record.options))
  ].join("\n");

  for (const token of [bootstrapToken, syncToken]) {
    assert(!combined.includes(token), `local smoke output leaked token: ${token}`);
  }

  for (const bait of sensitiveBaitRegistry) {
    assert(!combined.includes(bait.value), `local smoke output leaked sensitive bait: ${bait.id}`);
  }
}

async function main(): Promise<void> {
  const outputs: string[] = [];
  const graphBucket = new LocalR2Bucket();
  const controlDb = new LocalD1Database();
  const claimLock = new BootstrapClaimLockCore(new InMemoryBootstrapClaimLockStorage());
  const controlState = await createFixtureLocalControlState("local-smoke-local-mcp-token-0001");
  const batch = buildCiphertextSyncBatch({
    controlState,
    tokenId: syncTokenId,
    baseGeneration: 0,
    targetGeneration: 1,
    now
  }).batch;
  const staleBatch = buildCiphertextSyncBatch({
    controlState,
    tokenId: syncTokenId,
    baseGeneration: 0,
    targetGeneration: 1,
    now: "2026-06-22T12:01:00.000Z"
  }).batch;

  const env: BootstrapWorkerEnv = {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => claimLock
    },
    LA_GRAPH_BUCKET: graphBucket as unknown as R2Bucket,
    LA_CONTROL_DB: controlDb as unknown as D1Database,
    BOOTSTRAP_CLAIM_TOKEN_HASH: await sha256TokenHash(bootstrapToken),
    BOOTSTRAP_TOKEN_EXPIRES_AT: "2026-06-23T00:00:00.000Z",
    LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken),
    LA_SYNC_CLIENT_ID: batch.client_id,
    LA_SYNC_CAPABILITY_ID: batch.capability_id,
    LA_SYNC_TOKEN_ID: syncTokenId
  };

  const health = await expectJson("health", await workerRequest(env, "/healthz"), 200, outputs);
  assert(health.ok === true, "health route did not report ok");

  const initialStatus = await expectJson("bootstrap status", await workerRequest(env, "/api/bootstrap/status"), 200, outputs);
  assert(initialStatus.bootstrap_state === "unclaimed", "bootstrap status should start unclaimed");

  const claimPayload = {
    authority_id: fixtureAuthorityId,
    user_id: fixtureUserId,
    device_id: fixtureDeviceId,
    device_public_key_hash: "synthetic-device-public-key-hash",
    policy_generation: 1,
    wrapped_keys: [
      {
        key_id: "la_key_smoketest0001",
        wrapping_device_id: fixtureDeviceId,
        algorithm: "synthetic-fixture",
        ciphertext: "synthetic-wrapped-key-ciphertext"
      }
    ],
    initial_remote_config: {
      remote_mcp_enabled: true,
      fixture_only: true
    }
  };

  const claim = await expectJson("bootstrap claim", await workerRequest(env, "/api/bootstrap/claim", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-living-atlas-bootstrap-token": bootstrapToken
    },
    body: JSON.stringify(claimPayload)
  }), 201, outputs);
  assert(claim.ok === true, "bootstrap claim did not succeed");

  const accepted = await expectJson("sync batch push", await workerRequest(env, "/api/sync/batch", {
    method: "POST",
    headers: syncHeaders(batch),
    body: JSON.stringify(batch)
  }), 202, outputs);
  assert(accepted.accepted_objects === 3, "sync push should accept three encrypted/remote-readable envelopes");
  assert(accepted.accepted_changes === 3, "sync push should accept three change events");
  assert(accepted.withheld_plaintext_count === 3, "sync push should withhold three plaintext fixtures");
  assert(graphBucket.puts.length === 3, "sync push should persist three object envelopes");

  const syncStatus = await expectJson("sync status", await workerRequest(env, "/api/sync/status", {
    headers: syncHeaders(batch)
  }), 200, outputs);
  assert(syncStatus.latest_generation === 1, "sync status should report generation 1");
  assert(syncStatus.object_count === 3, "sync status should count three stored objects");
  assert(syncStatus.change_count === 3, "sync status should count three stored changes");

  const pull = await expectJson("sync pull", await workerRequest(env, `/api/sync/pull?authority_id=${fixtureAuthorityId}&after_generation=0`, {
    headers: syncHeaders(batch)
  }), 200, outputs);
  assert(Array.isArray(pull.batches), "sync pull should include a batches array");
  assert(pull.batches.length === 1, "sync pull should return one batch");
  assert((pull.next_cursor as { generation?: unknown } | undefined)?.generation === 1, "sync pull should advance cursor to generation 1");

  const duplicate = await expectJson("duplicate replay", await workerRequest(env, "/api/sync/batch", {
    method: "POST",
    headers: syncHeaders(batch),
    body: JSON.stringify(batch)
  }), 202, outputs);
  assert(duplicate.idempotent_replay === true, "duplicate sync batch should be idempotent replay");
  assert(graphBucket.puts.length === 3, "duplicate replay should not write more object envelopes");

  const stale = await expectJson("stale conflict", await workerRequest(env, "/api/sync/batch", {
    method: "POST",
    headers: syncHeaders(staleBatch),
    body: JSON.stringify(staleBatch)
  }), 409, outputs);
  assert(stale.error === "stale-generation", "stale same-generation batch should conflict");
  assert(graphBucket.puts.length === 3, "stale conflict should not write more object envelopes");

  const queryToken = await expectJson("query token rejection", await workerRequest(env, `/api/sync/status?sync_token=${syncToken}`, {
    headers: syncHeaders(batch)
  }), 400, outputs);
  assert(String(queryToken.error).includes("query string"), "query token rejection should explain the token placement rule");

  assertNoLeak(outputs, graphBucket);
  console.log(`ok leakage guard -> no sync/bootstrap tokens or sensitive bait in ${outputs.length} responses and ${graphBucket.puts.length} R2 envelopes`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
