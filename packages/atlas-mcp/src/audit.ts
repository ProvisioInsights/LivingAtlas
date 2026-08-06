import { createHash } from "node:crypto";
import { canonicalRecordedAt, stableStringify, type RecordedAt } from "@living-atlas/atlas-core";
import { CONTRACT_LIMITS } from "@living-atlas/atlas-contract";
import type { Principal } from "./principal.js";

/**
 * One durable event per TOOL CALL. Never per graph object.
 *
 * AGENTS.md requires that every mutating operation produce a durable,
 * inspectable event, and that reads by remote providers are security-relevant
 * events too. The prior implementation satisfied the letter of that and broke
 * on it: `localListObjects` called `recordToolDecision` inside
 * `for (const object of contextObjects(context))` — an unbounded whole-graph
 * loop — so a single `object_list` call wrote one event per object across two
 * logs. Measured at ~58 MiB for one call, and eventually past Node's 512 MiB
 * maximum string length, at which point the audit log stopped being writable at
 * all. An audit trail that fails under load is worse than none, because the
 * failure looks like an absence of activity.
 *
 * The fix is a size bound that holds by construction rather than by care:
 *
 *   **An audit event may name only identifiers that appeared in the REQUEST.
 *   Everything the graph produced is counted, never listed.**
 *
 * The request is already bounded by published limits — `max_ids_per_request`
 * (100) and `max_batch_items` (100) — so the event's size is bounded by the
 * contract, not by how much graph the call happened to touch. A full-graph scan
 * and a single-id read write events of the same order of size.
 *
 * What is lost is per-object attribution, and that is the right trade: knowing
 * that one call read 41,203 records and withheld 812 is the security-relevant
 * fact. Which 41,203 is a copy of the graph, and writing a copy of the graph
 * into the audit log on every read is how the log became unwritable.
 */

/** The counters every tool call reports. Absent means the tool cannot produce it. */
export type AuditCounts = {
  /** Records examined before filtering. */
  evaluated?: number;
  /** Records that matched and were returned as content. */
  returned?: number;
  /** Records replaced by a redaction stub for this credential. */
  withheld?: number;
  /** Assertions durably committed. */
  committed?: number;
  /** Items the tool refused. */
  refused?: number;
  /** Withheld records this call actually disclosed. Non-zero only for reveal. */
  revealed?: number;
};

export type AuditEvent = {
  record_schema: "atlas.audit:v1";
  event_id: string;
  recorded_at: RecordedAt;
  tool: string;
  /**
   * Resolved from the credential. Never anything the caller sent, and `null`
   * when no credential resolved at all.
   *
   * `null` rather than a sentinel string, because a sentinel is a name a real
   * credential could also be given, and "nobody was authenticated" then becomes
   * indistinguishable from "a client called itself that". A rejected call is
   * still an event: an unauthenticated attempt is exactly the activity an audit
   * reader most needs to see.
   */
  client_id: string | null;
  credential_class: Principal["credential_class"] | null;
  /**
   * Which plane served the call, and which grant authorized it.
   *
   * The plane is known even for a refused credential — it is a property of the
   * server, not of the caller — and it has to be, because two planes write into
   * one journal. `grant_id` names the grant without naming the credential, so a
   * later revision of a credential's grant does not make old events ambiguous.
   */
  plane: Principal["plane"];
  grant_id: string | null;
  outcome: "ok" | "refused" | "input-required" | "error";
  /** Set on any non-ok outcome. An open vocabulary, matching `atlas.error:v1`. */
  reason_code?: string;
  counts: AuditCounts;
  /**
   * Identifiers the CALLER named, capped. Never ids the graph produced.
   *
   * Capped even so: the cap is a published limit, but a caller that ignores the
   * schema still cannot make the log grow without bound, because the cap is
   * applied here rather than trusted from validation upstream.
   */
  subjects: string[];
  subjects_truncated: boolean;
  /**
   * Digest of the request arguments, so an event can be tied to the exact call
   * that produced it without the arguments themselves entering the log. A query
   * filter is graph content: `subject_entity_id` names a real thing, and a text
   * query is frequently the most sensitive string in the request.
   */
  arguments_digest: string;
  protocol_version: string;
};

