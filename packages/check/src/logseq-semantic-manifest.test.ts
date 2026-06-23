import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSemanticCorpusManifest } from "./logseq-semantic-manifest";

describe("Logseq semantic corpus manifest", () => {
  it("accounts for readable, empty, oversized, and ignored files without raw paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-manifest-"));
    try {
      await writeFile(join(root, "Readable Private Note.md"), "- ok\n");
      await writeFile(join(root, "Empty Private Note.md"), "");
      await writeFile(join(root, "Oversized Private Note.md"), "x".repeat(128));
      await writeFile(join(root, "Attachment Secret.txt"), "private attachment name");

      const manifest = await createSemanticCorpusManifest({
        root,
        pathRedactionSecret: "fixture-path-redaction-secret-0001",
        sourceKind: "logseq",
        maxFileBytes: 64,
        now: "2026-06-23T00:00:00.000Z"
      });

      expect(manifest.total_entries).toBe(4);
      expect(manifest.entries.map((entry) => entry.discovery_status).sort()).toEqual([
        "empty",
        "ignored-extension",
        "oversized",
        "readable"
      ]);
      expect(manifest.entries.filter((entry) => entry.terminal_decision === "pending")).toHaveLength(1);
      expect(manifest.entries.filter((entry) => entry.terminal_decision === "skipped")).toHaveLength(2);
      expect(manifest.entries.filter((entry) => entry.terminal_decision === "quarantined")).toHaveLength(1);
      expect(JSON.stringify(manifest)).not.toContain("Readable Private Note");
      expect(JSON.stringify(manifest)).not.toContain("Attachment Secret");
      expect(JSON.stringify(manifest)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
