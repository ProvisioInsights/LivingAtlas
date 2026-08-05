import { z } from "zod";
import {
  AssertionDraftSchema,
  DEFAULT_ASSERTION_SENSITIVITY,
  validateLineage,
  type Assertion,
  type AssertionDraft
} from "./assertion.js";
import {
  AssertionIdSchema,
  ClaimDigestSchema,
  SubmissionIdSchema,
  claimDigest,
  mintAssertionId,
  mintSubmissionId,
  type AssertionId
} from "./ids.js";
import {
  RecordedAtSchema,
  canonicalRecordedAt,
  intervalContains,
  validTimeFidelity,
  type MatchQuality,
  type RecordedAt,
  type ValidTimeFidelity
} from "./time.js";

/**
 * The append-only assertion log.
 *
 * Two properties are load-bearing and everything else follows from them:
 *
 *  1. An assertion is never rewritten. The only mutation is stamping
 *     `superseded_at`/`superseded_by` once, on a record that is already
 *     committed, when something else supersedes it.
 *  2. `recorded_at` and `seq` are assigned at COMMIT and nowhere else. A draft
 *     that has not committed has neither, so it is invisible to every as-of
 *     read and absent from every feed page. Belief time is therefore monotone
 *     by construction, which is what makes an as-of read repeatable: a query
 *     over a past instant can never change answer because something was sitting
 *     in a queue.
 */

export type Clock = () => Date;

/**
 * The idempotency identity, as one function rather than one string template per
 * call site. A reload has to rebuild these keys from receipts read off disk,
 * and a reader that reconstructed the key with a different separator would miss
 * every prior submission — so a retry after a restart would commit a second
 * copy instead of replaying the original receipt. One definition, no drift.
 *
 * The separator is NUL because both halves are caller-supplied free strings: a
 * printable separator lets one client choose a `client_id`/`idempotency_key`
 * pair that collides with another client's, and replay its receipt.
 */
export function submissionKey(clientId: string, idempotencyKey: string): string {
  return `${clientId}\u0000${idempotencyKey}`;
}

/**
 * A schema, not just a type, because a receipt has to survive a round trip
 * through the durable log: replaying an idempotent retry after a restart means
 * reading a receipt back off disk and handing it to a caller as authoritative.
 * Anything that comes back from disk is untrusted until it has been parsed.
 */
export const SubmissionReceiptSchema = z
  .object({
    submission_id: SubmissionIdSchema,
    client_id: z.string(),
    idempotency_key: z.string(),
    committed_at: RecordedAtSchema,
    assertion_ids: z.array(AssertionIdSchema),
    /** Digest of the request payload, so a retry with different content is caught. */
    request_digest: ClaimDigestSchema
  })
  .strict();

export type SubmissionReceipt = z.infer<typeof SubmissionReceiptSchema>;

/**
 * The write-once supersession stamp, as a value rather than as an edit.
 *
 * A durable log expresses this by APPENDING the stamp and folding it in on
 * load, never by rewriting the line that holds the superseded record. That is
 * the entire proof that the record was not altered: the original bytes are
 * still there, byte-for-byte, and the stamp sits after them.
 */
export type SupersessionStamp = {
  assertion_id: AssertionId;
  superseded_at: RecordedAt;
  superseded_by: AssertionId;
};

/**
 * What is left of an assertion after compaction reclaimed it.
 *
 * A reclaimed id resolves to this note, never to a bare "not found". The old
 * store's 169,205 mutations left no recoverable prior state AND no evidence
 * that the prior state had ever existed, so a dangling reference and a typo
 * were indistinguishable. Here they are not.
 */
export type ReclamationNote = {
  seq: number;
  reclaimed_at: RecordedAt;
  reclaimed_from_segment: number;
};

/**
 * The durability port.
 *
 * Deliberately synchronous. `commit()` returns a receipt, and a receipt is a
 * claim about the past — "this is written" — not a promise about the future.
 * An async append would let the receipt escape before the bytes were durable,
 * which is precisely the lie this layer exists to prevent.
 */
