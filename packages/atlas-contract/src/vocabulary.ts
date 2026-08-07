/**
 * The OPEN vocabularies.
 *
 * A closed enum and an open vocabulary answer different questions, and the
 * published schemas must not blur them:
 *
 *   A closed enum is a set the contract controls. Adding a member is a
 *   published event, so every closed enum ships a reserved `other` at v1 and a
 *   consumer that receives `other` knows it is looking at something newer than
 *   itself.
 *
 *   An open vocabulary is a set the GRAPH controls. Predicates, entity subtypes
 *   and error codes grow whenever the owner records something new, which is
 *   constantly, and enumerating them in a published schema would mean either
 *   republishing the contract on every new predicate or shipping a schema that
 *   rejects valid data. So the schema says `{"type":"string"}` plus
 *   `x-atlas-known-values`, and the LIVE registry is served by
 *   `atlas.contract.describe.v1`.
 *
 * The distinction is the whole point: a consumer validates against the running
 * vocabulary, not against a copy that was accurate on the day it shipped. The
 * values below are a hint for tooling and documentation — never a whitelist.
 */

/**
 * Predicate cardinality, which the bitemporal query engine needs to answer
 * `contested[]` correctly.
 *
 *  - `functional`   — at most one live value per subject at any world instant.
 *    Two live assertions on the same functional key are a CONTRADICTION and
 *    both are returned in `contested[]`, neither superseded. The prior model's
 *    last-write-wins rule silently kept one and discarded the other.
 *  - `multi-valued` — several may be true at once. Two overlapping
 *    `employed-by` assertions are two jobs, not a contradiction.
 *  - `other`        — reserved.
 */
export const PREDICATE_CARDINALITIES = ["functional", "multi-valued", "other"] as const;
export type PredicateCardinality = (typeof PREDICATE_CARDINALITIES)[number];

export type PredicateEntry = {
  predicate: string;
  cardinality: PredicateCardinality;
  /**
   * For a functional predicate, what makes the value unique. Absent means the
   * subject alone is the key. Publishing it matters because "at most one
   * employer" and "at most one employer per organization" are different claims
   * and a consumer cannot infer which from the cardinality alone.
   */
  functional_key?: string[];
  /** True when this predicate takes `target_entity_id` rather than `value`. */
  relational: boolean;
};

/**
 * The seed registry. Neutral relationship names only — no graph contents.
 *
 * A running Atlas serves its own registry through `atlas.contract.describe.v1`
 * and that answer, not this list, is what a consumer validates against.
 *
 * The graph-side relational names here are exactly the vocabulary in
 * `@living-atlas/contracts`, and a parity test in `@living-atlas/atlas-client`
 * holds the two lists together — this package cannot import that one without a
 * dependency the workspace does not have, and a hint that quietly names a
 * predicate the graph refuses is worse than no hint. The three non-relational
 * and identity-plane entries below have no graph-side counterpart by design:
 * they are properties of the CONTRACT, not edges anybody may assert.
 */
