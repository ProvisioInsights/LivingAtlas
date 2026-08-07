import type { AuditEvent } from "../audit.js";
import type { AtlasStore } from "../store.js";
import type {
  MeteredUsage,
  MigrationWindow,
  OperatorSource,
  ReconcileOutcome,
  ReplicationTarget,
  ReviewItem
} from "./source.js";

/**
 * The operator plane over a REAL durable store.
 *
 * What this source reports is exactly what the store knows, and the interesting
 * part is how much of that is EMPTY. `syntheticOperatorSource` fabricates a
 * migration window, a replication target and a review queue because a harness
 * needs rows to page through. A real store holds none of those: it is a segment
 * log and an identity log, and nothing in it records which migration window
 * produced it, which replica has acknowledged which seq, or which record a
 * curator is looking at.
 *
 * So those lists are empty, deliberately and permanently until something durable
 * backs them. Carrying the synthetic rows over would be the worst available
 * option — an operator would read a replication lag for a replica that does not
 * exist and act on it. An empty list says "this deployment has none", which is
 * true, and the page block that wraps it says the list was not truncated.
 *
 * The one thing a store DOES know about itself is its own identity and health,
 * and that is served by `atlas.ops.store.status.read.v1` rather than smuggled
 * into a row shaped like something else.
 */

export type StoreBackedOperatorSourceOptions = {
  store: AtlasStore;
  /**
   * The audit events this plane serves reads from. Supplied rather than derived
   * from the store: the audit log is a disclosure record, not graph state, and
   * where it lives is an argument to the plane that writes it.
   */
  audit: () => readonly AuditEvent[];
};

/**
 * Operational state a durable store does not carry, and why each one is empty.
 *
 * A named table rather than four bare `[]` returns, because "there are none" and
 * "nobody wired this up" are different facts and only one of them is true here.
 * When a durable source for one of these arrives, its row leaves this table.
 */
const NOT_DURABLE_IN_THE_STORE = {
  "migration-window":
    "A migration window is the state of a RUN, held by whatever performs the migration. The store it writes into records the assertions, not the window.",
  replication:
    "The store publishes a change feed; it does not record who consumes it. A replica's acknowledged seq is held by the replication agent, and reporting a lag without one would be reporting a lag against nothing.",
  usage:
    "Metered usage comes from a meter, on purpose: reconciliation only means something when the two numbers come from two places. Deriving it from the audit log would reconcile the log against itself.",
  "review-queue": "Curation state is not written into the assertion log, so a store on its own has no queue to show."
} as const;

export function storeBackedOperatorSource(options: StoreBackedOperatorSourceOptions): OperatorSource {
  const windows: readonly MigrationWindow[] = [];
  const targets: readonly ReplicationTarget[] = [];
  const metered: readonly MeteredUsage[] = [];
  const queue: readonly ReviewItem[] = [];

  return {
    store: () => options.store.status(),
    migrationWindows: () => windows,
    replicationTargets: () => targets,
    meteredUsage: () => metered,
    reviewQueue: () => queue,
    audit: { read: () => options.audit() },
    /**
     * Every reconcile is refused, and the refusal names the subject.
     *
     * A reconcile applies a correction to operational state. This source has no
     * operational state to correct, so the only outcomes available are a
     * refusal and a lie — `{ok: true, applied: true, changes: []}` would report
     * success for work nobody did, which is the exact failure
     * `reconcile-subject-unknown` already exists to prevent one layer up.
     */
    reconcile: ({ subject }): ReconcileOutcome => ({
      ok: false,
      code: "reconcile-refused",
      message:
        `This server is serving a durable store, which holds no ${subject} state to reconcile. ` +
        (NOT_DURABLE_IN_THE_STORE[subject as keyof typeof NOT_DURABLE_IN_THE_STORE] ??
          "Nothing durable backs that subject on this deployment.")
    })
  };
}
