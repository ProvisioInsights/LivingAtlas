import type { Finding, FindingKind } from "./finding.js";
import type { CollectOptions } from "./sources.js";

/**
 * The surfaces gate 1 and gate 5 examine, and what each one owes.
 *
 * Two planes exist because this repository contains two tool surfaces at once
 * and they are not in the same state. The consumer plane published in
 * `2026.08.0` is ENFORCED: every detector runs and every finding is a build
 * failure. The 30-tool surface it replaces is QUARANTINED: the detectors still
 * run, but the drift they find is compared against a frozen ledger.
 *
 * A quarantine is not a suppression, and the difference is the entire point:
 *
 *  - the ledger holds FINGERPRINTS, so a finding whose wording improves still
 *    matches and a finding whose substance changes does not;
 *  - the comparison is EQUALITY, not containment. New drift fails. Changed drift
 *    fails. Drift that was fixed without deleting its ledger row fails, because
 *    a ledger describing defects that no longer exist is a document nobody can
 *    trust;
 *  - `enforcement: "enforced"` is a variant with NO ledger field. The consumer
 *    plane cannot acquire a quarantine entry, because there is nowhere to put
 *    one. That is a type, not a policy.
 *
 * When the legacy surface is deleted, its plane registration is deleted with it.
 * Deleting the code and leaving the registration behind fails with
 * `plane-unreadable` rather than passing quietly, so demolition cannot leave a
 * gate pointed at nothing and still green.
 */

export type PlaneDetector = FindingKind;

export type QuarantineEntry = {
  /** From `fingerprint()`. Substance, not wording. */
  fingerprint: string;
  /** Why this is tolerated, and what ends the toleration. */
  note: string;
};

type PlaneCommon = {
  id: string;
  title: string;
  /** Everything the source-level detectors read. */
  sources: CollectOptions;
  /** The plane's published tool names, for the redeclared-set detector. */
  toolNames: readonly string[];
  /** Detectors that run against this plane. */
  detectors: readonly PlaneDetector[];
  /**
   * Every detector this plane does NOT run, with the reason. A required record
   * rather than an omission: a detector silently not running against a surface
   * is indistinguishable from a detector finding nothing there.
   */
  notApplicable: Readonly<Record<string, string>>;
  /** Runtime probes: shapes and reachability that no amount of text scanning can settle. */
  probe?: (root: string) => Promise<Finding[]>;
};

export type EnforcedPlane = PlaneCommon & { enforcement: "enforced" };

export type QuarantinedPlane = PlaneCommon & {
  enforcement: "quarantined";
  /** Who removes this plane, and what removing it means. */
  disposition: string;
  quarantine: readonly QuarantineEntry[];
};

export type GatedPlane = EnforcedPlane | QuarantinedPlane;

export const ALL_DETECTORS: readonly PlaneDetector[] = [
  "redeclared-tool-name-set",
  "transport-varying-limit",
  "input-schema-divergence",
  "advertised-tool-unimplemented",
  "literal-contract-constant"
];
