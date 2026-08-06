import { CONTRACT_LIMITS, type ContractToolName, type RecordSchemaName } from "./revision.js";
import {
  anyJson,
  anyOfShape,
  arr,
  constant,
  enumOf,
  frozenEnum,
  nullable,
  obj,
  record,
  ref,
  scalar,
  taggedUnion,
  vocabulary,
  type Shape
} from "./shape.js";

/**
 * The 12 consumer tools and the 6 record schemas, authored ONCE.
 *
 * Nothing in this file says `additionalProperties`, and nothing may: strictness
 * is a property of the wire position, applied by the renderer in `shape.ts`. An
 * input is closed, an output is open, and the same authored shape used on both
 * sides comes out correct on both.
 *
 * The old surface returned stringified JSON inside MCP text blocks. That had no
 * place to put an output contract at all — which is why it never had one, why
 * nothing could validate a response, and why a field could be dropped from a
 * result for months without any consumer noticing. Every tool here declares an
 * `outputSchema`.
 */

const IDENTIFIER_SUFFIX = "[0-9a-z]{26}";

// ---------------------------------------------------------------------------
// shared $defs — rendered into BOTH common:input and common:output
// ---------------------------------------------------------------------------

export const SHARED_DEFS: Record<string, Shape> = {
  recorded_at: scalar({
    type: "string",
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
    description:
      "Belief-time instant: RFC 3339, UTC, `Z`, exactly millisecond precision. Canonicalised so string order equals chronological order, because the change feed is ordered by string comparison. An offset-bearing timestamp sorts wrong even when it names the same instant, so offsets are not accepted."
  }),

  world_time_point: anyOfShape(
    [
      obj(
        { kind: constant("unknown") },
        ["kind"],
        "The world-time endpoint is not known. `unknown` never matches an as-of point, never sorts, and is not a large number: the prior store mapped it to the string \"9999\", so an unknown start silently satisfied every \"before X\" filter."
      ),
      obj(
        {
          kind: frozenEnum(
            ["exact", "approximate"],
            "Structural discriminator of a two-branch union: a third kind would be a new branch shape, not a new label, and a branch with no declared shape could never validate.",
            "`approximate` widens by one unit of its own precision and can only ever yield match_quality `possible`."
          ),
          value: scalar({
            type: "string",
            pattern: "^\\d{4}(-\\d{2}(-\\d{2})?)?$",
            description: "`2019`, `2019-03`, or `2019-03-15`. Precision is inferred from length."
          })
        },
        ["kind", "value"]
      )
    ],
    "A world-time endpoint. World time is when a thing was true; belief time is when Atlas learned it. The two axes are never interchangeable."
  ),

  world_time_probe: scalar({
    type: "string",
    pattern: "^\\d{4}(-\\d{2}(-\\d{2})?)?$",
    description:
      "A partial date on the WORLD axis. Matching is interval overlap, not point containment, so `2019` asks \"true at any point in 2019\"."
  }),

  assertion_id: scalar({
    type: "string",
    pattern: `^la_assertion_${IDENTIFIER_SUFFIX}$`,
    description:
      "Minted, never derived. Nothing about an assertion's content, position or encoding influences its id. Ids sort by mint time as an index convenience — never infer feed order (that is `seq`) or belief time (that is `recorded_at`) from one."
  }),

  entity_id: scalar({
    type: "string",
    pattern: `^la_entity_${IDENTIFIER_SUFFIX}$`,
    description: "Minted once, never re-derived, and never reused. An id Atlas returned resolves forever."
  }),

  submission_id: scalar({
    type: "string",
    pattern: `^la_submission_${IDENTIFIER_SUFFIX}$`
  }),

  opaque_reference: scalar({
    type: "string",
    minLength: 1,
    description:
      "Any identifier a caller holds, including ids Atlas never minted. Legacy ids inherited at migration are exactly the ones that most need to keep resolving, so this is deliberately not pattern-constrained."
  }),

  predicate: vocabulary(
    "predicate",
    "Open vocabulary. Cardinality and the functional key for each predicate are published by atlas.contract.describe.v1; validate against that, not against this hint."
  ),

  confidence: obj(
    {
      band: enumOf(["high", "medium", "low"]),
      rationale: scalar({ type: "string", minLength: 1 })
    },
    ["band"]
  ),

  evidence_link: obj(
    {
      evidence_id: scalar({ type: "string", minLength: 1 }),
      stance: enumOf(["supports", "contradicts", "context"])
    },
    ["evidence_id", "stance"]
  )
};

// ---------------------------------------------------------------------------
// input-only $defs
// ---------------------------------------------------------------------------

export const INPUT_DEFS: Record<string, Shape> = {
  /**
   * The paging arguments are `$defs` rather than an object, because a caller
   * passes them flat. Declaring them once is what keeps the published cap in
   * one place across four paged tools — the prior surface's 100-vs-10 drift
   * came from the same number being written down twice.
   */
  page_size: scalar({
    type: "integer",
    minimum: 1,
    maximum: CONTRACT_LIMITS.max_page_size,
    default: CONTRACT_LIMITS.default_page_size,
    description: "Transport-invariant cap. A transport may not narrow it."
  }),

  page_cursor: scalar({ type: "string", minLength: 1, description: "Opaque. Echo what the prior page returned." }),

  snapshot_token: scalar({
    type: "string",
    minLength: 1,
    description:
      "The pin returned with page 1. Pages 2..N MUST echo it. Without it a later page is computed against newer state, so the sequence silently skips and repeats rows."
  }),

  assertion_draft: obj(
    {
      kind: enumOf(["fact", "relationship", "observation"]),
      lineage_action: enumOf(
        ["assert", "correct", "retract", "invalidate", "reinstate"],
        "assert: a new claim. correct: the prior claim was recorded wrongly, both stay readable. retract: a BELIEF error — we should never have said this, and world time is untouched because the world did not change. invalidate: a WORLD change — this was true and has stopped being true, typically also closing valid_to. reinstate: re-assert something retracted. Any action other than `assert` MUST name what it acts on in supersedes[]."
      ),
      subject_entity_id: ref("entity_id"),
      predicate: ref("predicate"),
      value: anyJson(
        "Whatever the predicate says it is. The one place input strictness does not reach, and deliberately so: typing it would require the contract to own the predicate vocabulary, which the graph owns. It is a value, never an envelope — nothing about the request's meaning hides inside it."
      ),
      target_entity_id: ref("entity_id"),
      valid_from: ref("world_time_point"),
      valid_to: ref("world_time_point", "Half-open [from, to). Absent means ongoing."),
      supersedes: arr(ref("assertion_id"), { maxItems: CONTRACT_LIMITS.max_batch_items }),
      confidence: ref("confidence"),
      evidence_links: arr(ref("evidence_link"), { minItems: 1 }),
      basis: scalar({ type: "string", minLength: 1 }),
      proposed_at: scalar({
        type: "string",
        minLength: 1,
        description:
          "Advisory only, and NOT a time axis. Atlas stamps recorded_at itself at commit; a caller-supplied belief time would let a client backdate what Atlas knew."
      })
    },
    ["kind", "subject_entity_id", "predicate", "confidence", "evidence_links"],
    "Note what a caller cannot supply: assertion_id, seq, recorded_at, superseded_at, claim_digest, provenance.client_id. Everything that carries authority is minted by Atlas at commit."
  )
};

