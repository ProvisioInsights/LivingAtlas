import { describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSemanticSourceDiscoveryComplete,
  discoverImportableSemanticSourceFiles,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

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

  it("attests metadata-safe skip reasons and fails closed on incomplete discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-source-discovery-"));
    const pages = join(root, "pages");
    const unreadable = join(pages, "D Unreadable.md");
    try {
      await mkdir(pages, { recursive: true });
      await writeFile(join(pages, "A Selected.md"), "- selected", "utf8");
      await writeFile(join(pages, "B Capped.md"), "- capped", "utf8");
      await writeFile(join(pages, "C Oversize.md"), "x".repeat(32), "utf8");
      await writeFile(unreadable, "- unreadable", "utf8");
      await chmod(unreadable, 0o000);
      await writeFile(join(pages, "Unsupported.txt"), "unsupported", "utf8");
      await writeFile(join(pages, ".Hidden.md"), "- hidden", "utf8");
      try {
        await symlink(join(pages, "A Selected.md"), join(pages, "Linked File.md"), "file");
        await symlink(pages, join(root, "Linked Directory"), "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      const discovery = await discoverImportableSemanticSourceFiles({
        root,
        sourceKind: "logseq",
        mode: "logseq-notes",
        maxFiles: 1,
        offset: 0,
        maxFileBytes: 16,
        include_empty: true
      });
      expect(discovery.counts).toEqual({
        selected: 1,
        unsupported: 1,
        hidden: 1,
        oversize: 1,
        unreadable: 1,
        cap: 1,
        symlink: 2
      });
      expect(() => assertSemanticSourceDiscoveryComplete(discovery.counts)).toThrow(
        "semantic source discovery incomplete: oversize=1 unreadable=1 cap=1 symlink=2"
      );
      try {
        assertSemanticSourceDiscoveryComplete(discovery.counts);
      } catch (error) {
        expect(String(error)).not.toContain(root);
        expect(String(error)).not.toContain("Unreadable.md");
      }
    } finally {
      await chmod(unreadable, 0o600).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("counts only eligible files beyond offset plus selection as cap omissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-source-cap-"));
    try {
      await mkdir(join(root, "pages"), { recursive: true });
      for (const name of ["A", "B", "C"]) {
        await writeFile(join(root, "pages", `${name}.md`), `- ${name}`, "utf8");
      }
      const discovery = await discoverImportableSemanticSourceFiles({
        root,
        sourceKind: "logseq",
        mode: "logseq-notes",
        maxFiles: 1,
        offset: 1,
        maxFileBytes: 1024,
        include_empty: true
      });

      expect(discovery.selected_paths).toEqual([join(root, "pages", "B.md")]);
      expect(discovery.counts).toMatchObject({ selected: 1, cap: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the legacy walker closed instead of silently omitting a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-source-walker-symlink-"));
    const pages = join(root, "pages");
    try {
      await mkdir(pages, { recursive: true });
      const source = join(pages, "Synthetic Source.md");
      await writeFile(source, "- source", "utf8");
      try {
        await symlink(source, join(pages, "Synthetic Link.md"), "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      await expect(walkImportableSemanticSourceFiles({
        root,
        sourceKind: "logseq",
        mode: "logseq-notes",
        maxFiles: 10,
        offset: 0,
        maxFileBytes: 1024,
        include_empty: true
      })).rejects.toThrow("semantic source discovery incomplete: symlink=1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the discovery root itself is a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-source-root-symlink-"));
    const realRoot = join(root, "real-source");
    const linkedRoot = join(root, "linked-source");
    try {
      await mkdir(join(realRoot, "pages"), { recursive: true });
      await writeFile(join(realRoot, "pages", "Synthetic.md"), "- source", "utf8");
      try {
        await symlink(realRoot, linkedRoot, "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        throw error;
      }

      await expect(discoverImportableSemanticSourceFiles({
        root: linkedRoot,
        sourceKind: "logseq",
        mode: "logseq-notes",
        maxFiles: 10,
        offset: 0,
        maxFileBytes: 1024,
        include_empty: true
      })).rejects.toThrow("semantic source root must not be a symlink");
      await expect(walkImportableSemanticSourceFiles({
        root: linkedRoot,
        sourceKind: "logseq",
        mode: "logseq-notes",
        maxFiles: 10,
        offset: 0,
        maxFileBytes: 1024,
        include_empty: true
      })).rejects.toThrow("semantic source root must not be a symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
