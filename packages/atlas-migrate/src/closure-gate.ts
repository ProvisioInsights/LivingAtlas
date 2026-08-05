import {
  projectionPlanDigest,
  recomputeProjectionBreakdown,
  type ProjectionBreakdown,
  type ProjectionPlan,
  type SourceOutcome
} from "./projection.js";
import {
  ProjectedRecordSchema,
  isEntityRecord,
  isMintedEntityRecord,
  isMintedRelationshipRecord,
  isProjectedFromLegacyObject,
  isRelationshipRecord,
  isRetractionRecord,
  slotMintedBy,
  type ProjectedRecord
} from "./target-plane.js";

/**
 * Findings are codes, not prose, so a gate failure is greppable and a new
 * failure mode cannot hide inside an existing message. Like every closed enum
 * here it carries "other", and a run that reports "other" is not certifiable.
 */
export const ClosureGateFindingCodeValues = [
  "closure-arithmetic-mismatch",
  "breakdown-mismatch",
  "plan-digest-mismatch",
  "invalid-record-shape",
  "unclassified-source-category",
  "unnamed-refusal-reason",
  "unnamed-source-disposition",
  "dangling-projected-endpoint",
  "retraction-target-missing",
  "duplicate-idempotency-key",
  "record-not-accounted",
  "minted-record-not-accounted",
  "duplicate-minted-topic",
  "alias-row-missing",
  "alias-target-missing-record",
  "other"
] as const;
export type ClosureGateFindingCode = (typeof ClosureGateFindingCodeValues)[number];

export type ClosureGateFinding = {
  code: ClosureGateFindingCode;
  detail: string;
  /** Legacy ids or record keys, truncated for report size but counted in full. */
  subjects: string[];
  subject_count: number;
};

export const ClosureGateSchemaName = "living-atlas-migration-closure-gate:v1" as const;

export type ClosureGateResult = {
  gate_schema: typeof ClosureGateSchemaName;
  ok: boolean;
  plan_digest: string;
  breakdown: ProjectionBreakdown;
  findings: ClosureGateFinding[];
};

const MaxReportedSubjects = 20;

function finding(code: ClosureGateFindingCode, detail: string, subjects: string[]): ClosureGateFinding {
  return {
    code,
    detail,
    subjects: subjects.slice(0, MaxReportedSubjects).sort(),
    subject_count: subjects.length
  };
}

/**
 * The whole point of the lane: for every source object,
 *
 *   count(source) == count(projected) + count(explicitly refused with a named reason)
 *
 * plus a dangling-endpoint check over what the projector actually produced. A
 * shape the author never mapped lands in "other" and FAILS here rather than
 * quietly disappearing between the two counts, because the failure mode this
 * gate exists to stop is a migration that reports success while leaving objects
 * behind with nobody to notice.
 */
export type ClosureGateOptions = {
  /**
   * Source count taken straight from the reader. Supplying it closes the last
   * gap: without it the gate can only compare the plan against itself, and a
   * source object lost between reading and planning would never be missed.
   */
  expected_source_object_count?: number;
};

export function evaluateClosureGate(plan: ProjectionPlan, options: ClosureGateOptions = {}): ClosureGateResult {
  const findings: ClosureGateFinding[] = [];
  const breakdown = recomputeProjectionBreakdown(plan.outcomes, plan.records, plan.hand_review);

  findings.push(...checkArithmetic(plan, breakdown, options));
  findings.push(...checkPlanIntegrity(plan));
  findings.push(...checkNamedCategories(plan.outcomes));
  findings.push(...checkRecordAccounting(plan.outcomes, plan.records));
  findings.push(...checkMintedRecords(plan));
  findings.push(...checkEndpointsResolve(plan.records));
  findings.push(...checkAliasRows(plan.outcomes, plan.records));

  return {
    gate_schema: ClosureGateSchemaName,
    ok: findings.length === 0,
    plan_digest: plan.plan_digest,
    breakdown,
    findings
  };
}

