import type { ContractToolName, RecordSchemaName } from "@living-atlas/atlas-contract";

/**
 * The records and honesty blocks a consumer holds, as TypeScript.
 *
 * These types are a CONVENIENCE, never the authority. The authority is the
 * published JSON Schema: `AtlasConsumerClient` validates every result against
 * the bytes in `packages/atlas-contract/schema/<revision>/` before it hands
 * anything back, so a document these types describe wrongly is refused by the
 * validator rather than smuggled through as a well-typed lie.
 *
 * The risk of writing them down at all is the defect this repository keeps
 * measuring: a shape declared in two places has two shapes, and the wrong one is
 * the one nobody looks at. That is why the closed shapes here are paired with a
 * KEY MANIFEST — an object literal constrained by `satisfies Record<keyof T,
 * true>`, which TypeScript accepts only when the listed keys are EXACTLY the
 * type's keys — and `contract-parity.test.ts` compares each manifest against the
 * published document's own `properties` AND its `required`. Add a field here and
 * forget the contract, or add one to the contract and forget here, and the build
 * fails.
 *
 * The manifests cover the TOP LEVEL of each document. Nested objects are typed
 * from the same schemas but not key-manifested, because the runtime validator
 * already walks them in full: a second mechanism there would cost review
 * attention without catching anything the first one misses.
 */

/**
 * Exactly the keys of `T`, both directions.
 *
 * `satisfies Record<keyof T, true>` rejects a missing key AND an unknown one,
 * which a `(keyof T)[]` array literal does not — an array can silently omit.
 */
export type KeyManifest<T> = Record<keyof T, true>;

/**
 * The keys of `T` a value must supply, as a manifest.
 *
 * Separate from `KeyManifest` because the contract distinguishes "published"
 * from "required", and a client that treated an optional field as guaranteed
 * would crash on a conformant server rather than on a broken one.
 */
export type RequiredKeyManifest<T> = Record<
  { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T],
  true
>;

// ---------------------------------------------------------------------------
// shared scalars
// ---------------------------------------------------------------------------

/** `recorded_at`: belief time, assigned by Atlas at COMMIT. Never caller-supplied. */
export type RecordedAt = string;

/**
 * Every closed enum in this contract carries `other`, so a value minted in 2031
 * reaches a 2026 consumer as a token it can display rather than one it might
 * branch on by accident. Modelled as a union with a string tail for exactly that
 * reason: narrowing on a known member still works, and an unknown member still
 * type-checks instead of forcing a cast at the seam where the surprise arrives.
 */
export type OpenEnum<Known extends string> = Known | (string & {});

/** An object the contract leaves open at the leaves. Read, never branched on blind. */
export type OpenObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// atlas.horizon:v1
// ---------------------------------------------------------------------------

export type AtlasHorizon = {
  record_schema: "atlas.horizon:v1";
  /** `partial` and `unknowable` are answers, not failures. Read them. */
  status: OpenEnum<"complete" | "partial" | "unknowable">;
  bitemporal_since: RecordedAt;
  feed_epoch: string;
  seq_watermark: number;
  as_of_recorded: RecordedAt;
  as_of_valid?: string;
  recorded_at_fidelity_mixed: boolean;
  retention_floor_seq?: number;
  migration_window_open?: boolean;
};

export const HORIZON_KEYS = {
  record_schema: true,
  status: true,
  bitemporal_since: true,
  feed_epoch: true,
  seq_watermark: true,
  as_of_recorded: true,
  as_of_valid: true,
  recorded_at_fidelity_mixed: true,
  retention_floor_seq: true,
  migration_window_open: true
} satisfies KeyManifest<AtlasHorizon>;

export const HORIZON_REQUIRED = {
  record_schema: true,
  status: true,
  bitemporal_since: true,
  feed_epoch: true,
  seq_watermark: true,
  as_of_recorded: true,
  recorded_at_fidelity_mixed: true
} satisfies RequiredKeyManifest<AtlasHorizon>;

// ---------------------------------------------------------------------------
// atlas.error:v1
// ---------------------------------------------------------------------------

export type AtlasErrorRecord = {
  record_schema: "atlas.error:v1";
  code: string;
  message: string;
  /**
   * Whether the IDENTICAL bytes could succeed later. Not "is this fixable" — a
   * refusal that needs the caller to change the request is not retryable,
   * however easy the change is.
   */
  retryable: boolean;
  jsonrpc_code?: number;
  required_capabilities?: string[];
  remedy?: { tool?: string; arguments_hint?: unknown; note?: string };
  details?: unknown;
};

