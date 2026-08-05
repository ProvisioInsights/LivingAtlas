import { describe, expect, it } from "vitest";
import { reconcile } from "./analyze.js";
import { fingerprint, type Finding } from "./finding.js";
import type { GatedPlane, QuarantinedPlane } from "./planes.js";
import { LEGACY_PLANE } from "./registry.js";

/**
 * The quarantine, tested as the thing it claims to be: a LEDGER, not a mute
 * button.
 *
 * The distinction is the only reason a quarantine is defensible at all. A
 * suppression list makes findings disappear and gives nothing back. A ledger
 * holds a fingerprint per defect and fails in all three directions — new drift,
 * changed drift, and drift that was fixed while its row stayed behind. The third
 * one is the one people forget, and it is the one that turns a ledger into
 * folklore: a file full of rows for problems that no longer exist, which the
 * next reader assumes is true of the remaining rows too.
 */

const KNOWN: Finding = {
  kind: "transport-varying-limit",
  where: "packages/example/src/index.ts",
  line: 12,
  detail: ["LocalCap=100", "RemoteCap=10"],
  message: "one cap, two numbers"
};

function planeWith(quarantine: QuarantinedPlane["quarantine"]): GatedPlane {
  return {
    id: "test-plane",
    title: "synthetic",
    enforcement: "quarantined",
    disposition: "synthetic fixture",
    toolNames: [],
    sources: { roots: [] },
    detectors: ["transport-varying-limit"],
    notApplicable: {
      "redeclared-tool-name-set": "synthetic",
      "input-schema-divergence": "synthetic",
      "advertised-tool-unimplemented": "synthetic",
      "literal-contract-constant": "synthetic"
    },
    quarantine
  };
}

