import { z } from "zod";
import { AssertionIdSchema, ClaimDigestSchema, EntityIdSchema } from "./ids.js";
import { RecordedAtSchema, WorldTimePointSchema } from "./time.js";

/**
 * The unit of the contract is an immutable ASSERTION: one statement, one
 * learning event, never edited in place. Corrections and retractions are new
 * assertions that point back at what they supersede.
 *
 * That single choice is what makes bitemporality an invariant rather than a
 * storage engine. The old store kept `Map<ObjectId, Envelope>` and overwrote on
 * every mutation, so 169,205 mutations left zero recoverable prior states —
 * "one envelope per id" is fatal for mutable records and irrelevant for
 * immutable ones.
 */

/**
 * Every closed enum ships a reserved `other` member at v1.
 *
 * Adding a member to an output enum is a breaking change for a strict consumer,
 * so without an escape hatch Atlas could never introduce a new kind of record
 * without a major version. With one, a 2026 consumer receiving a 2031 record
 * sees `kind: "other"` plus an unrecognised `record_schema` and knows precisely
 * that it is looking at something it does not understand — rather than silently
 * misreading it as a fact.
 */
export const AssertionKindSchema = z.enum(["fact", "relationship", "observation", "other"]);

/**
 * The five lineage actions, given normative meaning. The distinction between
 * `retract` and `invalidate` is the one that matters most and the one nothing
 * in the old store expressed: a tombstone was a boolean with no actor, no
 * reason and no restore path.
 *
 *  - `assert`     — a new claim.
 *  - `correct`    — the prior claim was recorded wrongly; both stay readable.
 *  - `retract`    — BELIEF error: "we should never have said this."
 *                   World time is untouched, because the world did not change.
 *  - `invalidate` — WORLD change: "this was true and has stopped being true."
 *                   Typically also closes `valid_to`.
 *  - `reinstate`  — re-assert something previously retracted.
 */
export const LineageActionSchema = z.enum([
  "assert",
  "correct",
  "retract",
  "invalidate",
  "reinstate",
  "other"
]);

/**
 * Whether a lineage action AFFIRMS the relationship it names, for a reader that
 * has to decide "does this edge exist right now?".
 *
 * A traversal cannot answer that from `kind` alone, and assuming it can is a
 * defect this repository shipped: `atlas.graph.neighbors.v1` filtered on
 * `kind === "relationship"` and nothing else, so a RETRACTION — which is itself
 * a relationship assertion carrying the same subject, predicate and target,
 * because that is how supersession is expressed — was counted as an edge. The
 * effect was that a retraction removed a claim from `atlas.assertion.query.v1`
 * and left it standing in the traversal, with the audit trail and the graph
 * disagreeing and nothing to indicate it. Measured against the real graph.
 *
 * A total `Record` rather than a predicate with a default: a seventh lineage
 * action must fail to compile until somebody decides whether it asserts the
 * relationship, instead of silently inheriting whichever answer the `else`
 * branch happened to give.
 *
 *  - `assert`, `correct`, `reinstate` — the record IS the current claim.
 *  - `invalidate` — the relationship was true and stopped being true. It stays
 *    an edge because it carries the world-time interval in which it held, and
 *    excluding it would delete real history from an `as_of_valid` read. A
 *    caller asking about now is answered by valid-time filtering, not here.
 *  - `retract` — a BELIEF error, "we should never have said this". Never an edge
 *    at any world time, which is exactly what distinguishes it from
 *    `invalidate`.
 *  - `other` — the forward-compatibility escape hatch. Fail CLOSED: a reader
 *    that does not understand a lineage action must not present it as a live
 *    relationship, for the same reason `kind: "other"` exists — better to be
 *    visibly ignorant than to silently misread. It remains readable through
 *    `atlas.assertion.query.v1`, so nothing is hidden, only un-asserted.
 */
export const LINEAGE_ACTION_AFFIRMS_EDGE: Record<z.infer<typeof LineageActionSchema>, boolean> = {
  assert: true,
  correct: true,
  reinstate: true,
  invalidate: true,
  retract: false,
  other: false
};

export const ConfidenceBandSchema = z.enum(["high", "medium", "low", "other"]);

/**
 * `authoritative` — Atlas stamped `recorded_at` itself at commit, so belief-time
 * ordering is meaningful.
 *
 * `import-artifact` — the value came from an import run and reflects when a
 * file was processed, not when Atlas learned anything. Pre-cutover records
 * carry this forever. Belief-time ordering across the cutover is meaningless,
 * and every page that mixes the two must say so rather than letting a consumer
 * assume otherwise.
 */
export const RecordedAtFidelitySchema = z.enum(["authoritative", "import-artifact"]);

export const SensitivitySchema = z.object({
  /** Open string plus a rank, so a new tier in 2032 is additive. */
  tier: z.string(),
  rank: z.number().int().nonnegative(),
  /** Consumers branch on this closed boolean, never on the tier name. */
  withheld: z.boolean()
}).strict();