function checkArithmetic(
  plan: ProjectionPlan,
  breakdown: ProjectionBreakdown,
  options: ClosureGateOptions
): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  if (breakdown.projected_count + breakdown.refused_count !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `projected ${breakdown.projected_count} + refused ${breakdown.refused_count} != source ${plan.source_object_count}`,
        []
      )
    );
  }

  if (
    options.expected_source_object_count !== undefined &&
    options.expected_source_object_count !== plan.source_object_count
  ) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `plan counted ${plan.source_object_count} source objects, the reader counted ${options.expected_source_object_count}`,
        []
      )
    );
  }

  if (plan.breakdown.projected_count + plan.breakdown.refused_count !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        "the plan's own summary does not balance against its source count",
        []
      )
    );
  }

  const categoryTotal = breakdown.by_category.reduce((total, entry) => total + entry.count, 0);
  const dispositionTotal = breakdown.by_disposition.reduce((total, entry) => total + entry.count, 0);
  if (categoryTotal !== plan.source_object_count || dispositionTotal !== plan.source_object_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `per-category total ${categoryTotal} and per-disposition total ${dispositionTotal} must both equal source ${plan.source_object_count}`,
        []
      )
    );
  }

  const refusalTotal = breakdown.refusals_by_reason.reduce((total, entry) => total + entry.count, 0);
  if (refusalTotal !== breakdown.refused_count) {
    findings.push(
      finding(
        "closure-arithmetic-mismatch",
        `refusals by reason total ${refusalTotal} != refused ${breakdown.refused_count}`,
        []
      )
    );
  }

  // A plan that misreports its own numbers is as dangerous as one that loses
  // objects, so the gate recomputes instead of trusting the plan's summary.
  if (JSON.stringify(plan.breakdown) !== JSON.stringify(breakdown)) {
    findings.push(finding("breakdown-mismatch", "plan breakdown does not match a recount of its outcomes", []));
  }

  return findings;
}

/**
 * Binds the commit to the plan that was actually reviewed. A plan file edited by
 * hand between the dry run and the apply is the realistic way a reviewed
 * migration turns into a different one, and the record shapes are re-parsed for
 * the same reason: apply must never commit a record nobody validated.
 */
function checkPlanIntegrity(plan: ProjectionPlan): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  if (projectionPlanDigest(plan) !== plan.plan_digest) {
    findings.push(finding("plan-digest-mismatch", "plan content does not match the digest it carries", []));
  }

  const malformed = plan.records
    .filter((record) => !ProjectedRecordSchema.safeParse(record).success)
    .map((record) => String((record as { idempotency_key?: string }).idempotency_key ?? "<unkeyed>"));
  if (malformed.length > 0) {
    findings.push(finding("invalid-record-shape", "a projected record does not satisfy its schema", malformed));
  }

  return findings;
}

function checkNamedCategories(outcomes: SourceOutcome[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  const unclassified = outcomes
    .filter(
      (outcome) =>
        outcome.category === "other" ||
        (outcome.disposition.kind === "refused" && outcome.disposition.reason === "unclassified-source-category")
    )
    .map((outcome) => outcome.legacy_object_id);
  if (unclassified.length > 0) {
    findings.push(
      finding(
        "unclassified-source-category",
        "source objects landed in a category this projector never declared a mapping for",
        unclassified
      )
    );
  }

  const unnamedRefusals = outcomes
    .filter((outcome) => outcome.disposition.kind === "refused" && outcome.disposition.reason === "other")
    .map((outcome) => outcome.legacy_object_id);
  if (unnamedRefusals.length > 0) {
    findings.push(
      finding("unnamed-refusal-reason", "refusals must carry a named reason, not the enum escape hatch", unnamedRefusals)
    );
  }

  const unnamedDispositions = outcomes
    .filter((outcome) => outcome.disposition.kind === "other")
    .map((outcome) => outcome.legacy_object_id);
  if (unnamedDispositions.length > 0) {
    findings.push(
      finding(
        "unnamed-source-disposition",
        "source objects carry the disposition escape hatch instead of a declared disposition",
        unnamedDispositions
      )
    );
  }

  return findings;
}

/**
 * Minted records are owned by the PLAN, so they are checked against the plan's
 * own claim list rather than against the outcomes.
 *
 * Two failures matter here and they are different. A minted record nobody claims
 * is a node that would land in the plane with no reviewable reason for existing.
 * Two nodes for one word is the defect the whole change exists to prevent: the
 * topic set IS the controlled vocabulary, and a duplicate splits one concept
 * into two that no query will ever rejoin.
 */
function checkMintedRecords(plan: ProjectionPlan): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];
  const claimed = new Set(plan.minted_record_keys);
  const minted = plan.records.filter(isMintedEntityRecord);

  const unaccounted = [
    ...minted.filter((record) => !claimed.has(record.idempotency_key)).map((record) => record.idempotency_key),
    ...plan.minted_record_keys.filter((key) => !minted.some((record) => record.idempotency_key === key))
  ];
  if (unaccounted.length > 0) {
    findings.push(
      finding(
        "minted-record-not-accounted",
        "every minted record must be claimed by the plan's minted list, and every claim must name a minted record",
        unaccounted
      )
    );
  }

  findings.push(...checkTopicVocabulary(plan.records));

  return findings;
}