// ---------------------------------------------------------------------------
// output-only $defs
// ---------------------------------------------------------------------------

export const OUTPUT_DEFS: Record<string, Shape> = {
  claim_digest: scalar({
    type: "string",
    pattern: "^sha256:[a-f0-9]{64}$",
    description:
      "Covers the CLAIM CORE only — subject, predicate, value, valid_from, valid_to. A dedup hint and a contradiction key, NEVER an identity: two consumers asserting the same fact at different moments produce two assertions with one digest and two ids, and both are real learning events."
  }),

  sensitivity: obj(
    {
      tier: scalar({ type: "string", minLength: 1, description: "Open string; a new tier in 2032 is additive." }),
      rank: scalar({ type: "integer", minimum: 0, description: "Compare this, never the tier name." }),
      withheld: scalar({ type: "boolean" })
    },
    ["tier", "rank", "withheld"]
  ),

  provenance: obj(
    {
      client_id: scalar({
        type: "string",
        minLength: 1,
        description:
          "Set by Atlas from the authenticated credential. A consumer can neither supply nor spoof it. The prior server unconditionally replaced any caller credential with the daemon's own token, collapsing every consumer to one identity and making attribution impossible."
      }),
      origin: enumOf(["consumer-proposed", "owner-authored", "pre-contract-import"]),
      recorded_at_fidelity: enumOf(
        ["authoritative", "import-artifact"],
        "authoritative: Atlas stamped recorded_at at commit, so belief-time ordering is meaningful. import-artifact: the value reflects when a file was processed, not when Atlas learned anything. Ordering across the two is meaningless permanently, not just below the history floor."
      ),
      proposed_at: scalar({ type: "string", minLength: 1 }),
      basis: scalar({ type: "string", minLength: 1 })
    },
    ["client_id", "origin", "recorded_at_fidelity"]
  ),

  coverage: obj(
    {
      evaluated: scalar({ type: "integer", minimum: 0 }),
      matched: scalar({ type: "integer", minimum: 0 }),
      returned: scalar({ type: "integer", minimum: 0, description: "Rows on THIS page." }),
      withheld: scalar({
        type: "integer",
        minimum: 0,
        description:
          "Records this credential may not read. They still occupy a row as an atlas.redaction:v1 stub, so counts reconcile and a partial graph is never indistinguishable from a complete one."
      }),
      with_valid_time: scalar({ type: "integer", minimum: 0 }),
      unknown_or_absent_valid_time: scalar({ type: "integer", minimum: 0 }),
      counts_basis: enumOf(
        ["exact", "bucketed"],
        "Exact counts are themselves a disclosure channel: repeated filter bisection against an exact `withheld` localises a withheld record without ever reading it. Below the owner tier the counts may be bucketed, and a consumer is told which it is rather than left to assume exactness."
      ),
      bucket_width: scalar({ type: "integer", minimum: 1, description: "Present when counts_basis is `bucketed`." })
    },
    ["evaluated", "matched", "returned", "withheld", "with_valid_time", "unknown_or_absent_valid_time", "counts_basis"],
    "Absence is REPORTED, never performed. The prior surface's search, traverse, timeline and edge_read each dropped rows the caller could not detect."
  ),

  page: obj(
    {
      page_size: scalar({ type: "integer", minimum: 1, maximum: CONTRACT_LIMITS.max_page_size }),
      has_more: scalar({ type: "boolean" }),
      cursor: nullable(scalar({ type: "string", minLength: 1 })),
      snapshot: scalar({
        type: "string",
        minLength: 1,
        description: "Echo this on pages 2..N. Pins {as_of_recorded, seq_watermark, feed_epoch} so the sequence is one consistent answer."
      }),
      snapshot_expires_at: ref("recorded_at"),
      feed_handoff: obj(
        {
          tool: scalar({ type: "string", minLength: 1 }),
          cursor_seq: scalar({ type: "integer", minimum: 0 })
        },
        ["tool", "cursor_seq"],
        "Present on the FINAL page of a full scan. Hands the caller to the change feed at the exact seq the scan covered, so bootstrap-then-follow has no gap and no overlap."
      )
    },
    ["page_size", "has_more"]
  ),

  cache: obj(
    {
      ttl_ms: scalar({ type: "integer", minimum: 0, description: "0 means: do not cache this result." }),
      cache_scope: enumOf(
        ["private", "public"],
        "Every result in this revision is `private`. Results vary by credential because policy filtering varies by credential, so a shared cache would serve one consumer's permitted view to another."
      )
    },
    ["ttl_ms", "cache_scope"]
  ),

  valid_time_fidelity: enumOf(
    ["exact", "approximate", "unknown", "absent"],
    "How much world time the record actually carries, so \"true in March 2019\" is distinguishable from \"we have no idea when\"."
  ),

  match_quality: enumOf(
    ["certain", "possible"],
    "`possible` whenever the match ran through a widened `approximate` bound. An approximate endpoint can never yield `certain`."
  ),

  contested_group: obj(
    {
      subject_entity_id: ref("entity_id"),
      predicate: ref("predicate"),
      cardinality: enumOf(["functional", "multi-valued"]),
      functional_key: arr(scalar({ type: "string", minLength: 1 })),
      assertion_ids: arr(ref("assertion_id"), { minItems: 2 }),
      claim_digests: arr(ref("claim_digest"))
    },
    ["subject_entity_id", "predicate", "cardinality", "assertion_ids"],
    "Two live assertions on one FUNCTIONAL key are a contradiction: both are returned, neither is superseded, and Atlas does not pick. Two overlapping multi-valued assertions are two facts and never appear here."
  ),

  reclamation_note: obj(
    {
      seq: scalar({ type: "integer", minimum: 1 }),
      reclaimed_at: ref("recorded_at"),
      reclaimed_from_segment: scalar({ type: "integer", minimum: 0 })
    },
    ["seq", "reclaimed_at", "reclaimed_from_segment"],
    "What is left of an assertion compaction reclaimed. A reclaimed id resolves to this, never to a bare not-found: otherwise a dangling reference and a typo are indistinguishable."
  ),

  submission_receipt: obj(
    {
      submission_id: ref("submission_id"),
      client_id: scalar({ type: "string", minLength: 1 }),
      idempotency_key: scalar({ type: "string", minLength: 1 }),
      committed_at: ref("recorded_at"),
      request_digest: ref("claim_digest"),
      assertion_ids: arr(ref("assertion_id")),
      state: enumOf(
        ["committed", "replayed", "refused", "expired"],
        "replayed: this exact (client_id, idempotency_key) already committed and the ORIGINAL receipt with the ORIGINAL ids is returned — nothing is re-minted, re-stamped, or given a new seq. expired: the idempotency record aged out, so a retry would now commit a SECOND copy."
      )
    },
    ["submission_id", "client_id", "idempotency_key", "committed_at", "request_digest", "assertion_ids", "state"]
  ),

  submission_item_result: obj(
    {
      index: scalar({ type: "integer", minimum: 0, description: "Position in the request's proposals[]." }),
      outcome: enumOf(["committed", "replayed", "refused"]),
      assertion_id: ref("assertion_id"),
      seq: scalar({ type: "integer", minimum: 1 }),
      claim_digest: ref("claim_digest"),
      error: record("atlas.error:v1")
    },
    ["index", "outcome"],
    "A submission is all-or-nothing: one submission is one durable commit group, so there is no state in which some items landed and others did not. Per-item results exist to say WHICH item caused a refusal, not to report partial success."
  ),

  reveal_input_request: obj(
    {
      request_id: scalar({ type: "string", minLength: 1 }),
      request_state: scalar({
        type: "string",
        minLength: 1,
        description:
          "Opaque and integrity-protected. Bound to the principal resolved from the credential — never to self-reported client info — and to this method and arguments, so it cannot be replayed across principals or requests."
      }),
      expires_at: ref("recorded_at"),
      prompt: scalar({ type: "string", minLength: 1 }),
      required_capabilities: arr(scalar({ type: "string", minLength: 1 }))
    },
    ["request_id", "request_state", "expires_at", "prompt"]
  )
};