/**
 * The tier an assertion lands at when nothing classified it.
 *
 * AGENTS.md: "Default new content to `local-private` unless explicitly
 * classified otherwise." An assertion is new content and the published
 * `atlas.assertion.propose.v1` input carries no tier, so a consumer submission
 * is by construction unclassified — which makes this default, not a per-call
 * argument, the whole of the rule for the consumer plane.
 *
 * Matches `DEFAULT_ENTITY_SENSITIVITY` in `entity.ts` deliberately: the same
 * sentence in AGENTS.md governs both, and two defaults for one rule is how the
 * two halves of the graph end up classified differently for no stated reason.
 * `rank` orders tiers so a consumer compares rather than string-matches; `open`
 * is 0. `withheld` is false because withholding is a decision a projection
 * makes per reader, not a property the log can know.
 */
export const DEFAULT_ASSERTION_SENSITIVITY = {
  tier: "local-private",
  rank: 10,
  withheld: false
} as const;

export const ProvenanceSchema = z.object({
  /**
   * Set by Atlas from the authenticated credential — a consumer can neither
   * supply nor spoof it. The old server unconditionally replaced any
   * caller-supplied credential with the daemon's own env token, collapsing
   * every consumer to one identity and making attribution impossible.
   */
  client_id: z.string(),
  origin: z.enum(["consumer-proposed", "owner-authored", "pre-contract-import", "other"]),
  recorded_at_fidelity: RecordedAtFidelitySchema,
  /** Advisory only. NOT a time axis — see `recorded_at`. */
  proposed_at: z.string().optional(),
  basis: z.string().optional()
}).strict();

export const EvidenceLinkSchema = z.object({
  evidence_id: z.string(),
  stance: z.enum(["supports", "contradicts", "context", "other"])
}).strict();

export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type Sensitivity = z.infer<typeof SensitivitySchema>;
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

/**
 * A committed assertion. Immutable except for the single write-once
 * `superseded_at` stamp, which is the one mutation the store permits and the
 * only reason it is not purely append-only.
 */
export const AssertionSchema = z.object({
  /** Frozen literal so a record is self-describing when logged or replayed. */
  record_schema: z.literal("atlas.assertion:v1"),

  assertion_id: AssertionIdSchema,

  /**
   * Change-feed position: per-assertion, monotone, gapless within a
   * `feed_epoch`. Deliberately NOT the old `generation`, which stamped one
   * value across every event in a transaction — a cursor could not resume
   * mid-submission because 1,000 changes shared one number.
   */
  seq: z.number().int().positive(),
  feed_epoch: z.string(),

  kind: AssertionKindSchema,
  lineage_action: LineageActionSchema,

  subject_entity_id: EntityIdSchema,
  predicate: z.string().min(1),
  value: z.unknown().optional(),
  target_entity_id: EntityIdSchema.optional(),

  // ---- world time (when it was true) ----
  valid_from: WorldTimePointSchema.optional(),
  valid_to: WorldTimePointSchema.optional(),

  // ---- belief time (when Atlas learned it) ----
  /** Assigned by Atlas AT COMMIT. Never accepted from a caller. */
  recorded_at: RecordedAtSchema,
  /**
   * Write-once: `null` until something supersedes this, then an instant,
   * never back to null and never changed again.
   */
  superseded_at: RecordedAtSchema.nullable(),
  superseded_by: AssertionIdSchema.nullable(),

  /** Required whenever `lineage_action` is not `assert`. */
  supersedes: z.array(AssertionIdSchema),

  claim_digest: ClaimDigestSchema,
  provenance: ProvenanceSchema,
  confidence: z.object({ band: ConfidenceBandSchema, rationale: z.string().optional() }).strict(),
  evidence_links: z.array(EvidenceLinkSchema),
  sensitivity: SensitivitySchema
}).strict();

export type Assertion = z.infer<typeof AssertionSchema>;

/**
 * A caller's proposal. Note what is absent and cannot be supplied: `assertion_id`,
 * `seq`, `recorded_at`, `superseded_at`, `claim_digest`, and `provenance.client_id`.
 * Everything that carries authority is minted by Atlas.
 */
export const AssertionDraftSchema = z.object({
  kind: AssertionKindSchema,
  lineage_action: LineageActionSchema.default("assert"),
  subject_entity_id: EntityIdSchema,
  predicate: z.string().min(1),
  value: z.unknown().optional(),
  target_entity_id: EntityIdSchema.optional(),
  valid_from: WorldTimePointSchema.optional(),
  valid_to: WorldTimePointSchema.optional(),
  supersedes: z.array(AssertionIdSchema).default([]),
  confidence: z.object({ band: ConfidenceBandSchema, rationale: z.string().optional() }).strict(),
  evidence_links: z.array(EvidenceLinkSchema).min(1),
  proposed_at: z.string().optional(),
  basis: z.string().optional()
}).strict();

export type AssertionDraft = z.infer<typeof AssertionDraftSchema>;

/** Non-`assert` actions must name what they act on, or lineage is unresolvable. */
export function validateLineage(draft: AssertionDraft): void {
  if (draft.lineage_action !== "assert" && draft.supersedes.length === 0) {
    throw new Error(
      `lineage_action "${draft.lineage_action}" requires a non-empty supersedes[]`
    );
  }
}
