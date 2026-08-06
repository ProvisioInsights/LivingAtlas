import type { AuditEvent } from "../audit.js";

/**
 * What the operator plane reads and writes through.
 *
 * A port, for the same reason `GraphSource` is one: the operational state a
 * deployment holds — which migration window is open, how far a replica has
 * fallen behind, what a meter says it billed — is deployment-specific, and a
 * server that reached into a concrete store for it could not be tested without
 * one. Every fixture in this package is synthetic and in memory.
 *
 * Note what is NOT here: any way to read graph CONTENT. Operational tools
 * answer questions about the system, not about the knowledge in it. A review
 * queue item names a record and carries its sensitivity; it does not carry the
 * record. That keeps the operator plane from becoming a second, unaudited read
 * path into the graph.
 */

/** A tier as the operator plane sees it. Content above the grant's reach is withheld here too. */
export type OperatorSensitivity = { tier: string; rank: number; withheld: boolean };

export type MigrationWindowPhase = "planned" | "open" | "draining" | "closed" | "blocked" | "other";

export type MigrationWindow = {
  window_id: string;
  phase: MigrationWindowPhase;
  opened_at: string | null;
  closed_at: string | null;
  /** A label for the source being migrated. Never a filesystem path. */
  source_label: string;
  planned_records: number;
  migrated_records: number;
  refused_records: number;
  /** Why the window cannot advance, when it cannot. Null is "no obstacle known". */
  blocked_reason: string | null;
};

export type ReplicationState = "in-sync" | "behind" | "stalled" | "disconnected" | "other";

export type ReplicationTarget = {
  target_id: string;
  direction: "push" | "pull" | "bidirectional" | "other";
  feed_epoch: string;
  /**
   * The two watermarks are reported separately and the lag is derived from
   * them. A single "lag" number cannot distinguish a replica that is behind
   * from one whose epoch rolled, and those need different operator responses.
   */
  local_watermark_seq: number;
  acknowledged_seq: number;
  outbox_depth: number;
  last_contact_at: string | null;
  state: ReplicationState;
};

/**
 * What a meter says one client consumed, for reconciliation against the audit
 * log. Deliberately a separate input rather than something derived from the
 * events: reconciliation only means something when the two numbers come from
 * two places.
 */
export type MeteredUsage = {
  client_id: string;
  period_from: string;
  period_to: string;
  metered_calls: number;
};

export type ReviewItemState = "waiting" | "in-review" | "resolved" | "escalated" | "other";

export type ReviewItem = {
  item_id: string;
  kind: string;
  /** The record awaiting curation, by id. Never its content. */
  subject_ref: string;
  opened_at: string;
  state: ReviewItemState;
  assigned_to: string | null;
  sensitivity: OperatorSensitivity;
};

export type ReconcileSubject = "migration-window" | "replication" | "usage" | "other";

export type ReconcileChange = { field: string; from: string; to: string };

export type ReconcileOutcome =
  | { ok: true; applied: boolean; changes: readonly ReconcileChange[] }
  | { ok: false; code: string; message: string };

/** The audit log, as a read port. Reading it is itself an audited operation. */
export type AuditReader = {
  read(): readonly AuditEvent[];
};

export type OperatorSource = {
  migrationWindows(): readonly MigrationWindow[];
  replicationTargets(): readonly ReplicationTarget[];
  meteredUsage(): readonly MeteredUsage[];
  reviewQueue(): readonly ReviewItem[];
  audit: AuditReader;
  /**
   * Apply — or, with `dryRun`, only compute — a reconciliation.
   *
   * `dryRun` is a parameter of the port rather than something the server
   * simulates, because only the store knows what applying would change. A
   * server that computed a preview itself would be describing an operation it
   * did not perform.
   */
  reconcile(input: { subject: ReconcileSubject; targetId: string; dryRun: boolean }): ReconcileOutcome;
};