export const ERROR_KEYS = {
  record_schema: true,
  code: true,
  message: true,
  retryable: true,
  jsonrpc_code: true,
  required_capabilities: true,
  remedy: true,
  details: true
} satisfies KeyManifest<AtlasErrorRecord>;

export const ERROR_REQUIRED = {
  record_schema: true,
  code: true,
  message: true,
  retryable: true
} satisfies RequiredKeyManifest<AtlasErrorRecord>;

// ---------------------------------------------------------------------------
// atlas.redaction:v1
// ---------------------------------------------------------------------------

/**
 * A record this credential may not read, still occupying its row.
 *
 * The row is the point. A filtered graph that simply omitted the row would be
 * indistinguishable from a complete graph that never held it, and a consumer
 * would draw conclusions from an absence nobody told it about.
 */
export type AtlasRedaction = {
  record_schema: "atlas.redaction:v1";
  redaction_id: string;
  withheld_record_schema: string;
  disclosure_level: string;
  sensitivity: OpenObject;
  reason_code: OpenEnum<"sensitivity-tier" | "policy" | "key-unavailable" | "other">;
  reveal_available: boolean;
  reveal_tool?: string;
  seq?: number;
  [extra: string]: unknown;
};

// ---------------------------------------------------------------------------
// atlas.assertion:v1 and atlas.entity:v1
// ---------------------------------------------------------------------------

/**
 * Typed loosely at the leaves ON PURPOSE.
 *
 * An assertion carries an open predicate vocabulary, open sensitivity tiers and
 * an open confidence band; the live vocabularies come from
 * `atlas.contract.describe.v1`, not from a frozen list compiled into a client.
 * Pinning them here would let a client refuse a predicate the graph
 * legitimately grew — the exact failure the open-vocabulary rule exists to
 * prevent — so the members a consumer branches on are named and the rest stays
 * open.
 */
export type AtlasAssertion = {
  record_schema: "atlas.assertion:v1";
  assertion_id: string;
  seq: number;
  feed_epoch: string;
  kind: OpenEnum<"fact" | "relationship" | "other">;
  lineage_action: OpenEnum<"assert" | "revise" | "retract" | "other">;
  subject_entity_id: string;
  predicate: string;
  value?: unknown;
  target_entity_id?: string | null;
  /** World time: when the thing was true. Never interchangeable with `recorded_at`. */
  valid_from?: unknown;
  valid_to?: unknown;
  /** Belief time: when Atlas learned it. Assigned at commit, never by a caller. */
  recorded_at: RecordedAt;
  /** Write-once, and expressed as an APPEND in the log rather than an edit. */
  superseded_at: RecordedAt | null;
  superseded_by: string[] | null;
  supersedes: string[];
  /** A dedup HINT. Never an identity: two assertions may share one legitimately. */
  claim_digest: string;
  provenance: OpenObject;
  confidence: OpenObject;
  evidence_links: OpenObject[];
  sensitivity: OpenObject;
  valid_time_fidelity?: OpenEnum<"exact" | "approximate" | "unknown" | "absent" | "other">;
  match_quality?: OpenEnum<"exact" | "possible" | "other">;
  [extra: string]: unknown;
};

export type AtlasEntity = {
  record_schema: "atlas.entity:v1";
  entity_id: string;
  /** The frozen half of the two-layer typing scheme. `type_label` is the open half. */
  type: OpenEnum<"person" | "organisation" | "place" | "thing" | "event" | "other">;
  type_label?: string;
  display_name: string;
  also_known_as: string[];
  registered_at: RecordedAt;
  updated_at: RecordedAt;
  provenance: OpenObject;
  sensitivity: OpenObject;
  [extra: string]: unknown;
};

// ---------------------------------------------------------------------------
// atlas.change:v1
// ---------------------------------------------------------------------------

export type AtlasChange = {
  record_schema: "atlas.change:v1";
  /** Stable across redeliveries: delivery is at-least-once, so deduplicate on this. */
  change_id: string;
  seq: number;
  feed_epoch: string;
  recorded_at: RecordedAt;
  change_kind: OpenEnum<"assertion-committed" | "assertion-superseded" | "entity-registered" | "other">;
  assertion_id?: string;
  entity_id?: string;
  submission_id?: string;
  /** Present only when `include_records` was asked for. A withheld one is a stub. */
  record?: AtlasAssertion | AtlasRedaction;
};

