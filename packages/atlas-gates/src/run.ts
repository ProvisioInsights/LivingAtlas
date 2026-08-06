import type { GateResult } from "./finding.js";
import { runCorpusGate } from "./gate-corpus.js";
import { runGoldenGate } from "./gate-golden.js";
import { runImmutableRevisionGate } from "./gate-immutable-revisions.js";
import { runLiteralConstantGate } from "./gate-literal-constants.js";
import { runSingleSourceGate } from "./gate-single-source.js";
import { repoRoot } from "./sources.js";

/**
 * All five gates, in the order a reader should read them.
 *
 * Every gate runs even when an earlier one fails. Stopping at the first failure
 * would turn a run into a queue: fix one thing, run again, discover the next.
 * Drift arrives in clusters — one edit to a published schema trips gate 4, gate
 * 5's round trip, and half the goldens — and a reader who sees all of it at once
 * understands what they did.
 */
export async function runAllGates(root = repoRoot()): Promise<GateResult[]> {
  return [
    await guard("1. single source", () => runSingleSourceGate(undefined, root)),
    await guard("2. golden fixtures", () => runGoldenGate(root)),
    await guard("3. answer reproducibility", () => runCorpusGate(root)),
    await guard("4. released revisions are immutable", () => runImmutableRevisionGate(root)),
    await guard("5. literal-constant lint", () => runLiteralConstantGate(undefined, root))
  ];
}

/**
 * A gate that THREW did not pass; it did not run.
 *
 * Without this the first gate to hit a malformed artifact takes the whole
 * process down with a stack trace, and the other four never report — so a single
 * hand-edited schema hides every other finding behind an Ajv message about an
 * unknown keyword. Measured, not imagined: adding one unrecognised keyword to a
 * published record schema did exactly that, and the immutability gate that would
 * have named the real problem never printed a line.
 */
async function guard(name: string, run: () => GateResult | Promise<GateResult>): Promise<GateResult> {
  try {
    return await run();
  } catch (error) {
    return {
      gate: name,
      ok: false,
      failures: [
        `This gate could not run: ${error instanceof Error ? error.message : String(error)}\n` +
          "    A gate that throws has not passed. Most often the artifact it reads is malformed — a " +
          "published schema edited by hand, a golden that is not JSON, a corpus truncated by a bad " +
          "merge — and one of the other gates below usually names it."
      ],
      examined: { status: "threw" }
    };
  }
}

export function formatReport(results: readonly GateResult[]): string {
  const lines: string[] = [];
  for (const result of results) {
    const summary = Object.entries(result.examined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    lines.push(`${result.ok ? "PASS" : "FAIL"}  ${result.gate}${summary ? `   (${summary})` : ""}`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }
  const failed = results.filter((result) => !result.ok).length;
  lines.push(
    failed === 0
      ? `\nAll ${results.length} anti-drift gates passed.`
      : `\n${failed} of ${results.length} anti-drift gates FAILED.`
  );
  return lines.join("\n");
}
