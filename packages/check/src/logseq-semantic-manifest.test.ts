import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMarkdownSourceRef } from "@living-atlas/importer";
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
      expect(manifest.source_kind).toBe("logseq");
      expect(manifest.source_mode).toBe("logseq-notes");
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

  it("discovers extensionless Logseq pages and journals while skipping non-markdown attachments", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-manifest-"));
    const pathRedactionSecret = "fixture-path-redaction-secret-0002";
    try {
      await mkdir(join(root, "pages"), { recursive: true });
      await mkdir(join(root, "journals"), { recursive: true });
      await mkdir(join(root, "assets"), { recursive: true });

      await writeFile(join(root, "pages", "Synthetic Private Page"), "- extensionless page\n");
      await writeFile(join(root, "journals", "2026_06_23"), "- extensionless journal\n");
      await writeFile(join(root, "assets", "Synthetic Attachment.png"), "not markdown");
      await writeFile(join(root, "assets", "Synthetic Attachment.pdf"), "%PDF-1.7");

      const manifest = await createSemanticCorpusManifest({
        root,
        pathRedactionSecret,
        sourceKind: "logseq",
        sourceMode: "logseq-extensionless-only",
        maxFileBytes: 64,
        now: "2026-06-23T00:00:00.000Z"
      });
      const entryFor = (sourcePath: string) => manifest.entries.find((entry) => (
        entry.source_path_ref === createMarkdownSourceRef(sourcePath, { path_redaction_secret: pathRedactionSecret })
      ));

      expect(manifest.total_entries).toBe(4);
      expect(manifest.source_kind).toBe("logseq");
      expect(manifest.source_mode).toBe("logseq-extensionless-only");
      expect(entryFor("pages/Synthetic Private Page")).toMatchObject({
        discovery_status: "readable",
        terminal_decision: "pending",
        reason_code: "ready"
      });
      expect(entryFor("journals/2026_06_23")).toMatchObject({
        discovery_status: "readable",
        terminal_decision: "pending",
        reason_code: "ready"
      });
      expect(entryFor("assets/Synthetic Attachment.png")).toMatchObject({
        discovery_status: "ignored-extension",
        terminal_decision: "skipped",
        reason_code: "ignored-extension"
      });
      expect(entryFor("assets/Synthetic Attachment.pdf")).toMatchObject({
        discovery_status: "ignored-extension",
        terminal_decision: "skipped",
        reason_code: "ignored-extension"
      });
      expect(manifest.entries.filter((entry) => entry.discovery_status === "readable")).toHaveLength(2);
      expect(manifest.entries.filter((entry) => entry.discovery_status === "ignored-extension")).toHaveLength(2);
      expect(manifest.entries.filter((entry) => entry.terminal_decision === "pending")).toHaveLength(2);
      expect(manifest.entries.filter((entry) => entry.terminal_decision === "skipped")).toHaveLength(2);
      expect(manifest.entries.filter((entry) => entry.reason_code === "ignored-extension")).toHaveLength(2);
      expect(JSON.stringify(manifest)).not.toContain("Synthetic Private Page");
      expect(JSON.stringify(manifest)).not.toContain("Synthetic Attachment");
      expect(JSON.stringify(manifest)).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