export const CHANGE_KEYS = {
  record_schema: true,
  change_id: true,
  seq: true,
  feed_epoch: true,
  recorded_at: true,
  change_kind: true,
  assertion_id: true,
  entity_id: true,
  submission_id: true,
  record: true
} satisfies KeyManifest<AtlasChange>;

export const CHANGE_REQUIRED = {
  record_schema: true,
  change_id: true,
  seq: true,
  feed_epoch: true,
  recorded_at: true,
  change_kind: true
} satisfies RequiredKeyManifest<AtlasChange>;

/** Every record schema this contract publishes. */
export type AtlasRecord = AtlasAssertion | AtlasEntity | AtlasRedaction | AtlasErrorRecord | AtlasHorizon | AtlasChange;

/** A row that may have arrived as content or as a stub. Check before reading either. */
export type AtlasAssertionRow = AtlasAssertion | AtlasRedaction | AtlasErrorRecord;
export type AtlasEntityRow = AtlasEntity | AtlasRedaction | AtlasErrorRecord;

/** True when a row arrived as a stub rather than as content. */
export function isRedaction(record: { record_schema?: unknown }): record is AtlasRedaction {
  return record.record_schema === ("atlas.redaction:v1" satisfies RecordSchemaName);
}

/** True when a row is a typed refusal rather than a record. */
export function isErrorRecord(record: { record_schema?: unknown }): record is AtlasErrorRecord {
  return record.record_schema === ("atlas.error:v1" satisfies RecordSchemaName);
}

/** True when a row carries assertion content this credential was allowed to read. */
export function isAssertion(record: { record_schema?: unknown }): record is AtlasAssertion {
  return record.record_schema === ("atlas.assertion:v1" satisfies RecordSchemaName);
}

/** True when a row carries entity content this credential was allowed to read. */
export function isEntity(record: { record_schema?: unknown }): record is AtlasEntity {
  return record.record_schema === ("atlas.entity:v1" satisfies RecordSchemaName);
}

// ---------------------------------------------------------------------------
// the honesty blocks
// ---------------------------------------------------------------------------

/**
 * What was looked at, what matched, what came back, and what was withheld.
 *
 * `returned` is never bucketed — it is the length of an array the caller is
 * holding, and rounding it would produce a result that contradicts itself. The
 * others are, when the grant says `bucketed`, because an exact `withheld` is a
 * disclosure channel: repeated filter bisection against it localises a withheld
 * record without ever reading it.
 */
export type AtlasCoverage = {
  evaluated: number;
  matched: number;
  returned: number;
  withheld: number;
  with_valid_time: number;
  unknown_or_absent_valid_time: number;
  counts_basis: OpenEnum<"exact" | "bucketed">;
  bucket_width?: number;
};

export const COVERAGE_KEYS = {
  evaluated: true,
  matched: true,
  returned: true,
  withheld: true,
  with_valid_time: true,
  unknown_or_absent_valid_time: true,
  counts_basis: true,
  bucket_width: true
} satisfies KeyManifest<AtlasCoverage>;

export const COVERAGE_REQUIRED = {
  evaluated: true,
  matched: true,
  returned: true,
  withheld: true,
  with_valid_time: true,
  unknown_or_absent_valid_time: true,
  counts_basis: true
} satisfies RequiredKeyManifest<AtlasCoverage>;

export type AtlasCache = {
  ttl_ms: number;
  cache_scope: OpenEnum<"private" | "public">;
};

export const CACHE_KEYS = { ttl_ms: true, cache_scope: true } satisfies KeyManifest<AtlasCache>;
export const CACHE_REQUIRED = { ttl_ms: true, cache_scope: true } satisfies RequiredKeyManifest<AtlasCache>;

/**
 * A page, and the snapshot pin that makes page 2..N mean anything.
 *
 * `cursor` and `snapshot` are echoed TOGETHER or not at all. A cursor without
 * its pin is answered against newer state, and the resulting sequence silently
 * skips and repeats rows — invisibly to the consumer, which is why the server
 * refuses the pair being split and why this client never sends one alone.
 */
export type AtlasPage = {
  page_size: number;
  has_more: boolean;
  cursor?: string | null;
  snapshot?: string;
  snapshot_expires_at?: RecordedAt;
  feed_handoff?: { tool: string; cursor_seq: number };
};

export const PAGE_KEYS = {
  page_size: true,
  has_more: true,
  cursor: true,
  snapshot: true,
  snapshot_expires_at: true,
  feed_handoff: true
} satisfies KeyManifest<AtlasPage>;

