import {
  type ConfidenceBand,
  type EvidenceLink,
  type Provenance,
  type Sensitivity
} from "./assertion.js";
import {
  aliasLedgerDigest,
  isTerminalDisposition,
  verifyAliasLedger,
  type AliasBasis,
  type AliasDisposition,
  type AliasRow,
  type LedgerIntegrity,
  type TerminalDisposition,
  type UnsealedAliasRow
} from "./alias-ledger.js";
import {
  DEFAULT_ENTITY_SENSITIVITY,
  EntityDraftSchema,
  SourceObservationSchema,
  observedTraits,
  validateEntityType,
  type Entity,
  type EntityDraft,
  type ObservationTrait,
  type SourceObservation
} from "./entity.js";
import { mintEntityId, type AssertionId, type EntityId } from "./ids.js";
import type { AssertionLog, Clock } from "./store.js";
import { canonicalRecordedAt, type RecordedAt } from "./time.js";

/**
 * The entity registry and the alias ledger, together.
 *
 * One promise governs the whole file: **an id Atlas has ever returned resolves
 * forever, and no id is ever reused.** Everything else is a consequence.
 *
 *  - Ids are minted here and nowhere else. There is no API that accepts one.
 *  - Merging never deletes. The merged-away entity stays; a ledger row makes
 *    its id keep answering.
 *  - Splitting refuses to guess. An id that turned out to name two things
 *    resolves to a typed ambiguity listing both, never to a silent pick.
 *  - Every walk terminates: one successor per id, a visited set, and a depth
 *    cap that fires as a typed error rather than a hang.
 *  - A redirect is not an assertion. Mechanical migration produces tens of
 *    thousands of them and has no evidence to offer; manufacturing an evidence
 *    record for each would poison the layer attribution depends on.
 */

/** Deep enough for any real chain, shallow enough that a bug fails loudly. */
export const DEFAULT_MAX_REDIRECT_DEPTH = 32;

/**
 * How many of the four source traits must agree before a re-import carries an
 * existing id forward. Pinned at 2 by the migration plan.
 *
 * The asymmetry is deliberate. Below the threshold Atlas mints a new entity,
 * which produces a DUPLICATE — repairable later by a merge. Above it, a wrong
 * match produces a CONFLATION — two different things wearing one id, which no
 * later operation can cleanly undo. Prefer the repairable error.
 */
export const IDENTITY_MATCH_THRESHOLD = 2;

export type EntityContext = {
  /** Set from the authenticated credential. A caller can neither supply nor spoof it. */
  client_id: string;
  origin?: Provenance["origin"];
  recorded_at_fidelity?: Provenance["recorded_at_fidelity"];
  sensitivity?: Sensitivity;
};

/**
 * The durability port, mirroring `LogJournal`: synchronous, because a returned
 * entity is a statement that its id is on disk. An id handed to a consumer and
 * then lost in a crash is an id that can be minted again for something else,
 * which is the one thing this registry may never allow.
 */
export type IdentityJournal = {
  /** One indivisible group. Durable before it returns. */
  appendIdentityGroup(group: {
    entities: Entity[];
    rows: AliasRow[];
    observations: { entity_id: EntityId; observation: SourceObservation; observed_at: RecordedAt }[];
  }): void;
};

/**
 * Where an owner- or consumer-initiated identity decision goes for evidence.
 *
 * A port rather than a direct dependency on `AssertionLog`, so that the
 * registry cannot quietly acquire the ability to write assertions on the
 * mechanical path. If no recorder is configured, an owner-initiated merge is
 * REFUSED rather than downgraded to a bare ledger row — silently dropping the
 * evidence would leave a human's decision indistinguishable from a machine's.
 */
export type ResolutionProposal = {
  client_id: string;
  idempotency_key: string;
  subject_entity_id: EntityId;
  predicate: string;
  target_entity_id?: EntityId;
  value?: unknown;
  evidence_links: EvidenceLink[];
  confidence: { band: ConfidenceBand; rationale?: string };
  basis?: string;
};

export type ResolutionRecorder = {
  record(
    proposal: ResolutionProposal
  ): { ok: true; assertion_id: AssertionId } | { ok: false; code: string; message: string };
};

export const RESOLUTION_PREDICATE_MERGE = "resolved-same-entity-as";
export const RESOLUTION_PREDICATE_SPLIT = "resolved-split-into";