export type LogJournal = {
  /** Append one commit as an indivisible group. Durable before it returns. */
  appendCommit(group: {
    assertions: Assertion[];
    supersessions: SupersessionStamp[];
    receipt: SubmissionReceipt;
  }): void;
  appendWatermark(entry: { published_seq: number; published_at: RecordedAt }): void;
  appendHistoryFloor(entry: { history_floor: RecordedAt; advanced_at: RecordedAt }): void;
};

/** Everything a reload has to restore for a restart to be invisible. */
export type RestoredLog = {
  feed_epoch: string;
  history_floor: RecordedAt;
  /** In `seq` order, with every supersession stamp already folded in. */
  assertions: Assertion[];
  /** Keyed by `submissionKey()` — never by an inlined string template. */
  submissions: Map<string, SubmissionReceipt>;
  reclaimed: Map<AssertionId, ReclamationNote>;
  next_seq: number;
  /** Highest belief-time instant ever stamped, so a restart cannot go back. */
  last_recorded_millis: number;
  published_watermark: number;
};

export type HistoryFloorAdvance =
  | { ok: true; history_floor: RecordedAt; advanced: boolean }
  | { ok: false; code: "history-floor-cannot-regress"; history_floor: RecordedAt; message: string };

export type HistoryFloorRefusal = {
  ok: false;
  code: "as-of-before-history-floor";
  bitemporal_since: RecordedAt;
  message: string;
};

export type AsOfQuery = {
  subject_entity_id?: string;
  predicate?: string;
  /** Instant on the BELIEF axis: "what did Atlas believe at this moment?" */
  as_of_recorded?: RecordedAt;
  /** Partial date on the WORLD axis: "...about this span of real time?" */
  as_of_valid?: string;
  /**
   * Return records that were superseded as well as the ones still believed.
   *
   * Off by default, because the default question is "what does Atlas believe";
   * on, the answer is "and what did it believe before that", which is the read a
   * lineage view needs. It composes with `as_of_recorded` rather than replacing
   * it: at a past belief instant it adds back the records superseded on or
   * before that instant, so "everything Atlas had ever said by T" is expressible
   * and "what Atlas believed at T" still is.
   */
  include_superseded?: boolean;
};

export type QueryHit = {
  assertion: Assertion;
  valid_time_fidelity: ValidTimeFidelity;
  match_quality?: MatchQuality;
};

export type QueryPage = {
  ok: true;
  hits: QueryHit[];
  /**
   * Absence is always reported, never performed. The old store's `search`,
   * `traverse`, `timeline` and `edge_read` all dropped rows the caller could
   * not detect, so a partial graph was indistinguishable from a complete one.
   */
  coverage: {
    evaluated: number;
    matched: number;
    withheld: number;
    with_valid_time: number;
    unknown_or_absent_valid_time: number;
  };
  /**
   * True when the page mixes Atlas-stamped belief times with import artifacts.
   * Belief-time ordering across that boundary is meaningless — permanently, not
   * just before the floor — so it is a property of the RESULT, not only of the
   * query input.
   */
  recorded_at_fidelity_mixed: boolean;
  horizon: {
    status: "complete" | "partial" | "unknowable";
    record_time_floor: RecordedAt;
    feed_epoch: string;
  };
};

export type CommitConflict = {
  ok: false;
  code: "idempotency-key-conflict";
  message: string;
  original: SubmissionReceipt;
};

export type CommitResult = { ok: true; receipt: SubmissionReceipt; replayed: boolean } | CommitConflict;

export type AssertionLogOptions = {
  clock?: Clock;
  feedEpoch?: string;
  /**
   * The instant from which belief time is trustworthy. Reads on the belief axis
   * before this are REFUSED, not silently answered from present state. This is
   * the single most important honesty mechanism in the store: Atlas has no
   * pre-cutover history and must say so rather than imply one.
   */
  bitemporalSince?: RecordedAt;
  /** Durability sink. Absent means an in-memory log that vanishes on exit. */
  journal?: LogJournal;
  /**
   * State replayed from a durable log. When present it WINS over `feedEpoch`
   * and `bitemporalSince`: what the log says happened outranks what a caller's
   * config file currently believes, or reopening a store would silently
   * re-forfeit — or un-forfeit — history that was already settled on disk.
   */
  restored?: RestoredLog;
};