export const SEED_PREDICATES: readonly PredicateEntry[] = [
  { predicate: "employed-by", cardinality: "multi-valued", relational: true },
  { predicate: "member-of", cardinality: "multi-valued", relational: true },
  { predicate: "part-of", cardinality: "functional", relational: true },
  { predicate: "contained-in", cardinality: "functional", relational: true },
  // Multi-valued on purpose, and this is the load-bearing difference from the
  // subtype enum it replaces: a state university is `has-type` government AND
  // `has-type` university, which one enum slot could never say.
  { predicate: "has-type", cardinality: "multi-valued", relational: true },
  { predicate: "operated-by", cardinality: "multi-valued", relational: true },
  { predicate: "based-in", cardinality: "functional", relational: true },
  { predicate: "occurred-at", cardinality: "functional", relational: true },
  { predicate: "participant-in", cardinality: "multi-valued", relational: true },
  { predicate: "connects", cardinality: "multi-valued", relational: true },
  { predicate: "owns", cardinality: "multi-valued", relational: true },
  { predicate: "offered-by", cardinality: "functional", relational: true },
  { predicate: "sold-by", cardinality: "functional", relational: true },
  { predicate: "purchased", cardinality: "multi-valued", relational: true },
  { predicate: "customer-of", cardinality: "multi-valued", relational: true },
  { predicate: "founder-of", cardinality: "multi-valued", relational: true },
  { predicate: "acquired-by", cardinality: "functional", relational: true },
  { predicate: "invests-in", cardinality: "multi-valued", relational: true },
  { predicate: "about", cardinality: "multi-valued", relational: true },
  { predicate: "parent-of", cardinality: "multi-valued", relational: true },
  { predicate: "spouse-of", cardinality: "multi-valued", relational: true },
  { predicate: "sibling-of", cardinality: "multi-valued", relational: true },
  { predicate: "estranged-from", cardinality: "multi-valued", relational: true },
  { predicate: "introduced-by", cardinality: "multi-valued", relational: true },
  { predicate: "created", cardinality: "multi-valued", relational: true },
  { predicate: "display-name", cardinality: "functional", relational: false },
  { predicate: "resolved-same-entity-as", cardinality: "multi-valued", relational: true },
  { predicate: "resolved-split-into", cardinality: "multi-valued", relational: true }
];

/**
 * The entries above that are properties of the contract rather than edges in the
 * graph, so the parity test can say which absences are intentional. Naming them
 * here rather than in the test keeps the exemption beside the list it exempts.
 */
export const CONTRACT_PLANE_PREDICATES: readonly string[] = [
  "display-name",
  "resolved-same-entity-as",
  "resolved-split-into"
];

/**
 * Known `type_label` values for entities whose closed `type` is `other`.
 *
 * Entity typing is deliberately two-layer. The closed `type` enum is the set
 * the contract controls and it ships `other`; `type_label` is the open
 * vocabulary the graph controls. A 2031 kind of thing therefore reaches a 2026
 * consumer as `type: "other"` plus a label it can display, never as an
 * unrecognised token it might branch on by accident.
 */
export const SEED_ENTITY_SUBTYPES: readonly string[] = [
  "project",
  "offering",
  "offering-item",
  "topic",
  "occurrence",
  "source-block",
  "evidence"
];

/**
 * Known error codes.
 *
 * OPEN, not closed, and that asymmetry is deliberate: a consumer MUST tolerate
 * an error code it has never seen, because the alternative is a consumer that
 * crashes on a refusal Atlas added to be MORE honest. The codes that map onto a
 * JSON-RPC error carry that mapping here so a consumer is never left inferring
 * it from the wire.
 *
 * Codes marked `core` are mirrored from `@living-atlas/atlas-core` refusals and
 * are pinned to it by a compile-time exhaustiveness check in the tests — if the
 * store or the registry grows a refusal the contract does not publish,
 * typecheck fails.
 */
export type ErrorCodeEntry = {
  code: string;
  /** What produced it, so a consumer can tell a policy refusal from a bad request. */
  origin: "store" | "identity" | "protocol" | "policy" | "contract";
  /** Present when the refusal also maps to a JSON-RPC error code. */
  jsonrpc_code?: number;
  /**
   * Whether the identical request could succeed later without the caller
   * changing anything. `as-of-before-history-floor` never can; `snapshot-expired`
   * cannot either (the caller must restart the read). `reveal-declined` and
   * `sensitivity-withheld` can: an owner decision or a reclassification makes
   * the same bytes succeed. A capability refusal cannot — declaring the missing
   * capability is the caller changing the request.
   */
  retryable: boolean;
  summary: string;
};

