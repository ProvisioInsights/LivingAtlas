import type {
  AliasLedger,
  AliasLedgerRow,
  AssertionMintRequest,
  CommitReceipt,
  CommitRequest,
  EntityMintRequest,
  EntityRegistry,
  MigrationApplyAudit,
  MigrationAuditSink,
  TargetPlaneSink
} from "./apply.js";
import type { MigrationIdempotencyKey } from "./target-plane.js";

/**
 * Reference implementations of the target-plane ports. They exist so the
 * projection pipeline can be exercised end to end against synthetic fixtures
 * with no store, no keys and no filesystem — the real run stays blocked on
 * offline media and must never be wired to a live path from here.
 */
export class InMemoryEntityRegistry implements EntityRegistry {
  private counter = 0;

  readonly mintedEntities: EntityMintRequest[] = [];
  readonly mintedAssertions: AssertionMintRequest[] = [];

  /**
   * Ids come from a sequence, never from the record's content. A content-derived
   * id would silently merge two legacy objects that happened to describe the
   * same thing, turning an unmade identity decision into a fact.
   */
  private nextId(): string {
    this.counter += 1;
    return `la_object_mint${String(this.counter).padStart(8, "0")}`;
  }

  async mintEntity(request: EntityMintRequest): Promise<{ entity_id: string }> {
    this.mintedEntities.push(request);
    return { entity_id: this.nextId() };
  }

  async mintAssertion(request: AssertionMintRequest): Promise<{ assertion_id: string }> {
    this.mintedAssertions.push(request);
    return { assertion_id: this.nextId() };
  }
}

export class InMemoryAliasLedger implements AliasLedger {
  readonly rows = new Map<string, AliasLedgerRow>();
  readonly appendLog: AliasLedgerRow[] = [];

  async resolve(legacyObjectId: string): Promise<AliasLedgerRow | undefined> {
    return this.rows.get(legacyObjectId);
  }

  async append(row: AliasLedgerRow): Promise<void> {
    if (this.rows.has(row.legacy_object_id)) {
      throw new Error(`alias ledger row for ${row.legacy_object_id} already exists`);
    }
    this.rows.set(row.legacy_object_id, row);
    this.appendLog.push(row);
  }
}

export class InMemoryTargetPlaneSink implements TargetPlaneSink {
  readonly commits: CommitRequest[] = [];
  private readonly receipts = new Map<string, CommitReceipt>();

  async receiptFor(idempotencyKey: MigrationIdempotencyKey): Promise<CommitReceipt | undefined> {
    return this.receipts.get(idempotencyKey);
  }

  async commit(request: CommitRequest): Promise<CommitReceipt> {
    const existing = this.receipts.get(request.idempotency_key);
    if (existing) {
      // The original receipt is replayed rather than the new attempt applied, so
      // a retry can never produce a second copy of the same record.
      return existing;
    }
    const receipt: CommitReceipt = {
      idempotency_key: request.idempotency_key,
      object_id: request.object_id,
      recorded_at: request.recorded_at,
      seq: request.seq
    };
    this.receipts.set(request.idempotency_key, receipt);
    this.commits.push(request);
    return receipt;
  }
}

export class InMemoryMigrationAuditSink implements MigrationAuditSink {
  readonly events: MigrationApplyAudit[] = [];

  async record(event: MigrationApplyAudit): Promise<void> {
    this.events.push(event);
  }
}

export type InMemoryTargetPlane = {
  registry: InMemoryEntityRegistry;
  alias_ledger: InMemoryAliasLedger;
  sink: InMemoryTargetPlaneSink;
  audit: InMemoryMigrationAuditSink;
};

export function createInMemoryTargetPlane(): InMemoryTargetPlane {
  return {
    registry: new InMemoryEntityRegistry(),
    alias_ledger: new InMemoryAliasLedger(),
    sink: new InMemoryTargetPlaneSink(),
    audit: new InMemoryMigrationAuditSink()
  };
}