export class AssertionLog {
  readonly feedEpoch: string;

  private readonly clock: Clock;
  private readonly journal: LogJournal | undefined;
  private readonly assertions: Assertion[] = [];
  private readonly byId = new Map<AssertionId, Assertion>();
  private readonly submissions = new Map<string, SubmissionReceipt>();
  private readonly reclaimed = new Map<AssertionId, ReclamationNote>();
  private historyFloor: RecordedAt;
  private nextSeq = 1;
  /** Guarantees strictly increasing belief time even under a coarse clock. */
  private lastRecordedMillis = 0;
  /** Highest seq handed to a consumer. Bounds compaction from above. */
  private publishedSeq = 0;
  /** Highest seq compaction has reclaimed, so a stale cursor can be told. */
  private retentionFloorSeq = 0;

  constructor(options: AssertionLogOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.journal = options.journal;

    const restored = options.restored;
    this.feedEpoch = restored?.feed_epoch ?? options.feedEpoch ?? "e1";
    this.historyFloor =
      restored?.history_floor ?? options.bitemporalSince ?? canonicalRecordedAt(this.clock());

    if (!restored) return;
    for (const assertion of restored.assertions) {
      this.assertions.push(assertion);
      this.byId.set(assertion.assertion_id, assertion);
    }
    for (const [key, receipt] of restored.submissions) this.submissions.set(key, receipt);
    for (const [id, note] of restored.reclaimed) {
      this.reclaimed.set(id, note);
      this.retentionFloorSeq = Math.max(this.retentionFloorSeq, note.seq);
    }
    this.nextSeq = restored.next_seq;
    this.lastRecordedMillis = restored.last_recorded_millis;
    this.publishedSeq = restored.published_watermark;
  }

  /**
   * The belief-time history floor. A getter rather than a readonly field
   * because it may be ADVANCED — never lowered — and advancing it is the only
   * act that makes history eligible for compaction. You cannot reclaim history
   * you are still promising to answer for.
   */
  get bitemporalSince(): RecordedAt {
    return this.historyFloor;
  }

  /**
   * Highest `seq` this store has HANDED to a consumer.
   *
   * Precision matters here, because compaction keys off it: this says the bytes
   * left the store, not that any consumer processed or acknowledged them. It is
   * therefore a necessary condition for reclaiming a record and never a
   * sufficient one.
   */
  get publishedWatermark(): number {
    return this.publishedSeq;
  }

  private stampNow(): RecordedAt {
    const millis = Math.max(this.clock().getTime(), this.lastRecordedMillis + 1);
    this.lastRecordedMillis = millis;
    return canonicalRecordedAt(new Date(millis));
  }

