/**
 * The LIVE error-code registry this server publishes through
 * `atlas.contract.describe.v1`.
 *
 * `atlas.error:v1`'s `code` is an OPEN vocabulary — a consumer must tolerate a
 * code it has never seen, because the alternative is a consumer that breaks
 * when Atlas becomes more honest. Open does not mean undocumented: a consumer
 * that cannot discover what a code MEANS can only branch on the ones its author
 * happened to have seen.
 *
 * So the table is here, next to the handlers that raise these codes, and a test
 * asserts that every code any handler can emit is registered. A refusal added
 * without a registry entry fails that test rather than reaching a consumer as an
 * unexplained string.
 */

export type ErrorCodeEntry = {
  code: string;
  origin: "store" | "identity" | "protocol" | "policy" | "contract";
  jsonrpc_code?: number;
  /** Whether the identical request could succeed later with nothing changed by the caller. */
  retryable: boolean;
  summary: string;
};

export const ERROR_CODES: readonly ErrorCodeEntry[] = [
  {
    code: "as-of-before-history-floor",
    origin: "store",
    retryable: false,
    summary: "The belief instant asked for is below the retained history floor. Refused rather than answered from present state."
  },
  {
    code: "assertion-reclaimed",
    origin: "store",
    retryable: false,
    summary: "Compaction reclaimed this assertion. It existed; its content is no longer retained. Never a bare not-found."
  },
  {
    code: "capability-required",
    origin: "protocol",
    jsonrpc_code: -32021,
    retryable: false,
    summary: "The operation needs a client capability this request did not declare, so no request that could answer it may be issued."
  },
  {
    code: "credential-plane-mismatch",
    origin: "policy",
    retryable: false,
    summary:
      "The presented credential is granted a different plane from the one this server serves. Written into the audit event; the caller is told only that the credential was not recognised."
  },
  {
    code: "credential-required",
    origin: "policy",
    retryable: false,
    summary:
      "No credential was presented on the request. Identity is per-request input on this revision, so a call without one has no client_id to attribute anything to."
  },
  {
    code: "credential-unknown",
    origin: "policy",
    retryable: false,
    summary:
      "The presented credential resolves to no grant in the directory. Written into the audit event; the caller is told only that the credential was not recognised."
  },
  {
    code: "credential-unrecognised",
    origin: "policy",
    retryable: false,
    summary:
      "The presented credential was refused. Deliberately one code for every cause: distinguishing them would tell a prober that a secret is real but issued for another plane."
  },
  {
    code: "cursor-before-retention-floor",
    origin: "store",
    retryable: false,
    summary: "The change-feed cursor predates retained history, so the page is missing changes that once existed."
  },
  {
    code: "cursor-invalid",
    origin: "contract",
    retryable: false,
    summary: "The paging cursor is not one this server issued."
  },
  {
    code: "feed-epoch-mismatch",
    origin: "store",
    retryable: false,
    summary: "The named feed epoch is not the running one. Every cursor from a prior epoch is invalid."
  },
  {
    code: "handler-failed",
    origin: "store",
    retryable: false,
    summary:
      "Audit-only reason code: a tool threw while serving the call. The event records THAT the call failed and never what failed, because a fault message carries stack frames and whatever graph value provoked it. The caller receives internal-error."
  },
  {
    code: "idempotency-key-conflict",
    origin: "store",
    retryable: false,
    summary: "This (client_id, idempotency_key) already committed a DIFFERENT payload. Neither version is silently accepted."
  },
  {
    code: "internal-error",
    origin: "store",
    retryable: false,
    summary:
      "A tool failed while serving this request. Deliberately uninformative: the failure is recorded in the server's audit log under handler-failed, and returning the fault detail would make an error message a channel for graph content and server internals."
  },
  {
    code: "invalid-argument",
    origin: "protocol",
    jsonrpc_code: -32602,
    retryable: false,
    summary: "The arguments do not satisfy the published input schema or a cross-field rule it cannot express."
  },
  {
    code: "invalid-request-state",
    origin: "protocol",
    jsonrpc_code: -32602,
    retryable: false,
    summary: "The echoed request_state failed integrity, expiry or principal-binding verification."
  },
  {
    code: "output-contract-violation",
    origin: "contract",
    retryable: false,
    summary: "The result this server built failed its own published output schema and was refused rather than returned."
  },
  {
    code: "reveal-declined",
    origin: "policy",
    // Retryable: the identical request could be approved next time. Nothing the
    // CALLER has to change — which is precisely what this flag answers.
    retryable: true,
    summary: "The owner did not approve the disclosure. Asking again is a second ask, not a repeat of the first."
  },
  {
    code: "owner-decision-missing",
    origin: "policy",
    retryable: true,
    summary: "The retry carried no answer for the owner-decision request, so nothing was disclosed."
  },
  {
    code: "predicate-not-writable",
    origin: "policy",
    retryable: false,
    summary:
      "This credential's grant does not name that predicate as writable. Write reach is granted per predicate, so a credential that may read a subject need not be able to assert about it."
  },
  {
    code: "request-state-object-mismatch",
    origin: "policy",
    retryable: false,
    summary: "The request_state verified, and names a different record from the one this call is about."
  },
  {
    code: "reveal-not-available",
    origin: "policy",
    retryable: false,
    summary: "This credential can never unlock withheld records. A property of the credential, not of the record."
  },
  {
    code: "sensitivity-withheld",
    origin: "policy",
    // Retryable: reclassifying the record or widening the grant makes the same
    // request succeed, and neither is something the caller does to its request.
    retryable: true,
    summary:
      "The record exists and this credential may not read it — either the record is marked withheld or its tier is outside the grant. Returned as a redaction stub, never dropped."
  },
  {
    code: "snapshot-expired",
    origin: "store",
    retryable: false,
    summary: "The paging snapshot pin expired. Restart the read; resuming against newer state skips and repeats rows."
  },
  {
    code: "snapshot-invalid",
    origin: "contract",
    retryable: false,
    summary: "A cursor was echoed without the snapshot token page 1 returned, or with one this server did not mint."
  },
  {
    code: "supersession-not-permitted",
    origin: "policy",
    retryable: false,
    summary: "This credential may supersede only assertions it authored. Attribution is what makes provenance mean anything."
  },
  {
    code: "tool-not-permitted",
    origin: "policy",
    retryable: false,
    summary:
      "This credential's grant does not permit that tool. The same tool is absent from this credential's tools/list, so the refusal and the listing agree rather than contradicting each other."
  },
  {
    code: "revision-not-served",
    origin: "contract",
    retryable: false,
    summary: "This server does not serve the contract revision the call named. Refused rather than silently substituted."
  },
  {
    code: "unknown-id",
    origin: "identity",
    retryable: false,
    summary: "No record was ever minted under this identifier."
  },
  {
    code: "unknown-redaction",
    origin: "policy",
    retryable: false,
    summary: "No withheld record for this credential carries that redaction_id. Stub ids are per-credential."
  },
  {
    code: "unknown-submission",
    origin: "store",
    retryable: false,
    summary: "No such submission under this credential, or the idempotency window has closed."
  },
  {
    code: "write-tier-not-permitted",
    origin: "policy",
    retryable: false,
    summary:
      "This credential's grant does not permit commits at that sensitivity tier. Reading a tier and writing at it are separate grants, so a broad reader cannot seal new content."
  },
  // The identity refusals `resolve()` can return. They reach a consumer as the
  // `outcome` of one resolution rather than as a whole-call failure, and they
  // are still error codes: a consumer branching on them needs them documented.
  {
    code: "ambiguous-split",
    origin: "identity",
    retryable: false,
    summary: "The id was split. Its candidates are named and no primary is nominated: choosing one would reattribute every historical reference to it."
  },
  {
    code: "not-carried-forward",
    origin: "identity",
    retryable: false,
    summary: "The id was never migrated forward. The disposition says why."
  },
  {
    code: "carried-as-assertion",
    origin: "identity",
    retryable: false,
    summary:
      "The id resolves, and what it names is an assertion rather than an entity. Read it from the assertion log; the refusal carries its id."
  },
  {
    code: "redirect-chain-too-long",
    origin: "identity",
    retryable: false,
    summary: "The alias chain exceeded the depth cap, which fires even if cycle detection is itself wrong."
  },
  {
    code: "redirect-cycle",
    origin: "identity",
    retryable: false,
    summary: "The alias ledger holds a cycle for this id. Refused rather than followed."
  },
  {
    code: "redirect-dangling",
    origin: "identity",
    retryable: false,
    summary: "The alias chain ends at an id no entity is registered under."
  }
] as const;