/**
 * The durability port. Synchronous, like `LogJournal` in atlas-core and for the
 * same reason: the call returns after the event is written, so a result can
 * never reach a consumer describing a disclosure the log does not know about.
 *
 * "Written" means DURABLE, not merely handed to the operating system. An
 * implementation MUST NOT return until the event would survive a crash — see
 * `DurableFileAuditJournal` in `audit-file.ts`, which is `commit()`'s
 * fsync-before-acknowledge discipline applied to this log. Both CLIs previously
 * used `appendFileSync`, which returns once the bytes reach the page cache, so
 * a crash could lose the event AFTER the disclosure it records had already been
 * returned. That is the one direction the discrepancy must never point: a graph
 * that was read and a log that says it was not.
 *
 * An implementation that cannot make the event durable MUST throw rather than
 * silently degrade. The dispatcher treats that throw as the call failing, which
 * is what makes the guarantee fail-closed: no disclosure is returned whose event
 * could not be written. (ADR 0014 OPEN-4, resolved 2026-08-04.)
 */
export type AuditJournal = {
  append(event: AuditEvent): void;
};

/** Ids named in one event. One more than the largest a valid request can carry. */
export const MAX_AUDIT_SUBJECTS = CONTRACT_LIMITS.max_ids_per_request;

function eventId(seed: string): string {
  return `la_audit_${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Digest of the arguments, over the canonical form.
 *
 * `stableStringify` is atlas-core's, shared with `claimDigest` and the alias
 * ledger's chain: one canonical form for the whole repo means two components
 * cannot disagree about what "the same arguments" are.
 */
export function argumentsDigest(args: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(args), "utf8").digest("hex")}`;
}

export type AuditRecorderOptions = {
  journal: AuditJournal;
  clock?: () => Date;
};

/**
 * Writes exactly one event per tool call.
 *
 * The counter is not decorative. A handler that recorded twice would be a
 * regression toward the per-object behaviour, so the recorder tracks how many
 * events it wrote and `writes` is asserted in tests directly.
 */
export class AuditRecorder {
  private readonly journal: AuditJournal;
  private readonly clock: () => Date;
  private count = 0;
  /** Strictly increasing belief time, so two events in one millisecond still order. */
  private lastMillis = 0;

  constructor(options: AuditRecorderOptions) {
    this.journal = options.journal;
    this.clock = options.clock ?? (() => new Date());
  }

  get writes(): number {
    return this.count;
  }

  record(input: {
    tool: string;
    /**
     * The resolved principal, or `undefined` when the credential did not
     * resolve. Undefined is a first-class case rather than an early return: a
     * refused credential is precisely the call an audit reader is looking for,
     * and a server that logs only successful authentications reports an attack
     * as silence.
     */
    principal: Principal | undefined;
    /** The SERVER's plane. Known without a credential, because it is not the caller's property. */
    plane: Principal["plane"];
    protocolVersion: string;
    outcome: AuditEvent["outcome"];
    reasonCode?: string;
    counts: AuditCounts;
    /** Ids the CALLER named. Passing graph-produced ids here is the defect. */
    subjects?: readonly string[];
    args: unknown;
  }): AuditEvent {
    const millis = Math.max(this.clock().getTime(), this.lastMillis + 1);
    this.lastMillis = millis;
    const recordedAt = canonicalRecordedAt(new Date(millis));

    const named = input.subjects ?? [];
    const subjects = named.slice(0, MAX_AUDIT_SUBJECTS);
    const digest = argumentsDigest(input.args);

    const event: AuditEvent = {
      record_schema: "atlas.audit:v1",
      event_id: eventId(`${recordedAt} ${input.tool} ${input.principal?.client_id ?? ""} ${digest}`),
      recorded_at: recordedAt,
      tool: input.tool,
      client_id: input.principal?.client_id ?? null,
      credential_class: input.principal?.credential_class ?? null,
      plane: input.plane,
      grant_id: input.principal?.grant.grant_id ?? null,
      outcome: input.outcome,
      ...(input.reasonCode === undefined ? {} : { reason_code: input.reasonCode }),
      counts: input.counts,
      subjects,
      subjects_truncated: named.length > subjects.length,
      arguments_digest: digest,
      protocol_version: input.protocolVersion
    };

    // Counted BEFORE the append, not after.
    //
    // `writes` is what the dispatcher consults to decide whether this call has
    // already had its event, so it has to mean "handed to the journal" rather
    // than "the journal returned". Counting after left it stale whenever
    // `append` threw: the dispatcher then believed nothing had been written and
    // wrote a second time, so a failing journal was hit twice for one call —
    // the per-call fanout this class exists to prevent, reached through the
    // error path. A duplicate audit event is also worse than a missing one,
    // because a reader cannot tell it from two real calls.
    this.count += 1;
    this.journal.append(event);
    return event;
  }
}

/** An in-memory journal for tests and for a server started with no audit path. */
export class MemoryAuditJournal implements AuditJournal {
  readonly events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(event);
  }
}
