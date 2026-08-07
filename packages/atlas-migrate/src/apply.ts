import type { EndpointSubtype, EndpointType } from "@living-atlas/contracts";
import { evaluateClosureGate, type ClosureGateResult } from "./closure-gate.js";
import type { MigrationRefusalReason } from "./legacy-source.js";
import type { ProjectionPlan, SourceDispositionKind, SourceOutcome } from "./projection.js";
import {
  ResolutionBearingRecordKinds,
  hasLegacyProvenance,
  isEntityRecord,
  isMintedEntityRecord,
  legacyObjectIdOf,
  provenanceGroupKey,
  slotMintedBy,
  type EntitySlot,
  type MigrationIdempotencyKey,
  type ProjectedProvenance,
  type ProjectedRecord,
  type ProjectedRecordKind
} from "./target-plane.js";

export type EntityMintRequest = {
  slot: EntitySlot;
  entity_type: EndpointType;
  entity_subtype?: EndpointSubtype;
  /**
   * The legacy object this entity came from, ABSENT when the migration minted
   * the node from a value shared by many objects. Optional rather than a
   * sentinel or a plausible-looking id: a registry that logged one arbitrary
   * contributor as the source of a shared topic node would record a provenance
   * nobody could reproduce, and a registry that logged a sentinel would print a
   * legacy id for something no legacy object ever held.
   */
  legacy_object_id?: string;
  /**
   * Also absent for a minted entity, and for the same reason one level up: that
   * record carries no `provenance` at all. A DERIVED node does carry one, so
   * this stays required-when-present rather than being dropped -- the two cases
   * are different and the registry must be able to tell them apart.
   */
  provenance?: ProjectedProvenance;
};

export type AssertionMintRequest = {
  /**
   * `minted-entity` is excluded because it goes through `mintEntity`; every
   * other kind, including `minted-relationship`, is an assertion.
   */
  record_kind: Exclude<ProjectedRecordKind, "entity" | "minted-entity">;
  legacy_object_id?: string;
  provenance: ProjectedProvenance;
};

/**
 * Identity is minted, never derived. The registry is a port precisely so the
 * projector cannot reach for a content hash when an id is inconvenient — the old
 * store's "id = hash(title)" shortcut is what made two different people with the
 * same name collapse into one node with no decision recorded anywhere.
 */
export interface EntityRegistry {
  mintEntity(request: EntityMintRequest): Promise<{ entity_id: string }>;
  mintAssertion(request: AssertionMintRequest): Promise<{ assertion_id: string }>;
}

export const AliasBasis = "mechanical-migration" as const;

export type AliasLedgerTarget =
  | { kind: "redirect"; object_id: string; record_kind: ProjectedRecordKind }
  /**
   * The id became more than one entity, and the ledger says so instead of
   * choosing. This mirrors the entity registry's own `ambiguous-split` row: there
   * is NO primary, on purpose, because naming one would silently reattribute
   * every historical reference to whichever half was nominated.
   *
   * A consumer holding the old id gets a refusal it can act on — "this is one of
   * these two, and Atlas will not guess" — which is a different and far more
   * useful answer than a redirect that quietly picked.
   */
  | { kind: "ambiguous-split"; candidate_object_ids: [string, string, ...string[]] }
  | {
      kind: "no-target";
      disposition: SourceDispositionKind;
      reason?: MigrationRefusalReason;
      detail: string;
    };

export type AliasLedgerRow = {
  legacy_object_id: string;
  basis: typeof AliasBasis;
  target: AliasLedgerTarget;
  recorded_at: string;
};

/**
 * A mechanical redirect is bookkeeping, not a claim about the world. It writes a
 * ledger row and nothing else: an entity-resolution assertion would say "these
 * two identities are the same thing, and here is the evidence", which a
 * migration has no standing to assert.
 */
export interface AliasLedger {
  resolve(legacyObjectId: string): Promise<AliasLedgerRow | undefined>;
  append(row: AliasLedgerRow): Promise<void>;
}

