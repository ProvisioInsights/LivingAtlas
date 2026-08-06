import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTRACT_REVISION, createContractValidator } from "@living-atlas/atlas-contract";
import { loadPublishedContract } from "./baseline.js";
import { firstDifference, stableJson } from "./canonical.js";
import { captureConsumerCases, type CapturedCase } from "./consumer-fixture.js";
import { gateResult, type GateResult } from "./finding.js";
import { repoRoot } from "./sources.js";

/**
 * GATE 2 — GOLDEN FIXTURES.
 *
 * For every published tool, one recorded response, checked three ways:
 *
 *   a. it matches the recorded bytes, so a shape change is a build failure;
 *   b. it satisfies the tool's OWN published output schema, so a golden
 *      re-recorded against a broken implementation still has to be contract-
 *      legal — which is the difference between a golden and a rubber stamp;
 *   c. every published tool has one and no golden exists for a tool nobody
 *      publishes, so coverage cannot rot by omission.
 *
 * (b) is the load-bearing one. A golden file alone says "the implementation
 * still does what it did", which is exactly as true after a regression as
 * before it if the regression was recorded. Validating against the published
 * schema says "and what it does is still what the contract promised".
 *
 * There is one thing this gate deliberately does NOT do: it does not compare a
 * version against its own past. A golden is re-recorded on purpose whenever the
 * shape changes on purpose. That is what gate 3 is for, and the two must not be
 * conflated — a corpus you may re-record is not a corpus.
 */

export function goldenDirectory(root = repoRoot()): string {
  return join(root, "packages", "atlas-gates", "golden");
}

export function goldenPath(caseName: string, root = repoRoot()): string {
  return join(goldenDirectory(root), `${caseName}.json`);
}

export type GoldenRecord = {
  case: string;
  tool: string;
  intent: string;
  contract_revision: string;
  /** The wire result, with minted ids and digests replaced by stable labels. */
  response: unknown;
};

/**
 * What replaces the text block when it is a re-serialisation of the structured
 * one. An assertion in its own right: if the two ever stop agreeing, the marker
 * is not written and the golden fails.
 */
export const MIRRORS_STRUCTURED = "<the text block is JSON.stringify(structuredContent)>";

/**
 * Collapse `content[0].text` when it mirrors `structuredContent`.
 *
 * Every complete result carries its payload twice: once structured, once as a
 * JSON string for a client with no structured-output support. Recording both
 * verbatim doubles the file and — the part that actually matters — makes the
 * diff useless, because `content` sorts before `structuredContent` and the first
 * difference reported is a two-kilobyte string nobody can read. Collapsing it
 * keeps the invariant (the two agree) and moves the diff to the field that moved.
 */
function collapseMirroredText(response: unknown): unknown {
  if (response === null || typeof response !== "object") return response;
  const record = response as Record<string, unknown>;
  const structured = record["structuredContent"];
  const content = record["content"];
  if (structured === undefined || !Array.isArray(content) || content.length !== 1) return response;

  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") return response;
  try {
    if (JSON.stringify(JSON.parse(first.text)) !== JSON.stringify(structured)) return response;
  } catch {
    return response;
  }
  return { ...record, content: MIRRORS_STRUCTURED };
}

export function goldenRecordFor(recorded: CapturedCase): GoldenRecord {
  return {
    case: recorded.caseName,
    tool: recorded.tool,
    intent: recorded.intent,
    contract_revision: CONTRACT_REVISION,
    response: collapseMirroredText(recorded.captured)
  };
}

/**
 * The structured payload a golden's response carries, if it carries one.
 *
 * `structuredContent` is absent on two legitimate shapes — an input-validation
 * error and the protocol's `input_required` channel — and the caller has to be
 * able to tell "no structured content" from "structured content that is empty".
 */
function structuredOf(response: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (response === undefined) return undefined;
  const structured = response["structuredContent"];
  if (structured === null || typeof structured !== "object" || Array.isArray(structured)) return undefined;
  return structured as Record<string, unknown>;
}

export async function runGoldenGate(root = repoRoot()): Promise<GateResult> {
  const contract = loadPublishedContract(CONTRACT_REVISION, root);
  const validator = createContractValidator(contract);
  const capture = await captureConsumerCases();
  const failures: string[] = [];
  const directory = goldenDirectory(root);

  const recordedNames = new Set<string>();

  for (const recorded of capture.cases) {
    recordedNames.add(recorded.caseName);
    const path = goldenPath(recorded.caseName, root);
    const shown = relative(root, path).split("\\").join("/");

    if (!existsSync(path)) {
      failures.push(
        `${recorded.tool} has no golden at ${shown}. Every published tool needs a recorded response; ` +
          "record it with `npm run gates -- --write-goldens` and read what it recorded before " +
          "committing it."
      );
      continue;
    }

    const expected = JSON.parse(readFileSync(path, "utf8")) as GoldenRecord;
    const actual = goldenRecordFor(recorded);

    const difference = firstDifference(expected, actual);
    if (difference !== undefined) {
      failures.push(
        `${recorded.caseName} no longer produces its recorded response.\n` +
          `    ${difference}\n` +
          "    If the change is intended, re-record the golden IN THE SAME COMMIT as the change and " +
          "say in the message which field moved and why. A golden re-recorded in a follow-up commit " +
          "is a golden nobody reviewed."
      );
    }

    // (b) — the recorded bytes have to be contract-legal, not merely stable.
    //
    // Validated against the RAW response, not the canonicalised one. The
    // canonical form replaces `la_entity_01kz…` with `<la_entity:0>`, which is
    // deliberately not a legal entity id — so validating the recorded file would
    // fail on the very substitution that makes the file reproducible. The two
    // checks want different views of the same response and each gets its own:
    // the recorded bytes are compared for stability, the wire bytes for legality.
    const structured = structuredOf(recorded.raw.result);
    if (structured !== undefined) {
      const outcome = validator.validateToolOutput(recorded.tool, structured);
      if (!outcome.valid) {
        failures.push(
          `${recorded.caseName} is recorded but does not satisfy the published output schema for ` +
            `${recorded.tool}: ${outcome.errors.join("; ")}. A golden that pins a contract-illegal ` +
            "shape pins the regression."
        );
      }
    }
  }

  // (c) — no golden for a case nothing produces.
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory).sort()) {
      if (!entry.endsWith(".json")) continue;
      const caseName = entry.slice(0, -".json".length);
      if (recordedNames.has(caseName)) continue;
      failures.push(
        `golden/${entry} records a case the fixture no longer produces. Delete it, or restore the ` +
          "case: a golden nothing exercises is a file that looks like coverage and is not."
      );
    }
  }

  const published = new Set(contract.manifest.tools.map((tool) => tool.name));
  for (const name of published) {
    if (!capture.cases.some((recorded) => recorded.tool === name)) {
      failures.push(
        `${name} is published and no golden case exercises it. A tool with no recorded response is ` +
          "a tool whose shape nothing is watching."
      );
    }
  }

  return gateResult("2. golden fixtures", failures, {
    cases: capture.cases.length,
    tools: published.size,
    goldens: existsSync(directory) ? readdirSync(directory).filter((entry) => entry.endsWith(".json")).length : 0
  });
}