/**
 * Bind the port to a real assertion log. Structural on purpose so both
 * `AssertionLog` and `DurableAssertionLog` satisfy it.
 */
export function assertionLogResolutions(log: Pick<AssertionLog, "commit">): ResolutionRecorder {
  return {
    record(proposal) {
      const result = log.commit({
        client_id: proposal.client_id,
        idempotency_key: proposal.idempotency_key,
        origin: "owner-authored",
        drafts: [
          {
            kind: proposal.target_entity_id ? "relationship" : "observation",
            lineage_action: "assert",
            subject_entity_id: proposal.subject_entity_id,
            predicate: proposal.predicate,
            value: proposal.value,
            target_entity_id: proposal.target_entity_id,
            supersedes: [],
            confidence: proposal.confidence,
            evidence_links: proposal.evidence_links,
            basis: proposal.basis
          }
        ]
      });
      if (!result.ok) {
        return { ok: false, code: result.code, message: result.message };
      }
      const assertionId = result.receipt.assertion_ids[0];
      if (!assertionId) {
        return {
          ok: false,
          code: "resolution-assertion-missing",
          message: "The resolution commit returned a receipt naming no assertion."
        };
      }
      return { ok: true, assertion_id: assertionId };
    }
  };
}

/** Everything a reload has to restore for a restart to be invisible. */
export type RestoredIdentity = {
  /** Latest version of each entity, in registration order. */
  entities: Entity[];
  /** In `row_seq` order. */
  rows: AliasRow[];
  observations: Map<EntityId, SourceObservation>;
  next_row_seq: number;
  last_recorded_millis: number;
  /**
   * Ids the log holds more than one active row for. First row wins, matching
   * the in-memory rule exactly, but a ledger that contradicts one-successor-per-id
   * is evidence of tampering and is never quietly normalised away.
   */
  conflicting_alias_rows: string[];
};

export type EntityRegistryOptions = {
  clock?: Clock;
  journal?: IdentityJournal;
  resolutions?: ResolutionRecorder;
  maxRedirectDepth?: number;
  restored?: RestoredIdentity;
};

// ---------------------------------------------------------------------------
// resolve()
// ---------------------------------------------------------------------------

export type ResolvedEntity = {
  ok: true;
  entity: Entity;
  /** Present only when a redirect was followed: the id the caller presented. */
  redirected_from?: string;
  /** Every id visited, oldest first, ending at `entity.entity_id`. */
  redirect_chain: string[];
  /**
   * Why the id the CALLER holds stopped being current — the first hop's reason.
   * Later hops are in `redirect_rows`; a single string cannot honestly
   * summarise a multi-hop history, so it does not try.
   */
  redirect_reason?: string;
  /** The ledger rows followed, in order. The auditable form of the above. */
  redirect_rows: AliasRow[];
};

export type ResolutionRefusal =
  | { ok: false; code: "unknown-id"; id: string; message: string }
  | { ok: false; code: "redirect-cycle"; id: string; redirect_chain: string[]; message: string }
  | {
      ok: false;
      code: "redirect-chain-too-long";
      id: string;
      redirect_chain: string[];
      max_depth: number;
      message: string;
    }
  | {
      ok: false;
      code: "redirect-dangling";
      id: string;
      redirect_chain: string[];
      missing_id: string;
      message: string;
    }
  | {
      ok: false;
      code: "ambiguous-split";
      id: string;
      redirect_chain: string[];
      candidate_ids: EntityId[];
      reason: string;
      message: string;
    }
  | {
      ok: false;
      code: "not-carried-forward";
      id: string;
      redirect_chain: string[];
      disposition: TerminalDisposition;
      reason: string;
      message: string;
    };

export type Resolution = ResolvedEntity | ResolutionRefusal;

// ---------------------------------------------------------------------------
// merge() / split()
// ---------------------------------------------------------------------------

type OwnerEvidence = {
  evidence_links: EvidenceLink[];
  confidence: { band: ConfidenceBand; rationale?: string };
  idempotency_key: string;
};

export type MergeRequest = EntityContext &
  ({ basis: "mechanical-migration" } | ({ basis: "owner-resolution" } & OwnerEvidence)) & {
    /** May be a legacy id Atlas never minted — those must keep resolving too. */
    from: string;
    into: EntityId;
    reason: string;
  };

export type SplitRequest = EntityContext &
  ({ basis: "mechanical-migration" } | ({ basis: "owner-resolution" } & OwnerEvidence)) & {
    from: string;
    into: EntityDraft[];
    reason: string;
  };

