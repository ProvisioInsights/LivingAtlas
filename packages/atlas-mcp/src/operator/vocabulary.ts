import type { ErrorCodeEntry } from "../vocabulary.js";

/**
 * The operator plane's OWN error-code registry.
 *
 * Separate from the consumer registry, and that separation is enforced by a
 * test rather than left to care: `atlas.contract.describe.v1` publishes the
 * consumer registry to anyone holding a consumer credential, so an operational
 * refusal listed there would tell every consumer which operational tools exist
 * and what can go wrong in them. The contract package already holds the same
 * line for atlas-core's identity-decision refusals.
 *
 * Published through `atlas.ops.scope.describe.v1`, because the operator plane
 * has no `contract.describe` — see ADR 0015 on why it is not a published,
 * fetchable contract.
 */
export const OPERATOR_ERROR_CODES: readonly ErrorCodeEntry[] = [
  {
    code: "migration-window-unknown",
    origin: "store",
    retryable: false,
    summary: "No migration window carries that id. Windows are named by the plan that opened them, never by position."
  },
  {
    code: "reconcile-refused",
    origin: "store",
    retryable: false,
    summary: "The store refused the reconciliation and said why. Reported rather than retried: a reconcile that silently retries can double-apply."
  },
  {
    code: "reconcile-subject-unknown",
    origin: "contract",
    retryable: false,
    summary: "That reconcile subject is not one this server implements. Refused rather than treated as a no-op, which would report success for work nobody did."
  },
  {
    code: "replication-target-unknown",
    origin: "store",
    retryable: false,
    summary: "No replication target carries that id, so there is nothing to reconcile against."
  },
  {
    code: "usage-period-unreconciled",
    origin: "store",
    retryable: false,
    summary: "The metered figure and the durable events disagree for this period. Reported as a delta; this server does not choose which of the two is right."
  }
] as const;

export const OPERATOR_ERROR_CODE_SET: ReadonlySet<string> = new Set(OPERATOR_ERROR_CODES.map((entry) => entry.code));
