/**
 * The published contract's frozen constants.
 *
 * Two artifacts are normative and must not drift apart: the JSON Schema
 * documents under `schema/<revision>/` are normative for SHAPE, and
 * `docs/contract/atlas-knowledge-contract-<revision>.md` is normative for
 * SEMANTICS and evolution policy. Everything in this file appears in both, so
 * it lives in exactly one place and both read it from here.
 */

/** Calendar-versioned, not semver: a revision is a date, not a promise about compatibility. */
export const CONTRACT_REVISION = "2026.08.0";

/**
 * The one MCP revision this contract speaks. There is no legacy era and no
 * dual-era negotiation: a server that quietly accepts an older protocol
 * revision has to answer questions the older revision cannot even express
 * (`resultType`, `cacheScope`, the elicitation gate `sensitive.reveal` needs),
 * so it answers them by guessing. A refusal naming the required revision is the
 * honest answer.
 */
export const CONTRACT_PROTOCOL_VERSION = "2026-07-28";

/**
 * URNs, not `https://` URLs, and that is a security property rather than a
 * style choice: a `urn:` `$ref` cannot be dereferenced over the network, so a
 * validator physically cannot reach out to a host to resolve one. The plan
 * requires local-only `$ref` resolution; using a scheme with no retrieval
 * semantics makes it impossible to violate rather than merely forbidden.
 *
 * It also keeps a deployment hostname out of a public repo's published bytes.
 */
export const CONTRACT_URN_PREFIX = `urn:living-atlas:contract:${CONTRACT_REVISION}`;

/**
 * Every record Atlas returns carries one of these as a frozen `record_schema`
 * literal. That single field is what makes a record self-describing when it is
 * logged, cached, or replayed in 2031 with no server present to ask.
 *
 * Note what these are NOT: they are not content hashes, not version numbers to
 * compare, and not extensible by a consumer. A consumer that receives a
 * `record_schema` it does not recognise handles the envelope alone — see the
 * consumer obligations in the policy document.
 */
export const RECORD_SCHEMAS = [
  "atlas.assertion:v1",
  "atlas.entity:v1",
  "atlas.redaction:v1",
  "atlas.error:v1",
  "atlas.horizon:v1",
  "atlas.change:v1"
] as const;

export type RecordSchemaName = (typeof RECORD_SCHEMAS)[number];

/**
 * Transport-invariant caps.
 *
 * These are constants because the measured defect was drift: the old surface
 * had `LocalBatchMaxItems = 100` and `RemoteBatchMaxItems = 10`, so the same
 * request succeeded on one transport and failed on the other with no way for a
 * caller to discover which limit applied. Here one number is compiled into the
 * schema (`maxItems`/`maximum`) AND published through
 * `atlas.contract.describe.v1`, and a test asserts the two agree. A transport
 * may not narrow them.
 */
export const CONTRACT_LIMITS = {
  /** Hard ceiling on `page_size`. A caller may ask for less, never for more. */
  max_page_size: 200,
  /** What a caller gets when it does not say. */
  default_page_size: 50,
  /** Items in one `atlas.assertion.propose.v1` submission. */
  max_batch_items: 100,
  /** Serialized request bytes for one submission. */
  max_batch_bytes: 1048576,
  /** Hops in one `atlas.graph.neighbors.v1` traversal. */
  max_traversal_depth: 5,
  /** Ids in one `atlas.entity.resolve.v1` or `atlas.assertion.read.v1` call. */
  max_ids_per_request: 100,
  /**
   * How long a paged read's snapshot pin stays answerable. After this, page
   * 2..N returns `snapshot-expired` naming the restart tool rather than
   * silently re-running the query against newer state — which would produce a
   * page sequence that skips and repeats rows with no way to notice.
   */
  snapshot_ttl_seconds: 900,
  /**
   * How long `(client_id, idempotency_key)` stays deduplicated. After this a
   * retry commits a SECOND copy, so the window is published rather than
   * implied, and `atlas.submission.read.v1` reports `expired` explicitly.
   */
  idempotency_ttl_days: 30,
  /**
   * The change feed's retention floor, as a concrete day count rather than
   * "recent". A consumer offline longer than this cannot resume from its
   * cursor and is told so with a typed refusal naming the re-scan entry point.
   */
  change_feed_floor_days: 400,
  /**
   * The minimum notice before anything published is removed.
   *
   * Equal to `change_feed_floor_days`, and not by coincidence: Atlas promises a
   * consumer offline for up to that long can resume from its cursor. A shorter
   * deprecation window would make that promise hollow — the consumer resumes
   * successfully into a surface where the tool it calls no longer exists.
   */
  deprecation_window_days: 400
} as const;

export type ContractLimits = typeof CONTRACT_LIMITS;

/**
 * The parts of the history block that are properties of the CONTRACT rather
 * than of a running store. `bitemporal_since`, `feed_epoch` and the watermarks
 * are runtime values the server fills in; these are frozen here.
 */
export const CONTRACT_HISTORY = {
  /**
   * Zero. Not "not applicable", not omitted, not a soft phrase — the number.
   *
   * Nothing published before this contract is retained in a form this contract
   * can serve. The prior surface returned stringified JSON in text blocks with
   * no output contract at all, so there is no earlier revision to be compatible
   * with and no earlier response any consumer can replay. Saying so as a
   * machine-readable `0` is the difference between a consumer knowing there is
   * no history and a consumer assuming there is some.
   */
  prior_versions_retained_before_cutover: 0,
  /**
   * Belief-time ordering is meaningless across the cutover: pre-contract
   * records carry `recorded_at_fidelity: "import-artifact"`, which reflects
   * when a file was processed, not when Atlas learned anything. Permanently
   * true of those records, not a transitional state.
   */
  belief_time_meaningful_since_cutover_only: true
} as const;

export type ContractHistory = typeof CONTRACT_HISTORY;

/** The document that is normative for semantics, cited by revision. */
export const CONTRACT_POLICY_DOCUMENT = `docs/contract/atlas-knowledge-contract-${CONTRACT_REVISION}.md`;

/**
 * The tools any recognised credential may call regardless of what its grant
 * enumerates, so that a caller can always find out what it may do instead of
 * discovering it by probing.
 *
 * Here rather than in the server, and that is the point: this is a SET OF TOOL
 * NAMES, and a set of tool names stated outside the contract is a second source
 * of truth for a rule the contract already makes. The measured cost of getting
 * that wrong is in `packages/graph-service`, where the enforcing copy of the
 * local-only deny list named four tools and the contract's named six — so two
 * tools whose own descriptions read "Local-only" were reachable remotely, and
 * both copies type-checked.
 */
export const CONTRACT_DISCOVERY_TOOLS = ["atlas.contract.describe.v1", "atlas.scope.describe.v1"] as const;

export const CONTRACT_TOOL_NAMES = [
  "atlas.contract.describe.v1",
  "atlas.scope.describe.v1",
  "atlas.entity.resolve.v1",
  "atlas.entity.read.v1",
  "atlas.assertion.query.v1",
  "atlas.assertion.read.v1",
  "atlas.graph.neighbors.v1",
  "atlas.text.search.v1",
  "atlas.changes.read.v1",
  "atlas.assertion.propose.v1",
  "atlas.submission.read.v1",
  "atlas.sensitive.reveal.v1"
] as const;

export type ContractToolName = (typeof CONTRACT_TOOL_NAMES)[number];