export type IdentityDecisionRefusal =
  | {
      ok: false;
      code: "alias-already-redirected";
      id: string;
      existing_row: AliasRow;
      message: string;
    }
  | { ok: false; code: "merge-into-self"; id: string; message: string }
  | {
      ok: false;
      code: "merge-would-create-cycle";
      id: string;
      redirect_chain: string[];
      message: string;
    }
  | {
      ok: false;
      code: "merge-target-unresolvable";
      id: string;
      target_refusal: ResolutionRefusal;
      message: string;
    }
  | {
      ok: false;
      code: "resolution-subject-unresolvable";
      id: string;
      subject_refusal: ResolutionRefusal;
      message: string;
    }
  | {
      ok: false;
      code: "resolution-recorder-required" | "resolution-assertion-failed";
      id: string;
      detail: string;
      message: string;
    }
  | { ok: false; code: "split-needs-two-candidates"; id: string; message: string };

export type MergeResult =
  | {
      ok: true;
      row: AliasRow;
      canonical: Entity;
      /** Non-null exactly when the decision was owner-initiated. */
      resolution_assertion_id: AssertionId | null;
    }
  | IdentityDecisionRefusal;

export type SplitResult =
  | {
      ok: true;
      row: AliasRow;
      created: Entity[];
      resolution_assertion_id: AssertionId | null;
    }
  | IdentityDecisionRefusal;

export type RenameResult =
  | { ok: true; entity: Entity }
  | { ok: false; code: "unknown-entity"; id: string; message: string }
  | {
      ok: false;
      code: "entity-redirected";
      id: string;
      /** Present only when the redirect names a single successor. */
      canonical_id?: EntityId;
      disposition: AliasDisposition;
      message: string;
    };

// ---------------------------------------------------------------------------
// resolveOrMint()
// ---------------------------------------------------------------------------

export type IdentityMatch =
  | {
      ok: true;
      entity: Entity;
      /** True when an existing id was carried forward rather than minted. */
      carried_forward: boolean;
      matched_traits: ObservationTrait[];
    }
  | {
      ok: false;
      code: "identity-ambiguous";
      candidate_ids: EntityId[];
      matched_traits: ObservationTrait[];
      message: string;
    }
  | {
      ok: false;
      code: "identity-observation-underspecified";
      observed: ObservationTrait[];
      message: string;
    };

export class EntityRegistry {
  private readonly clock: Clock;
  private readonly journal: IdentityJournal | undefined;
  private readonly resolutions: ResolutionRecorder | undefined;
  private readonly maxRedirectDepth: number;

  private readonly entities = new Map<EntityId, Entity>();
  private readonly order: EntityId[] = [];
  /** At most one ACTIVE row per id — see `appendRow`. */
  private readonly rowsByOldId = new Map<string, AliasRow>();
  private readonly rows: AliasRow[] = [];
  private readonly observations = new Map<EntityId, SourceObservation>();
  /** trait+value -> entity ids that have carried it. */
  private readonly traitIndex = new Map<string, Set<EntityId>>();

  private nextRowSeq = 1;
  private lastRecordedMillis = 0;
  private readonly conflictingAliasRows: string[];

  constructor(options: EntityRegistryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.journal = options.journal;
    this.resolutions = options.resolutions;
    this.maxRedirectDepth = options.maxRedirectDepth ?? DEFAULT_MAX_REDIRECT_DEPTH;

    const restored = options.restored;
    this.conflictingAliasRows = restored?.conflicting_alias_rows ?? [];
    if (!restored) return;

    for (const entity of restored.entities) this.remember(entity);
    for (const row of restored.rows) {
      this.rows.push(row);
      if (!this.rowsByOldId.has(row.old_id)) this.rowsByOldId.set(row.old_id, row);
    }
    for (const [entityId, observation] of restored.observations) {
      this.indexObservation(entityId, observation);
    }
    this.nextRowSeq = restored.next_row_seq;
    this.lastRecordedMillis = restored.last_recorded_millis;
  }

  get size(): number {
    return this.entities.size;
  }

  /** The ledger, in row order. A copy: the ledger is append-only from outside too. */
  get ledger(): readonly AliasRow[] {
    return [...this.rows];
  }

  get conflicts(): readonly string[] {
    return [...this.conflictingAliasRows];
  }

