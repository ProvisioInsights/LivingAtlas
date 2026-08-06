import type { Finding } from "./finding.js";
import { lineOf, type SourceFile } from "./sources.js";

/**
 * The three source-level detectors, and the one property they share: each one
 * looks for a SECOND copy of something that has exactly one correct home.
 *
 * Every drift this repository actually shipped is an instance of that:
 *
 *  - `packages/mcp-contract` declared six local-only tools; the guard in
 *    `packages/graph-service` that enforces the rule declared four. Two lists,
 *    one rule, and the enforcing copy was the short one — so `migration_open`
 *    and `migration_seal`, whose own descriptions say "Local-only", were
 *    reachable over remote HTTP.
 *  - `LocalBatchMaxItems = 100` and `RemoteBatchMaxItems = 10` are one limit
 *    written twice. The published schema said `maxItems: 100` to everybody, so a
 *    remote caller sending 11 items was refused by a number no document
 *    mentioned.
 *  - A published cap copied into a validator becomes a cap nobody updates when
 *    the contract changes.
 *
 * None of these are visible to a type checker: both copies type-check. None are
 * visible to a single-transport test: only one copy is reached. They are visible
 * in the text, which is why these read the text.
 */

// ---------------------------------------------------------------------------
// redeclared tool-name sets
// ---------------------------------------------------------------------------

const ARRAY_LITERAL = /\[([^[\]]*)\]/g;
const STRING_LITERAL = /"([^"\\]*)"|'([^'\\]*)'/g;

/**
 * An array literal holding two or more of the plane's published tool names, in
 * a file that is not the one allowed to declare such a set.
 *
 * Two or more, not one: a single name is a dispatch label, a test fixture, or an
 * error message, and those are not a duplicated source of truth. A LIST of them
 * is a policy — which tools are local-only, which are batchable, which are
 * writable — and a policy stated outside the contract is a policy that can
 * disagree with it. That is the 6-versus-4 defect exactly.
 */
export function findRedeclaredToolNameSets(
  files: readonly SourceFile[],
  toolNames: readonly string[]
): Finding[] {
  const published = new Set(toolNames);
  const findings: Finding[] = [];

  for (const file of files) {
    ARRAY_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ARRAY_LITERAL.exec(file.code)) !== null) {
      const body = match[1] ?? "";
      const members: string[] = [];
      let clean = true;

      STRING_LITERAL.lastIndex = 0;
      let literal: RegExpExecArray | null;
      while ((literal = STRING_LITERAL.exec(body)) !== null) {
        members.push(literal[1] ?? literal[2] ?? "");
      }
      // A mixed array — some tool names, some not — is a different animal (a
      // heterogeneous list that happens to mention tools) and reporting it would
      // bury the real finding. Every member has to be a published tool name.
      for (const member of members) {
        if (!published.has(member)) clean = false;
      }
      if (!clean || members.length < 2) continue;

      findings.push({
        kind: "redeclared-tool-name-set",
        where: file.relative,
        line: lineOf(file.code, match.index),
        detail: members,
        message:
          `${file.relative} declares its own set of ${members.length} published tool names. ` +
          "A tool-name set outside the contract is a second source of truth for a rule the " +
          "contract already states, and the two copies drift silently because both type-check. " +
          "Import the contract's exported set instead."
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// transport-varying limits
// ---------------------------------------------------------------------------

/**
 * Words that name a WIRE. A limit whose identifier carries one of these is a
 * limit a caller cannot discover, because the caller does not know — and under
 * ADR 0015 must not need to know — which wire it is on.
 */
const TRANSPORT_WORDS = ["local", "remote", "stdio", "http", "https", "cloud", "worker", "inproc", "loopback"];

/** Words that make an identifier a LIMIT rather than a port number or a colour. */
const LIMIT_WORDS = [
  "max",
  "min",
  "limit",
  "cap",
  "size",
  "items",
  "bytes",
  "count",
  "depth",
  "window",
  "timeout",
  "ttl",
  "floor",
  "quota",
  "page"
];

const NUMERIC_DECLARATION = /(?:const|let|var|readonly)?\s*([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)\s*(?:[;,)\]}]|$)/gm;
const NUMERIC_PROPERTY = /([A-Za-z_$][\w$]*)\s*:\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)\s*[,}\n]/g;

function evaluateNumeric(expression: string): number | undefined {
  const parts = expression.split("*").map((part) => Number(part.trim().replace(/_/g, "")));
  if (parts.some((part) => !Number.isInteger(part))) return undefined;
  return parts.reduce((product, part) => product * part, 1);
}

function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/** The identifier with every transport word removed, e.g. `LocalBatchMaxItems` -> `batch max items`. */
function withoutTransport(identifier: string): { normalized: string; carried: string[] } {
  const parts = words(identifier);
  const carried = parts.filter((part) => TRANSPORT_WORDS.includes(part));
  return { normalized: parts.filter((part) => !TRANSPORT_WORDS.includes(part)).join(" "), carried };
}

type NumericConstant = { identifier: string; value: number; file: string; line: number };

function collectNumericConstants(files: readonly SourceFile[]): NumericConstant[] {
  const found: NumericConstant[] = [];
  for (const file of files) {
    for (const pattern of [NUMERIC_DECLARATION, NUMERIC_PROPERTY]) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(file.code)) !== null) {
        const identifier = match[1];
        const value = evaluateNumeric(match[2] ?? "");
        if (identifier === undefined || value === undefined) continue;
        found.push({ identifier, value, file: file.relative, line: lineOf(file.code, match.index) });
      }
    }
  }
  return found;
}