/**
 * ONE SLOT PER WORD, across every mechanism that can put a topic in the plane.
 *
 * Keyed on the normalised NAME rather than on `minted_basis.legacy_value`, and
 * read off every topic-typed record rather than off the minted ones alone. The
 * old check could only ever see `minted-entity` records, and two of those with
 * one value share a slot and an idempotency key — so `duplicate-idempotency-key`
 * fired first and this branch was unreachable in practice. Meanwhile the plan
 * had three other ways to produce a topic node: the subtype classifier mints
 * one, the derived-node registry creates one per occupation under the
 * `job_title` namespace, and the corpus itself may already hold a legacy topic
 * node with that name. Any two of the three landing on one word is exactly the
 * defect, and the guard could see none of them.
 *
 * This DOES fire on the pair ADR-0026 OPEN-14 ratified — a subtype topic and an
 * occupation topic spelled the same — and that is intended. OPEN-14 decided the
 * migration will not MERGE them on a string match; it did not decide the plan
 * should be certified for apply while holding them. The operator learns it on
 * the dry run, with the colliding words named, which is when curating one of
 * them is still cheap.
 */
function checkTopicVocabulary(records: ProjectedRecord[]): ClosureGateFinding[] {
  const slotsByName = new Map<string, Set<string>>();

  for (const record of records) {
    if (record.record_kind !== "entity" && record.record_kind !== "minted-entity") {
      continue;
    }
    if (record.entity_type !== "topic") {
      continue;
    }
    const name = record.name.trim().toLowerCase();
    const slots = slotsByName.get(name) ?? new Set<string>();
    slots.add(record.slot);
    slotsByName.set(name, slots);
  }

  const collided = [...slotsByName.entries()].filter(([, slots]) => slots.size > 1).map(([name]) => name);
  if (collided.length === 0) {
    return [];
  }

  return [
    finding(
      "duplicate-minted-topic",
      "one word holds more than one topic slot; the controlled vocabulary would carry two nodes for one concept",
      collided
    )
  ];
}