  verifyLedger(): LedgerIntegrity {
    return verifyAliasLedger(this.rows);
  }

  /** Unconditional read. Returns a merged-away entity too — it still exists. */
  read(entityId: EntityId): Entity | undefined {
    return this.entities.get(entityId);
  }

  private stampNow(): RecordedAt {
    const millis = Math.max(this.clock().getTime(), this.lastRecordedMillis + 1);
    this.lastRecordedMillis = millis;
    return canonicalRecordedAt(new Date(millis));
  }

  private remember(entity: Entity): void {
    if (!this.entities.has(entity.entity_id)) this.order.push(entity.entity_id);
    this.entities.set(entity.entity_id, entity);
  }

  private static traitKey(trait: ObservationTrait, value: string | number): string {
    // NUL, because `source_path_ref` and `text_digest` are caller-supplied free
    // strings: with a printable separator one path could forge another trait's
    // key and match an entity it has nothing to do with.
    return `${trait}\u0000${String(value)}`;
  }

  private indexObservation(entityId: EntityId, observation: SourceObservation): void {
    const previous = this.observations.get(entityId);
    if (previous) {
      for (const trait of observedTraits(previous)) {
        const value = previous[trait];
        if (value === undefined) continue;
        this.traitIndex.get(EntityRegistry.traitKey(trait, value))?.delete(entityId);
      }
    }
    for (const trait of observedTraits(observation)) {
      const value = observation[trait];
      if (value === undefined) continue;
      const key = EntityRegistry.traitKey(trait, value);
      const bucket = this.traitIndex.get(key);
      if (bucket) bucket.add(entityId);
      else this.traitIndex.set(key, new Set([entityId]));
    }
    this.observations.set(entityId, observation);
  }

  /**
   * Register a new entity. There is deliberately no parameter for an id: the
   * only way to obtain one is to be handed one by this method, which is what
   * makes "minted, never derived" a property of the API rather than a
   * convention callers are asked to respect.
   */
  register(draft: EntityDraft, context: EntityContext): Entity {
    const entity = this.mint(draft, context, this.stampNow());
    this.journal?.appendIdentityGroup({ entities: [entity], rows: [], observations: [] });
    this.remember(entity);
    return entity;
  }

  private mint(draft: EntityDraft, context: EntityContext, at: RecordedAt): Entity {
    const parsed = EntityDraftSchema.parse(draft);
    validateEntityType(parsed);
    return {
      record_schema: "atlas.entity:v1",
      entity_id: mintEntityId(new Date(at)),
      type: parsed.type,
      type_label: parsed.type_label,
      display_name: parsed.display_name,
      also_known_as: parsed.also_known_as,
      registered_at: at,
      updated_at: at,
      provenance: {
        client_id: context.client_id,
        origin: context.origin ?? "consumer-proposed",
        recorded_at_fidelity: context.recorded_at_fidelity ?? "authoritative",
        proposed_at: parsed.proposed_at,
        basis: parsed.basis
      },
      sensitivity: context.sensitivity ?? { ...DEFAULT_ENTITY_SENSITIVITY }
    };
  }

  /**
   * Change what an entity is CALLED. It cannot change what it IS.
   *
   * No ledger row, no new id, no redirect — a rename is not an identity event.
   * The old store could not express this distinction at all: a name was part of
   * the id derivation, so correcting a spelling minted a new object and orphaned
   * every reference to the old one.
   */
  rename(
    entityId: EntityId,
    change: { display_name?: string; also_known_as?: string[] },
    context: EntityContext
  ): RenameResult {
    const existing = this.entities.get(entityId);
    if (!existing) {
      return {
        ok: false,
        code: "unknown-entity",
        id: entityId,
        message: `No entity ${entityId} was ever registered.`
      };
    }
    const row = this.rowsByOldId.get(entityId);
    if (row) {
      return {
        ok: false,
        code: "entity-redirected",
        id: entityId,
        canonical_id: row.disposition === "mapped" ? row.new_id : undefined,
        disposition: row.disposition,
        message:
          `${entityId} already has a ledger row (${row.disposition}); rename the entity that is ` +
          "current instead. Editing a record that has been superseded changes history rather " +
          "than the present."
      };
    }

    const updated: Entity = {
      ...existing,
      display_name: change.display_name ?? existing.display_name,
      also_known_as: change.also_known_as ?? existing.also_known_as,
      updated_at: this.stampNow(),
      provenance: { ...existing.provenance, client_id: context.client_id }
    };
    this.journal?.appendIdentityGroup({ entities: [updated], rows: [], observations: [] });
    this.remember(updated);
    return { ok: true, entity: updated };
  }

