import type { ClosureGateResult } from "./closure-gate.js";
import type { ProjectionPlan, SourceOutcome } from "./projection.js";

function pad(label: string, width = 34): string {
  return label.length >= width ? `${label} ` : label.padEnd(width, " ");
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ["", title, ...lines];
}

function refusedOutcomes(outcomes: SourceOutcome[]): Map<string, string[]> {
  const byReason = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (outcome.disposition.kind !== "refused") {
      continue;
    }
    const bucket = byReason.get(outcome.disposition.reason) ?? [];
    bucket.push(outcome.legacy_object_id);
    byReason.set(outcome.disposition.reason, bucket);
  }
  for (const bucket of byReason.values()) {
    bucket.sort();
  }
  return byReason;
}

/**
 * The plan report is the review surface for a migration, so it is deliberately
 * content-free: ids, types and counts only. Printing names or payload text would
 * put personal graph content into whatever file or terminal the review happens
 * in, and a dry-run artifact is the last place that should hold plaintext.
 */
export function renderProjectionPlanReport(plan: ProjectionPlan, gate?: ClosureGateResult): string {
  const breakdown = plan.breakdown;
  const closed = breakdown.projected_count + breakdown.refused_count === plan.source_object_count;

  const lines: string[] = [
    plan.plan_schema,
    `authority        ${plan.authority_id}`,
    `projector        ${plan.projector_version}`,
    `plan-digest      ${plan.plan_digest}`,
    "",
    "closure",
    `  ${pad("source objects")}${plan.source_object_count}`,
    `  ${pad("projected")}${breakdown.projected_count}`,
    `  ${pad("refused (named reason)")}${breakdown.refused_count}`,
    `  ${pad("closed")}${closed ? "yes" : "NO"}`
  ];

  lines.push(
    ...section(
      "by-category",
      breakdown.by_category.map((entry) => `  ${pad(entry.category)}${entry.count}`)
    )
  );
  lines.push(
    ...section(
      "by-disposition",
      breakdown.by_disposition.map((entry) => `  ${pad(entry.disposition)}${entry.count}`)
    )
  );
  lines.push(
    ...section(
      "projected-records",
      breakdown.records_by_kind.map((entry) => `  ${pad(entry.record_kind)}${entry.count}`)
    )
  );

  const refusals = refusedOutcomes(plan.outcomes);
  const refusalLines: string[] = [];
  for (const entry of breakdown.refusals_by_reason) {
    refusalLines.push(`  ${pad(entry.reason)}${entry.count}`);
    for (const legacyObjectId of refusals.get(entry.reason) ?? []) {
      refusalLines.push(`    ${legacyObjectId}`);
    }
  }
  lines.push(...section("refusals", refusalLines));

  lines.push(
    ...section("derived-from-attributes", [
      `  ${pad("entities minted")}${breakdown.entities_minted_from_attributes}`,
      `  ${pad("relationships derived")}${breakdown.relationships_derived_from_attributes}`
    ].filter(() => breakdown.entities_minted_from_attributes + breakdown.relationships_derived_from_attributes > 0))
  );

  /**
   * WHAT THIS RUN DEFERRED, PRINTED WHETHER OR NOT IT DEFERRED ANYTHING.
   *
   * Unconditional, unlike every other section here, and the zero is the reason.
   * An absent section reads as "not measured"; `carried 0` reads as "nothing was
   * deferred in this run", which is the sentence a reviewer needs in order to
   * notice the run where it stops being zero.
   *
   * The owner accepted a stated risk to carry the outline blocks now and model
   * them later — that an unmodelled record type tends to stay unmodelled. This
   * line, plus the closure-gate finding, is what that acceptance is held to: the
   * deferral is a number on the review surface of every run.
   */
  const unmodelledTotal = breakdown.unmodelled_records.reduce((total, entry) => total + entry.count, 0);
  lines.push(
    "",
    "unmodelled-records",
    `  ${pad("carried (no contract, no revision)")}${unmodelledTotal}`,
    ...breakdown.unmodelled_records.map((entry) => `  ${pad(entry.record_kind)}${entry.count}`)
  );

  /**
   * The three vocabularies as three populations. Label uniqueness is scoped per
   * scheme, so an operator reading a homonym finding needs to know which schemes
   * exist and how big each is; one flat topic count cannot answer that, and a
   * scheme that appears or vanishes between dry runs shows up here before any
   * finding fires.
   */
  lines.push(
    ...section(
      "topic-schemes",
      breakdown.topic_nodes_by_scheme.map((entry) => `  ${pad(entry.scheme)}${entry.count}`)
    )
  );

  /**
   * The two aggregates a reviewer reads FIRST, before the per-object rows.
   *
   * `attributes-without-a-contract-slot` is where the frozen-revision gap shows
   * up as a number: the ratified table keeps `mode` as an attribute and the
   * 2026.08.1 occurrence endpoint declares no key for one, so the count is the
   * size of the contract change that closes it. `travel-endpoint-coverage` is
   * the control on the rule that nothing is synthesised — gate G3 measured the
   * shapes disjoint and incomplete, and a `none` row that fell to zero would
   * mean a leg had been given an origin nobody recorded.
   *
   * Both are printed even though every underlying row is also enumerated below:
   * a queue of hundreds of rows is not a number anybody checks.
   */
  const attributeSlotGaps = new Map<string, number>();
  for (const item of plan.hand_review) {
    if (item.reason === "no-contract-slot") {
      attributeSlotGaps.set(item.attribute, (attributeSlotGaps.get(item.attribute) ?? 0) + 1);
    }
  }
  lines.push(
    ...section(
      "attributes-without-a-contract-slot",
      [...attributeSlotGaps.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([attribute, count]) => `  ${pad(attribute)}${count}`)
    )
  );
  lines.push(
    ...section(
      "travel-endpoint-coverage",
      breakdown.travel_endpoint_coverage.map((entry) => `  ${pad(entry.coverage)}${entry.count}`)
    )
  );

  // Attributes nobody could place. Ids and reasons only: naming the VALUE would
  // put the very content a reviewer is deciding about into the report file.
  const handReviewLines: string[] = [];
  for (const entry of breakdown.hand_review_by_reason) {
    handReviewLines.push(`  ${pad(entry.reason)}${entry.count}`);
    for (const item of plan.hand_review.filter((candidate) => candidate.reason === entry.reason)) {
      handReviewLines.push(`    ${item.legacy_object_id} ${item.attribute}`);
    }
  }
  lines.push(...section("hand-review", handReviewLines));

  const aliasRows = plan.outcomes.length;
  const aliasRedirects = plan.outcomes.filter((outcome) => outcome.alias_target.kind === "record").length;
  const aliasSplits = breakdown.legacy_ids_split;
  lines.push(
    "",
    "alias-ledger",
    `  ${pad("rows planned")}${aliasRows}`,
    `  ${pad("redirects to a new record")}${aliasRedirects}`,
    `  ${pad("ambiguous splits (no primary)")}${aliasSplits}`,
    `  ${pad("no-target rows")}${aliasRows - aliasRedirects - aliasSplits}`
  );

  if (gate) {
    lines.push("", "closure-gate", `  ${pad("verdict")}${gate.ok ? "pass" : "FAIL"}`);
    for (const item of gate.findings) {
      // The severity travels with every finding, so a `pass` verdict printed
      // above a list of findings reads as what it is rather than as a
      // contradiction the reader has to resolve by knowing the codes.
      lines.push(`  ${pad(`${item.code} [${item.severity}]`)}${item.subject_count}`);
      lines.push(`    ${item.detail}`);
      for (const subject of item.subjects) {
        lines.push(`      ${subject}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