export type CommitResolution =
  | { record_kind: "entity" }
  | { record_kind: "relationship"; source_entity_id: string; target_entity_id: string }
  | { record_kind: "retraction"; retracts_object_id: string }
  | { record_kind: "absence" }
  /**
   * A record carried across with its modelling deferred (ADR 0029). It resolves
   * to nothing — no endpoints, no retraction target — so the variant carries no
   * fields, and it is a variant of its own rather than folded into `absence`
   * because the two are opposite facts: an absence says content did NOT come
   * across, and this says content came across whole and unmodelled.
   *
   * A SINK MUST NOT WRITE THIS INTO A PUBLISHED CONTRACT SHAPE. The kind is
   * unpublished precisely because it is expected to change, and a released
   * revision cannot be edited once it ships — so a durable adapter that mapped
   * it onto `atlas.assertion:v1` would freeze by accident the shape this whole
   * deferral exists to keep unfrozen. `UnmodelledRecordKinds` is the check.
   */
  | { record_kind: "provisional-block" };

export type CommitRequest = {
  idempotency_key: MigrationIdempotencyKey;
  object_id: string;
  recorded_at: string;
  seq: number;
  record: ProjectedRecord;
  resolved: CommitResolution;
};

export type CommitReceipt = {
  idempotency_key: MigrationIdempotencyKey;
  object_id: string;
  recorded_at: string;
  seq: number;
};

export interface TargetPlaneSink {
  receiptFor(idempotencyKey: MigrationIdempotencyKey): Promise<CommitReceipt | undefined>;
  commit(request: CommitRequest): Promise<CommitReceipt>;
}

export const MigrationApplyAuditSchemaName = "living-atlas-migration-apply:v1" as const;

/**
 * ONE event per apply run carrying aggregate counts. Per-record audit fanout
 * would make the audit log a second copy of the graph and would leak the shape
 * of the corpus to anyone allowed to read audit.
 */
export type MigrationApplyAudit = {
  event_schema: typeof MigrationApplyAuditSchemaName;
  authority_id: string;
  actor_id: string;
  plan_digest: string;
  recorded_at: string;
  mode: "apply" | "refused";
  /**
   * What the run actually DID, as distinct from what it set out to do.
   *
   * Separate from `mode` because the two answer different questions and
   * collapsing them is how the defect got in: `mode` says which operation was
   * attempted, and a run that committed every record and then hit an alias
   * conflict is unambiguously an `apply`. Whether it SUCCEEDED is another fact,
   * and it used to be recorded nowhere — a conflicted run wrote
   * `mode: "apply", gate_verdict: "pass"` and returned `ok: false`, so the
   * durable event said the run went fine while the caller was told it had not.
   * The only trace was that `alias_rows_written + alias_rows_reused` fell short
   * of the outcome count, which a reader can only notice if they already
   * suspect. AGENTS.md requires a durable inspectable event for every mutating
   * operation; an event that misreports its own outcome is not one.
   */
  outcome: "committed" | "alias-ledger-conflict" | "closure-gate-failed";
  gate_verdict: "pass" | "fail";
  source_object_count: number;
  refused_source_objects: number;
  records_committed: number;
  records_replayed: number;
  entities_minted: number;
  assertions_minted: number;
  alias_rows_written: number;
  alias_rows_reused: number;
  /**
   * Alias rows this run planned that the ledger already held pointing somewhere
   * ELSE. Non-zero is the conflict, counted so the event states the size of the
   * disagreement rather than leaving it to be inferred from a shortfall.
   */
  alias_rows_conflicted: number;
  resolution_assertions_written: number;
};

export interface MigrationAuditSink {
  record(event: MigrationApplyAudit): Promise<void>;
}

export type AliasLedgerConflict = {
  legacy_object_id: string;
  existing: AliasLedgerTarget;
  planned: AliasLedgerTarget;
};

export type ApplyProjectionPlanResult =
  | { ok: true; audit: MigrationApplyAudit; receipts: CommitReceipt[] }
  | { ok: false; reason: "closure-gate-failed"; gate: ClosureGateResult; audit: MigrationApplyAudit }
  | {
      ok: false;
      reason: "alias-ledger-conflict";
      conflicts: AliasLedgerConflict[];
      audit: MigrationApplyAudit;
    };

export type ApplyProjectionPlanInput = {
  plan: ProjectionPlan;
  actor_id: string;
  registry: EntityRegistry;
  alias_ledger: AliasLedger;
  sink: TargetPlaneSink;
  audit: MigrationAuditSink;
  now?: () => string;
};

