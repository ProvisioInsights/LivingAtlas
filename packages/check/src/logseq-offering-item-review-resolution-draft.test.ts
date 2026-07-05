import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOfferingItemReviewGroupedPacket } from "./logseq-offering-item-review-grouped-packet";
import { buildOfferingItemReviewPacket } from "./logseq-offering-item-review-packet";
import {
  buildOfferingItemReviewResolutionDraft,
  buildOfferingItemReviewResolutionDraftReport
} from "./logseq-offering-item-review-resolution-draft";

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

describe("Logseq offering/item review resolution draft", () => {
  it("creates a conservative all-defer map without plaintext in the report", () => {
    const groupedPacket = fixtureGroupedPacket();
    const draft = buildOfferingItemReviewResolutionDraft({
      groupedPacket,
      generatedAt: "2026-06-24T00:02:00.000Z"
    });
    const report = buildOfferingItemReviewResolutionDraftReport({
      groupedPacket,
      draft,
      outputWritten: false
    });

    expect(draft.resolutions).toHaveLength(groupedPacket.group_count);
    expect(draft.resolutions.every((resolution) => resolution.decision === "defer")).toBe(true);
    expect(report.draft.defer_count).toBe(groupedPacket.group_count);
    expect(JSON.stringify(report)).not.toContain("Synthetic Vendor");
    expect(JSON.stringify(report)).not.toContain("Synthetic receipt");
  });

  it("writes a private draft through the CLI", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-offering-item-resolution-draft-"));
    try {
      const groupedPacket = fixtureGroupedPacket();
      const packetPath = join(root, "groups.json");
      const outputPath = join(root, "private", "resolutions.json");
      await writeFile(packetPath, JSON.stringify(groupedPacket, null, 2));

      const { spawnSync } = await import("node:child_process");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "packages/check/src/logseq-offering-item-review-resolution-draft.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_DRAFT_ACK: "write-local-private-offering-item-review-resolution-draft",
            LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_PATH: packetPath,
            LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_PATH: outputPath
          },
          encoding: "utf8"
        }
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("\"defer_count\"");
      expect(result.stdout).not.toContain("Synthetic Vendor");
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain("\"decision\": \"defer\"");
      expect(output).not.toContain("Synthetic Vendor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
