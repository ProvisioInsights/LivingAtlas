/**
 * What a gate says when it has something to say.
 *
 * Every gate answers in the same shape, because the runner has to be able to
 * print, count, and compare findings from five different analyses without
 * knowing what any of them looked at. More importantly, a finding has a
 * FINGERPRINT: a short, stable, order-independent string that identifies the
 * defect and not the phrasing of its message.
 *
 * The fingerprint exists so that "this drift is known and quarantined" can be
 * recorded as data rather than as a suppression. A quarantine keyed on a message
 * string silently stops matching the moment somebody improves the wording, and a
 * suppression that stopped matching is indistinguishable from a defect that was
 * fixed. Keyed on the fingerprint, a quarantine entry can only stop matching
 * because the defect itself changed — which is exactly when a human should look.
 */

/** Which analysis produced a finding. One per detector, stable over time. */
export type FindingKind =
  /** A set of published tool names declared somewhere other than the contract. */
  | "redeclared-tool-name-set"
  /** Two constants naming one limit, differing only by transport, with different values. */
  | "transport-varying-limit"
  /** A tool's registered input shape disagrees with the shape the catalog publishes. */
  | "input-schema-divergence"
  /** A tool the catalog advertises that the server cannot actually answer. */
  | "advertised-tool-unimplemented"
  /** A published count or limit restated as a numeric literal in code. */
  | "literal-contract-constant"
  /** The plane's own sources could not be loaded, so nothing was checked. */
  | "plane-unreadable";

export type Finding = {
  kind: FindingKind;
  /**
   * Repo-relative when the finding is anchored to a file, otherwise a symbolic
   * location such as a tool name. Never an absolute path: a finding is compared
   * against a committed quarantine ledger, and an absolute path would embed the
   * machine that ran the gate.
   */
  where: string;
  /** 1-indexed, when the finding is anchored to a line. */
  line?: number;
  /** The identifiers, names, or values that make this finding what it is. */
  detail: string[];
  /** Prose for a human reading CI output. Never part of the fingerprint. */
  message: string;
};

/**
 * `kind | where | sorted detail`.
 *
 * Two things are deliberately absent.
 *
 * `message` is absent because a fingerprint has to survive somebody improving
 * the wording; a quarantine keyed on prose stops matching the moment the prose
 * gets better, and a suppression that stopped matching is indistinguishable from
 * a defect that was fixed.
 *
 * `line` is absent because it moves for reasons that are not the defect. Adding
 * a comment above a constant would re-key every finding below it and fail the
 * build with a diff nobody can interpret — a gate that cries wolf on an
 * unrelated edit is a gate that gets switched off. `detail` already separates
 * two findings of the same kind in the same file, because it holds the members
 * or the constants that make each one what it is. The line still travels on the
 * finding and still appears in the message, where a reader wants it.
 *
 * `detail` is sorted so that a detector which happens to enumerate its evidence
 * in a different order — a `Set` iteration, a `readdir`, a map — does not mint a
 * new fingerprint for the same defect.
 */
export function fingerprint(finding: Finding): string {
  return [finding.kind, finding.where, [...finding.detail].sort().join(",")].join("|");
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const a = fingerprint(left);
    const b = fingerprint(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** One gate's verdict. `ok` is `failures.length === 0` and nothing else. */
export type GateResult = {
  gate: string;
  ok: boolean;
  /** Human-readable failure lines, in the order a reader should read them. */
  failures: string[];
  /** What the gate examined, for a reader deciding whether it examined enough. */
  examined: Record<string, number | string>;
};

export function gateResult(gate: string, failures: string[], examined: Record<string, number | string> = {}): GateResult {
  return { gate, ok: failures.length === 0, failures, examined };
}