  /**
   * Idempotency is `(client_id, idempotency_key)` and never content hashing.
   *
   * Content hashing cannot work here: an assertion's body carries a
   * server-assigned `recorded_at`, so the same logical write can never hash the
   * same twice. Content-addressed identity and server-assigned belief time are
   * mutually exclusive, and belief time is the one that has to win.
   *
   * A retry returns the ORIGINAL receipt with the ORIGINAL ids — it does not
   * re-mint, does not re-stamp `recorded_at`, and does not burn new `seq`
   * values. A retry carrying a *different* payload is a conflict, not a
   * silent accept of either version.
   */
  commit(input: {
    client_id: string;
    idempotency_key: string;
    drafts: AssertionDraft[];
    origin?: Assertion["provenance"]["origin"];
    recorded_at_fidelity?: Assertion["provenance"]["recorded_at_fidelity"];
    sensitivity?: Assertion["sensitivity"];
  }): CommitResult {
    const key = submissionKey(input.client_id, input.idempotency_key);
    const drafts = input.drafts.map((draft) => AssertionDraftSchema.parse(draft));
    drafts.forEach(validateLineage);

    const requestDigest = claimDigest({
      subject_entity_id: input.client_id,
      predicate: input.idempotency_key,
      value: drafts
    });

    const prior = this.submissions.get(key);
    if (prior) {
      if (prior.request_digest !== requestDigest) {
        return {
          ok: false,
          code: "idempotency-key-conflict",
          message:
            "This idempotency key was already used with a different payload. " +
            "Use a new key, or resend the original payload byte-for-byte.",
          original: prior
        };
      }
      return { ok: true, receipt: prior, replayed: true };
    }

    const committedAt = this.stampNow();
    const mintedAt = new Date(committedAt);
    const ids: AssertionId[] = [];
    const minted: Assertion[] = [];
    const stamps: SupersessionStamp[] = [];
    let seq = this.nextSeq;

    for (const draft of drafts) {
      const assertionId = mintAssertionId(mintedAt);
      const assertion: Assertion = {
        record_schema: "atlas.assertion:v1",
        assertion_id: assertionId,
        seq,
        feed_epoch: this.feedEpoch,
        kind: draft.kind,
        lineage_action: draft.lineage_action,
        subject_entity_id: draft.subject_entity_id,
        predicate: draft.predicate,
        value: draft.value,
        target_entity_id: draft.target_entity_id,
        valid_from: draft.valid_from,
        valid_to: draft.valid_to,
        recorded_at: committedAt,
        superseded_at: null,
        superseded_by: null,
        supersedes: draft.supersedes,
        claim_digest: claimDigest({
          subject_entity_id: draft.subject_entity_id,
          predicate: draft.predicate,
          value: draft.value,
          valid_from: draft.valid_from,
          valid_to: draft.valid_to
        }),
        provenance: {
          client_id: input.client_id,
          origin: input.origin ?? "consumer-proposed",
          recorded_at_fidelity: input.recorded_at_fidelity ?? "authoritative",
          proposed_at: draft.proposed_at,
          basis: draft.basis
        },
        confidence: draft.confidence,
        evidence_links: draft.evidence_links,
        // Unclassified content is local-private, per AGENTS.md. A caller that
        // means something else has to say so, which is the point: the tier a
        // record lands at when nobody chose one is a privacy decision, and the
        // safe end of it is the only end that can be reversed later.
        sensitivity: input.sensitivity ?? { ...DEFAULT_ASSERTION_SENSITIVITY }
      };

      seq += 1;
      minted.push(assertion);
      ids.push(assertionId);

      // Supersession stamps the PRIOR record. This is the only write to an
      // already-committed assertion, it happens at most once, and it never
      // returns to null. Resolved here but NOT applied — nothing touches live
      // state until the whole group is durable.
      for (const supersededId of draft.supersedes) {
        const target = this.byId.get(supersededId);
        if (!target) {
          throw new Error(`supersedes references an unknown assertion: ${supersededId}`);
        }
        if (target.superseded_at === null && !stamps.some((s) => s.assertion_id === supersededId)) {
          stamps.push({
            assertion_id: supersededId,
            superseded_at: committedAt,
            superseded_by: assertionId
          });
        }
      }
    }

    const receipt: SubmissionReceipt = {
      submission_id: mintSubmissionId(mintedAt),
      client_id: input.client_id,
      idempotency_key: input.idempotency_key,
      committed_at: committedAt,
      assertion_ids: ids,
      request_digest: requestDigest
    };

    // Durability BEFORE visibility. If the append throws, `seq` was never
    // advanced, nothing entered `byId`, and no receipt exists — so the caller's
    // retry is a fresh commit rather than a replay of something that only ever
    // existed in RAM. A gap in `seq` would be permanent and unfixable, because
    // gapless-within-an-epoch is what lets a consumer prove it missed nothing.
    this.journal?.appendCommit({ assertions: minted, supersessions: stamps, receipt });

    for (const assertion of minted) {
      this.assertions.push(assertion);
      this.byId.set(assertion.assertion_id, assertion);
    }
    for (const stamp of stamps) {
      const target = this.byId.get(stamp.assertion_id);
      if (target && target.superseded_at === null) {
        target.superseded_at = stamp.superseded_at;
        target.superseded_by = stamp.superseded_by;
      }
    }
    this.nextSeq = seq;
    this.submissions.set(key, receipt);
    return { ok: true, receipt, replayed: false };
  }

