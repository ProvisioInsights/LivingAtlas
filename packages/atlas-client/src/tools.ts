import type { ContractToolName } from "@living-atlas/atlas-contract";
import type {
  AtlasAssertion,
  AtlasAssertionRow,
  AtlasAuditReceipt,
  AtlasCache,
  AtlasChange,
  AtlasContestedGroup,
  AtlasCoverage,
  AtlasEntity,
  AtlasEntityRow,
  AtlasErrorRecord,
  AtlasHorizon,
  AtlasPage,
  AtlasReclamationNote,
  AtlasRedaction,
  AtlasRevealInputRequest,
  AtlasSubmissionItemResult,
  AtlasSubmissionReceipt,
  KeyManifest,
  OpenEnum,
  OpenObject,
  RecordedAt,
  RequiredKeyManifest
} from "./records.js";

/**
 * The twelve tools, as arguments in and results out.
 *
 * Same rule as `records.ts`: these types are a convenience and the published
 * JSON Schema is the authority. Every argument object is validated against the
 * tool's published INPUT schema before it goes on the wire, and every result
 * against its published OUTPUT schema before it is handed back — so what is
 * written here can be wrong only in the direction of being less precise, never
 * in the direction of admitting a document the contract refuses.
 *
 * Each type carries a key manifest and a required-key manifest, and
 * `contract-parity.test.ts` compares both against the published document. That
 * is the whole defence against the failure this repo has measured repeatedly: a
 * declared parameter the implementation silently drops, and a caller that
 * receives an answer to a question it did not ask with no way to tell.
 */

// ---------------------------------------------------------------------------
// atlas.contract.describe.v1
// ---------------------------------------------------------------------------

export type ContractDescribeArgs = {
  /** Naming a revision this server does not serve is a typed refusal, never a substitution. */
  revision?: string;
};

export const CONTRACT_DESCRIBE_ARG_KEYS = { revision: true } satisfies KeyManifest<ContractDescribeArgs>;
export const CONTRACT_DESCRIBE_ARG_REQUIRED = {} satisfies RequiredKeyManifest<ContractDescribeArgs>;

/**
 * What Atlas says about itself, including the part most surfaces leave out.
 *
 * `history.prior_versions_retained_before_cutover` is a NUMBER, and reading it
 * is the difference between a consumer knowing there is no pre-contract history
 * and a consumer assuming there is some.
 */
export type ContractDescribeResult = {
  revision: string;
  revisions_served: string[];
  protocol_version: string;
  policy_document: string;
  history: {
    prior_versions_retained_before_cutover: number;
    belief_time_meaningful_since_cutover_only: boolean;
    bitemporal_since: RecordedAt;
    feed_epoch: string;
    retention_floor_seq: number;
    change_feed_floor_days: number;
  };
  limits: Record<string, number>;
  record_schemas: { name: string; schema_id: string; schema_path: string }[];
  tools: {
    name: string;
    title: string;
    input_schema_id: string;
    output_schema_id: string;
    requires_capabilities: string[];
    deprecation: OpenObject | null;
  }[];
  /** The LIVE registries. Validate against these, not against a copy that shipped with a client. */
  vocabularies: {
    predicate: { predicate: string; cardinality: string; functional_key?: string[]; relational?: boolean }[];
    entity_subtype: string[];
    error_code: OpenObject[];
  };
  deprecations: OpenObject[];
  cache: AtlasCache;
};

export const CONTRACT_DESCRIBE_RESULT_KEYS = {
  revision: true,
  revisions_served: true,
  protocol_version: true,
  policy_document: true,
  history: true,
  limits: true,
  record_schemas: true,
  tools: true,
  vocabularies: true,
  deprecations: true,
  cache: true
} satisfies KeyManifest<ContractDescribeResult>;

export const CONTRACT_DESCRIBE_RESULT_REQUIRED = CONTRACT_DESCRIBE_RESULT_KEYS satisfies RequiredKeyManifest<ContractDescribeResult>;

// ---------------------------------------------------------------------------
// atlas.scope.describe.v1
// ---------------------------------------------------------------------------

export type ScopeDescribeArgs = Record<string, never>;