const RecordKindOrder: Record<ProjectedRecordKind, number> = {
  entity: 0,
  // Minted entities commit in the same wave as imported ones and before any
  // edge: a `has-type` edge resolves its target through the slot map, so a
  // topic node committed after its edges would leave them unresolvable.
  "minted-entity": 0,
  absence: 1,
  // Nothing resolves through a provisional record and it resolves through
  // nothing, so its wave is free. It commits BEFORE retractions because a
  // deleted block is carried and then retracted, and a retraction whose target
  // has not committed throws.
  "provisional-block": 1,
  relationship: 2,
  "minted-relationship": 2,
  retraction: 3
};

/**
 * The stream a record's `seq` counts within.
 *
 * Imported records count within their legacy object. A minted topic has no
 * legacy object, so it counts within its own value -- which is stable across
 * runs for the same reason its slot is, and cannot collide with a legacy id
 * because the two are built from different prefixes.
 */
/**
 * Two independent reasons a record has no legacy object to be counted against,
 * and this composes both: a minted entity has no `provenance` field at all, and
 * a derived node has one whose variant names an attribute value rather than an
 * object. Reading `provenance.legacy_object_id` directly -- as this did when
 * only the first case existed -- would put every derived node into a single
 * `undefined` stream and hand two of them the same seq.
 */
function seqStreamKey(record: ProjectedRecord): string {
  return hasLegacyProvenance(record)
    ? provenanceGroupKey(record.provenance)
    : `minted-topic:${record.minted_basis.legacy_value}`;
}

/**
 * What a mint request names as its origin. `undefined` for a minted node, and
 * that is not a gap: passing a legacy id it did not come from would make the
 * registry's own log claim the topic node was imported.
 */
function legacyObjectIdFor(record: ProjectedRecord): string | undefined {
  return hasLegacyProvenance(record) ? legacyObjectIdOf(record) : undefined;
}

function orderRecords(records: ProjectedRecord[]): ProjectedRecord[] {
  return [...records].sort((left, right) => {
    const kindDelta = RecordKindOrder[left.record_kind] - RecordKindOrder[right.record_kind];
    if (kindDelta !== 0) {
      return kindDelta;
    }
    return left.idempotency_key < right.idempotency_key ? -1 : left.idempotency_key > right.idempotency_key ? 1 : 0;
  });
}

function plannedAliasTarget(outcome: SourceOutcome, objectIdByRecordKey: Map<string, string>): AliasLedgerTarget {
  if (outcome.alias_target.kind === "record") {
    const objectId = objectIdByRecordKey.get(outcome.alias_target.record_key);
    if (objectId) {
      return { kind: "redirect", object_id: objectId, record_kind: outcome.alias_target.record_kind };
    }
    return {
      kind: "no-target",
      disposition: outcome.disposition.kind,
      detail: "planned redirect target was not committed in this run"
    };
  }

  if (outcome.alias_target.kind === "ambiguous-split") {
    const objectIds = outcome.alias_target.candidates.map((candidate) =>
      objectIdByRecordKey.get(candidate.record_key)
    );
    const [first, second, ...rest] = objectIds;
    if (first && second && objectIds.every((objectId): objectId is string => objectId !== undefined)) {
      return { kind: "ambiguous-split", candidate_object_ids: [first, second, ...rest.filter((id): id is string => id !== undefined)] };
    }
    // A split whose candidates did not all commit cannot be written as a split:
    // the row would name a subset and read as though the missing half never
    // existed, which is the silent pick this path exists to avoid.
    return {
      kind: "no-target",
      disposition: outcome.disposition.kind,
      detail: "planned split candidates were not all committed in this run"
    };
  }

  return {
    kind: "no-target",
    disposition: outcome.alias_target.disposition,
    ...(outcome.alias_target.reason ? { reason: outcome.alias_target.reason } : {}),
    detail: outcome.alias_target.detail
  };
}

/**
 * Applies a plan exactly once. Re-running is safe: every record carries a
 * deterministic idempotency key, and a key with an existing receipt is replayed
 * from that receipt rather than committed a second time. recorded_at is stamped
 * HERE, at commit, and nowhere earlier — a plan that carried its own timestamp
 * would let the same migration claim two different times of record.
 */