  /**
   * Move the belief-time history floor forward. This is a FORFEITURE: after it
   * returns, reads before the new floor are refused, and only then may
   * compaction reclaim what sits below it.
   *
   * It never moves backwards. Lowering the floor would re-open a window Atlas
   * has already reclaimed storage for, so the store would start accepting
   * as-of reads it can only answer from an incomplete log — a confident wrong
   * answer produced by a config change.
   */
  advanceHistoryFloor(to: RecordedAt): HistoryFloorAdvance {
    if (to < this.historyFloor) {
      return {
        ok: false,
        code: "history-floor-cannot-regress",
        history_floor: this.historyFloor,
        message:
          `The history floor is already ${this.historyFloor} and cannot be lowered to ${to}. ` +
          "History below a floor may already have been reclaimed, so re-opening the " +
          "window would answer as-of reads from a log that is knowingly incomplete."
      };
    }
    if (to === this.historyFloor) {
      return { ok: true, history_floor: this.historyFloor, advanced: false };
    }
    this.journal?.appendHistoryFloor({ history_floor: to, advanced_at: this.stampNow() });
    this.historyFloor = to;
    return { ok: true, history_floor: to, advanced: true };
  }

  /**
   * Why an id that once resolved no longer does. Returns undefined for an id
   * that was never minted — which is a different answer from "reclaimed", and
   * the caller gets to tell them apart.
   */
  readReclamation(assertionId: AssertionId): ReclamationNote | undefined {
    return this.reclaimed.get(assertionId);
  }

  /**
   * Drop reclaimed records from live state so behaviour is identical either
   * side of a restart. Compaction owns the decision and the durable proof; this
   * only makes memory agree with the segments that survived.
   */
  applyReclamation(notes: Map<AssertionId, ReclamationNote>): void {
    if (notes.size === 0) return;
    for (const [id, note] of notes) {
      this.reclaimed.set(id, note);
      this.byId.delete(id);
      this.retentionFloorSeq = Math.max(this.retentionFloorSeq, note.seq);
    }
    for (let index = this.assertions.length - 1; index >= 0; index -= 1) {
      const assertion = this.assertions[index];
      if (assertion && notes.has(assertion.assertion_id)) this.assertions.splice(index, 1);
    }
  }

  /**
   * The bitemporal read.
   *
   *   recorded_at   <= as_of_recorded
   *   AND (superseded_at IS NULL OR superseded_at > as_of_recorded)
   *   AND valid_interval CONTAINS as_of_valid
   *
   * The two axes are independent, which is the whole point:
   *   as_of_valid=2019-03, as_of_recorded=now  → what we NOW believe about March 2019
   *   as_of_valid=2019-03, as_of_recorded=<past> → what we believed THEN about March 2019
   */
  query(request: AsOfQuery): QueryPage | HistoryFloorRefusal {
    if (request.as_of_recorded && request.as_of_recorded < this.bitemporalSince) {
      return {
        ok: false,
        code: "as-of-before-history-floor",
        bitemporal_since: this.bitemporalSince,
        message:
          `Atlas retains no belief-time history before ${this.bitemporalSince}. ` +
          "This is refused rather than answered from present state, because a " +
          "confident wrong answer is worse than a refusal."
      };
    }

    const asOfRecorded = request.as_of_recorded;
    let evaluated = 0;
    let withheld = 0;
    let withValidTime = 0;
    const hits: QueryHit[] = [];

    for (const assertion of this.assertions) {
      if (request.subject_entity_id && assertion.subject_entity_id !== request.subject_entity_id) {
        continue;
      }
      if (request.predicate && assertion.predicate !== request.predicate) continue;
      evaluated += 1;

      const includeSuperseded = request.include_superseded === true;
      if (asOfRecorded) {
        if (assertion.recorded_at > asOfRecorded) continue;
        if (!includeSuperseded && assertion.superseded_at !== null && assertion.superseded_at <= asOfRecorded) {
          continue;
        }
      } else if (!includeSuperseded && assertion.superseded_at !== null) {
        continue;
      }

      const fidelity = validTimeFidelity({ from: assertion.valid_from, to: assertion.valid_to });

      let quality: MatchQuality | undefined;
      if (request.as_of_valid) {
        const match = intervalContains(
          { from: assertion.valid_from, to: assertion.valid_to },
          request.as_of_valid
        );
        if (!match.matches) continue;
        quality = match.quality;
      }

      // Counted AFTER the world-time filter, never before it. `with_valid_time`
      // partitions the rows that ENTERED the page, so its complement is
      // `hits.length - withValidTime`; counting a row that the `as_of_valid`
      // filter then rejected makes that subtraction go negative and publishes a
      // coverage block whose own members contradict each other.
      if (fidelity === "exact" || fidelity === "approximate") withValidTime += 1;

      // A withheld record still occupies a row: the consumer learns THAT it
      // exists and is unreachable, so counts always reconcile.
      if (assertion.sensitivity.withheld) withheld += 1;
      hits.push({ assertion, valid_time_fidelity: fidelity, match_quality: quality });
    }

    const fidelities = new Set(hits.map((hit) => hit.assertion.provenance.recorded_at_fidelity));

    return {
      ok: true,
      hits,
      coverage: {
        evaluated,
        matched: hits.length,
        withheld,
        with_valid_time: withValidTime,
        unknown_or_absent_valid_time: hits.length - withValidTime
      },
      recorded_at_fidelity_mixed: fidelities.size > 1,
      horizon: {
        status: "complete",
        record_time_floor: this.bitemporalSince,
        feed_epoch: this.feedEpoch
      }
    };
  }

