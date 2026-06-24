import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticInventoryReport } from "./logseq-semantic-inventory";

describe("Logseq semantic inventory report", () => {
  it("counts schema-relevant properties, refs, and assets without source paths or plaintext values", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-inventory-"));
    try {
      await mkdir(join(root, "pages"), { recursive: true });
      await writeFile(join(root, "pages", "Synthetic Org.md"), [
        "type:: organization",
        "subtype:: company",
        "aliases:: Synthetic Co, [[Synthetic Company]]",
        "founded-year:: 2024",
        "headquarters:: [[Synthetic City]]",
        "custom-secret-key:: hidden-value",
        "",
        "- see [[Synthetic Person]] and ((block-ref-001)) #synthetic",
        "- ![asset](../assets/synthetic.png)"
      ].join("\n"));

      const report = await buildSemanticInventoryReport({
        root,
        pathRedactionSecret: "fixture-path-redaction-secret-0001",
        sourceKind: "logseq",
        sourceMode: "markdown-only"
      });

      expect(report.file_count).toBe(1);
      expect(report.endpoint_type_counts.organization).toBe(1);
      expect(report.totals.accepted_endpoint_type_pages).toBe(1);
      expect(report.totals.rejected_endpoint_type_pages).toBe(0);
      expect(report.totals.page_properties).toBe(6);
      expect(report.known_property_key_counts).toMatchObject({
        aliases: 1,
        "founded-year": 1,
        headquarters: 1,
        subtype: 1,
        type: 1
      });
      expect(report.totals.unknown_property_keys).toBe(1);
      expect(Object.keys(report.unknown_property_key_hash_counts)).toHaveLength(1);
      expect(report.totals.wikilinks).toBe(3);
      expect(report.totals.hash_tags).toBe(1);
      expect(report.totals.block_refs).toBe(1);
      expect(report.totals.asset_refs).toBe(1);
      expect(report.totals.date_like_properties).toBe(1);
      expect(JSON.stringify(report)).not.toContain("Synthetic Org");
      expect(JSON.stringify(report)).not.toContain("hidden-value");
      expect(JSON.stringify(report)).not.toContain("custom-secret-key");
      expect(JSON.stringify(report)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
