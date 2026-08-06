import { CONTRACT_LIMITS, type RecordSchemaName } from "./revision.js";

/**
 * One synthetic sample per published record schema.
 *
 * Entirely invented: neutral names, minted-shaped but fabricated ids, no graph
 * contents. These exist so that "the schema is valid JSON Schema" and "the
 * schema accepts the records Atlas actually returns" are two separate,
 * separately-failing assertions — a schema can be perfectly well-formed and
 * still describe a record shape nothing produces.
 */

const RECORDED_AT = "2026-08-04T12:00:00.000Z";
const LATER = "2026-08-04T12:30:00.000Z";
const ENTITY_A = "la_entity_01k3zj9m00abcdefghjkmnpqrs";
const ENTITY_B = "la_entity_01k3zj9m01abcdefghjkmnpqrs";
const ASSERTION_A = "la_assertion_01k3zj9m02abcdefghjkmnpqrs";
const ASSERTION_B = "la_assertion_01k3zj9m03abcdefghjkmnpqrs";
const SUBMISSION_A = "la_submission_01k3zj9m04abcdefghjkmnpqrs";
const DIGEST = `sha256:${"ab12cd34".repeat(8)}`;

export const RECORD_SAMPLES: Record<RecordSchemaName, unknown> = {
  "atlas.assertion:v1": {
    record_schema: "atlas.assertion:v1",
    assertion_id: ASSERTION_A,
    seq: 42,
    feed_epoch: "e1",
    kind: "relationship",
    lineage_action: "assert",
    subject_entity_id: ENTITY_A,
    predicate: "employed-by",
    target_entity_id: ENTITY_B,
    value: null,
    // Approximate on the world axis, so any as-of match is `possible` and never
    // `certain` — the sample carries the case the prior store got wrong by
    // stripping the "~" before comparing.
    valid_from: { kind: "approximate", value: "2019" },
    valid_to: { kind: "unknown" },
    recorded_at: RECORDED_AT,
    superseded_at: null,
    superseded_by: null,
    supersedes: [],
    claim_digest: DIGEST,
    provenance: {
      client_id: "fixture-consumer",
      origin: "consumer-proposed",
      recorded_at_fidelity: "authoritative"
    },
    confidence: { band: "medium", rationale: "single corroborating document" },
    evidence_links: [{ evidence_id: "fixture-evidence-1", stance: "supports" }],
    sensitivity: { tier: "open", rank: 0, withheld: false },
    valid_time_fidelity: "approximate",
    match_quality: "possible"
  },

  "atlas.entity:v1": {
    record_schema: "atlas.entity:v1",
    entity_id: ENTITY_A,
    type: "organization",
    display_name: "Northwind Cooperative",
    also_known_as: ["Northwind"],
    registered_at: RECORDED_AT,
    updated_at: LATER,
    provenance: {
      client_id: "fixture-importer",
      origin: "pre-contract-import",
      recorded_at_fidelity: "import-artifact",
      basis: "synthetic fixture"
    },
    // Entities default to local-private: an entity record holds the names, which
    // makes it the most identifying record in the graph.
    sensitivity: { tier: "local-private", rank: 10, withheld: false }
  },

  "atlas.redaction:v1": {
    record_schema: "atlas.redaction:v1",
    redaction_id: "fixture-redaction-1",
    withheld_record_schema: "atlas.assertion:v1",
    disclosure_level: "shape",
    sensitivity: { tier: "escalated", rank: 40, withheld: true },
    reason_code: "sensitivity-withheld",
    reveal_available: true,
    reveal_tool: "atlas.sensitive.reveal.v1",
    seq: 43
  },

  "atlas.error:v1": {
    record_schema: "atlas.error:v1",
    code: "as-of-before-history-floor",
    message:
      "Atlas retains no belief-time history before 2026-08-01T00:00:00.000Z. Refused rather than answered from present state.",
    retryable: false,
    remedy: {
      tool: "atlas.contract.describe.v1",
      note: "history.bitemporal_since names the earliest answerable belief instant"
    },
    details: { bitemporal_since: "2026-08-01T00:00:00.000Z" }
  },

  "atlas.horizon:v1": {
    record_schema: "atlas.horizon:v1",
    status: "partial",
    bitemporal_since: "2026-08-01T00:00:00.000Z",
    feed_epoch: "e1",
    seq_watermark: 512,
    as_of_recorded: RECORDED_AT,
    as_of_valid: "2019",
    recorded_at_fidelity_mixed: true,
    retention_floor_seq: 0,
    migration_window_open: false
  },

  "atlas.change:v1": {
    record_schema: "atlas.change:v1",
    change_id: "fixture-change-1",
    seq: 42,
    feed_epoch: "e1",
    recorded_at: RECORDED_AT,
    change_kind: "assertion-superseded",
    assertion_id: ASSERTION_B,
    submission_id: SUBMISSION_A,
    record: {
      record_schema: "atlas.redaction:v1",
      redaction_id: "fixture-redaction-2",
      withheld_record_schema: "atlas.assertion:v1",
      disclosure_level: "existence-only",
      sensitivity: { tier: "escalated", rank: 40, withheld: true },
      reason_code: "sensitivity-withheld",
      reveal_available: false
    }
  }
};

/**
 * A minimal, valid argument object per tool — the smallest call that should be
 * accepted. Used to prove the input schemas admit the calls they document, not
 * only that they reject malformed ones.
 */
export const TOOL_INPUT_SAMPLES: Record<string, unknown> = {
  "atlas.contract.describe.v1": {},
  "atlas.scope.describe.v1": {},
  "atlas.entity.resolve.v1": { ids: ["legacy-object-0001", ENTITY_A] },
  "atlas.entity.read.v1": { entity_ids: [ENTITY_A] },
  // The published default, read rather than restated: a sample that quotes a
  // cap by writing the number down is a second copy of that cap, and it is the
  // copy a reader trusts because it looks like a worked example.
  "atlas.assertion.query.v1": { full_scan: true, page_size: CONTRACT_LIMITS.default_page_size },
  "atlas.assertion.read.v1": { assertion_ids: [ASSERTION_A], include_lineage: true },
  "atlas.graph.neighbors.v1": { entity_id: ENTITY_A, direction: "both", max_depth: 2 },
  "atlas.text.search.v1": { query: "cooperative" },
  "atlas.changes.read.v1": { cursor_seq: 0, feed_epoch: "e1", limit: 100 },
  "atlas.assertion.propose.v1": {
    idempotency_key: "fixture-key-1",
    proposals: [
      {
        kind: "fact",
        subject_entity_id: ENTITY_A,
        predicate: "based-in",
        value: "synthetic-locality",
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "fixture-evidence-2", stance: "supports" }]
      }
    ]
  },
  "atlas.submission.read.v1": { idempotency_key: "fixture-key-1" },
  "atlas.sensitive.reveal.v1": {
    redaction_id: "fixture-redaction-1",
    reason: "reviewing an escalated claim before answering the owner"
  }
};