export const SEED_ERROR_CODES: readonly ErrorCodeEntry[] = [
  {
    code: "as-of-before-history-floor",
    origin: "store",
    retryable: false,
    summary:
      "The belief-time instant asked for is below the retained history floor. Refused rather than answered from present state."
  },
  {
    code: "idempotency-key-conflict",
    origin: "store",
    retryable: false,
    summary: "This (client_id, idempotency_key) was already used with a different payload."
  },
  {
    code: "history-floor-cannot-regress",
    origin: "store",
    retryable: false,
    summary: "A history floor may be advanced and never lowered."
  },
  {
    code: "cursor-before-retention-floor",
    origin: "store",
    retryable: false,
    summary: "The change-feed cursor predates retained history. Names the re-scan entry point."
  },
  {
    code: "snapshot-expired",
    origin: "store",
    retryable: false,
    summary: "The paged read's snapshot pin aged out. Names the tool that restarts the read."
  },
  {
    code: "assertion-reclaimed",
    origin: "store",
    retryable: false,
    summary: "The assertion existed and was reclaimed by compaction. Never reported as not-found."
  },
  { code: "unknown-id", origin: "identity", retryable: false, summary: "No such id was ever minted or inherited." },
  {
    code: "ambiguous-split",
    origin: "identity",
    retryable: false,
    summary: "The id was split into several entities. Candidates are named; Atlas does not pick one."
  },
  { code: "redirect-cycle", origin: "identity", retryable: false, summary: "The alias ledger contains a cycle." },
  {
    code: "redirect-chain-too-long",
    origin: "identity",
    retryable: false,
    summary: "The redirect chain exceeded the configured depth cap."
  },
  {
    code: "redirect-dangling",
    origin: "identity",
    retryable: false,
    summary: "A redirect names a successor that does not exist."
  },
  {
    code: "not-carried-forward",
    origin: "identity",
    retryable: false,
    summary: "The id resolves to a terminal disposition: never migrated, content unrecoverable, or redacted in place."
  },
  {
    code: "carried-as-assertion",
    origin: "identity",
    retryable: false,
    summary: "The id resolves, and what it names is an assertion rather than an entity: a legacy edge object carried across as a claim."
  },
  {
    code: "identity-ambiguous",
    origin: "identity",
    retryable: false,
    summary: "A source observation matched several entities. Atlas refuses to guess."
  },
  {
    code: "capability-required",
    origin: "protocol",
    jsonrpc_code: -32021,
    // NOT retryable, by this field's own definition: the identical request —
    // the same `_meta` envelope, declaring the same capabilities — refuses
    // forever. Declaring the missing capability is the caller changing the
    // request, which is the case this flag says `false` for.
    retryable: false,
    summary: "The call needs a client capability that was not declared. Names the capabilities in data."
  },
  {
    code: "unsupported-protocol-version",
    origin: "protocol",
    jsonrpc_code: -32022,
    retryable: false,
    summary: "The connection negotiated a protocol revision this contract does not speak."
  },
  {
    code: "invalid-argument",
    origin: "protocol",
    jsonrpc_code: -32602,
    retryable: false,
    summary: "The arguments failed the tool's published input schema."
  },
  {
    code: "sensitivity-withheld",
    origin: "policy",
    retryable: true,
    summary: "The record exists and this credential may not read it. Reported, never silently dropped."
  },
  {
    code: "supersession-not-permitted",
    origin: "policy",
    retryable: false,
    summary: "A consumer may only supersede assertions its own client_id authored."
  },
  {
    code: "reveal-declined",
    origin: "policy",
    retryable: true,
    summary: "The owner declined the disclosure request."
  },
  {
    code: "batch-limit-exceeded",
    origin: "contract",
    retryable: false,
    summary: "The submission exceeded a published, transport-invariant cap."
  },
  {
    code: "revision-not-served",
    origin: "contract",
    retryable: false,
    summary: "The contract revision asked for is not one this server publishes."
  },
  {
    code: "lineage-target-unknown",
    origin: "store",
    retryable: false,
    summary: "supersedes[] names an assertion this store has never seen."
  }
];

/** Named registries `atlas.contract.describe.v1` serves. */
export const VOCABULARY_NAMES = ["predicate", "entity_subtype", "error_code"] as const;
export type VocabularyName = (typeof VOCABULARY_NAMES)[number];

/** The `x-atlas-known-values` hint each open-vocabulary field carries. */
export const KNOWN_VALUES: Record<VocabularyName, readonly string[]> = {
  predicate: SEED_PREDICATES.map((entry) => entry.predicate),
  entity_subtype: SEED_ENTITY_SUBTYPES,
  error_code: SEED_ERROR_CODES.map((entry) => entry.code)
};