export async function applyProjectionPlan(input: ApplyProjectionPlanInput): Promise<ApplyProjectionPlanResult> {
  const { plan, registry, sink } = input;
  const aliasLedger = input.alias_ledger;
  const now = input.now ?? (() => new Date().toISOString());
  const recordedAt = now();

  const gate = evaluateClosureGate(plan);
  if (!gate.ok) {
    // Refusing is itself an observable event: a migration that silently declined
    // to run is indistinguishable from one that was never started.
    const refusedAudit: MigrationApplyAudit = {
      event_schema: MigrationApplyAuditSchemaName,
      authority_id: plan.authority_id,
      actor_id: input.actor_id,
      plan_digest: plan.plan_digest,
      recorded_at: recordedAt,
      mode: "refused",
      outcome: "closure-gate-failed",
      gate_verdict: "fail",
      source_object_count: plan.breakdown.source_object_count,
      refused_source_objects: plan.breakdown.refused_count,
      records_committed: 0,
      records_replayed: 0,
      entities_minted: 0,
      assertions_minted: 0,
      alias_rows_written: 0,
      alias_rows_reused: 0,
      alias_rows_conflicted: 0,
      resolution_assertions_written: 0
    };
    await input.audit.record(refusedAudit);
    return { ok: false, reason: "closure-gate-failed", gate, audit: refusedAudit };
  }

  const objectIdByRecordKey = new Map<string, string>();
  const entityIdBySlot = new Map<string, string>();
  const receipts: CommitReceipt[] = [];
  const seqByLegacyObject = new Map<string, number>();
  const committedKinds: ProjectedRecordKind[] = [];
  let entitiesMinted = 0;
  let assertionsMinted = 0;
  let recordsCommitted = 0;
  let recordsReplayed = 0;

  for (const record of orderRecords(plan.records)) {
    const existing = await sink.receiptFor(record.idempotency_key);
    if (existing) {
      objectIdByRecordKey.set(record.idempotency_key, existing.object_id);
      // EVERY record that puts a slot into the plane, replayed exactly as the
      // commit branch below registers it. Asking `isEntityRecord` alone missed
      // `minted-entity`, so a resume that replayed an already-committed topic
      // node left its slot unknown and threw on the first `has-type` edge
      // pointing at it — a partial apply that could never be finished, reachable
      // only when the failure fell between a topic node and its edges.
      const replayedSlot = slotMintedBy(record);
      if (replayedSlot !== undefined) {
        entityIdBySlot.set(replayedSlot, existing.object_id);
      }
      // The counter advances on a REPLAY too, and that is not bookkeeping —
      // it is the per-assertion seq invariant. A run that died part-way (sink
      // throw, full disk, killed process) leaves some keys with receipts and
      // some without; the resume replays the committed ones and commits the
      // rest. With the counter left at zero across the replays, the first
      // record the resume actually commits would be handed seq=1 — a number a
      // record already committed in the failed run is holding. Measured: a
      // tombstoned object's entity record committed seq=1 in the first run and
      // its retraction committed seq=1 in the resume.
      const replayedGroup = seqStreamKey(record);
      seqByLegacyObject.set(
        replayedGroup,
        Math.max(seqByLegacyObject.get(replayedGroup) ?? 0, existing.seq)
      );
      receipts.push(existing);
      recordsReplayed += 1;
      continue;
    }

    const group = seqStreamKey(record);
    const seq = (seqByLegacyObject.get(group) ?? 0) + 1;
    seqByLegacyObject.set(group, seq);

    let objectId: string;
    let resolved: CommitResolution;

    if (isEntityRecord(record) || isMintedEntityRecord(record)) {
      const legacyObjectId = legacyObjectIdFor(record);
      const minted = await registry.mintEntity({
        slot: record.slot,
        entity_type: record.entity_type,
        // `"entity_subtype" in record` rather than a bare property read: a
        // minted entity has no such key, and the ratified vocabulary leaves
        // seven of the eight endpoint types with no subtype at all.
        ...("entity_subtype" in record && record.entity_subtype !== undefined
          ? { entity_subtype: record.entity_subtype }
          : {}),
        ...(legacyObjectId === undefined ? {} : { legacy_object_id: legacyObjectId }),
        // Absent for a minted entity, present (and possibly `derived`) for
        // every other entity. Spread rather than assigned so the key does not
        // appear holding `undefined`, which a sink would persist as a recorded
        // absence rather than as no record at all.
        ...(hasLegacyProvenance(record) ? { provenance: record.provenance } : {})
      });
      objectId = minted.entity_id;
      entitiesMinted += 1;
      entityIdBySlot.set(record.slot, objectId);
      resolved = { record_kind: "entity" };
    } else {
      // Narrowed past both entity kinds, so `provenance` is known to be present
      // here -- which is why this reads it directly while the entity branch
      // above has to ask.
      const legacyObjectId = legacyObjectIdOf(record);
      const minted = await registry.mintAssertion({
        record_kind: record.record_kind,
        ...(legacyObjectId === undefined ? {} : { legacy_object_id: legacyObjectId }),
        provenance: record.provenance
      });
      objectId = minted.assertion_id;
      assertionsMinted += 1;

      if (record.record_kind === "relationship" || record.record_kind === "minted-relationship") {
        const sourceEntityId = entityIdBySlot.get(record.source_slot);
        const targetEntityId = entityIdBySlot.get(record.target_slot);
        if (!sourceEntityId || !targetEntityId) {
          throw new Error(`relationship ${record.idempotency_key} has an endpoint slot with no minted entity`);
        }
        resolved = { record_kind: "relationship", source_entity_id: sourceEntityId, target_entity_id: targetEntityId };
      } else if (record.record_kind === "retraction") {
        const retractsObjectId = objectIdByRecordKey.get(record.retracts_idempotency_key);
        if (!retractsObjectId) {
          throw new Error(`retraction ${record.idempotency_key} names a record that was not committed`);
        }
        resolved = { record_kind: "retraction", retracts_object_id: retractsObjectId };
      } else if (record.record_kind === "provisional-block") {
        // Named rather than swept into the `absence` default. A sink deciding
        // how to persist a record reads this field, and a provisional block told
        // it was an absence would be stored as a report that content did not
        // come across — the exact inverse of what it is.
        resolved = { record_kind: "provisional-block" };
      } else {
        resolved = { record_kind: "absence" };
      }
    }

    const receipt = await sink.commit({
      idempotency_key: record.idempotency_key,
      object_id: objectId,
      recorded_at: recordedAt,
      seq,
      record,
      resolved
    });
    objectIdByRecordKey.set(record.idempotency_key, receipt.object_id);
    receipts.push(receipt);
    committedKinds.push(record.record_kind);
    recordsCommitted += 1;
  }

  let aliasRowsWritten = 0;
  let aliasRowsReused = 0;
  const conflicts: AliasLedgerConflict[] = [];

  for (const outcome of [...plan.outcomes].sort((left, right) =>
    left.legacy_object_id < right.legacy_object_id ? -1 : left.legacy_object_id > right.legacy_object_id ? 1 : 0
  )) {
    const planned = plannedAliasTarget(outcome, objectIdByRecordKey);
    const existing = await aliasLedger.resolve(outcome.legacy_object_id);
    if (existing) {
      if (JSON.stringify(existing.target) !== JSON.stringify(planned)) {
        conflicts.push({ legacy_object_id: outcome.legacy_object_id, existing: existing.target, planned });
        continue;
      }
      aliasRowsReused += 1;
      continue;
    }
    await aliasLedger.append({
      legacy_object_id: outcome.legacy_object_id,
      basis: AliasBasis,
      target: planned,
      recorded_at: recordedAt
    });
    aliasRowsWritten += 1;
  }

  // Built AFTER the alias loop, so the outcome the event reports is the outcome
  // the caller is about to be given rather than the one the run was hoping for.
  // Still exactly one event per call.
  const audit: MigrationApplyAudit = {
    event_schema: MigrationApplyAuditSchemaName,
    authority_id: plan.authority_id,
    actor_id: input.actor_id,
    plan_digest: plan.plan_digest,
    recorded_at: recordedAt,
    mode: "apply",
    outcome: conflicts.length > 0 ? "alias-ledger-conflict" : "committed",
    gate_verdict: "pass",
    source_object_count: plan.breakdown.source_object_count,
    refused_source_objects: plan.breakdown.refused_count,
    records_committed: recordsCommitted,
    records_replayed: recordsReplayed,
    entities_minted: entitiesMinted,
    assertions_minted: assertionsMinted,
    alias_rows_written: aliasRowsWritten,
    alias_rows_reused: aliasRowsReused,
    alias_rows_conflicted: conflicts.length,
    resolution_assertions_written: committedKinds.filter((kind) => ResolutionBearingRecordKinds.has(kind)).length
  };
  await input.audit.record(audit);

  if (conflicts.length > 0) {
    return { ok: false, reason: "alias-ledger-conflict", conflicts, audit };
  }

  return { ok: true, audit, receipts };
}
