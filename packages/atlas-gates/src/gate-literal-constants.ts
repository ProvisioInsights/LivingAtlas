import { CONTRACT_LIMITS, CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { analyzePlane, reconcile } from "./analyze.js";
import {
  baselineConstants,
  baselinePath,
  generateBaseline,
  loadPublishedContract,
  readBaseline,
  serializeBaseline
} from "./baseline.js";
import { gateResult, type FindingKind, type GateResult } from "./finding.js";
import type { GatedPlane } from "./planes.js";
import { GATED_PLANES } from "./registry.js";
import { repoRoot } from "./sources.js";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

/**
 * GATE 5 — LITERAL-CONSTANT LINT.
 *
 * Three checks, and they are the three links of one chain. `revision.ts` AUTHORS
 * a limit; `schema/<revision>/` PUBLISHES it; `baseline/` GENERATES a summary of
 * what was published; every consumer READS the generated summary.
 *
 *   5a  the committed baseline is exactly what regenerating produces
 *   5b  what the code authored is exactly what the published bytes carry
 *   5c  nothing else in the plane restates either
 *
 * 5a is what makes the baseline GENERATED rather than merely committed. Without
 * it, "read the number from the baseline" degrades into "read the number from a
 * file somebody typed", which is the same defect one indirection further away.
 *
 * 5b is the link 5a cannot check: the baseline is derived from the schemas, so
 * it agrees with them by construction. Only a comparison against the authored
 * constant can catch a schema edited by hand after generation.
 */

export const LITERAL_DETECTORS: readonly FindingKind[] = ["literal-contract-constant"];

export async function runLiteralConstantGate(
  planes: readonly GatedPlane[] = GATED_PLANES,
  root = repoRoot()
): Promise<GateResult> {
  const failures: string[] = [];
  const path = baselinePath(CONTRACT_REVISION, root);
  const relativePath = relative(root, path).split("\\").join("/");

  if (!existsSync(path)) {
    return gateResult("5. literal-constant lint", [
      `No generated baseline at ${relativePath}. Run \`npm run gates -- --write-baseline\`; ` +
        "until it exists nothing downstream has a number to read."
    ]);
  }

  const contract = loadPublishedContract(CONTRACT_REVISION, root);
  const regenerated = serializeBaseline(generateBaseline(contract, `schema/${CONTRACT_REVISION}`));
  const committed = readFileSync(path, "utf8");

  // 5a — the round trip.
  if (regenerated !== committed) {
    failures.push(
      `${relativePath} is not what regenerating it from schema/${CONTRACT_REVISION} produces.\n` +
        "    Either a published schema changed and the baseline was not regenerated, or the baseline " +
        "was edited by hand. A baseline that is written rather than derived is a prose constant with " +
        "an extra step.\n" +
        `    ${describeJsonDrift(committed, regenerated)}`
    );
  }

  // 5b — author against publication.
  const baseline = readBaseline(CONTRACT_REVISION, root);
  for (const [name, authored] of Object.entries(CONTRACT_LIMITS)) {
    const published = baseline.limits[name];
    if (published !== authored) {
      failures.push(
        `CONTRACT_LIMITS.${name} is ${String(authored)} in revision.ts and ${String(published)} in the ` +
          "published bytes. The schemas were edited after they were generated, so the number a " +
          "consumer validates against and the number this server enforces are different numbers."
      );
    }
  }
  for (const name of Object.keys(baseline.limits)) {
    if (!(name in CONTRACT_LIMITS)) {
      failures.push(
        `The published bytes carry a limit "${name}" that revision.ts does not author. A published ` +
          "number with no authoring point is one nobody can change on purpose."
      );
    }
  }

  // 5c — the lint.
  const constants = baselineConstants(baseline);
  const examined: Record<string, number | string> = {
    baseline: relativePath,
    "lint.constants": constants.length
  };
  for (const plane of planes) {
    const findings = await analyzePlane(plane, constants, root);
    examined[`${plane.id}.findings`] = findings.filter((found) => found.kind === "literal-contract-constant").length;
    failures.push(...reconcile(plane, findings, LITERAL_DETECTORS));
  }

  return gateResult("5. literal-constant lint", failures, examined);
}

/** The first differing top-level section, so a reader knows where to look. */
function describeJsonDrift(committed: string, regenerated: string): string {
  let left: Record<string, unknown>;
  let right: Record<string, unknown>;
  try {
    left = JSON.parse(committed) as Record<string, unknown>;
    right = JSON.parse(regenerated) as Record<string, unknown>;
  } catch {
    return "The committed baseline is not parseable JSON.";
  }
  for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      return `First difference in "${key}": committed ${JSON.stringify(left[key])}, generated ${JSON.stringify(right[key])}`;
    }
  }
  return "The parsed content agrees; only the serialisation differs.";
}