  /**
   * Follow the ledger to whatever `id` means now.
   *
   * The ledger is consulted BEFORE the entity table, because a merged-away
   * entity is still a live record — it is never deleted — and returning it
   * would hand the caller a stale identity that looks perfectly valid.
   */
  resolve(id: string): Resolution {
    const chain: string[] = [id];
    const followed: AliasRow[] = [];
    const visited = new Set<string>([id]);
    let current = id;

    // `chain.length - 1` is the number of hops taken. At most `maxRedirectDepth`
    // of them, and the id reached by the last permitted hop still gets resolved
    // — the cap bounds the walk, it does not shorten a legal chain by one.
    while (chain.length - 1 <= this.maxRedirectDepth) {
      const row = this.rowsByOldId.get(current);

      if (row && row.disposition === "mapped") {
        const next = row.new_id;
        if (visited.has(next)) {
          return {
            ok: false,
            code: "redirect-cycle",
            id,
            redirect_chain: [...chain, next],
            message:
              `Resolving ${id} returns to ${next}, which it already visited. The ledger ` +
              "contains a cycle, so this id has no current meaning. It is refused rather " +
              "than answered from an arbitrary point on the loop."
          };
        }
        visited.add(next);
        chain.push(next);
        followed.push(row);
        current = next;
        continue;
      }

      if (row && row.disposition === "ambiguous-split") {
        return {
          ok: false,
          code: "ambiguous-split",
          id,
          redirect_chain: chain,
          candidate_ids: row.candidate_ids,
          reason: row.reason,
          message:
            `${current} was split into ${row.candidate_ids.length} entities and Atlas will not ` +
            "guess which one a given reference meant. Choose among the candidates."
        };
      }

      if (row && isTerminalDisposition(row.disposition)) {
        return {
          ok: false,
          code: "not-carried-forward",
          id,
          redirect_chain: chain,
          disposition: row.disposition,
          reason: row.reason,
          message: `${current} was not carried forward (${row.disposition}): ${row.reason}`
        };
      }

      const entity = this.entities.get(current as EntityId);
      if (entity) {
        const first = followed[0];
        if (!first) return { ok: true, entity, redirect_chain: chain, redirect_rows: [] };
        return {
          ok: true,
          entity,
          redirected_from: id,
          redirect_chain: chain,
          redirect_reason: first.reason,
          redirect_rows: followed
        };
      }

      if (followed.length === 0) {
        return {
          ok: false,
          code: "unknown-id",
          id,
          message: `${id} was never minted by Atlas and has no ledger row.`
        };
      }
      return {
        ok: false,
        code: "redirect-dangling",
        id,
        redirect_chain: chain,
        missing_id: current,
        message:
          `Resolving ${id} led to ${current}, which is neither a registered entity nor a ` +
          "ledger row. A redirect that points at nothing is an integrity failure, not a " +
          "missing record, and it is reported as one."
      };
    }

    return {
      ok: false,
      code: "redirect-chain-too-long",
      id,
      redirect_chain: chain,
      max_depth: this.maxRedirectDepth,
      message:
        `Resolving ${id} exceeded ${this.maxRedirectDepth} redirects. The cap exists so that a ` +
        "malformed ledger fails as a typed error rather than as a hang, even if cycle " +
        "detection is itself wrong."
    };
  }