function checkRecordAccounting(outcomes: SourceOutcome[], records: ProjectedRecord[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];

  const seenKeys = new Set<string>();
  const duplicates: string[] = [];
  for (const record of records) {
    if (seenKeys.has(record.idempotency_key)) {
      duplicates.push(record.idempotency_key);
    }
    seenKeys.add(record.idempotency_key);
  }
  if (duplicates.length > 0) {
    findings.push(
      finding(
        "duplicate-idempotency-key",
        "two records share an idempotency key; apply would treat the second as a replay of the first",
        duplicates
      )
    );
  }

  const claimed = new Set<string>();
  const claimedTwice: string[] = [];
  const claimedMissing: string[] = [];
  for (const outcome of outcomes) {
    for (const key of outcome.record_keys) {
      if (claimed.has(key)) {
        claimedTwice.push(key);
      }
      claimed.add(key);
      if (!seenKeys.has(key)) {
        claimedMissing.push(key);
      }
    }
  }

  /**
   * A record is accounted for in exactly one of two ways, and which one is
   * readable off the record itself rather than off a list the plan asserts.
   *
   * A record PROJECTED from a legacy object must be claimed by that object's
   * outcome — that is the closure property. A node the migration MINTED has no
   * source object, so it must be claimed by NO outcome: a minted node appearing
   * in some object's record_keys would mean one arbitrary contributor had been
   * made to own a node shared by hundreds, and the shortfall would never show up
   * in the arithmetic.
   *
   * `isProjectedFromLegacyObject` answers this for both minted kinds at once —
   * the entity that has no provenance field and the derived node whose
   * provenance variant is `derived`. Minted entities remain checked, not
   * skipped: `checkMintedRecords` holds them to the plan-level claim, so they
   * are accounted for once rather than never.
   */
  const unclaimed = records
    .filter((record) => isProjectedFromLegacyObject(record))
    .map((record) => record.idempotency_key)
    .filter((key) => !claimed.has(key));
  const mintedButClaimed = records
    .filter((record) => !isProjectedFromLegacyObject(record))
    .map((record) => record.idempotency_key)
    .filter((key) => claimed.has(key));

  const accountingProblems = [...claimedTwice, ...claimedMissing, ...unclaimed, ...mintedButClaimed];
  if (accountingProblems.length > 0) {
    findings.push(
      finding(
        "record-not-accounted",
        "a projected record must be claimed by exactly one source outcome, and a minted node by none",
        accountingProblems
      )
    );
  }

  const retractionTargets = records
    .filter(isRetractionRecord)
    .filter((record) => !seenKeys.has(record.retracts_idempotency_key))
    .map((record) => record.idempotency_key);
  if (retractionTargets.length > 0) {
    findings.push(
      finding(
        "retraction-target-missing",
        "a retraction names a record this plan does not create; the deletion would apply to nothing",
        retractionTargets
      )
    );
  }

  return findings;
}

/**
 * Every relationship endpoint must resolve through the identity map that this
 * plan itself mints. The projector already refuses dangling edges, so a finding
 * here means the projector produced an edge it should have refused — which is
 * exactly the class of bug that put unreachable edges in the old store.
 */
function checkEndpointsResolve(records: ProjectedRecord[]): ClosureGateFinding[] {
  // Every slot the plan puts into the plane, imported or minted. Reading only
  // the imported ones would report every `has-type` edge as dangling, because
  // its target slot is by definition one this plan minted rather than imported.
  const mintedSlots = new Set<string>(
    records.map(slotMintedBy).filter((slot): slot is string => slot !== undefined)
  );

  const dangling = [...records.filter(isRelationshipRecord), ...records.filter(isMintedRelationshipRecord)]
    .filter((record) => !mintedSlots.has(record.source_slot) || !mintedSlots.has(record.target_slot))
    .map((record) => record.idempotency_key);

  if (dangling.length === 0) {
    return [];
  }

  return [
    finding(
      "dangling-projected-endpoint",
      "a projected relationship names an entity slot that this plan does not mint",
      dangling
    )
  ];
}

function checkAliasRows(outcomes: SourceOutcome[], records: ProjectedRecord[]): ClosureGateFinding[] {
  const findings: ClosureGateFinding[] = [];
  const recordKeys = new Set(records.map((record) => record.idempotency_key));

  const missingAliasTargets = outcomes
    .filter((outcome) => outcome.alias_target === undefined)
    .map((outcome) => outcome.legacy_object_id);
  if (missingAliasTargets.length > 0) {
    findings.push(
      finding(
        "alias-row-missing",
        "every legacy id must plan an alias row, including the ids that carried nothing across",
        missingAliasTargets
      )
    );
  }

  // A split names candidates instead of a target, and EVERY candidate has to
  // exist. A split with one reachable candidate is worse than a plain redirect:
  // it tells a caller the id is ambiguous and then hands them a list they cannot
  // fully resolve.
  const brokenTargets = outcomes
    .filter((outcome) => {
      if (outcome.alias_target.kind === "record") {
        return !recordKeys.has(outcome.alias_target.record_key);
      }
      if (outcome.alias_target.kind === "ambiguous-split") {
        return outcome.alias_target.candidates.some((candidate) => !recordKeys.has(candidate.record_key));
      }
      return false;
    })
    .map((outcome) => outcome.legacy_object_id);
  if (brokenTargets.length > 0) {
    findings.push(
      finding(
        "alias-target-missing-record",
        "an alias row points at a record this plan does not create",
        brokenTargets
      )
    );
  }

  return findings;
}