// ---------------------------------------------------------------------------
// the six record schemas
// ---------------------------------------------------------------------------

export const RECORD_SHAPES: Record<RecordSchemaName, Shape> = {
  "atlas.assertion:v1": obj(
    {
      record_schema: constant("atlas.assertion:v1"),
      assertion_id: ref("assertion_id"),
      seq: scalar({
        type: "integer",
        minimum: 1,
        description:
          "Per-assertion, monotone, gapless within a feed_epoch. Deliberately not the prior `generation`, which stamped one value across every event in a transaction — so a cursor could not resume mid-submission when 1,000 changes shared one number."
      }),
      feed_epoch: scalar({ type: "string", minLength: 1 }),
      kind: enumOf(["fact", "relationship", "observation"]),
      lineage_action: enumOf(["assert", "correct", "retract", "invalidate", "reinstate"]),
      subject_entity_id: ref("entity_id"),
      predicate: ref("predicate"),
      value: anyJson(),
      target_entity_id: ref("entity_id"),
      valid_from: ref("world_time_point"),
      valid_to: ref("world_time_point"),
      recorded_at: ref("recorded_at", "Assigned by Atlas at commit. Never accepted from a caller."),
      superseded_at: nullable(ref("recorded_at")),
      superseded_by: nullable(ref("assertion_id")),
      supersedes: arr(ref("assertion_id")),
      claim_digest: ref("claim_digest"),
      provenance: ref("provenance"),
      confidence: ref("confidence"),
      evidence_links: arr(ref("evidence_link")),
      sensitivity: ref("sensitivity"),
      valid_time_fidelity: ref(
        "valid_time_fidelity",
        "Read context, not part of the stored record: present in query results, absent from a feed row."
      ),
      match_quality: ref("match_quality", "Read context. Present only when the request supplied as_of_valid.")
    },
    [
      "record_schema",
      "assertion_id",
      "seq",
      "feed_epoch",
      "kind",
      "lineage_action",
      "subject_entity_id",
      "predicate",
      "recorded_at",
      "superseded_at",
      "superseded_by",
      "supersedes",
      "claim_digest",
      "provenance",
      "confidence",
      "evidence_links",
      "sensitivity"
    ],
    "One statement, one learning event, never edited in place. The only mutation Atlas ever makes to a committed assertion is stamping superseded_at/superseded_by once — write-once, never back to null. Corrections and retractions are NEW assertions pointing at what they supersede."
  ),

  "atlas.entity:v1": obj(
    {
      record_schema: constant("atlas.entity:v1"),
      entity_id: ref("entity_id"),
      type: enumOf(["person", "organization", "place", "concept", "source-document", "event"]),
      type_label: vocabulary(
        "entity_subtype",
        "Required when type is `other`, forbidden otherwise. This is the open half of a two-layer typing scheme: a kind of thing added in 2031 reaches a 2026 consumer as type `other` plus a label it can display, never as a token it might branch on by accident."
      ),
      display_name: scalar({ type: "string", minLength: 1 }),
      also_known_as: arr(
        scalar({ type: "string", minLength: 1 }),
        {},
        "Nicknames, not aliases. In Atlas an alias is a row in the id ledger; letting one word mean both a nickname and an id redirect is how a rename becomes a re-identification. Renaming writes no ledger row and cannot move an id."
      ),
      registered_at: ref("recorded_at"),
      updated_at: ref("recorded_at"),
      provenance: ref("provenance"),
      sensitivity: ref("sensitivity")
    },
    [
      "record_schema",
      "entity_id",
      "type",
      "display_name",
      "also_known_as",
      "registered_at",
      "updated_at",
      "provenance",
      "sensitivity"
    ],
    "A thing the graph makes claims about. There is no `merged` or `redirected` status field: a second place the redirect state is written is a second place that can disagree with the alias ledger. The ledger is the only redirect authority and atlas.entity.resolve.v1 is the only way to ask."
  ),

  "atlas.redaction:v1": obj(
    {
      record_schema: constant("atlas.redaction:v1"),
      redaction_id: scalar({
        type: "string",
        minLength: 1,
        description: "Stable for this record and this credential, so atlas.sensitive.reveal.v1 has something to name."
      }),
      withheld_record_schema: scalar({
        type: "string",
        minLength: 1,
        description: "What KIND of record is behind the stub. Knowing the shape is not knowing the content."
      }),
      disclosure_level: enumOf(
        ["existence-only", "shape", "metadata"],
        "How much this stub itself discloses. existence-only: something is here. shape: plus its record kind. metadata: plus non-identifying facets."
      ),
      sensitivity: ref("sensitivity"),
      reason_code: vocabulary("error_code"),
      reveal_available: scalar({
        type: "boolean",
        description: "Whether atlas.sensitive.reveal.v1 could unlock this for this credential at all."
      }),
      reveal_tool: scalar({ type: "string", minLength: 1 }),
      seq: scalar({ type: "integer", minimum: 1, description: "Present when the withheld record has a feed position." })
    },
    ["record_schema", "redaction_id", "withheld_record_schema", "disclosure_level", "sensitivity", "reason_code", "reveal_available"],
    "A withheld record still occupies its row. The consumer learns THAT something is here and unreachable, so page counts reconcile and a filtered graph is never mistaken for a complete one."
  ),

  "atlas.error:v1": obj(
    {
      record_schema: constant("atlas.error:v1"),
      code: vocabulary(
        "error_code",
        "OPEN vocabulary. A consumer MUST tolerate a code it has never seen: the alternative is a consumer that breaks when Atlas becomes more honest."
      ),
      message: scalar({ type: "string", minLength: 1, description: "Human-readable. Never parse it; branch on `code`." }),
      retryable: scalar({
        type: "boolean",
        description: "Whether the identical request could succeed later with nothing changed by the caller."
      }),
      jsonrpc_code: scalar({
        type: "integer",
        description:
          "Present when the refusal also maps to a JSON-RPC error — e.g. -32021 for an undeclared capability, -32022 for an unsupported protocol revision, -32602 for arguments that failed the published input schema."
      }),
      required_capabilities: arr(scalar({ type: "string", minLength: 1 })),
      remedy: obj(
        {
          tool: scalar({ type: "string", minLength: 1 }),
          arguments_hint: anyJson(),
          note: scalar({ type: "string", minLength: 1 })
        },
        [],
        "Names the next call rather than describing it. A cursor below the retention floor names the re-scan entry point; an expired snapshot names the tool that restarts the read."
      ),
      details: anyJson("Code-specific. Its shape is part of the code's definition, published by atlas.contract.describe.v1.")
    },
    ["record_schema", "code", "message", "retryable"],
    "A typed refusal. Atlas refuses rather than guessing: a confident wrong answer is worse than an admission that the question cannot be answered."
  ),

  "atlas.horizon:v1": obj(
    {
      record_schema: constant("atlas.horizon:v1"),
      status: enumOf(
        ["complete", "partial", "unknowable"],
        "complete: everything matching was evaluated. partial: something was not reachable and coverage says how much. unknowable: the question cannot be answered from retained history at all."
      ),
      bitemporal_since: ref(
        "recorded_at",
        "The belief-time history floor. Reads before it are refused, not answered from present state. Atlas has no pre-cutover belief history and says so rather than implying one."
      ),
      feed_epoch: scalar({ type: "string", minLength: 1, description: "A change of epoch invalidates every cursor, loudly." }),
      seq_watermark: scalar({
        type: "integer",
        minimum: 0,
        description: "The highest seq this answer accounts for. With feed_epoch and as_of_recorded it is the snapshot pin."
      }),
      as_of_recorded: ref("recorded_at", "The belief instant this answer was computed at — echoed even when the caller did not supply one."),
      as_of_valid: ref("world_time_probe"),
      recorded_at_fidelity_mixed: scalar({
        type: "boolean",
        description:
          "True when the answer mixes Atlas-stamped belief times with import artifacts. Belief-time ordering across that boundary is meaningless, so it is a property of the RESULT and not only of the query."
      }),
      retention_floor_seq: scalar({
        type: "integer",
        minimum: 0,
        description: "Highest seq compaction has reclaimed. 0 when nothing ever was."
      }),
      migration_window_open: scalar({
        type: "boolean",
        description:
          "True while an audited migration window has append-only immutability suspended. Surfaced in READ responses because an answer taken during one may not be reproducible afterwards."
      })
    },
    ["record_schema", "status", "bitemporal_since", "feed_epoch", "seq_watermark", "as_of_recorded", "recorded_at_fidelity_mixed"],
    "What this answer can and cannot speak for. Present on every read result — the honesty block is not optional and not conditional on anything having gone wrong."
  ),

  "atlas.change:v1": obj(
    {
      record_schema: constant("atlas.change:v1"),
      change_id: scalar({
        type: "string",
        minLength: 1,
        description: "Delivery is at-least-once. Deduplicate on this; it is stable across redeliveries of the same change."
      }),
      seq: scalar({ type: "integer", minimum: 1 }),
      feed_epoch: scalar({ type: "string", minLength: 1 }),
      recorded_at: ref("recorded_at"),
      change_kind: enumOf([
        "assertion-committed",
        "assertion-superseded",
        "entity-registered",
        "entity-renamed",
        "entity-redirected"
      ]),
      assertion_id: ref("assertion_id"),
      entity_id: ref("entity_id"),
      submission_id: ref("submission_id"),
      record: taggedUnion(
        ["atlas.assertion:v1", "atlas.entity:v1", "atlas.redaction:v1"],
        "The changed record, when the request asked for it and this credential may read it. A record it may not read arrives as a redaction stub, so the feed's seq sequence stays gapless."
      )
    },
    ["record_schema", "change_id", "seq", "feed_epoch", "recorded_at", "change_kind"],
    "One row of the resumable change feed. Supersession is its own change with its own seq, so a mirror converges from the feed alone without re-reading the graph."
  )
};