  /**
   * Redirect one id to another.
   *
   * `mechanical-migration` writes a ledger row and NOTHING else — no assertion,
   * no evidence, no fabricated provenance. `owner-resolution` additionally
   * commits a resolution assertion carrying the real evidence for the decision.
   *
   * The assertion is committed BEFORE the row. A crash between them leaves
   * evidence for a redirect that does not exist — inert and discoverable. The
   * other order would leave a redirect consumers already follow with no record
   * of who decided it or why, which is an unattributed identity change.
   */
  merge(request: MergeRequest): MergeResult {
    if (request.from === request.into) {
      return {
        ok: false,
        code: "merge-into-self",
        id: request.from,
        message: "An id cannot redirect to itself; that is a one-step cycle."
      };
    }

    const existingRow = this.rowsByOldId.get(request.from);
    if (existingRow) return this.alreadyRedirected(request.from, existingRow);

    const target = this.resolve(request.into);
    if (!target.ok) {
      return {
        ok: false,
        code: "merge-target-unresolvable",
        id: request.from,
        target_refusal: target,
        message:
          `${request.into} does not resolve to a live entity, so merging into it would mint an ` +
          "id that resolves to nothing. Resolve the target first."
      };
    }
    if (target.redirect_chain.includes(request.from)) {
      return {
        ok: false,
        code: "merge-would-create-cycle",
        id: request.from,
        redirect_chain: target.redirect_chain,
        message:
          `${request.into} already resolves through ${request.from}, so this row would close a ` +
          "loop. Cycles are refused at write time as well as detected at read time."
      };
    }

    let assertionId: AssertionId | null = null;
    if (request.basis === "owner-resolution") {
      const subject = this.resolve(request.from);
      if (!subject.ok) {
        return {
          ok: false,
          code: "resolution-subject-unresolvable",
          id: request.from,
          subject_refusal: subject,
          message:
            `An owner decision has to be ABOUT something Atlas holds, and ${request.from} does not ` +
            "resolve to a live entity. Register it before deciding it is a duplicate."
        };
      }
      const recorded = this.recordResolution({
        client_id: request.client_id,
        idempotency_key: request.idempotency_key,
        subject_entity_id: subject.entity.entity_id,
        predicate: RESOLUTION_PREDICATE_MERGE,
        target_entity_id: target.entity.entity_id,
        evidence_links: request.evidence_links,
        confidence: request.confidence,
        basis: request.reason
      });
      if (!recorded.ok) return { ...recorded, id: request.from };
      assertionId = recorded.assertion_id;
    }

    const row = this.appendRow(
      {
        old_id: request.from,
        reason: request.reason,
        basis: request.basis,
        client_id: request.client_id,
        origin: request.origin,
        recorded_at_fidelity: request.recorded_at_fidelity,
        resolution_assertion_id: assertionId
      },
      { disposition: "mapped", new_id: request.into }
    );

    return { ok: true, row, canonical: target.entity, resolution_assertion_id: assertionId };
  }

  /**
   * Split one id into several new entities, and redirect it AMBIGUOUSLY.
   *
   * There is no primary. Nominating one would silently attribute every existing
   * reference to it, which is exactly the "silently combining different people"
   * failure the identity design exists to prevent. The old id keeps resolving —
   * to a refusal that names the candidates, which is an answer, not a 404.
   */
  split(request: SplitRequest): SplitResult {
    if (request.into.length < 2) {
      return {
        ok: false,
        code: "split-needs-two-candidates",
        id: request.from,
        message: "A split produces at least two entities; anything less is a rename."
      };
    }

    const existingRow = this.rowsByOldId.get(request.from);
    if (existingRow) return this.alreadyRedirected(request.from, existingRow);

    const at = this.stampNow();
    const created = request.into.map((draft) => this.mint(draft, request, at));
    const candidateIds = created.map((entity) => entity.entity_id);

    let assertionId: AssertionId | null = null;
    if (request.basis === "owner-resolution") {
      const subject = this.resolve(request.from);
      if (!subject.ok) {
        return {
          ok: false,
          code: "resolution-subject-unresolvable",
          id: request.from,
          subject_refusal: subject,
          message:
            `An owner decision has to be ABOUT something Atlas holds, and ${request.from} does not ` +
            "resolve to a live entity."
        };
      }
      const recorded = this.recordResolution({
        client_id: request.client_id,
        idempotency_key: request.idempotency_key,
        subject_entity_id: subject.entity.entity_id,
        predicate: RESOLUTION_PREDICATE_SPLIT,
        value: { candidate_ids: candidateIds },
        evidence_links: request.evidence_links,
        confidence: request.confidence,
        basis: request.reason
      });
      if (!recorded.ok) return { ...recorded, id: request.from };
      assertionId = recorded.assertion_id;
    }

    const row = this.appendRow(
      {
        old_id: request.from,
        reason: request.reason,
        basis: request.basis,
        client_id: request.client_id,
        origin: request.origin,
        recorded_at_fidelity: request.recorded_at_fidelity,
        resolution_assertion_id: assertionId,
        entities: created
      },
      { disposition: "ambiguous-split", candidate_ids: candidateIds }
    );

    return { ok: true, row, created, resolution_assertion_id: assertionId };
  }