/**
 * Two constants that name the same limit and differ only by a transport word,
 * holding different numbers.
 *
 * The finding is not "these numbers differ" — a deployment may legitimately want
 * a smaller batch over an expensive wire. The finding is that the difference is
 * expressed as two constants and therefore appears in no published document: the
 * schema a remote caller reads says one number and the code refuses it at
 * another. If a wire genuinely needs a smaller cap, the cap belongs in the
 * caller's published grant, where the caller can read it.
 */
export function findTransportVaryingLimits(files: readonly SourceFile[]): Finding[] {
  const byNormalized = new Map<string, NumericConstant[]>();

  for (const constant of collectNumericConstants(files)) {
    const { normalized, carried } = withoutTransport(constant.identifier);
    if (carried.length === 0) continue;
    if (!words(normalized).some((word) => LIMIT_WORDS.includes(word))) continue;
    const bucket = byNormalized.get(normalized) ?? [];
    bucket.push(constant);
    byNormalized.set(normalized, bucket);
  }

  const findings: Finding[] = [];
  for (const [normalized, constants] of [...byNormalized.entries()].sort()) {
    const distinct = new Set(constants.map((constant) => constant.value));
    if (distinct.size < 2) continue;
    const sorted = [...constants].sort((left, right) =>
      left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
    );
    const anchor = sorted[0];
    if (!anchor) continue;
    findings.push({
      kind: "transport-varying-limit",
      where: anchor.file,
      line: anchor.line,
      detail: sorted.map((constant) => `${constant.identifier}=${constant.value}`),
      message:
        `The limit "${normalized}" has ${distinct.size} different values depending on transport ` +
        `(${sorted.map((constant) => `${constant.identifier}=${constant.value}`).join(", ")}). ` +
        "A caller cannot discover which one applies to it, so the same request succeeds on one " +
        "wire and is refused on another by a number no published document names."
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// literal contract constants
// ---------------------------------------------------------------------------

/** One published number, and the words that make a line about THAT number. */
export type BaselineConstant = {
  name: string;
  value: number;
  /** Any of these on the line makes a matching literal a restatement, not a coincidence. */
  contextWords: readonly string[];
};

/**
 * Integer literals, and products of two of them so that `1024 * 1024` is seen
 * as `1048576`. A number with a leading zero is deliberately NOT matched: it is
 * not a legal integer literal in strict-mode TypeScript, so every one of them is
 * a fragment of something else — a date, a version, a padded field — and
 * matching them is how `"2025-06-01"` gets read as the number six.
 */
const INTEGER = /\b([1-9]\d*|0)\s*\*\s*([1-9]\d*|0)\b|\b([1-9]\d*|0)\b/g;

/**
 * Symbols that mean "this line READS the baseline". A line that mentions one is
 * quoting the generated number, which is the behaviour the gate wants, so a
 * literal on that line is a bound or a fallback beside the real source rather
 * than a copy of it.
 */
const BASELINE_SYMBOLS = ["CONTRACT_LIMITS", "contractBaseline", "CONTRACT_BASELINE", "baseline.limits", "manifest.limits"];

/**
 * A published count or limit, restated as a number in code.
 *
 * The rule is narrow on purpose. `100` on its own is not a finding — it is one
 * of the most common integers in any codebase. `100` on a line that also says
 * `batch` or `items` is a restatement of `max_batch_items`, and the next time
 * that cap moves it will move in the generated baseline and not here.
 *
 * A line that already names the baseline is left alone: reading the number and
 * then bounding it is the intended shape, not a second copy.
 */
export function findLiteralContractConstants(
  files: readonly SourceFile[],
  constants: readonly BaselineConstant[]
): Finding[] {
  const byValue = new Map<number, BaselineConstant[]>();
  for (const constant of constants) {
    const bucket = byValue.get(constant.value) ?? [];
    bucket.push(constant);
    byValue.set(constant.value, bucket);
  }

  const findings: Finding[] = [];
  for (const file of files) {
    // Strings blanked: a limit quoted inside a sentence is documentation, and a
    // lint that fired on the documentation would be answered by deleting it.
    const lines = file.codeWithoutStrings.split("\n");
    for (const [index, line] of lines.entries()) {
      if (BASELINE_SYMBOLS.some((symbol) => line.includes(symbol))) continue;
      // Tokenised the same way an identifier is, so `pageSize`, `page_size` and
      // `PAGE_SIZE` all yield `page` and `size` — and `canonicalRecordedAt`
      // yields `recorded`, which is not `record`. Substring matching would have
      // called that a restatement of `record_schemas`.
      const lineWords = new Set(words(line));

      const values = new Set<number>();
      INTEGER.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INTEGER.exec(line)) !== null) {
        if (match[1] !== undefined && match[2] !== undefined) {
          values.add(Number(match[1]) * Number(match[2]));
        } else if (match[3] !== undefined) {
          values.add(Number(match[3]));
        }
      }

      const matched: string[] = [];
      for (const value of values) {
        for (const constant of byValue.get(value) ?? []) {
          if (constant.contextWords.some((word) => lineWords.has(word))) {
            matched.push(`${constant.name}=${constant.value}`);
          }
        }
      }
      if (matched.length === 0) continue;

      findings.push({
        kind: "literal-contract-constant",
        where: file.relative,
        line: index + 1,
        detail: [...new Set(matched)],
        message:
          `${file.relative}:${index + 1} restates a published contract number as a literal ` +
          `(${[...new Set(matched)].join(", ")}). Read it from the generated baseline instead: a ` +
          "number copied into code is a number that stays behind when the published one moves, " +
          "and nothing in the type system or the tests notices that it did."
      });
    }
  }
  return findings;
}