// ---------------------------------------------------------------------------
// tool definitions
// ---------------------------------------------------------------------------

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type CatalogTool = {
  name: ContractToolName;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  /** 0 means do not cache. `cache_scope` is stamped `private` by the generator. */
  cache_ttl_ms: number;
  requires_capabilities: readonly string[];
  input: Shape;
  output: Shape;
};

/** Every read tool: no writes, safe to repeat, closed world. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};

const RESULT_ENVELOPE = {
  coverage: ref("coverage"),
  horizon: record("atlas.horizon:v1"),
  cache: ref("cache")
};

/**
 * The two axes, as flat arguments. Independent by construction: `as_of_valid`
 * with no `as_of_recorded` asks what we NOW believe about that span of world
 * time; adding a past `as_of_recorded` asks what we believed THEN about it.
 */
const AS_OF_INPUT = {
  as_of_recorded: ref(
    "recorded_at",
    "BELIEF axis. Below the retained history floor this is refused, never answered from present state."
  ),
  as_of_valid: ref("world_time_probe", "WORLD axis.")
};

const PAGE_INPUT = {
  page_size: ref("page_size"),
  cursor: ref("page_cursor"),
  snapshot: ref("snapshot_token")
};

export const CATALOG_TOOLS: readonly CatalogTool[] = [
  {
    name: "atlas.contract.describe.v1",
    title: "Describe the published contract",
    description:
      "Return the running contract: revision, protocol revision, record schemas, tool list, live vocabularies, transport-invariant limits, machine-readable deprecations, and the history block. Call this first. Validate against the vocabularies it returns, not against a copy captured when your client shipped.",
    annotations: READ_ONLY,
    cache_ttl_ms: 300000,
    requires_capabilities: [],
    input: obj(
      {
        revision: scalar({
          type: "string",
          minLength: 1,
          description: "Ask for a specific revision. Absent means the current one. A revision this server does not serve is a typed refusal, never a silent substitution."
        })
      },
      []
    ),
    output: obj(
      {
        revision: scalar({ type: "string", minLength: 1 }),
        revisions_served: arr(scalar({ type: "string", minLength: 1 }), { minItems: 1 }),
        protocol_version: scalar({ type: "string", minLength: 1 }),
        policy_document: scalar({
          type: "string",
          minLength: 1,
          description: "The document normative for semantics. Cite a revision by this pair: contract revision plus this path."
        }),
        history: obj(
          {
            prior_versions_retained_before_cutover: scalar({
              type: "integer",
              minimum: 0,
              description:
                "The number, not a phrase. It is 0: nothing published before this contract is retained in a form this contract can serve, so there is no earlier response any consumer can replay."
            }),
            bitemporal_since: ref("recorded_at"),
            belief_time_meaningful_since_cutover_only: scalar({ type: "boolean" }),
            feed_epoch: scalar({ type: "string", minLength: 1 }),
            retention_floor_seq: scalar({ type: "integer", minimum: 0 }),
            change_feed_floor_days: scalar({ type: "integer", minimum: 1 })
          },
          [
            "prior_versions_retained_before_cutover",
            "bitemporal_since",
            "belief_time_meaningful_since_cutover_only",
            "feed_epoch",
            "change_feed_floor_days"
          ]
        ),
        limits: obj(
          {
            max_page_size: scalar({ type: "integer", minimum: 1 }),
            default_page_size: scalar({ type: "integer", minimum: 1 }),
            max_batch_items: scalar({ type: "integer", minimum: 1 }),
            max_batch_bytes: scalar({ type: "integer", minimum: 1 }),
            max_traversal_depth: scalar({ type: "integer", minimum: 1 }),
            max_ids_per_request: scalar({ type: "integer", minimum: 1 }),
            snapshot_ttl_seconds: scalar({ type: "integer", minimum: 1 }),
            idempotency_ttl_days: scalar({ type: "integer", minimum: 1 }),
            change_feed_floor_days: scalar({ type: "integer", minimum: 1 }),
            deprecation_window_days: scalar({
              type: "integer",
              minimum: 1,
              description:
                "Minimum notice before anything published is removed. Equal to change_feed_floor_days: a consumer promised it can resume after that long offline must not resume into a surface where its tool is gone."
            })
          },
          [
            "max_page_size",
            "default_page_size",
            "max_batch_items",
            "max_batch_bytes",
            "max_traversal_depth",
            "max_ids_per_request",
            "snapshot_ttl_seconds",
            "idempotency_ttl_days",
            "change_feed_floor_days",
            "deprecation_window_days"
          ],
          "Transport-invariant. A transport may not narrow them, and these are the same numbers compiled into the published schemas."
        ),
        record_schemas: arr(
          obj(
            {
              name: scalar({ type: "string", minLength: 1 }),
              schema_id: scalar({ type: "string", minLength: 1 }),
              schema_path: scalar({ type: "string", minLength: 1 })
            },
            ["name", "schema_id", "schema_path"]
          ),
          { minItems: 1 }
        ),
        tools: arr(
          obj(
            {
              name: scalar({ type: "string", minLength: 1 }),
              title: scalar({ type: "string", minLength: 1 }),
              input_schema_id: scalar({ type: "string", minLength: 1 }),
              output_schema_id: scalar({ type: "string", minLength: 1 }),
              requires_capabilities: arr(scalar({ type: "string", minLength: 1 })),
              deprecation: nullable(
                obj(
                  {
                    announced_at: ref("recorded_at"),
                    removal_not_before: ref("recorded_at"),
                    replacement_tool: scalar({ type: "string", minLength: 1 }),
                    reason: scalar({ type: "string", minLength: 1 })
                  },
                  ["announced_at", "removal_not_before", "reason"]
                )
              )
            },
            ["name", "title", "input_schema_id", "output_schema_id", "requires_capabilities", "deprecation"]
          ),
          { minItems: 1 },
          "Deterministically ordered. The order is part of the contract so a diff of two tools/list responses is meaningful."
        ),
        vocabularies: obj(
          {
            predicate: arr(
              obj(
                {
                  predicate: scalar({ type: "string", minLength: 1 }),
                  cardinality: enumOf(["functional", "multi-valued"]),
                  functional_key: arr(scalar({ type: "string", minLength: 1 })),
                  relational: scalar({ type: "boolean" })
                },
                ["predicate", "cardinality", "relational"]
              )
            ),
            entity_subtype: arr(scalar({ type: "string", minLength: 1 })),
            error_code: arr(
              obj(
                {
                  code: scalar({ type: "string", minLength: 1 }),
                  origin: enumOf(["store", "identity", "protocol", "policy", "contract"]),
                  jsonrpc_code: scalar({ type: "integer" }),
                  retryable: scalar({ type: "boolean" }),
                  summary: scalar({ type: "string", minLength: 1 })
                },
                ["code", "origin", "retryable", "summary"]
              )
            )
          },
          ["predicate", "entity_subtype", "error_code"],
          "The LIVE registries. Open vocabularies are the graph's to grow, so a consumer validates against this answer rather than against the x-atlas-known-values hint frozen into the schema."
        ),
        deprecations: arr(
          obj(
            {
              target_kind: enumOf(["tool", "field", "error_code", "record_schema", "vocabulary_value"]),
              target: scalar({ type: "string", minLength: 1 }),
              announced_at: ref("recorded_at"),
              removal_not_before: ref("recorded_at"),
              replacement: scalar({ type: "string", minLength: 1 }),
              reason: scalar({ type: "string", minLength: 1 })
            },
            ["target_kind", "target", "announced_at", "removal_not_before", "reason"]
          ),
          {},
          "Machine-readable, so a client can alert on its own use of something scheduled for removal instead of discovering it at removal time. Empty is a real answer: nothing is deprecated."
        ),
        cache: ref("cache")
      },
      [
        "revision",
        "revisions_served",
        "protocol_version",
        "policy_document",
        "history",
        "limits",
        "record_schemas",
        "tools",
        "vocabularies",
        "deprecations",
        "cache"
      ]
    )
  },

  {
    name: "atlas.scope.describe.v1",
    title: "Describe what this credential can reach",
    description:
      "Report the calling credential's own client_id and the capability grant behind it: the tools it may call, the sensitivity tiers it may read, the predicates and tiers it may write, the limits that apply to it, whether its coverage counts are exact, and whose assertions it may supersede. Ask here rather than inferring scope from a refusal — and never from which transport you connected over. Two deployments differ by grant, not by wire.",
    annotations: READ_ONLY,
    cache_ttl_ms: 60000,
    requires_capabilities: [],
    input: obj({}, []),
    output: obj(
      {
        client_id: scalar({
          type: "string",
          minLength: 1,
          description: "Resolved from the authenticated credential. Three credentials over one transport are three client_ids; one credential over two transports is one."
        }),
        credential_class: enumOf(["consumer", "owner"]),
        plane: enumOf(["consumer", "operator"]),
        grant_id: scalar({
          type: "string",
          minLength: 1,
          description:
            "Names the capability grant this answer describes, so an audit event and a scope description can be tied together without either naming the credential."
        }),
        tools_available: arr(scalar({ type: "string", minLength: 1 }), { minItems: 1 }, "Exactly what tools/list returns for this credential. A tool absent here is refused by name, not silently ignored."),
        sensitivity_reachable: arr(
          obj({ tier: scalar({ type: "string", minLength: 1 }), rank: scalar({ type: "integer", minimum: 0 }) }, ["tier", "rank"]),
          { minItems: 1 },
          "Tiers whose content this credential may read, BY NAME. A named set rather than a threshold: a tier introduced later is unreachable until someone grants it, where a threshold would admit it for having been ranked low."
        ),
        sensitivity_ceiling: obj(
          { tier: scalar({ type: "string", minLength: 1 }), rank: scalar({ type: "integer", minimum: 0 }) },
          ["tier", "rank"],
          "The highest-ranked member of sensitivity_reachable. A report of that set, not the rule: reachability is membership. It sizes how much a redaction stub discloses about itself."
        ),
        predicates_writable: arr(
          scalar({ type: "string", minLength: 1 }),
          {},
          "Predicates this credential may assert about. Empty is a read-only credential, and is not the same as the tool being absent."
        ),
        write_tiers_permitted: arr(
          scalar({ type: "string", minLength: 1 }),
          {},
          "Sensitivity tiers this credential may commit AT. Reading a tier and writing at it are separate grants."
        ),
        limits: obj(
          {
            max_page_size: scalar({ type: "integer", minimum: 1 }),
            max_ids_per_request: scalar({ type: "integer", minimum: 1 }),
            max_batch_items: scalar({ type: "integer", minimum: 1 })
          },
          ["max_page_size", "max_ids_per_request", "max_batch_items"],
          "The limits that apply to THIS credential: the contract's published caps, narrowed by the grant. A grant can only ever narrow them, so these are never above what atlas.contract.describe.v1 publishes."
        ),
        coverage_counts_basis: enumOf(["exact", "bucketed"]),
        supersession_scope: enumOf(
          ["own-client-id", "any"],
          "own-client-id: this credential may only supersede assertions it authored. A consumer that can retract another consumer's belief can rewrite attribution, and attribution is the only thing making provenance meaningful."
        ),
        reveal_available: scalar({ type: "boolean" }),
        declared_client_capabilities: arr(scalar({ type: "string", minLength: 1 })),
        horizon: record("atlas.horizon:v1"),
        cache: ref("cache")
      },
      [
        "client_id",
        "credential_class",
        "plane",
        "grant_id",
        "tools_available",
        "sensitivity_reachable",
        "sensitivity_ceiling",
        "predicates_writable",
        "write_tiers_permitted",
        "limits",
        "coverage_counts_basis",
        "supersession_scope",
        "reveal_available",
        "horizon",
        "cache"
      ]
    )
  },

  {
    name: "atlas.entity.resolve.v1",
    title: "Resolve identifiers to current entities",
    description:
      "Follow the alias ledger from any identifier — including legacy ids Atlas never minted — to the entity it names today. Every outcome is typed. An id that was split returns its candidates and no primary: nominating one would silently reattribute every historical reference to it.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        ids: arr(ref("opaque_reference"), { minItems: 1, maxItems: CONTRACT_LIMITS.max_ids_per_request }),
        ...AS_OF_INPUT
      },
      ["ids"]
    ),
    output: obj(
      {
        resolutions: arr(
          obj(
            {
              requested_id: ref("opaque_reference"),
              outcome: enumOf([
                "resolved",
                "unknown-id",
                "ambiguous-split",
                "not-carried-forward",
                "redirect-cycle",
                "redirect-chain-too-long",
                "redirect-dangling"
              ]),
              entity: taggedUnion(["atlas.entity:v1", "atlas.redaction:v1"]),
              redirect_chain: arr(ref("opaque_reference"), {}, "Every id visited, oldest first."),
              redirect_reason: scalar({
                type: "string",
                minLength: 1,
                description: "Why the id the CALLER holds stopped being current — the first hop only. A single string cannot honestly summarise a multi-hop history, so it does not try."
              }),
              candidate_ids: arr(ref("entity_id"), {}, "Present on ambiguous-split. Atlas names them and does not choose."),
              disposition: enumOf(["mapped", "ambiguous-split", "never-migrated", "content-unrecoverable", "redacted-in-place"]),
              error: record("atlas.error:v1")
            },
            ["requested_id", "outcome", "redirect_chain"]
          ),
          { minItems: 1 }
        ),
        ...RESULT_ENVELOPE
      },
      ["resolutions", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.entity.read.v1",
    title: "Read entities by id",
    description:
      "Read registered entities. An id that redirects is NOT followed here — that is atlas.entity.resolve.v1's job, and conflating the two is how a consumer stops noticing that the thing it asked about was merged away.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        entity_ids: arr(ref("entity_id"), { minItems: 1, maxItems: CONTRACT_LIMITS.max_ids_per_request }),
        ...AS_OF_INPUT
      },
      ["entity_ids"]
    ),
    output: obj(
      {
        results: arr(taggedUnion(["atlas.entity:v1", "atlas.redaction:v1", "atlas.error:v1"])),
        ...RESULT_ENVELOPE
      },
      ["results", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.assertion.query.v1",
    title: "Query assertions on both time axes",
    description:
      "The bitemporal read. as_of_recorded selects what Atlas believed at an instant; as_of_valid selects what was true over a span of world time; the axes are independent. Set full_scan to bootstrap a mirror — the last page hands off to the change feed at an exact seq with no gap.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        subject_entity_id: ref("entity_id"),
        target_entity_id: ref("entity_id"),
        predicate: ref("predicate"),
        kind: enumOf(["fact", "relationship", "observation"]),
        ...AS_OF_INPUT,
        include_superseded: scalar({
          type: "boolean",
          default: false,
          description: "Include records already superseded at as_of_recorded. Lineage archaeology, not a present-tense read."
        }),
        full_scan: scalar({
          type: "boolean",
          default: false,
          description:
            "Bootstrap mode: every assertion this credential may read, paged and snapshot-pinned. Legal with no filters at all — that is the point. The final page carries page.feed_handoff."
        }),
        ...PAGE_INPUT
      },
      []
    ),
    output: obj(
      {
        results: arr(taggedUnion(["atlas.assertion:v1", "atlas.redaction:v1"])),
        contested: arr(
          ref("contested_group"),
          {},
          "Empty is a real answer. A non-empty group means Atlas holds two live, mutually exclusive beliefs and is reporting both rather than picking one."
        ),
        page: ref("page"),
        ...RESULT_ENVELOPE
      },
      ["results", "contested", "page", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.assertion.read.v1",
    title: "Read assertions by id",
    description:
      "Read specific assertions whether or not they are still believed, optionally with their lineage. An id compaction reclaimed returns a typed atlas.error:v1 carrying the reclamation note — never a bare not-found, because a dangling reference and a typo must not look the same.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        assertion_ids: arr(ref("assertion_id"), { minItems: 1, maxItems: CONTRACT_LIMITS.max_ids_per_request }),
        include_lineage: scalar({
          type: "boolean",
          default: false,
          description: "Also return what each assertion supersedes and what superseded it, one hop in each direction."
        })
      },
      ["assertion_ids"]
    ),
    output: obj(
      {
        results: arr(taggedUnion(["atlas.assertion:v1", "atlas.redaction:v1", "atlas.error:v1"])),
        lineage: arr(
          obj(
            {
              assertion_id: ref("assertion_id"),
              supersedes: arr(ref("assertion_id")),
              superseded_by: nullable(ref("assertion_id")),
              lineage_action: enumOf(["assert", "correct", "retract", "invalidate", "reinstate"])
            },
            ["assertion_id", "supersedes", "superseded_by", "lineage_action"]
          )
        ),
        reclamations: arr(
          obj({ assertion_id: ref("assertion_id"), note: ref("reclamation_note") }, ["assertion_id", "note"])
        ),
        ...RESULT_ENVELOPE
      },
      ["results", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.graph.neighbors.v1",
    title: "Walk relationship assertions from an entity",
    description:
      "Traverse relationship assertions outward from one entity, bounded by depth and pinned to both time axes. Nodes and edges are returned as self-describing records; anything this credential may not read arrives as a redaction stub so the shape of what was skipped is still visible.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        entity_id: ref("entity_id"),
        direction: enumOf(["outbound", "inbound", "both"]),
        predicates: arr(ref("predicate"), { maxItems: CONTRACT_LIMITS.max_ids_per_request }),
        max_depth: scalar({ type: "integer", minimum: 1, maximum: CONTRACT_LIMITS.max_traversal_depth, default: 1 }),
        ...AS_OF_INPUT,
        ...PAGE_INPUT
      },
      ["entity_id"]
    ),
    output: obj(
      {
        nodes: arr(taggedUnion(["atlas.entity:v1", "atlas.redaction:v1"])),
        edges: arr(taggedUnion(["atlas.assertion:v1", "atlas.redaction:v1"])),
        traversal: obj(
          {
            origin_entity_id: ref("entity_id"),
            direction: enumOf(["outbound", "inbound", "both"]),
            max_depth: scalar({ type: "integer", minimum: 1 }),
            deepest_reached: scalar({ type: "integer", minimum: 0 }),
            truncated_by: nullable(
              enumOf(
                ["max_depth", "page_size", "policy"],
                "Why the walk stopped short. A truncated traversal that does not say so is a subgraph presented as a graph."
              )
            )
          },
          ["origin_entity_id", "direction", "max_depth", "deepest_reached", "truncated_by"]
        ),
        page: ref("page"),
        ...RESULT_ENVELOPE
      },
      ["nodes", "edges", "traversal", "page", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.text.search.v1",
    title: "Search readable text",
    description:
      "Rank entities and assertions by a deterministic text scorer. The answer states what was searchable: encrypted content is not scanned, and the count of what could not be searched is reported rather than silently excluded.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        query: scalar({ type: "string", minLength: 1 }),
        entity_types: arr(enumOf(["person", "organization", "place", "concept", "source-document", "event"])),
        predicates: arr(ref("predicate"), { maxItems: CONTRACT_LIMITS.max_ids_per_request }),
        ...AS_OF_INPUT,
        ...PAGE_INPUT
      },
      ["query"]
    ),
    output: obj(
      {
        results: arr(
          obj(
            {
              score: scalar({ type: "number", minimum: 0 }),
              match_basis: enumOf(["display-name", "also-known-as", "assertion-value", "evidence"]),
              record: taggedUnion(["atlas.entity:v1", "atlas.assertion:v1", "atlas.redaction:v1"])
            },
            ["score", "match_basis", "record"]
          )
        ),
        search_scope: obj(
          {
            scorer: enumOf(["deterministic-text", "embedding"]),
            plaintext_candidates: scalar({ type: "integer", minimum: 0 }),
            encrypted_unsearchable: scalar({
              type: "integer",
              minimum: 0,
              description:
                "Records that could not be scanned because their content is encrypted at rest. The prior remote path filtered to plaintext with score>0 and reported nothing, so an encrypted match was indistinguishable from no match."
            }),
            counts_basis: enumOf(["exact", "bucketed"])
          },
          ["scorer", "plaintext_candidates", "encrypted_unsearchable", "counts_basis"]
        ),
        page: ref("page"),
        ...RESULT_ENVELOPE
      },
      ["results", "search_scope", "page", "coverage", "horizon", "cache"]
    )
  },

  {
    name: "atlas.changes.read.v1",
    title: "Read the resumable change feed",
    description:
      "Read changes after a cursor in total seq order within a feed_epoch. Delivery is at-least-once; deduplicate on change_id. A cursor below the retention floor is a typed refusal naming the re-scan entry point, never a silent empty page.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        cursor_seq: scalar({ type: "integer", minimum: 0, description: "0 starts at the beginning of retained history." }),
        feed_epoch: scalar({
          type: "string",
          minLength: 1,
          description: "Supply the epoch your cursor came from. A mismatch fails loudly instead of resuming into a different total order."
        }),
        limit: ref("page_size", "Rows on this page. The same transport-invariant cap every paged read uses."),
        include_records: scalar({ type: "boolean", default: false })
      },
      ["cursor_seq"]
    ),
    output: obj(
      {
        changes: arr(record("atlas.change:v1")),
        next_cursor_seq: scalar({ type: "integer", minimum: 0 }),
        has_more: scalar({ type: "boolean" }),
        feed_epoch: scalar({ type: "string", minLength: 1 }),
        retention_floor_seq: scalar({ type: "integer", minimum: 0 }),
        cursor_before_retention_floor: scalar({
          type: "boolean",
          description:
            "The cursor predates retained history, so this page is missing changes that once existed. A consumer that resumes past a hole cannot otherwise tell a compacted range from an uneventful one."
        }),
        error: record("atlas.error:v1"),
        horizon: record("atlas.horizon:v1"),
        cache: ref("cache")
      },
      ["changes", "next_cursor_seq", "has_more", "feed_epoch", "retention_floor_seq", "cursor_before_retention_floor", "horizon", "cache"]
    )
  },

  {
    name: "atlas.assertion.propose.v1",
    title: "Propose assertions",
    description:
      "Commit one or more assertions under a single idempotency key. The submission is all-or-nothing: one submission is one durable commit group. A retry with the same (client_id, idempotency_key) returns the ORIGINAL receipt with the ORIGINAL ids; the same key with a different payload is a typed conflict, never a silent accept of either version.",
    annotations: {
      readOnlyHint: false,
      // Append-only: nothing is ever overwritten or deleted, and a retraction is
      // a new assertion pointing at what it supersedes. There is no argument to
      // this tool that can destroy a prior record.
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        idempotency_key: scalar({
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Identity is (client_id, idempotency_key) and never a content hash: an assertion's body carries a server-assigned recorded_at, so the same logical write can never hash the same twice. Content-addressed identity and server-assigned belief time are mutually exclusive, and belief time wins."
        }),
        proposals: arr(ref("assertion_draft"), { minItems: 1, maxItems: CONTRACT_LIMITS.max_batch_items }),
        expected_feed_epoch: scalar({
          type: "string",
          minLength: 1,
          description: "Refuse the commit if the epoch has rolled since you last read. Optional; supply it when superseding."
        })
      },
      ["idempotency_key", "proposals"]
    ),
    output: obj(
      {
        submission: ref("submission_receipt"),
        results: arr(ref("submission_item_result"), { minItems: 1 }),
        committed: scalar({ type: "integer", minimum: 0 }),
        refused: scalar({ type: "integer", minimum: 0 }),
        error: record("atlas.error:v1"),
        horizon: record("atlas.horizon:v1")
      },
      ["submission", "results", "committed", "refused", "horizon"]
    )
  },

  {
    name: "atlas.submission.read.v1",
    title: "Read a submission receipt",
    description:
      "Look up a submission by id or by the idempotency key you used. This exists for the case that matters: your connection dropped after you sent a proposal and you do not know whether it committed. Retrying blind is only safe while the key is still within the published idempotency window.",
    annotations: READ_ONLY,
    cache_ttl_ms: 0,
    requires_capabilities: [],
    input: obj(
      {
        submission_id: ref("submission_id"),
        idempotency_key: scalar({
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Scoped to your own client_id. You cannot read another credential's receipts."
        })
      },
      [],
      "Supply exactly one. Supplying neither, or both, is invalid-argument — guessing which the caller meant is how a client silently reads the wrong submission."
    ),
    output: obj(
      {
        submission: ref("submission_receipt"),
        results: arr(ref("submission_item_result")),
        idempotency_expires_at: nullable(
          ref(
            "recorded_at",
            "When this key stops being deduplicated. After it, an identical retry commits a SECOND copy. null means the receipt has already expired."
          )
        ),
        error: record("atlas.error:v1"),
        horizon: record("atlas.horizon:v1")
      },
      ["horizon"]
    )
  },

  {
    name: "atlas.sensitive.reveal.v1",
    title: "Request disclosure of a withheld record",
    description:
      "Ask for the record behind an atlas.redaction:v1 stub. This is not a read: it always produces a durable audit event, and it may return input_required so the owner can decide in their own client. Requires the elicitation capability; without it the refusal names the capability rather than issuing a request nobody can answer.",
    annotations: {
      // Not read-only. A reveal writes a durable, inspectable audit event
      // whether or not it succeeds — reads by a remote provider are
      // security-relevant events and must be observable. Annotating it
      // read-only would tell a client it is free to retry it silently.
      readOnlyHint: false,
      destructiveHint: false,
      // An owner decision is not repeatable: the second call is a second ask.
      idempotentHint: false,
      openWorldHint: false
    },
    cache_ttl_ms: 0,
    requires_capabilities: ["elicitation"],
    input: obj(
      {
        redaction_id: scalar({ type: "string", minLength: 1 }),
        reason: scalar({
          type: "string",
          minLength: 1,
          description: "Recorded in the audit event and shown to the owner when a decision is requested. Required: an unattributed disclosure request is one the owner cannot judge."
        }),
        request_state: scalar({
          type: "string",
          minLength: 1,
          description: "Echo the value from a prior input_required response. Integrity-protected and bound to this principal, method and arguments."
        })
      },
      ["redaction_id", "reason"]
    ),
    output: obj(
      {
        outcome: enumOf(["revealed", "input-required", "refused"]),
        record: taggedUnion(["atlas.assertion:v1", "atlas.entity:v1", "atlas.redaction:v1"]),
        input_request: ref("reveal_input_request"),
        audit: obj(
          {
            event_id: scalar({ type: "string", minLength: 1 }),
            recorded_at: ref("recorded_at")
          },
          ["event_id", "recorded_at"],
          "Returned on every outcome, including a refusal. The caller is told that the attempt was recorded, because an audit trail a consumer does not know exists is one it cannot reason about."
        ),
        error: record("atlas.error:v1"),
        horizon: record("atlas.horizon:v1")
      },
      ["outcome", "audit", "horizon"]
    )
  }
];