  /**
   * Record that a legacy id was NOT carried forward, and why.
   *
   * Always mechanical: these outcomes belong to a migration, and there is no
   * surviving entity for an assertion to be about. Without such a row the id
   * would resolve to a bare not-found, and a consumer could not tell a
   * deliberately dropped record from a dangling reference or a typo.
   */
  recordMigrationDisposition(input: {
    old_id: string;
    disposition: TerminalDisposition;
    reason: string;
    client_id: string;
    origin?: Provenance["origin"];
    recorded_at_fidelity?: Provenance["recorded_at_fidelity"];
  }):
    | { ok: true; row: AliasRow }
    | { ok: false; code: "alias-already-redirected"; id: string; existing_row: AliasRow; message: string } {
    const existingRow = this.rowsByOldId.get(input.old_id);
    if (existingRow) return this.alreadyRedirected(input.old_id, existingRow);
    const row = this.appendRow(
      {
        old_id: input.old_id,
        reason: input.reason,
        basis: "mechanical-migration",
        client_id: input.client_id,
        origin: input.origin ?? "pre-contract-import",
        recorded_at_fidelity: input.recorded_at_fidelity ?? "import-artifact",
        resolution_assertion_id: null
      },
      { disposition: input.disposition }
    );
    return { ok: true, row };
  }

  /**
   * Find the entity a source observation already belongs to, or mint one.
   *
   * This is the half of the fix that the id-minting rule alone does not give
   * you. Minting stops an edit from CHANGING an id; this stops a re-import from
   * failing to FIND it. The old importer had neither: identity was a pure
   * function of path, line number, and text, so a one-character edit produced a
   * new object and the previous one became unreferenced.
   *
   * The match is a vote across four independently unstable traits. Any one of
   * them changes on an ordinary edit; two changing at once in a way that still
   * matches some other entity is the rare case, and it is refused as ambiguous
   * rather than resolved by picking.
   */
  resolveOrMint(input: {
    observation: SourceObservation;
    draft: EntityDraft;
    client_id: string;
    origin?: Provenance["origin"];
    recorded_at_fidelity?: Provenance["recorded_at_fidelity"];
    sensitivity?: Sensitivity;
  }): IdentityMatch {
    const observation = SourceObservationSchema.parse(input.observation);
    const present = observedTraits(observation);

    // With fewer than the threshold, no future re-import could ever match this
    // record, so every run would mint another copy — the duplicate explosion
    // this method exists to prevent. Refuse rather than seed it.
    if (present.length < IDENTITY_MATCH_THRESHOLD) {
      return {
        ok: false,
        code: "identity-observation-underspecified",
        observed: present,
        message:
          `An observation needs at least ${IDENTITY_MATCH_THRESHOLD} of ` +
          `${present.length === 0 ? "four" : "the four"} traits to be re-findable; a record ` +
          "that cannot be re-found is minted again on every import."
      };
    }

    const votes = new Map<EntityId, ObservationTrait[]>();
    for (const trait of present) {
      const value = observation[trait];
      if (value === undefined) continue;
      const bucket = this.traitIndex.get(EntityRegistry.traitKey(trait, value));
      if (!bucket) continue;
      for (const entityId of bucket) {
        const hits = votes.get(entityId);
        if (hits) hits.push(trait);
        else votes.set(entityId, [trait]);
      }
    }

    const candidates = [...votes.entries()].filter(
      ([, traits]) => traits.length >= IDENTITY_MATCH_THRESHOLD
    );

    if (candidates.length > 1) {
      return {
        ok: false,
        code: "identity-ambiguous",
        candidate_ids: candidates.map(([entityId]) => entityId),
        matched_traits: [...new Set(candidates.flatMap(([, traits]) => traits))],
        message:
          `${candidates.length} entities match this observation on ${IDENTITY_MATCH_THRESHOLD} or ` +
          "more traits. Merging them is a decision with consequences, so it is left to a human " +
          "rather than made by an importer."
      };
    }

    const winner = candidates[0];
    if (winner) {
      const [entityId, traits] = winner;
      const entity = this.entities.get(entityId);
      if (entity) {
        // Re-anchor on the observation just seen. Drift accumulates one trait at
        // a time — edit the text today, rename the file tomorrow — and only
        // re-anchoring keeps each step within the threshold of the last.
        this.journal?.appendIdentityGroup({
          entities: [],
          rows: [],
          observations: [{ entity_id: entityId, observation, observed_at: this.stampNow() }]
        });
        this.indexObservation(entityId, observation);
        return { ok: true, entity, carried_forward: true, matched_traits: traits };
      }
    }

    const entity = this.mint(input.draft, input, this.stampNow());
    this.journal?.appendIdentityGroup({
      entities: [entity],
      rows: [],
      observations: [
        { entity_id: entity.entity_id, observation, observed_at: entity.registered_at }
      ]
    });
    this.remember(entity);
    this.indexObservation(entity.entity_id, observation);
    return { ok: true, entity, carried_forward: false, matched_traits: [] };
  }