describe("a quarantined plane", () => {
  it("accepts exactly the drift its ledger names", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    expect(reconcile(plane, [KNOWN], ["transport-varying-limit"])).toEqual([]);
  });

  it("fails on drift the ledger does not name, and prints the fingerprint to add", () => {
    const plane = planeWith([]);
    const failures = reconcile(plane, [KNOWN], ["transport-varying-limit"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("not in its ledger");
    expect(failures[0]).toContain(fingerprint(KNOWN));
  });

  it("fails when a ledger entry matches nothing, so a fixed defect cannot leave a row behind", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    const failures = reconcile(plane, [], ["transport-varying-limit"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("matched nothing");
    expect(failures[0]).toContain("delete the row");
  });

  it("fails when the SAME defect changes shape, because the fingerprint is its substance", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    // The remote cap moves from 10 to 25. Still one cap with two numbers, still
    // the same file — and a different defect, because the number a remote caller
    // is silently refused by is different.
    const changed: Finding = { ...KNOWN, detail: ["LocalCap=100", "RemoteCap=25"] };
    const failures = reconcile(plane, [changed], ["transport-varying-limit"]);
    expect(failures).toHaveLength(2);
    expect(failures.join("\n")).toContain("not in its ledger");
    expect(failures.join("\n")).toContain("matched nothing");
  });

  it("does not care how a finding words its message", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    const rephrased: Finding = { ...KNOWN, message: "a much better sentence about the same defect" };
    expect(reconcile(plane, [rephrased], ["transport-varying-limit"])).toEqual([]);
  });

  it("does not move when an unrelated edit shifts the line the defect is on", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    // Somebody adds a comment above the constant. The defect is identical and
    // the ledger must still match it, or every ledger becomes a list of line
    // numbers that a formatting pass invalidates.
    const shifted: Finding = { ...KNOWN, line: 340 };
    expect(reconcile(plane, [shifted], ["transport-varying-limit"])).toEqual([]);
  });

  it("does not care what order a detector enumerated its evidence in", () => {
    const plane = planeWith([{ fingerprint: fingerprint(KNOWN), note: "known" }]);
    const reordered: Finding = { ...KNOWN, detail: ["RemoteCap=10", "LocalCap=100"] };
    expect(reconcile(plane, [reordered], ["transport-varying-limit"])).toEqual([]);
  });

  it("fails when a detector is neither run nor recorded as not-applicable", () => {
    const plane = planeWith([]);
    const missing: GatedPlane = { ...plane, notApplicable: {} };
    const failures = reconcile(missing, [], ["literal-contract-constant"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("neither runs against this plane nor is recorded");
  });
});

describe("an enforced plane", () => {
  it("fails on any finding at all, with no ledger to consult", () => {
    const plane: GatedPlane = {
      id: "enforced-test",
      title: "synthetic",
      enforcement: "enforced",
      toolNames: [],
      sources: { roots: [] },
      detectors: ["transport-varying-limit"],
      notApplicable: {
        "redeclared-tool-name-set": "synthetic",
        "input-schema-divergence": "synthetic",
        "advertised-tool-unimplemented": "synthetic",
        "literal-contract-constant": "synthetic"
      }
    };
    const failures = reconcile(plane, [KNOWN], ["transport-varying-limit"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("transport-varying-limit");
    expect(failures[0]).not.toContain("ledger");
  });
});

describe("the legacy ledger as committed", () => {
  it("names the drift the surviving remote half still ships", () => {
    const plane = LEGACY_PLANE;
    if (plane.enforcement !== "quarantined") throw new Error("the legacy plane must be quarantined");
    const prints = plane.quarantine.map((entry) => entry.fingerprint);

    // (1) the local-only deny list, four names where the contract says six
    expect(prints).toContain(
      "redeclared-tool-name-set|packages/graph-service/src/index.ts|resolution_apply,review_decide,review_list,review_read"
    );
    // (2) one batch cap, two numbers, chosen by transport
    expect(prints).toContain(
      "transport-varying-limit|packages/graph-service/src/index.ts|LocalBatchMaxItems=100,RemoteBatchMaxItems=10"
    );
  });

  /**
   * The other half of the same assertion, and the half that is easy to forget.
   *
   * Twenty-four rows described the local server, and the local server was
   * demolished (ADR 0017). `reconcile` already fails a row that matches nothing,
   * so a stale row cannot survive a gate RUN — but only if the gate runs, and
   * only in a tree where the deletion happened. This pins it in the ledger
   * itself: no row here may name a file the demolition removed, so re-adding one
   * fails here even before a gate is started.
   */
  it("names no file the local demolition removed, in any row", () => {
    const plane = LEGACY_PLANE;
    if (plane.enforcement !== "quarantined") throw new Error("the legacy plane must be quarantined");
    const demolished = ["packages/local-mcp/src/server.ts", "packages/local-review-site/"];
    for (const entry of plane.quarantine) {
      for (const path of demolished) {
        expect(`${entry.fingerprint} ${entry.note}`, entry.fingerprint).not.toContain(path);
      }
    }
    // The twenty-one twice-authored input shapes were the local server's zod
    // against the catalog's JSON Schema. There is no local server, so there is
    // no second authoring, so there can be no row of this kind.
    expect(plane.quarantine.filter((entry) => entry.fingerprint.startsWith("input-schema-divergence|"))).toEqual([]);
  });

  it("records a reason for every detector it stopped running", () => {
    const plane = LEGACY_PLANE;
    // Dropping a detector and saying nothing is indistinguishable from a
    // detector that found nothing. `reconcile` enforces this at run time; this
    // asserts the two the demolition retired are actually accounted for.
    expect(plane.notApplicable["input-schema-divergence"]).toBeDefined();
    expect(plane.notApplicable["advertised-tool-unimplemented"]).toBeDefined();
    expect(plane.detectors).not.toContain("input-schema-divergence");
    expect(plane.detectors).not.toContain("advertised-tool-unimplemented");
  });

  it("gives every ledger entry a note, because a fingerprint alone explains nothing", () => {
    const plane = LEGACY_PLANE;
    if (plane.enforcement !== "quarantined") throw new Error("the legacy plane must be quarantined");
    for (const entry of plane.quarantine) {
      expect(entry.note.length, entry.fingerprint).toBeGreaterThan(40);
    }
  });

  it("says who removes the plane and what removing it means", () => {
    const plane = LEGACY_PLANE;
    if (plane.enforcement !== "quarantined") throw new Error("the legacy plane must be quarantined");
    expect(plane.disposition).toContain("delete this registration");
  });
});