  /** Unconditional read: returns the record whether or not it is still believed. */
  read(assertionId: AssertionId): Assertion | undefined {
    return this.byId.get(assertionId);
  }

  /**
   * Look up a receipt by the identity that produced it.
   *
   * This exists for the one case that matters: a caller's connection dropped
   * after it sent a proposal and it does not know whether the commit landed.
   * Retrying blind is only safe while the key is still deduplicated, so the
   * caller has to be able to ASK — and `commit()` alone cannot answer, because
   * asking it means risking a second copy.
   */
  readSubmission(clientId: string, idempotencyKey: string): SubmissionReceipt | undefined {
    return this.submissions.get(submissionKey(clientId, idempotencyKey));
  }

  /**
   * Look up a receipt by the id Atlas minted.
   *
   * Deliberately NOT scoped to a caller here: this layer has no notion of a
   * credential, and inventing one would put the same access rule in two places.
   * The scope check belongs to whatever serves the receipt, against the
   * `client_id` the receipt itself carries.
   */
  readSubmissionById(submissionId: string): SubmissionReceipt | undefined {
    for (const receipt of this.submissions.values()) {
      if (receipt.submission_id === submissionId) return receipt;
    }
    return undefined;
  }

  /**
   * Resumable change feed. Total order by `seq` within an epoch, so a consumer
   * offline for a week resumes from its cursor and misses nothing.
   *
   * Delivering a change PUBLISHES it: the watermark advances to the highest seq
   * that left the store, and that advance is journalled. Compaction may never
   * reclaim above it. The watermark is written only when it actually moves, so
   * a consumer polling an idle feed every second appends nothing.
   */
  changesSince(cursorSeq: number, limit = 100): {
    changes: Assertion[];
    next_cursor: number;
    has_more: boolean;
    feed_epoch: string;
    /** Highest seq compaction has reclaimed; 0 when nothing was ever reclaimed. */
    retention_floor_seq: number;
    /**
     * The cursor predates retained history, so this page is missing changes
     * that once existed. Reported rather than papered over: a consumer that
     * silently resumes past a hole cannot tell a compacted range from an
     * uneventful one.
     */
    cursor_before_retention_floor: boolean;
  } {
    const changes = this.assertions.filter((a) => a.seq > cursorSeq).slice(0, limit);
    const last = changes[changes.length - 1];
    const nextCursor = last ? last.seq : cursorSeq;

    if (nextCursor > this.publishedSeq) {
      this.journal?.appendWatermark({
        published_seq: nextCursor,
        published_at: this.stampNow()
      });
      this.publishedSeq = nextCursor;
    }

    return {
      changes,
      next_cursor: nextCursor,
      has_more: this.assertions.some((a) => a.seq > nextCursor),
      feed_epoch: this.feedEpoch,
      retention_floor_seq: this.retentionFloorSeq,
      cursor_before_retention_floor: cursorSeq < this.retentionFloorSeq
    };
  }

  get size(): number {
    return this.assertions.length;
  }
}
