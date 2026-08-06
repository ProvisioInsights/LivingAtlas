import { analyzePlane, reconcile } from "./analyze.js";
import { baselineConstants, readBaseline } from "./baseline.js";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { gateResult, type GateResult } from "./finding.js";
import type { FindingKind } from "./finding.js";
import type { GatedPlane } from "./planes.js";
import { GATED_PLANES } from "./registry.js";
import { repoRoot } from "./sources.js";

/**
 * GATE 1 — SINGLE SOURCE.
 *
 * A tool's shape, a tool's existence, and the set a tool belongs to each have
 * exactly one home. This gate looks for second homes.
 *
 * Four detectors, one per way the repository has actually drifted:
 *
 *   redeclared-tool-name-set        a policy list restated outside the contract
 *   transport-varying-limit         one limit written twice, chosen by wire
 *   input-schema-divergence         one shape authored twice, in two languages
 *   advertised-tool-unimplemented   a tool the catalog promises and nothing serves
 *
 * The detectors run against every registered plane. What differs by plane is
 * what happens next: on the published consumer contract any finding fails the
 * build; on the surface being demolished the findings are matched against a
 * frozen ledger, so the drift is a recorded fact that cannot move without
 * somebody noticing.
 */

export const SINGLE_SOURCE_DETECTORS: readonly FindingKind[] = [
  "redeclared-tool-name-set",
  "transport-varying-limit",
  "input-schema-divergence",
  "advertised-tool-unimplemented"
];

export async function runSingleSourceGate(
  planes: readonly GatedPlane[] = GATED_PLANES,
  root = repoRoot()
): Promise<GateResult> {
  const constants = baselineConstants(readBaseline(CONTRACT_REVISION, root));
  const failures: string[] = [];
  const examined: Record<string, number | string> = { planes: planes.length };

  for (const plane of planes) {
    const findings = await analyzePlane(plane, constants, root);
    examined[`${plane.id}.findings`] = findings.filter((found) =>
      SINGLE_SOURCE_DETECTORS.includes(found.kind) || found.kind === "plane-unreadable"
    ).length;
    failures.push(...reconcile(plane, findings, SINGLE_SOURCE_DETECTORS));
  }

  return gateResult("1. single source", failures, examined);
}