export const PAGE_REQUIRED = { page_size: true, has_more: true } satisfies RequiredKeyManifest<AtlasPage>;

export type AtlasSubmissionReceipt = {
  submission_id: string;
  client_id: string;
  idempotency_key: string;
  committed_at: RecordedAt;
  request_digest: string;
  assertion_ids: string[];
  state: OpenEnum<"committed" | "replayed" | "expired" | "other">;
};

export const SUBMISSION_RECEIPT_KEYS = {
  submission_id: true,
  client_id: true,
  idempotency_key: true,
  committed_at: true,
  request_digest: true,
  assertion_ids: true,
  state: true
} satisfies KeyManifest<AtlasSubmissionReceipt>;

export const SUBMISSION_RECEIPT_REQUIRED = {
  submission_id: true,
  client_id: true,
  idempotency_key: true,
  committed_at: true,
  request_digest: true,
  assertion_ids: true,
  state: true
} satisfies RequiredKeyManifest<AtlasSubmissionReceipt>;

export type AtlasSubmissionItemResult = {
  index: number;
  outcome: OpenEnum<"committed" | "replayed" | "refused" | "other">;
  assertion_id?: string;
  seq?: number;
  claim_digest?: string;
  error?: AtlasErrorRecord;
};

export const SUBMISSION_ITEM_RESULT_KEYS = {
  index: true,
  outcome: true,
  assertion_id: true,
  seq: true,
  claim_digest: true,
  error: true
} satisfies KeyManifest<AtlasSubmissionItemResult>;

export const SUBMISSION_ITEM_RESULT_REQUIRED = {
  index: true,
  outcome: true
} satisfies RequiredKeyManifest<AtlasSubmissionItemResult>;

/** The in-band escalation form, for a client with no multi-round-trip support. */
export type AtlasRevealInputRequest = {
  request_id: string;
  request_state: string;
  expires_at: RecordedAt;
  prompt: string;
  required_capabilities?: string[];
};

export const REVEAL_INPUT_REQUEST_KEYS = {
  request_id: true,
  request_state: true,
  expires_at: true,
  prompt: true,
  required_capabilities: true
} satisfies KeyManifest<AtlasRevealInputRequest>;

export const REVEAL_INPUT_REQUEST_REQUIRED = {
  request_id: true,
  request_state: true,
  expires_at: true,
  prompt: true
} satisfies RequiredKeyManifest<AtlasRevealInputRequest>;

/** The receipt for the one audit event a reveal attempt always writes. */
export type AtlasAuditReceipt = { event_id: string; recorded_at: RecordedAt };

/** A group of live assertions on one FUNCTIONAL key. Atlas reports it; it does not pick. */
export type AtlasContestedGroup = {
  subject_entity_id: string;
  predicate: string;
  cardinality: OpenEnum<"functional" | "multi-valued" | "other">;
  functional_key?: string[];
  assertion_ids: string[];
  claim_digests?: string[];
};

export const CONTESTED_GROUP_KEYS = {
  subject_entity_id: true,
  predicate: true,
  cardinality: true,
  functional_key: true,
  assertion_ids: true,
  claim_digests: true
} satisfies KeyManifest<AtlasContestedGroup>;

export const CONTESTED_GROUP_REQUIRED = {
  subject_entity_id: true,
  predicate: true,
  cardinality: true,
  assertion_ids: true
} satisfies RequiredKeyManifest<AtlasContestedGroup>;

/** An id whose content compaction reclaimed. It existed; it is no longer retained. */
export type AtlasReclamationNote = {
  seq: number;
  reclaimed_at: RecordedAt;
  reclaimed_from_segment: number;
};

export const RECLAMATION_NOTE_KEYS = {
  seq: true,
  reclaimed_at: true,
  reclaimed_from_segment: true
} satisfies KeyManifest<AtlasReclamationNote>;

export const RECLAMATION_NOTE_REQUIRED = {
  seq: true,
  reclaimed_at: true,
  reclaimed_from_segment: true
} satisfies RequiredKeyManifest<AtlasReclamationNote>;

/**
 * The `$defs` in `common.output.json` this file describes, with both manifests.
 *
 * A table rather than a check per call site, so a `$def` ADDED to the common
 * document with no type here is a parity failure. A shared shape nothing
 * describes is the one every consumer ends up guessing at separately.
 */
export const COMMON_OUTPUT_KEY_MANIFESTS: Readonly<
  Record<string, { keys: Readonly<Record<string, true>>; required: Readonly<Record<string, true>> }>