  /** What the registry currently believes about where an entity came from. */
  observationOf(entityId: EntityId): SourceObservation | undefined {
    return this.observations.get(entityId);
  }

  private alreadyRedirected(
    id: string,
    existingRow: AliasRow
  ): { ok: false; code: "alias-already-redirected"; id: string; existing_row: AliasRow; message: string } {
    return {
      ok: false,
      code: "alias-already-redirected",
      id,
      existing_row: existingRow,
      message:
        `${id} already has a ledger row (${existingRow.disposition}, row ${existingRow.row_seq}). ` +
        "One successor per id is what makes resolution a path rather than a graph; a second row " +
        "would leave two readers free to pick different answers. Extend the chain from its head instead."
    };
  }

  private recordResolution(
    proposal: ResolutionProposal
  ):
    | { ok: true; assertion_id: AssertionId }
    | { ok: false; code: "resolution-recorder-required" | "resolution-assertion-failed"; detail: string; message: string } {
    if (!this.resolutions) {
      return {
        ok: false,
        code: "resolution-recorder-required",
        detail: "no resolution recorder configured",
        message:
          "An owner-initiated identity decision must be backed by a resolution assertion, and no " +
          "assertion log is wired up. Refusing rather than writing a bare redirect: silently " +
          "dropping the evidence would make a human's decision indistinguishable from a machine's."
      };
    }
    const recorded = this.resolutions.record(proposal);
    if (!recorded.ok) {
      return {
        ok: false,
        code: "resolution-assertion-failed",
        detail: `${recorded.code}: ${recorded.message}`,
        message:
          "The resolution assertion did not commit, so no ledger row was written. The redirect " +
          "and its evidence stand or fall together."
      };
    }
    return recorded;
  }

  /**
   * Seal a row onto the chain and make it durable before it is visible.
   *
   * `prev_ledger_digest` is read from the current head, so a row's digest
   * covers its position as well as its content — removing any earlier row
   * invalidates every row after it.
   */
  private appendRow(
    base: {
      old_id: string;
      reason: string;
      basis: AliasBasis;
      client_id: string;
      origin?: Provenance["origin"];
      recorded_at_fidelity?: Provenance["recorded_at_fidelity"];
      resolution_assertion_id: AssertionId | null;
      entities?: Entity[];
    },
    disposition:
      | { disposition: "mapped"; new_id: EntityId }
      | { disposition: "ambiguous-split"; candidate_ids: EntityId[] }
      | { disposition: TerminalDisposition }
  ): AliasRow {
    const head = this.rows[this.rows.length - 1];
    const unsealed = {
      record_schema: "atlas.alias-row:v1",
      row_seq: this.nextRowSeq,
      old_id: base.old_id,
      reason: base.reason,
      recorded_at: this.stampNow(),
      basis: base.basis,
      provenance: {
        client_id: base.client_id,
        origin: base.origin ?? "owner-authored",
        recorded_at_fidelity: base.recorded_at_fidelity ?? "authoritative"
      },
      resolution_assertion_id: base.resolution_assertion_id,
      prev_ledger_digest: head ? head.ledger_digest : null,
      ...disposition
    } as UnsealedAliasRow;

    const row = { ...unsealed, ledger_digest: aliasLedgerDigest(unsealed) } as AliasRow;

    // Durability before visibility, exactly as `commit()` does it: if the append
    // throws, no row_seq was burned and nothing resolves differently, so a retry
    // is a fresh decision rather than a replay of one that only existed in RAM.
    this.journal?.appendIdentityGroup({
      entities: base.entities ?? [],
      rows: [row],
      observations: []
    });

    for (const entity of base.entities ?? []) this.remember(entity);
    this.rows.push(row);
    this.rowsByOldId.set(row.old_id, row);
    this.nextRowSeq += 1;
    return row;
  }
}
