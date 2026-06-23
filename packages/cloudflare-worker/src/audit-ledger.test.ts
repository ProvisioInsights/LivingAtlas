import { describe, expect, it } from "vitest";
import type { DurableAuditEvent } from "@living-atlas/contracts";
import {
  appendAuditEvent,
  readPraxisActivityAuditStream,
  readAuditLedgerEvents,
  type AuditLedgerMetadataStore,
  type StoredAuditLedgerEvent
} from "./audit-ledger";
import { sha256TokenHash } from "./bootstrap";
import { handleBootstrapRequest, type BootstrapWorkerEnv } from "./worker";

const timestamp = "2026-06-22T12:00:00.000Z";
const syncToken = "fixture-sync-token-0001";
const genesisAuditHash = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

type D1RunRecord = {
  query: string;
  bindings: unknown[];
};

function fakeD1Result<T>(results: T[] = [], changes = 0): D1Result<T> {
  return {
    success: true,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes
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

  private auditRows(): StoredAuditLedgerEvent[] {
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
      }));
  }

  async first<T = unknown>(_colName?: string): Promise<T | null> {
    if (this.query.includes("SELECT event_hash") && this.query.includes("FROM audit_events")) {
      const authorityRef = String(this.bindings[0]);
      const latest = this.auditRows()
        .filter((row) => row.authority_ref === authorityRef)
        .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at) || right.audit_id.localeCompare(left.audit_id))[0];

      return (latest ? { event_hash: latest.event_hash } : null) as T | null;
    }

    return null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes("INSERT INTO audit_events")) {
      const conditionOffset = this.bindings.length - 9;
      const previousEventHash = this.bindings[conditionOffset] === null ? null : String(this.bindings[conditionOffset]);
      const genesisHash = String(this.bindings[conditionOffset + 2]);
      const authorityRef = String(this.bindings[conditionOffset + 3]);
      const currentLatest = this.auditRows()
        .filter((row) => row.authority_ref === authorityRef)
        .sort((left, right) => right.recorded_at.localeCompare(left.recorded_at) || right.audit_id.localeCompare(left.audit_id))[0]?.event_hash ?? null;

      const canAppend = currentLatest === null
        ? previousEventHash === null || previousEventHash === genesisHash
        : previousEventHash === currentLatest;
      if (!canAppend) {
        return fakeD1Result<T>([], 0);
      }

      this.records.push({ query: this.query, bindings: this.bindings });
      return fakeD1Result<T>([], 1);
    }

    this.records.push({ query: this.query, bindings: this.bindings });
    return fakeD1Result<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.query.includes("FROM audit_events")) {
      const limit = Number(this.bindings.at(-1));
      const cursorIndex = this.query.includes("recorded_at < ?") ? this.bindings.length - 4 : -1;
      const cursorRecordedAt = cursorIndex >= 0 ? String(this.bindings[cursorIndex]) : undefined;
      const cursorAuditId = cursorIndex >= 0 ? String(this.bindings[cursorIndex + 2]) : undefined;
      return fakeD1Result<T>(
        this.auditRows()
          .filter((row) => {
            if (!cursorRecordedAt || !cursorAuditId) {
              return true;
            }
            return row.recorded_at < cursorRecordedAt || (row.recorded_at === cursorRecordedAt && row.audit_id < cursorAuditId);
          })
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

class FakeD1Database implements AuditLedgerMetadataStore {
  readonly records: D1RunRecord[] = [];

  prepare(query: string): FakePreparedStatement {
    return new FakePreparedStatement(this.records, query);
  }
}

async function createEnv(controlDb = new FakeD1Database()): Promise<BootstrapWorkerEnv> {
  return {
    BOOTSTRAP_CLAIM_LOCK: {
      getByName: () => {
        throw new Error("bootstrap lock should not be used by audit tests");
      }
    },
    LA_GRAPH_BUCKET: {} as R2Bucket,
    LA_CONTROL_DB: controlDb as unknown as D1Database,
    LA_AUTHORITY_ID: "la_authority_audit0001",
    LA_SYNC_TOKEN_HASH: await sha256TokenHash(syncToken)
  };
}

function auditEvent(overrides: Partial<DurableAuditEvent> = {}): DurableAuditEvent {
  return {
    audit_id: "la_audit_worker0001",
    authority_id: "la_authority_audit0001",
    operation_id: "la_operation_audit0001",
    trace_id: "la_trace_audit0001",
    recorded_at: timestamp,
    actor_id: "fixture-actor-secret-token-0001",
    mcp_profile: "remote-safe",
    operation: "read",
    event_type: "object.read",
    outcome: "allowed",
    object_id: "la_object_audit0001",
    access_class: "remote-safe",
    redaction: "remote-redacted",
    summary: "Remote object read allowed",
    ...overrides
  };
}

async function testSha256Hash(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("Cloudflare audit ledger", () => {
  it("persists read, denial, release, and key events with only redacted hashed refs", async () => {
    const controlDb = new FakeD1Database();

    const read = await appendAuditEvent(controlDb, auditEvent());
    const denied = await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0002",
      operation_id: "la_operation_audit0002",
      event_type: "object.denied",
      outcome: "denied",
      reason_code: "remote-sensitive-unavailable",
      object_id: "la_object_privateaudit0001",
      access_class: "local-private",
      redaction: "remote-redacted",
      summary: "Remote object unavailable"
    }));
    const release = await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0003",
      operation_id: "la_operation_audit0003",
      mcp_profile: "local-release",
      operation: "create",
      event_type: "release.published",
      outcome: "released",
      release_id: "la_object_releaseaudit0001",
      object_id: undefined,
      access_class: "release",
      summary: "Release projection published"
    }));
    const key = await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0004",
      operation_id: "la_operation_audit0004",
      mcp_profile: "sensitive-keyholding-client",
      operation: "admin-config",
      event_type: "key.changed",
      outcome: "changed",
      object_id: undefined,
      access_class: undefined,
      key_id: "la_key_audit0001",
      summary: "Key reference changed"
    }));

    expect([read.event_hash, denied.event_hash, release.event_hash, key.event_hash]).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sha256:[a-f0-9]{64}$/)])
    );
    expect(denied.previous_event_hash).toBe(read.event_hash);
    expect(release.previous_event_hash).toBe(denied.event_hash);
    expect(key.previous_event_hash).toBe(release.event_hash);

    const inserts = controlDb.records.filter((record) => record.query.includes("INSERT INTO audit_events"));
    expect(inserts).toHaveLength(4);

    const serializedWrites = JSON.stringify(controlDb.records);
    expect(serializedWrites).not.toContain("la_authority_audit0001");
    expect(serializedWrites).not.toContain("fixture-actor-secret-token-0001");
    expect(serializedWrites).not.toContain("la_object_privateaudit0001");
    expect(serializedWrites).not.toContain("la_object_releaseaudit0001");
    expect(serializedWrites).not.toContain("la_key_audit0001");
    expect(serializedWrites).not.toContain("wrapped-key-ciphertext-fixture");

    const rows = await readAuditLedgerEvents(controlDb, { limit: 10 });
    expect(rows).toHaveLength(4);
    expect(rows[0]!.key_ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(rows[1]!.release_ref).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(rows[3]!.authority_ref).not.toBe(await testSha256Hash("la_authority_audit0001"));
    expect(rows[3]!.actor_ref).not.toBe(await testSha256Hash("fixture-actor-secret-token-0001"));
    expect(rows.every((row) => row.redaction !== "none")).toBe(true);
  });

  it("rejects stale concurrent appends instead of forking one authority hash chain", async () => {
    const controlDb = new FakeD1Database();
    const first = await appendAuditEvent(controlDb, auditEvent());
    const stalePreviousHash = first.event_hash;
    const staleInsert = controlDb.prepare(`
INSERT INTO audit_events (
  audit_id,
  authority_ref,
  operation_id,
  trace_id,
  recorded_at,
  actor_ref,
  mcp_profile,
  operation,
  event_type,
  outcome,
  reason_code,
  object_ref,
  release_ref,
  key_ref,
  capability_ref,
  sync_batch_ref,
  access_class,
  redaction,
  summary,
  checkpoint_bucket,
  previous_event_hash,
  event_hash
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE (
  (? IS NULL OR ? = ?)
  AND NOT EXISTS (
    SELECT 1 FROM audit_events WHERE authority_ref = ?
  )
) OR (
  ? IS NOT NULL
  AND ? <> ?
  AND ? = (
    SELECT event_hash
    FROM audit_events
    WHERE authority_ref = ?
    ORDER BY recorded_at DESC, audit_id DESC
    LIMIT 1
  )
)`).bind(
      "la_audit_workerstale1",
      first.authority_ref,
      "la_operation_auditstale1",
      "la_trace_auditstale1",
      "2026-06-22T12:00:30.000Z",
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "remote-safe",
      "read",
      "object.read",
      "allowed",
      null,
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      null,
      null,
      null,
      null,
      "remote-safe",
      "remote-redacted",
      "Remote object read allowed",
      "2026-06-22",
      stalePreviousHash,
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      stalePreviousHash,
      stalePreviousHash,
      genesisAuditHash,
      first.authority_ref,
      stalePreviousHash,
      stalePreviousHash,
      genesisAuditHash,
      stalePreviousHash,
      first.authority_ref
    );

    await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0002",
      operation_id: "la_operation_audit0002",
      trace_id: "la_trace_audit0002",
      recorded_at: "2026-06-22T12:01:00.000Z",
      summary: "Remote object read allowed"
    }));

    await expect(staleInsert.run()).resolves.toMatchObject({
      meta: {
        changes: 0
      }
    });

    const rows = await readAuditLedgerEvents(controlDb, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.audit_id === "la_audit_workerstale1")).toBe(false);
  });

  it("rejects unredacted remote ledger records and leak-bearing summaries", async () => {
    const controlDb = new FakeD1Database();

    await expect(appendAuditEvent(controlDb, auditEvent({
      redaction: "none"
    }))).rejects.toThrow(/redacted/);

    await expect(appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0005",
      summary: "Leaked wrapped-key-ciphertext-fixture"
    }))).rejects.toThrow(/plaintext, ciphertext, secret, token, or payload/);

    expect(controlDb.records.filter((record) => record.query.includes("INSERT INTO audit_events"))).toHaveLength(0);
  });

  it("returns a bounded Praxis stream with stable cursors and hashed refs only", async () => {
    const controlDb = new FakeD1Database();
    await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0001",
      recorded_at: "2026-06-22T12:00:00.000Z",
      summary: "Remote object read allowed"
    }));
    await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0002",
      operation_id: "la_operation_audit0002",
      recorded_at: "2026-06-22T12:01:00.000Z",
      event_type: "object.denied",
      outcome: "denied",
      reason_code: "remote-sensitive-unavailable",
      object_id: "la_object_privateaudit0001",
      access_class: "local-private",
      summary: "Remote object unavailable"
    }));
    await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0003",
      operation_id: "la_operation_audit0003",
      recorded_at: "2026-06-22T12:02:00.000Z",
      event_type: "sync.read",
      operation: "sync-read",
      object_id: undefined,
      access_class: undefined,
      summary: "Remote sync status read"
    }));

    const first = await readPraxisActivityAuditStream(controlDb, { limit: 2 });
    expect(first).toMatchObject({
      stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
      ok: true,
      limit: 2,
      has_more: true
    });
    expect(first.events.map((event) => event.audit.audit_id)).toEqual(["la_audit_worker0003", "la_audit_worker0002"]);
    expect(first.events[1]!.policy_decision).toBe("deny");
    expect(first.events[0]!.crud).toBe("sync-pull");
    expect(first.next_cursor).toBe(first.events[1]!.cursor);

    const next = await readPraxisActivityAuditStream(controlDb, { cursor: first.next_cursor!, limit: 2 });
    expect(next.events.map((event) => event.audit.audit_id)).toEqual(["la_audit_worker0001"]);
    expect(next.has_more).toBe(false);
    expect(next.next_cursor).toBeNull();

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("la_authority_audit0001");
    expect(serialized).not.toContain("fixture-actor-secret-token-0001");
    expect(serialized).not.toContain("la_object_privateaudit0001");
    expect(serialized).not.toContain("wrapped-key-ciphertext-fixture");
    expect(first.events.every((event) => event.refs.authority_ref.startsWith("sha256:"))).toBe(true);
  });

  it("serves the Praxis stream over token-gated HTTP and MCP routes", async () => {
    const controlDb = new FakeD1Database();
    await appendAuditEvent(controlDb, auditEvent({
      audit_id: "la_audit_worker0006",
      operation_id: "la_operation_audit0006",
      summary: "Remote object read allowed"
    }));
    const env = await createEnv(controlDb);

    const missingToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/activity/audit"), env);
    expect(missingToken.status).toBe(401);

    const queryToken = await handleBootstrapRequest(new Request("https://living-atlas.example/api/audit/recent?sync_token=secret"), env);
    expect(queryToken.status).toBe(400);

    const response = await handleBootstrapRequest(new Request("https://living-atlas.example/api/audit/recent?limit=1", {
      headers: { "x-living-atlas-sync-token": syncToken }
    }), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
      ok: true,
      events: [
        {
          audit: {
            audit_id: "la_audit_worker0006"
          }
        }
      ]
    });

    const mcpResponse = await handleBootstrapRequest(new Request("https://living-atlas.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-living-atlas-sync-token": syncToken
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "activity_read",
          arguments: {
            authority_id: "la_authority_audit0001",
            limit: 1
          }
        }
      })
    }), env);
    expect(mcpResponse.status).toBe(200);
    const mcpBody = await mcpResponse.json() as { result?: { structuredContent?: unknown } };
    expect(mcpBody.result?.structuredContent).toMatchObject({
      stream_schema: "living-atlas-praxis-activity-audit-stream:v1",
      ok: true
    });
  });
});