> = {
  coverage: { keys: COVERAGE_KEYS, required: COVERAGE_REQUIRED },
  cache: { keys: CACHE_KEYS, required: CACHE_REQUIRED },
  page: { keys: PAGE_KEYS, required: PAGE_REQUIRED },
  submission_receipt: { keys: SUBMISSION_RECEIPT_KEYS, required: SUBMISSION_RECEIPT_REQUIRED },
  submission_item_result: { keys: SUBMISSION_ITEM_RESULT_KEYS, required: SUBMISSION_ITEM_RESULT_REQUIRED },
  reveal_input_request: { keys: REVEAL_INPUT_REQUEST_KEYS, required: REVEAL_INPUT_REQUEST_REQUIRED },
  contested_group: { keys: CONTESTED_GROUP_KEYS, required: CONTESTED_GROUP_REQUIRED },
  reclamation_note: { keys: RECLAMATION_NOTE_KEYS, required: RECLAMATION_NOTE_REQUIRED }
};

/**
 * Common `$defs` deliberately NOT typed here, and why.
 *
 * A required record rather than an omission: a shape quietly left undescribed is
 * indistinguishable from one that was described and agreed. Every entry below is
 * either a scalar alias (a `$def` that exists to name a string format once) or a
 * leaf the client passes through without branching on it.
 */
export const COMMON_OUTPUT_NOT_TYPED: Readonly<Record<string, string>> = {
  recorded_at: "A scalar alias for the belief-time string. Typed as `RecordedAt`.",
  world_time_point: "A scalar alias. World time is passed through, never parsed by this client.",
  world_time_probe: "A scalar alias for the as-of probe. Passed through.",
  assertion_id: "A scalar alias. Ids are minted, never derived, so a client only ever echoes them.",
  entity_id: "A scalar alias, same reason as assertion_id.",
  submission_id: "A scalar alias, same reason as assertion_id.",
  opaque_reference: "A scalar alias, and opaque by name: parsing it would be the defect.",
  predicate: "A scalar alias over an OPEN vocabulary; the live set comes from atlas.contract.describe.v1.",
  claim_digest: "A scalar alias. A dedup hint, never an identity, so a client compares it and nothing more.",
  valid_time_fidelity: "A scalar enum alias, carried on the assertion record.",
  match_quality: "A scalar enum alias, carried on the assertion record.",
  confidence: "A leaf on the assertion record over an open band vocabulary; typed as OpenObject there.",
  evidence_link: "A leaf on the assertion record; typed as OpenObject there.",
  sensitivity: "A leaf over an OPEN tier set; freezing it here would make a new tier a client-side failure.",
  provenance: "A leaf on the assertion and entity records; typed as OpenObject there."
};

/** The record documents this file freezes a key set for. */
export const RECORD_KEY_MANIFESTS: Readonly<
  Partial<Record<RecordSchemaName, { keys: Readonly<Record<string, true>>; required: Readonly<Record<string, true>> }>>
> = {
  "atlas.horizon:v1": { keys: HORIZON_KEYS, required: HORIZON_REQUIRED },
  "atlas.error:v1": { keys: ERROR_KEYS, required: ERROR_REQUIRED },
  "atlas.change:v1": { keys: CHANGE_KEYS, required: CHANGE_REQUIRED }
};

/**
 * Record documents deliberately NOT key-manifested, and why.
 *
 * All three are open at the top level in the published schema too — they carry
 * graph vocabulary a client must not freeze — so they are typed with an index
 * signature, and an index signature makes `keyof T` unusable as a manifest. The
 * runtime validator still checks each of them in full on every call; what is
 * given up is the compile-time half, and only for the three documents where the
 * compile-time half would have been wrong.
 */
export const RECORDS_NOT_KEY_MANIFESTED: Readonly<Partial<Record<RecordSchemaName, string>>> = {
  "atlas.assertion:v1":
    "Carries an open predicate vocabulary and open sensitivity tiers. The client names the members a consumer branches on and leaves the document open.",
  "atlas.entity:v1":
    "Two-layer typing: a frozen `type` beside an open `type_label` the graph grows. Freezing the key set here would make a new label a client-side failure.",
  "atlas.redaction:v1":
    "A stub's fields depend on why the record was withheld, and a new reason is exactly the case a consumer must still be able to display."
};

/** The tools this package exposes as methods. Re-exported so callers need not reach past it. */
export type AtlasToolName = ContractToolName;