/** The registry as a lookup, for the test that every emitted code is registered. */
export const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES.map((entry) => entry.code));

/**
 * Contract-published codes this server does not serve on this revision, and why.
 *
 * An explicit register rather than an absence, because the two are not the same
 * fact. The measured drift this replaces: the published vocabulary and this
 * registry had grown apart in BOTH directions at once, and four refusals were
 * shipping under a second name — `client-capability-required` for the published
 * `capability-required`, `sensitivity-ceiling-exceeded` for `sensitivity-withheld`,
 * `owner-decision-declined` for `reveal-declined`, `unknown-contract-revision`
 * for `revision-not-served`. A consumer branching on the published name matched
 * none of them, and nothing failed, because nothing compared the two lists.
 *
 * `vocabulary.test.ts` now asserts the partition is EXACT: every published code
 * is either registered here or named below. Adding a published code without
 * doing one of those two things fails the build, which is the whole point — the
 * server may hold MORE codes than the contract seeds (the vocabulary is open),
 * but it may never quietly hold a different name for the same refusal.
 */
export const SEED_CODES_NOT_SERVED: Readonly<Record<string, string>> = {
  "history-floor-cannot-regress":
    "Advancing the belief-time history floor is not exposed on either plane, so no call can reach the store refusal.",
  "identity-ambiguous":
    "Source-observation matching is not a tool on this revision. An ambiguous SPLIT is reachable and is reported as ambiguous-split.",
  "unsupported-protocol-version":
    "Emitted, but as a JSON-RPC error from the transport gate before any handler, so it never becomes an atlas.error:v1 record. Published so a consumer can look up -32022.",
  "batch-limit-exceeded":
    "The published caps compile into the input schemas as maxItems, so an over-large submission is refused at validation as invalid-argument and never reaches a handler.",
  "lineage-target-unknown":
    "supersedes[] naming an unknown assertion is refused by the store, and this plane reports it as invalid-argument rather than mapping the store's throw."
};

export type PredicateEntry = {
  predicate: string;
  /**
   * Two live assertions on one FUNCTIONAL key are a contradiction Atlas reports
   * rather than resolves. Two overlapping multi-valued assertions are two facts.
   */
  cardinality: "functional" | "multi-valued";
  functional_key?: string[];
  /** True when the predicate's assertions carry a `target_entity_id`. */
  relational: boolean;
};
