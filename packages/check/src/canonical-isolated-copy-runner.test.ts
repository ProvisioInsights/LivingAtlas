import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalIsolatedCopy, validateCanonicalIsolatedCopyRun } from "./canonical-isolated-copy-runner";

describe("canonical isolated-copy runner guard", () => {
  it("rejects missing acknowledgement, non-copy marker, and live source paths", () => {
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "", live_paths: [] })).toThrow("acknowledgement");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("copy marker");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/live/profile", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toThrow("live path");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/archive-copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("must not overlap");
    expect(validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toEqual({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy" });
  });

  it("reads only a designated source copy and writes an encrypted canonical-only Atlas store", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-copy-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    const sourceFile = join(source, "pages", "Synthetic.md");
    const content = "Synthetic sensitive content that must remain encrypted.";
    try {
      await (await import("node:fs/promises")).mkdir(join(source, "pages"), { recursive: true });
      await writeFile(sourceFile, content, "utf8");
      const result = await runCanonicalIsolatedCopy({ copy_dir: output, source_dir: source, acknowledgement: "run-canonical-isolated-copy", live_paths: [], authority_id: "la_authority_fixture0001", keyring_passphrase: "synthetic-isolated-copy-passphrase", source_kind: "logseq", source_mode: "logseq-notes" });
      expect(result).toMatchObject({ source_file_count: 1, canonical_object_count: expect.any(Number), generation: 1 });
      expect(await readFile(sourceFile, "utf8")).toBe(content);
      await expect(readFile(join(output, "graph", "snapshot.json"), "utf8")).resolves.not.toContain(content);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses to overwrite a nonempty isolated-copy output", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-isolated-copy-existing-"));
    const source = join(root, "source-copy");
    const output = join(root, "output", ".atlas-isolated-copy");
    try {
      await (await import("node:fs/promises")).mkdir(source, { recursive: true });
      await (await import("node:fs/promises")).mkdir(output, { recursive: true });
      await writeFile(join(output, "existing"), "do-not-overwrite");
      await expect(runCanonicalIsolatedCopy({ copy_dir: output, source_dir: source, acknowledgement: "run-canonical-isolated-copy", live_paths: [], authority_id: "la_authority_fixture0001", keyring_passphrase: "synthetic-isolated-copy-passphrase", source_kind: "logseq", source_mode: "logseq-notes" })).rejects.toThrow("output must be empty");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
