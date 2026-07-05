import { describe, expect, it } from "vitest";
import { buildOfferingItemReviewGroupedPacket } from "./logseq-offering-item-review-grouped-packet";
import { buildOfferingItemReviewPacket } from "./logseq-offering-item-review-packet";
import {
  buildOfferingItemReviewReport,
  OfferingItemReviewResolutionMapSchema
} from "./logseq-offering-item-review-report";

function fixtureGroupedPacket() {
  const packet = buildOfferingItemReviewPacket({
    pathRedactionSecret: "fixture-path-redaction-secret-0001",
    sourceMode: "markdown-only",
    generatedAt: "2026-06-24T00:00:00.000Z",
    files: [
      {
        source_path: "pages/Synthetic Offering.md",
        source_kind: "logseq",
        markdown: [
          "type:: product",
          "provider:: [[Synthetic Vendor]]",
          "- Synthetic receipt for a subscription renewal from Synthetic Vendor."
        ].join("\n")
      }
    ]
  });
  return buildOfferingItemReviewGroupedPacket({
    packet,
    generatedAt: "2026-06-24T00:01:00.000Z"
  });
}

describe("Logseq offering/item review report", () => {
  it("reports resolution coverage without leaking snippets", () => {
    const groupedPacket = fixtureGroupedPacket();
    const group = groupedPacket.groups[0]!;
    const resolutionMap = OfferingItemReviewResolutionMapSchema.parse({
      resolution_schema: "living-atlas-logseq-offering-item-review-resolution-map:v1",
      plaintext_policy: "local-private-offering-item-review-resolution-map",
      generated_at: "2026-06-24T00:02:00.000Z",
      resolutions: [
        {
          group_id: group.group_id,
          group_hash: group.group_hash,
          decision: "defer",
          confidence: "high",
          normalized_facts: []
        }
      ]
    });

    const report = buildOfferingItemReviewReport({
      groupedPacket,
      resolutionMap
    });

    expect(report.resolutions.resolution_count).toBe(1);
    expect(report.resolutions.matched_resolution_count).toBe(1);
    expect(report.resolutions.unresolved_group_count).toBe(groupedPacket.group_count - 1);
    expect(JSON.stringify(report)).not.toContain("Synthetic Vendor");
    expect(JSON.stringify(report)).not.toContain("Synthetic receipt");
  });
});
