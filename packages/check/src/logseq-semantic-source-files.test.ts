import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkImportableSemanticSourceFiles } from "./logseq-semantic-source-files";

describe("semantic source file walker", () => {
  it("includes empty supported Markdown only when the caller opts in", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-source-walker-"));
    const pages = join(root, "pages");
    const empty = join(pages, "Synthetic Empty.md");
    const nonempty = join(pages, "Synthetic Nonempty.md");
    try {
      await mkdir(pages, { recursive: true });
      await writeFile(empty, "", "utf8");
      await writeFile(nonempty, "- Synthetic nonempty note.", "utf8");
      const base = {
        root,
        sourceKind: "logseq" as const,
        mode: "logseq-notes" as const,
        maxFiles: 100,
        offset: 0,
        maxFileBytes: 1024
      };

      await expect(walkImportableSemanticSourceFiles(base)).resolves.toEqual([nonempty]);
      await expect(walkImportableSemanticSourceFiles({ ...base, include_empty: true })).resolves.toEqual([
        empty,
        nonempty
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
