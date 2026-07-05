import { describe, expect, it } from "vitest";
import { buildOfferingItemReviewPacket } from "./logseq-offering-item-review-packet";

describe("Logseq offering/item review packet", () => {
  it("extracts local-private review candidates without source paths", () => {
    const packet = buildOfferingItemReviewPacket({
      pathRedactionSecret: "fixture-path-redaction-secret-0001",
      sourceMode: "markdown-only",
      generatedAt: "2026-06-24T00:00:00.000Z",
      files: [
        {
          source_path: "pages/Synthetic Product.md",
          source_kind: "logseq",
          markdown: [
            "type:: product",
            "provider:: [[Synthetic Vendor]]",
            "",
            "- Synthetic receipt for a subscription renewal from Synthetic Vendor.",
            "- Prepared a synthetic deck for [[Synthetic Project]].",
            "- Synthetic flight DL123 has seat 2A and a hotel reservation."
          ].join("\n")
        }
      ]
    });

    expect(packet).toMatchObject({
      packet_schema: "living-atlas-logseq-offering-item-review-packet:v1",
      plaintext_policy: "local-private-review-packet",
      source_path_policy: "redacted",
      covered_file_count: 1,
      truncated: false
    });
    expect(packet.reason_counts).toMatchObject({
      "explicit-offering-or-item": 1,
      "provider-or-model-link": 1,
      "purchase-or-payment": 1,
      "creation-or-deliverable": 1,
      "travel-or-reservation": 1
    });
    expect(packet.candidates.map((candidate) => candidate.kind)).toEqual(expect.arrayContaining([
      "explicit-offering-or-item",
      "provider-or-model-link",
      "purchase-or-payment",
      "creation-or-deliverable",
      "travel-or-reservation"
    ]));
    expect(JSON.stringify(packet)).not.toContain("pages/Synthetic");
    expect(JSON.stringify(packet)).not.toContain("/tmp/");
  });
});
