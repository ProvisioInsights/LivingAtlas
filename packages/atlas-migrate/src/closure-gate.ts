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
  const breakdown = recomputeProjectionBreakdown(plan.outcomes, plan.records);

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
 * Two minted nodes for one value is the defect the whole change exists to
 * prevent: the topic set IS the controlled vocabulary, and a duplicate splits
 * one concept into two that no query will ever rejoin.
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

  const seenValues = new Map<string, number>();
  for (const record of minted) {
    seenValues.set(record.minted_basis.legacy_value, (seenValues.get(record.minted_basis.legacy_value) ?? 0) + 1);
  }
  const duplicated = [...seenValues.entries()].filter(([, count]) => count > 1).map(([value]) => value);
  if (duplicated.length > 0) {
    findings.push(
      finding(
        "duplicate-minted-topic",
        "a retired value minted more than one topic node; the controlled vocabulary would hold two nodes for one concept",
        duplicated
      )
    );
  }

  return findings;
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
  // Minted entities are excluded because no outcome CAN claim them: they are
  // shared by every node that carried the value. `checkMintedRecords` holds them
  // to the plan-level claim instead, so they are checked once, not never.
  const unclaimed = records
    .filter((record) => !isMintedEntityRecord(record))
    .map((record) => record.idempotency_key)
    .filter((key) => !claimed.has(key));

  const accountingProblems = [...claimedTwice, ...claimedMissing, ...unclaimed];
  if (accountingProblems.length > 0) {
    findings.push(
      finding(
        "record-not-accounted",
        "every projected record must be claimed by exactly one source outcome",
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

  const brokenTargets = outcomes
    .filter((outcome) => outcome.alias_target.kind === "record" && !recordKeys.has(outcome.alias_target.record_key))
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