export const SCOPE_DESCRIBE_ARG_KEYS = {} satisfies Record<string, true>;
export const SCOPE_DESCRIBE_ARG_REQUIRED = {} satisfies Record<string, true>;

/**
 * This credential's own grant, published back to its holder.
 *
 * A correct consumer reads its differences HERE and never from which transport
 * it connected over. Nothing in this result names a transport, and nothing may.
 */
export type ScopeDescribeResult = {
  client_id: string;
  credential_class: OpenEnum<"consumer" | "owner" | "operator">;
  plane: OpenEnum<"consumer" | "operator">;
  grant_id: string;
  tools_available: string[];
  sensitivity_reachable: { tier: string; rank: number }[];
  sensitivity_ceiling: { tier: string; rank: number };
  predicates_writable: string[];
  write_tiers_permitted: string[];
  limits: Record<string, number>;
  coverage_counts_basis: OpenEnum<"exact" | "bucketed">;
  supersession_scope: OpenEnum<"own-client-id" | "any">;
  reveal_available: boolean;
  /** Echoed from the request envelope, so a capability refusal can be debugged. */
  declared_client_capabilities?: string[];
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const SCOPE_DESCRIBE_RESULT_KEYS = {
  client_id: true,
  credential_class: true,
  plane: true,
  grant_id: true,
  tools_available: true,
  sensitivity_reachable: true,
  sensitivity_ceiling: true,
  predicates_writable: true,
  write_tiers_permitted: true,
  limits: true,
  coverage_counts_basis: true,
  supersession_scope: true,
  reveal_available: true,
  declared_client_capabilities: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<ScopeDescribeResult>;

export const SCOPE_DESCRIBE_RESULT_REQUIRED = {
  client_id: true,
  credential_class: true,
  plane: true,
  grant_id: true,
  tools_available: true,
  sensitivity_reachable: true,
  sensitivity_ceiling: true,
  predicates_writable: true,
  write_tiers_permitted: true,
  limits: true,
  coverage_counts_basis: true,
  supersession_scope: true,
  reveal_available: true,
  horizon: true,
  cache: true
} satisfies RequiredKeyManifest<ScopeDescribeResult>;

// ---------------------------------------------------------------------------
// atlas.entity.resolve.v1
// ---------------------------------------------------------------------------

export type EntityResolveArgs = {
  ids: string[];
  /** Belief time. A value below the history floor is refused, never answered from now. */
  as_of_recorded?: string;
  /** World time. Never interchangeable with the above. */
  as_of_valid?: string;
};

export const ENTITY_RESOLVE_ARG_KEYS = {
  ids: true,
  as_of_recorded: true,
  as_of_valid: true
} satisfies KeyManifest<EntityResolveArgs>;

export const ENTITY_RESOLVE_ARG_REQUIRED = { ids: true } satisfies RequiredKeyManifest<EntityResolveArgs>;

export type EntityResolution = {
  requested_id: string;
  outcome: OpenEnum<"resolved" | "unknown-id" | "ambiguous" | "split" | "other">;
  entity?: AtlasEntityRow;
  redirect_chain: string[];
  redirect_reason?: string;
  /** An id that SPLIT names its candidates and no primary: nominating one would rewrite history. */
  candidate_ids?: string[];
  disposition?: string;
  error?: AtlasErrorRecord;
};

export type EntityResolveResult = {
  resolutions: EntityResolution[];
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const ENTITY_RESOLVE_RESULT_KEYS = {
  resolutions: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<EntityResolveResult>;

export const ENTITY_RESOLVE_RESULT_REQUIRED = ENTITY_RESOLVE_RESULT_KEYS satisfies RequiredKeyManifest<EntityResolveResult>;

// ---------------------------------------------------------------------------
// atlas.entity.read.v1
// ---------------------------------------------------------------------------

export type EntityReadArgs = {
  entity_ids: string[];
  as_of_recorded?: string;
  as_of_valid?: string;
};

export const ENTITY_READ_ARG_KEYS = {
  entity_ids: true,
  as_of_recorded: true,
  as_of_valid: true
} satisfies KeyManifest<EntityReadArgs>;

export const ENTITY_READ_ARG_REQUIRED = { entity_ids: true } satisfies RequiredKeyManifest<EntityReadArgs>;

export type EntityReadResult = {
  results: AtlasEntityRow[];
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const ENTITY_READ_RESULT_KEYS = {
  results: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<EntityReadResult>;

export const ENTITY_READ_RESULT_REQUIRED = ENTITY_READ_RESULT_KEYS satisfies RequiredKeyManifest<EntityReadResult>;

// ---------------------------------------------------------------------------
// atlas.assertion.query.v1
// ---------------------------------------------------------------------------

export type AssertionQueryArgs = {
  subject_entity_id?: string;
  target_entity_id?: string;
  predicate?: string;
  kind?: string;
  as_of_recorded?: string;
  as_of_valid?: string;
  include_superseded?: boolean;
  /** Ask for the feed handoff on the final page, so a bootstrap can become a follow. */
  full_scan?: boolean;
  page_size?: number;
  cursor?: string;
  /** Echo with `cursor`, always. See `AtlasPage`. */
  snapshot?: string;
};

export const ASSERTION_QUERY_ARG_KEYS = {
  subject_entity_id: true,
  target_entity_id: true,
  predicate: true,
  kind: true,
  as_of_recorded: true,
  as_of_valid: true,
  include_superseded: true,
  full_scan: true,
  page_size: true,
  cursor: true,
  snapshot: true
} satisfies KeyManifest<AssertionQueryArgs>;

export const ASSERTION_QUERY_ARG_REQUIRED = {} satisfies RequiredKeyManifest<AssertionQueryArgs>;

export type AssertionQueryResult = {
  results: AtlasAssertionRow[];
  /** Two live assertions on one functional key. Both are returned; Atlas does not pick. */
  contested: AtlasContestedGroup[];
  page: AtlasPage;
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const ASSERTION_QUERY_RESULT_KEYS = {
  results: true,
  contested: true,
  page: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<AssertionQueryResult>;

export const ASSERTION_QUERY_RESULT_REQUIRED = ASSERTION_QUERY_RESULT_KEYS satisfies RequiredKeyManifest<AssertionQueryResult>;

// ---------------------------------------------------------------------------
// atlas.assertion.read.v1
// ---------------------------------------------------------------------------

export type AssertionReadArgs = {
  assertion_ids: string[];
  include_lineage?: boolean;
};

export const ASSERTION_READ_ARG_KEYS = {
  assertion_ids: true,
  include_lineage: true
} satisfies KeyManifest<AssertionReadArgs>;

export const ASSERTION_READ_ARG_REQUIRED = { assertion_ids: true } satisfies RequiredKeyManifest<AssertionReadArgs>;

export type AssertionReadResult = {
  results: AtlasAssertionRow[];
  /** Structure, not content: reported for a withheld record too, and discloses no value. */
  lineage?: {
    assertion_id: string;
    supersedes: string[];
    superseded_by: string[] | null;
    lineage_action: string;
  }[];
  /** An id compaction reclaimed still resolves — to its note, never to a bare not-found. */
  reclamations?: { assertion_id: string; note: AtlasReclamationNote }[];
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const ASSERTION_READ_RESULT_KEYS = {
  results: true,
  lineage: true,
  reclamations: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<AssertionReadResult>;

export const ASSERTION_READ_RESULT_REQUIRED = {
  results: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies RequiredKeyManifest<AssertionReadResult>;

// ---------------------------------------------------------------------------
// atlas.graph.neighbors.v1
// ---------------------------------------------------------------------------

export type GraphNeighborsArgs = {
  entity_id: string;
  direction?: OpenEnum<"outbound" | "inbound" | "both">;
  predicates?: string[];
  max_depth?: number;
  as_of_recorded?: string;
  as_of_valid?: string;
  page_size?: number;
  cursor?: string;
  snapshot?: string;
};

export const GRAPH_NEIGHBORS_ARG_KEYS = {
  entity_id: true,
  direction: true,
  predicates: true,
  max_depth: true,
  as_of_recorded: true,
  as_of_valid: true,
  page_size: true,
  cursor: true,
  snapshot: true
} satisfies KeyManifest<GraphNeighborsArgs>;

export const GRAPH_NEIGHBORS_ARG_REQUIRED = { entity_id: true } satisfies RequiredKeyManifest<GraphNeighborsArgs>;

export type GraphNeighborsResult = {
  nodes: AtlasEntityRow[];
  edges: AtlasAssertionRow[];
  traversal: {
    origin_entity_id: string;
    direction: string;
    max_depth: number;
    deepest_reached: number;
    /** Why the walk stopped. `null` means it finished, which is a different claim. */
    truncated_by: OpenEnum<"max_depth" | "page_size" | "policy"> | null;
  };
  page: AtlasPage;
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const GRAPH_NEIGHBORS_RESULT_KEYS = {
  nodes: true,
  edges: true,
  traversal: true,
  page: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<GraphNeighborsResult>;

export const GRAPH_NEIGHBORS_RESULT_REQUIRED = GRAPH_NEIGHBORS_RESULT_KEYS satisfies RequiredKeyManifest<GraphNeighborsResult>;

// ---------------------------------------------------------------------------
// atlas.text.search.v1
// ---------------------------------------------------------------------------

export type TextSearchArgs = {
  query: string;
  entity_types?: string[];
  predicates?: string[];
  as_of_recorded?: string;
  as_of_valid?: string;
  page_size?: number;
  cursor?: string;
  snapshot?: string;
};

export const TEXT_SEARCH_ARG_KEYS = {
  query: true,
  entity_types: true,
  predicates: true,
  as_of_recorded: true,
  as_of_valid: true,
  page_size: true,
  cursor: true,
  snapshot: true
} satisfies KeyManifest<TextSearchArgs>;

export const TEXT_SEARCH_ARG_REQUIRED = { query: true } satisfies RequiredKeyManifest<TextSearchArgs>;

export type TextSearchResult = {
  results: { score: number; match_basis: string; record: AtlasEntityRow }[];
  /**
   * What could NOT be scanned, reported rather than silently dropped. Without
   * `encrypted_unsearchable` an encrypted match and no match look the same.
   */
  search_scope: {
    scorer: string;
    plaintext_candidates: number;
    encrypted_unsearchable: number;
    counts_basis: OpenEnum<"exact" | "bucketed">;
  };
  page: AtlasPage;
  coverage: AtlasCoverage;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const TEXT_SEARCH_RESULT_KEYS = {
  results: true,
  search_scope: true,
  page: true,
  coverage: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<TextSearchResult>;

export const TEXT_SEARCH_RESULT_REQUIRED = TEXT_SEARCH_RESULT_KEYS satisfies RequiredKeyManifest<TextSearchResult>;

// ---------------------------------------------------------------------------
// atlas.changes.read.v1
// ---------------------------------------------------------------------------

export type ChangesReadArgs = {
  cursor_seq: number;
  /** Echo the epoch you read at. A mismatch is refused rather than resumed into a new order. */
  feed_epoch?: string;
  limit?: number;
  include_records?: boolean;
};

export const CHANGES_READ_ARG_KEYS = {
  cursor_seq: true,
  feed_epoch: true,
  limit: true,
  include_records: true
} satisfies KeyManifest<ChangesReadArgs>;

export const CHANGES_READ_ARG_REQUIRED = { cursor_seq: true } satisfies RequiredKeyManifest<ChangesReadArgs>;

export type ChangesReadResult = {
  changes: AtlasChange[];
  next_cursor_seq: number;
  has_more: boolean;
  feed_epoch: string;
  retention_floor_seq: number;
  /** A hole, named. A compacted range and an uneventful one are otherwise identical. */
  cursor_before_retention_floor: boolean;
  error?: AtlasErrorRecord;
  horizon: AtlasHorizon;
  cache: AtlasCache;
};

export const CHANGES_READ_RESULT_KEYS = {
  changes: true,
  next_cursor_seq: true,
  has_more: true,
  feed_epoch: true,
  retention_floor_seq: true,
  cursor_before_retention_floor: true,
  error: true,
  horizon: true,
  cache: true
} satisfies KeyManifest<ChangesReadResult>;

export const CHANGES_READ_RESULT_REQUIRED = {
  changes: true,
  next_cursor_seq: true,
  has_more: true,
  feed_epoch: true,
  retention_floor_seq: true,
  cursor_before_retention_floor: true,
  horizon: true,
  cache: true
} satisfies RequiredKeyManifest<ChangesReadResult>;

// ---------------------------------------------------------------------------
// atlas.assertion.propose.v1
// ---------------------------------------------------------------------------

/**
 * One draft assertion.
 *
 * Note what a caller CANNOT send: `recorded_at`, `seq`, `assertion_id`,
 * `claim_digest`, `superseded_at`. Belief time is assigned at commit and ids are
 * minted, never derived, so a client that could name them could rewrite when
 * Atlas learned something.
 */
export type AssertionDraft = {
  kind: OpenEnum<"fact" | "relationship" | "other">;
  lineage_action?: OpenEnum<"assert" | "revise" | "retract" | "other">;
  subject_entity_id: string;
  predicate: string;
  value?: unknown;
  target_entity_id?: string;
  valid_from?: unknown;
  valid_to?: unknown;
  supersedes?: string[];
  confidence: OpenObject;
  evidence_links: OpenObject[];
  basis?: unknown;
  proposed_at?: string;
};

export const ASSERTION_DRAFT_KEYS = {
  kind: true,
  lineage_action: true,
  subject_entity_id: true,
  predicate: true,
  value: true,
  target_entity_id: true,
  valid_from: true,
  valid_to: true,
  supersedes: true,
  confidence: true,
  evidence_links: true,
  basis: true,
  proposed_at: true
} satisfies KeyManifest<AssertionDraft>;

export const ASSERTION_DRAFT_REQUIRED = {
  kind: true,
  subject_entity_id: true,
  predicate: true,
  confidence: true,
  evidence_links: true
} satisfies RequiredKeyManifest<AssertionDraft>;

export type AssertionProposeArgs = {
  /**
   * Idempotency is `(client_id, idempotency_key)`. A retry returns the ORIGINAL
   * receipt with the ORIGINAL ids; the same key with a different payload is a
   * typed conflict, never a silent accept of either version.
   */
  idempotency_key: string;
  proposals: AssertionDraft[];
  expected_feed_epoch?: string;
};

export const ASSERTION_PROPOSE_ARG_KEYS = {
  idempotency_key: true,
  proposals: true,
  expected_feed_epoch: true
} satisfies KeyManifest<AssertionProposeArgs>;

export const ASSERTION_PROPOSE_ARG_REQUIRED = {
  idempotency_key: true,
  proposals: true
} satisfies RequiredKeyManifest<AssertionProposeArgs>;

export type AssertionProposeResult = {
  submission: AtlasSubmissionReceipt;
  results: AtlasSubmissionItemResult[];
  /** Zero on a replay: nothing new was committed, and saying so is the point. */
  committed: number;
  refused: number;
  error?: AtlasErrorRecord;
  horizon: AtlasHorizon;
};

export const ASSERTION_PROPOSE_RESULT_KEYS = {
  submission: true,
  results: true,
  committed: true,
  refused: true,
  error: true,
  horizon: true
} satisfies KeyManifest<AssertionProposeResult>;

export const ASSERTION_PROPOSE_RESULT_REQUIRED = {
  submission: true,
  results: true,
  committed: true,
  refused: true,
  horizon: true
} satisfies RequiredKeyManifest<AssertionProposeResult>;

// ---------------------------------------------------------------------------
// atlas.submission.read.v1
// ---------------------------------------------------------------------------

export type SubmissionReadArgs = {
  /** Exactly one of these. Guessing which was meant is how a client reads the wrong receipt. */
  submission_id?: string;
  idempotency_key?: string;
};

export const SUBMISSION_READ_ARG_KEYS = {
  submission_id: true,
  idempotency_key: true
} satisfies KeyManifest<SubmissionReadArgs>;

export const SUBMISSION_READ_ARG_REQUIRED = {} satisfies RequiredKeyManifest<SubmissionReadArgs>;

export type SubmissionReadResult = {
  submission?: AtlasSubmissionReceipt;
  results?: AtlasSubmissionItemResult[];
  /** When the dedup window closes. After it, the same key commits a SECOND copy. */
  idempotency_expires_at?: RecordedAt | null;
  error?: AtlasErrorRecord;
  horizon: AtlasHorizon;
};

export const SUBMISSION_READ_RESULT_KEYS = {
  submission: true,
  results: true,
  idempotency_expires_at: true,
  error: true,
  horizon: true
} satisfies KeyManifest<SubmissionReadResult>;

export const SUBMISSION_READ_RESULT_REQUIRED = { horizon: true } satisfies RequiredKeyManifest<SubmissionReadResult>;

// ---------------------------------------------------------------------------
// atlas.sensitive.reveal.v1
// ---------------------------------------------------------------------------

export type SensitiveRevealArgs = {
  redaction_id: string;
  /** Recorded in the audit event and shown to the owner. An unattributed ask is unjudgeable. */
  reason: string;
  /**
   * The ARGUMENT channel for an echoed state, for a client with no multi-round-
   * trip support. Integrity-protected and bound exactly as the protocol channel
   * is — a verification enforced on one channel and not the other is not
   * enforced.
   */
  request_state?: string;
};

export const SENSITIVE_REVEAL_ARG_KEYS = {
  redaction_id: true,
  reason: true,
  request_state: true
} satisfies KeyManifest<SensitiveRevealArgs>;

export const SENSITIVE_REVEAL_ARG_REQUIRED = {
  redaction_id: true,
  reason: true
} satisfies RequiredKeyManifest<SensitiveRevealArgs>;

export type SensitiveRevealResult = {
  outcome: OpenEnum<"revealed" | "input-required" | "refused" | "other">;
  record?: AtlasAssertion | AtlasEntity | AtlasRedaction;
  input_request?: AtlasRevealInputRequest;
  /** On EVERY outcome, refusals included: an audit trail nobody knows about is unusable. */
  audit: AtlasAuditReceipt;
  error?: AtlasErrorRecord;
  horizon: AtlasHorizon;
};

export const SENSITIVE_REVEAL_RESULT_KEYS = {
  outcome: true,
  record: true,
  input_request: true,
  audit: true,
  error: true,
  horizon: true
} satisfies KeyManifest<SensitiveRevealResult>;

export const SENSITIVE_REVEAL_RESULT_REQUIRED = {
  outcome: true,
  audit: true,
  horizon: true
} satisfies RequiredKeyManifest<SensitiveRevealResult>;

// ---------------------------------------------------------------------------
// atlas.entity.create.v1
// ---------------------------------------------------------------------------

export type EntityCreateArgs = {
  type: string;
  display_name: string;
  also_known_as?: string[];
};

export const ENTITY_CREATE_ARG_KEYS = {
  type: true,
  display_name: true,
  also_known_as: true
} satisfies KeyManifest<EntityCreateArgs>;

export const ENTITY_CREATE_ARG_REQUIRED = {
  type: true,
  display_name: true
} satisfies RequiredKeyManifest<EntityCreateArgs>;

/**
 * `AtlasEntity`, not `AtlasEntityRow`: the caller just wrote this record, so it
 * cannot come back as a redaction stub or an error row. A union here would make
 * every consumer narrow a case the write path cannot produce.
 */
export type EntityCreateResult = {
  entity: AtlasEntity;
  horizon: AtlasHorizon;
};

export const ENTITY_CREATE_RESULT_KEYS = {
  entity: true,
  horizon: true
} satisfies KeyManifest<EntityCreateResult>;

export const ENTITY_CREATE_RESULT_REQUIRED = ENTITY_CREATE_RESULT_KEYS satisfies RequiredKeyManifest<EntityCreateResult>;

// ---------------------------------------------------------------------------
// atlas.entity.rename.v1
// ---------------------------------------------------------------------------

export type EntityRenameArgs = {
  entity_id: string;
  display_name?: string;
  also_known_as?: string[];
};

export const ENTITY_RENAME_ARG_KEYS = {
  entity_id: true,
  display_name: true,
  also_known_as: true
} satisfies KeyManifest<EntityRenameArgs>;

/**
 * Only `entity_id`. The "supply at least one of display_name or also_known_as"
 * rule is a relationship BETWEEN two optional fields, which a required-key
 * manifest cannot express; the server states it and refuses `invalid-argument`.
 */
export const ENTITY_RENAME_ARG_REQUIRED = { entity_id: true } satisfies RequiredKeyManifest<EntityRenameArgs>;

export type EntityRenameResult = {
  entity: AtlasEntity;
  horizon: AtlasHorizon;
};

export const ENTITY_RENAME_RESULT_KEYS = {
  entity: true,
  horizon: true
} satisfies KeyManifest<EntityRenameResult>;

export const ENTITY_RENAME_RESULT_REQUIRED = ENTITY_RENAME_RESULT_KEYS satisfies RequiredKeyManifest<EntityRenameResult>;

// ---------------------------------------------------------------------------
// the tables the parity test reads
// ---------------------------------------------------------------------------

export type SchemaKeyManifest = {
  keys: Readonly<Record<string, true>>;
  required: Readonly<Record<string, true>>;
};

/**
 * Every published tool, with the manifests for its input and its output.
 *
 * `Record<ContractToolName, …>` is TOTAL by type: a thirteenth tool added to the
 * contract with no entry here fails to compile, and an entry for a name the
 * contract does not publish is not expressible. That is the same construction
 * `TOOL_HANDLERS` uses on the server, and for the same reason — the old surface's
 * thirty tools and its documentation drifted apart because nothing connected
 * them.
 */
export const TOOL_KEY_MANIFESTS: Record<ContractToolName, { input: SchemaKeyManifest; output: SchemaKeyManifest }> = {
  "atlas.contract.describe.v1": {
    input: { keys: CONTRACT_DESCRIBE_ARG_KEYS, required: CONTRACT_DESCRIBE_ARG_REQUIRED },
    output: { keys: CONTRACT_DESCRIBE_RESULT_KEYS, required: CONTRACT_DESCRIBE_RESULT_REQUIRED }
  },
  "atlas.scope.describe.v1": {
    input: { keys: SCOPE_DESCRIBE_ARG_KEYS, required: SCOPE_DESCRIBE_ARG_REQUIRED },
    output: { keys: SCOPE_DESCRIBE_RESULT_KEYS, required: SCOPE_DESCRIBE_RESULT_REQUIRED }
  },
  "atlas.entity.resolve.v1": {
    input: { keys: ENTITY_RESOLVE_ARG_KEYS, required: ENTITY_RESOLVE_ARG_REQUIRED },
    output: { keys: ENTITY_RESOLVE_RESULT_KEYS, required: ENTITY_RESOLVE_RESULT_REQUIRED }
  },
  "atlas.entity.read.v1": {
    input: { keys: ENTITY_READ_ARG_KEYS, required: ENTITY_READ_ARG_REQUIRED },
    output: { keys: ENTITY_READ_RESULT_KEYS, required: ENTITY_READ_RESULT_REQUIRED }
  },
  "atlas.assertion.query.v1": {
    input: { keys: ASSERTION_QUERY_ARG_KEYS, required: ASSERTION_QUERY_ARG_REQUIRED },
    output: { keys: ASSERTION_QUERY_RESULT_KEYS, required: ASSERTION_QUERY_RESULT_REQUIRED }
  },
  "atlas.assertion.read.v1": {
    input: { keys: ASSERTION_READ_ARG_KEYS, required: ASSERTION_READ_ARG_REQUIRED },
    output: { keys: ASSERTION_READ_RESULT_KEYS, required: ASSERTION_READ_RESULT_REQUIRED }
  },
  "atlas.graph.neighbors.v1": {
    input: { keys: GRAPH_NEIGHBORS_ARG_KEYS, required: GRAPH_NEIGHBORS_ARG_REQUIRED },
    output: { keys: GRAPH_NEIGHBORS_RESULT_KEYS, required: GRAPH_NEIGHBORS_RESULT_REQUIRED }
  },
  "atlas.text.search.v1": {
    input: { keys: TEXT_SEARCH_ARG_KEYS, required: TEXT_SEARCH_ARG_REQUIRED },
    output: { keys: TEXT_SEARCH_RESULT_KEYS, required: TEXT_SEARCH_RESULT_REQUIRED }
  },
  "atlas.changes.read.v1": {
    input: { keys: CHANGES_READ_ARG_KEYS, required: CHANGES_READ_ARG_REQUIRED },
    output: { keys: CHANGES_READ_RESULT_KEYS, required: CHANGES_READ_RESULT_REQUIRED }
  },
  "atlas.assertion.propose.v1": {
    input: { keys: ASSERTION_PROPOSE_ARG_KEYS, required: ASSERTION_PROPOSE_ARG_REQUIRED },
    output: { keys: ASSERTION_PROPOSE_RESULT_KEYS, required: ASSERTION_PROPOSE_RESULT_REQUIRED }
  },
  "atlas.submission.read.v1": {
    input: { keys: SUBMISSION_READ_ARG_KEYS, required: SUBMISSION_READ_ARG_REQUIRED },
    output: { keys: SUBMISSION_READ_RESULT_KEYS, required: SUBMISSION_READ_RESULT_REQUIRED }
  },
  "atlas.sensitive.reveal.v1": {
    input: { keys: SENSITIVE_REVEAL_ARG_KEYS, required: SENSITIVE_REVEAL_ARG_REQUIRED },
    output: { keys: SENSITIVE_REVEAL_RESULT_KEYS, required: SENSITIVE_REVEAL_RESULT_REQUIRED }
  },
  "atlas.entity.create.v1": {
    input: { keys: ENTITY_CREATE_ARG_KEYS, required: ENTITY_CREATE_ARG_REQUIRED },
    output: { keys: ENTITY_CREATE_RESULT_KEYS, required: ENTITY_CREATE_RESULT_REQUIRED }
  },
  "atlas.entity.rename.v1": {
    input: { keys: ENTITY_RENAME_ARG_KEYS, required: ENTITY_RENAME_ARG_REQUIRED },
    output: { keys: ENTITY_RENAME_RESULT_KEYS, required: ENTITY_RENAME_RESULT_REQUIRED }
  }
};

/** The `$defs` in `common.input.json` this file describes. */
export const COMMON_INPUT_KEY_MANIFESTS: Readonly<Record<string, SchemaKeyManifest>> = {
  assertion_draft: { keys: ASSERTION_DRAFT_KEYS, required: ASSERTION_DRAFT_REQUIRED }
};

/**
 * The argument type each tool takes and the result type it returns, as one
 * table the client's method signatures are derived from.
 *
 * Derived rather than repeated: a method typed by hand beside a table typed by
 * hand is two declarations again, and only one of them is the one the caller
 * reads in an editor.
 */
export type AtlasToolShapes = {
  "atlas.contract.describe.v1": { args: ContractDescribeArgs; result: ContractDescribeResult };
  "atlas.scope.describe.v1": { args: ScopeDescribeArgs; result: ScopeDescribeResult };
  "atlas.entity.resolve.v1": { args: EntityResolveArgs; result: EntityResolveResult };
  "atlas.entity.read.v1": { args: EntityReadArgs; result: EntityReadResult };
  "atlas.assertion.query.v1": { args: AssertionQueryArgs; result: AssertionQueryResult };
  "atlas.assertion.read.v1": { args: AssertionReadArgs; result: AssertionReadResult };
  "atlas.graph.neighbors.v1": { args: GraphNeighborsArgs; result: GraphNeighborsResult };
  "atlas.text.search.v1": { args: TextSearchArgs; result: TextSearchResult };
  "atlas.changes.read.v1": { args: ChangesReadArgs; result: ChangesReadResult };
  "atlas.assertion.propose.v1": { args: AssertionProposeArgs; result: AssertionProposeResult };
  "atlas.submission.read.v1": { args: SubmissionReadArgs; result: SubmissionReadResult };
  "atlas.sensitive.reveal.v1": { args: SensitiveRevealArgs; result: SensitiveRevealResult };
  "atlas.entity.create.v1": { args: EntityCreateArgs; result: EntityCreateResult };
  "atlas.entity.rename.v1": { args: EntityRenameArgs; result: EntityRenameResult };
};

/** Compile-time proof that the shape table covers exactly the published tools. */
export type AtlasToolShapesAreTotal = KeyManifest<AtlasToolShapes> extends Record<ContractToolName, true>
  ? Record<ContractToolName, true> extends KeyManifest<AtlasToolShapes>
    ? true
    : never
  : never;

export const ATLAS_TOOL_SHAPES_ARE_TOTAL: AtlasToolShapesAreTotal = true;
