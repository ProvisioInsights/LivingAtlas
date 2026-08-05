import { describe, expect, it } from "vitest";
import {
  findLiteralContractConstants,
  findRedeclaredToolNameSets,
  findTransportVaryingLimits
} from "./detectors.js";
import { collectSources, stripComments, stripStrings } from "./sources.js";
import { makeTemporaryRepo, seedSource } from "./harness.test-helpers.js";

/**
 * The three source lints, each shown catching the exact defect this repository
 * shipped — and each shown NOT firing on the shape that looks like it.
 *
 * A lint with only positive tests is a lint whose false-positive rate is
 * unmeasured, and an unmeasured false-positive rate is how a gate gets switched
 * off six months later by somebody who is right to be annoyed.
 */

const TOOLS = ["review_list", "review_read", "review_decide", "resolution_apply", "migration_open", "migration_seal"];

function sourcesIn(root: string) {
  return collectSources({ root, roots: ["seeded"] });
}

describe("redeclared tool-name sets", () => {
  it("finds the four-name enforcing copy of a six-name deny list", () => {
    const root = makeTemporaryRepo();
    seedSource(
      root,
      "seeded/guard.ts",
      [
        "const LocalOnlyToolNames = new Set<Name>([",
        '  "review_list",',
        '  "review_read",',
        '  "review_decide",',
        '  "resolution_apply"',
        "]);"
      ].join("\n")
    );

    const findings = findRedeclaredToolNameSets(sourcesIn(root), TOOLS);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toEqual(["review_list", "review_read", "review_decide", "resolution_apply"]);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.message).toContain("second source of truth");
  });

  it("does not fire on a single tool name, which is a dispatch label and not a policy", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/dispatch.ts", 'if (tool === "review_list") return handleReviewList();');
    expect(findRedeclaredToolNameSets(sourcesIn(root), TOOLS)).toEqual([]);
  });

  it("does not fire on a list that merely mentions a tool among other strings", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/mixed.ts", 'const labels = ["review_list", "a free-form label"];');
    expect(findRedeclaredToolNameSets(sourcesIn(root), TOOLS)).toEqual([]);
  });

  it("does not fire on a tool-name list that appears only inside a comment", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/prose.ts", '// The local-only set is ["review_list", "review_read"].\nexport const x = 1;');
    expect(findRedeclaredToolNameSets(sourcesIn(root), TOOLS)).toEqual([]);
  });
});

describe("transport-varying limits", () => {
  it("finds one batch cap written twice and chosen by transport", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/limits.ts", ["const LocalBatchMaxItems = 100;", "const RemoteBatchMaxItems = 10;"].join("\n"));

    const findings = findTransportVaryingLimits(sourcesIn(root));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toEqual(["LocalBatchMaxItems=100", "RemoteBatchMaxItems=10"]);
    expect(findings[0]?.message).toContain("succeeds on one");
  });

  it("does not fire when both transports agree, because then there is one limit", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/agree.ts", ["const LocalBatchMaxItems = 100;", "const RemoteBatchMaxItems = 100;"].join("\n"));
    expect(findTransportVaryingLimits(sourcesIn(root))).toEqual([]);
  });

  it("does not fire on transport-named constants that are not limits", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/ports.ts", ["const LocalPort = 8787;", "const RemotePort = 443;"].join("\n"));
    expect(findTransportVaryingLimits(sourcesIn(root))).toEqual([]);
  });
});

describe("literal contract constants", () => {
  const constants = [
    { name: "limits.max_batch_items", value: 100, contextWords: ["batch", "items"] },
    { name: "limits.change_feed_floor_days", value: 400, contextWords: ["change", "feed", "floor", "days"] }
  ];

  it("finds a published cap restated as a literal beside its own name", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/copy.ts", "const maxBatchItems = 100;");

    const findings = findLiteralContractConstants(sourcesIn(root), constants);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detail).toEqual(["limits.max_batch_items=100"]);
    expect(findings[0]?.message).toContain("generated baseline");
  });

  it("finds the same cap written as a product", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/product.ts", "const batchItemCap = 20 * 5;");
    expect(findLiteralContractConstants(sourcesIn(root), constants)).toHaveLength(1);
  });

  it("does not fire on the number alone, which is one of the commonest integers there is", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/percent.ts", "const percentage = 100;");
    expect(findLiteralContractConstants(sourcesIn(root), constants)).toEqual([]);
  });

  it("does not fire on a line that reads the constant and then bounds it", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/reads.ts", "const items = Math.min(requested, CONTRACT_LIMITS.max_batch_items, 100);");
    expect(findLiteralContractConstants(sourcesIn(root), constants)).toEqual([]);
  });

  it("does not fire on a date fragment, because 06 is not an integer literal", () => {
    const root = makeTemporaryRepo();
    // `400` here is inside a string; `2026-04-00` would offer a leading-zero
    // fragment. Both are shapes an earlier draft of this lint misread.
    seedSource(root, "seeded/dates.ts", 'const feedFloorDay = parseDay("2026-04-00T00:00:00.400Z");');
    expect(findLiteralContractConstants(sourcesIn(root), constants)).toEqual([]);
  });

  it("does not fire on the number written inside a sentence explaining it", () => {
    const root = makeTemporaryRepo();
    seedSource(root, "seeded/prose.ts", 'const note = "the batch cap is 100 items";');
    expect(findLiteralContractConstants(sourcesIn(root), constants)).toEqual([]);
  });

  it("distinguishes `recorded` from `record`, so a timestamp helper is not a count", () => {
    const root = makeTemporaryRepo();
    const withRecordSchemas = [{ name: "counts.record_schemas", value: 6, contextWords: ["record", "schemas"] }];
    seedSource(root, "seeded/clock.ts", "const floor = canonicalRecordedAt(6);");
    expect(findLiteralContractConstants(sourcesIn(root), withRecordSchemas)).toEqual([]);
  });
});

describe("the source views the detectors read", () => {
  it("blanks comments without moving a single line", () => {
    const text = "const a = 1; // note\n/* block\n   spans */\nconst b = 2;\n";
    const stripped = stripComments(text);
    expect(stripped.split("\n")).toHaveLength(text.split("\n").length);
    expect(stripped).not.toContain("note");
    expect(stripped).toContain("const b = 2;");
  });

  it("blanks string contents but keeps the quotes and the line count", () => {
    const code = 'const a = "one hundred";\nconst b = `two\nlines`;\n';
    const stripped = stripStrings(code);
    expect(stripped.split("\n")).toHaveLength(code.split("\n").length);
    expect(stripped).not.toContain("hundred");
    // Quotes survive and the content becomes spaces, so column offsets hold.
    expect(stripped).toContain('const a = "           ";');
  });
});
