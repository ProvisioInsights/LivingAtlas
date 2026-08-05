import {
  findLiteralContractConstants,
  findRedeclaredToolNameSets,
  findTransportVaryingLimits,
  type BaselineConstant
} from "./detectors.js";
import { fingerprint, sortFindings, type Finding, type FindingKind } from "./finding.js";
import { ALL_DETECTORS, type GatedPlane } from "./planes.js";
import { collectSources, repoRoot } from "./sources.js";

/**
 * Run a plane's detectors once, and reconcile what they found against what the
 * plane is allowed to have.
 *
 * The analysis is memoised per plane because gate 1 and gate 5 both want it and
 * one of the detectors starts an MCP server over a pipe. Memoising a pure
 * function of the working tree is not a shortcut here — the alternative is
 * running the same server twice and hoping both runs agree.
 */

const analyses = new Map<string, Promise<Finding[]>>();

export async function analyzePlane(
  plane: GatedPlane,
  constants: readonly BaselineConstant[],
  root = repoRoot()
): Promise<Finding[]> {
  const cached = analyses.get(plane.id);
  if (cached) return cached;
  const running = analyzeUncached(plane, constants, root);
  analyses.set(plane.id, running);
  return running;
}

/** For tests that drive a synthetic plane and must not see another plane's cache. */
export function resetAnalysisCache(): void {
  analyses.clear();
}

async function analyzeUncached(
  plane: GatedPlane,
  constants: readonly BaselineConstant[],
  root: string
): Promise<Finding[]> {
  const enabled = new Set<FindingKind>(plane.detectors);
  const files = collectSources({ ...plane.sources, root });
  const findings: Finding[] = [];

  if (enabled.has("redeclared-tool-name-set")) {
    findings.push(...findRedeclaredToolNameSets(files, plane.toolNames));
  }
  if (enabled.has("transport-varying-limit")) {
    findings.push(...findTransportVaryingLimits(files));
  }
  if (enabled.has("literal-contract-constant")) {
    findings.push(...findLiteralContractConstants(files, constants));
  }
  if (plane.probe && (enabled.has("input-schema-divergence") || enabled.has("advertised-tool-unimplemented"))) {
    const probed = await plane.probe(root);
    // `plane-unreadable` is never in a plane's detector list — it is not an
    // analysis, it is the analysis failing to start — so it is always kept.
    findings.push(...probed.filter((found) => found.kind === "plane-unreadable" || enabled.has(found.kind)));
  }

  return sortFindings(findings);
}

/**
 * Turn findings into failure lines, honouring the plane's enforcement.
 *
 * An enforced plane fails on any finding. A quarantined plane fails on any
 * finding its ledger does not name, AND on any ledger entry nothing matched —
 * because a ledger row for a defect that no longer exists is a row nobody can
 * evaluate, and the next reader will assume the remaining rows are equally
 * stale.
 */
export function reconcile(plane: GatedPlane, findings: readonly Finding[], kinds: readonly FindingKind[]): string[] {
  const scope = new Set<FindingKind>(kinds);
  const scoped = findings.filter((found) => scope.has(found.kind) || found.kind === "plane-unreadable");
  const failures: string[] = [];

  for (const detector of ALL_DETECTORS) {
    if (!scope.has(detector)) continue;
    if (plane.detectors.includes(detector)) continue;
    if (plane.notApplicable[detector] === undefined) {
      failures.push(
        `[${plane.id}] detector "${detector}" neither runs against this plane nor is recorded as ` +
          "not-applicable. A detector that silently does not run is indistinguishable from one that " +
          "found nothing."
      );
    }
  }

  if (plane.enforcement === "enforced") {
    for (const found of scoped) {
      failures.push(format(plane, found));
    }
    return failures;
  }

  const ledger = new Map(
    plane.quarantine.filter((entry) => scope.has(entry.fingerprint.split("|")[0] as FindingKind)).map((entry) => [entry.fingerprint, entry])
  );
  const seen = new Set<string>();

  for (const found of scoped) {
    const print = fingerprint(found);
    if (ledger.has(print)) {
      seen.add(print);
      continue;
    }
    failures.push(
      `${format(plane, found)}\n    This plane is quarantined, and this finding is not in its ledger. ` +
        "New drift on a surface that is being demolished is still new drift. Fix it, or add it to " +
        `the ledger in packages/atlas-gates/src/registry.ts with fingerprint:\n      ${print}`
    );
  }

  for (const [print, entry] of ledger) {
    if (seen.has(print)) continue;
    failures.push(
      `[${plane.id}] a quarantine ledger entry matched nothing:\n      ${print}\n` +
        `    Recorded as: ${entry.note}\n` +
        "    Either the defect was fixed — in which case delete the row, so the ledger keeps " +
        "describing only defects that exist — or it changed shape, in which case look at what it " +
        "changed into."
    );
  }

  return failures;
}

function format(plane: GatedPlane, found: Finding): string {
  const at = found.line === undefined ? found.where : `${found.where}:${found.line}`;
  return `[${plane.id}] ${found.kind} at ${at}\n    ${found.message}`;
}
