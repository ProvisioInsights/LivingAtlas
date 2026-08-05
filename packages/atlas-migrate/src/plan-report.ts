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

  const aliasRows = plan.outcomes.length;
  const aliasRedirects = plan.outcomes.filter((outcome) => outcome.alias_target.kind === "record").length;
  lines.push(
    "",
    "alias-ledger",
    `  ${pad("rows planned")}${aliasRows}`,
    `  ${pad("redirects to a new record")}${aliasRedirects}`,
    `  ${pad("no-target rows")}${aliasRows - aliasRedirects}`
  );

  if (gate) {
    lines.push("", "closure-gate", `  ${pad("verdict")}${gate.ok ? "pass" : "FAIL"}`);
    for (const item of gate.findings) {
      lines.push(`  ${pad(item.code)}${item.subject_count}`);
      lines.push(`    ${item.detail}`);
      for (const subject of item.subjects) {
        lines.push(`      ${subject}`);
      }
    }
  }

  return `${lines.join("\n")}\n`;
}
