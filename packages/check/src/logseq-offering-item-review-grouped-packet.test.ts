import { describe, expect, it } from "vitest";
import { buildOfferingItemReviewPacket } from "./logseq-offering-item-review-packet";
import {
  buildOfferingItemReviewGroupedPacket,
  buildOfferingItemReviewGroupedReport
} from "./logseq-offering-item-review-grouped-packet";

describe("Logseq offering/item grouped review packet", () => {
  it("groups local-private candidates and reports counts without snippets", () => {
    const packet = buildOfferingItemReviewPacket({
      pathRedactionSecret: "fixture-path-redaction-secret-0001",
      sourceMode: "markdown-only",
      generatedAt: "2026-06-24T00:00:00.000Z",
      files: [
        {
          source_path: "pages/Synthetic Travel.md",
          source_kind: "logseq",
          markdown: [
            "- Synthetic flight DL123 has seat 2A and a hotel reservation.",
            "- Synthetic flight DL456 has seat 3B and a hotel reservation.",
            "- Synthetic receipt for a subscription renewal from Synthetic Vendor.",
            "- Synthetic receipt for a subscription renewal from Synthetic Vendor."
          ].join("\n")
        }
      ]
    });

    const groupedPacket = buildOfferingItemReviewGroupedPacket({
      packet,
      generatedAt: "2026-06-24T00:00:01.000Z"
    });
    const report = buildOfferingItemReviewGroupedReport(groupedPacket);

    expect(groupedPacket.packet_schema).toBe("living-atlas-logseq-offering-item-review-grouped-packet:v1");
    expect(groupedPacket.group_count).toBeLessThan(packet.candidate_count);
    expect(groupedPacket.groups.some((group) => group.representative_snippets.some((snippet) => snippet.includes("Synthetic flight")))).toBe(true);
    expect(report.report_schema).toBe("living-atlas-logseq-offering-item-review-grouped-report:v1");
    expect(report.plaintext_policy).toBe("hash-counts-refs-only");
    expect(report.source.reduction_count).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("Synthetic flight");
    expect(JSON.stringify(report)).not.toContain("Synthetic Vendor");
  });
});
