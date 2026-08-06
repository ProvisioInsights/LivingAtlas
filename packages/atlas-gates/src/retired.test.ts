import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RETIRED_SUBJECTS, findLiveDocumentsNamingRetiredSubjects } from "./retired.js";
import { repoRoot } from "./sources.js";

/**
 * A live document may not name a package, path or command that no longer
 * exists.
 *
 * The failure mode this catches is not "a broken link". It is a reader
 * following working instructions to a binary that was deleted, concluding the
 * checkout is broken, and going looking for the problem in the code. Every
 * subject below was reachable from `README.md` or `docs/` on the morning this
 * ran.
 *
 * Three exemptions, and each is the rule rather than a hole in it:
 *
 *  - a document whose HEADER declares a supersession — in either direction — may
 *    name what it described. That is what a supersession record is, and the
 *    alternative, editing the body of a decision record until it describes
 *    current behaviour, destroys the record;
 *  - a paragraph that cites ADR 0017 alongside the old name is a RETIREMENT
 *    NOTICE, not an instruction. Forbidding it would delete the one thing a
 *    reader with a stale bookmark needs: the old name next to its replacement;
 *  - `docs/superpowers/` is excluded. Those are dated plan artifacts of work
 *    that was done at the time. Rewriting them is editing history.
 */

describe("the retired-subject scan", () => {
  it("finds nothing in this repository's live documents", () => {
    expect(findLiveDocumentsNamingRetiredSubjects(repoRoot())).toEqual([]);
  });

  it("names a non-trivial set of subjects, so it cannot pass by having nothing to look for", () => {
    expect(RETIRED_SUBJECTS.length).toBeGreaterThanOrEqual(8);
    for (const subject of RETIRED_SUBJECTS) {
      expect(subject.needle.length, subject.needle).toBeGreaterThan(8);
      expect(subject.replacement.length, subject.needle).toBeGreaterThan(20);
    }
  });
});

/** A throwaway tree with one doc in it, so each case below tests exactly one rule. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "living-atlas-retired-scan-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

describe("the retired-subject scan, against seeded trees", () => {
  it("fails a live doc that names a retired path", () => {
    const root = tree({
      "docs/how-to.md": "Run `npx tsx packages/local-mcp/src/cli.ts` to start the server.\n"
    });
    try {
      const found = findLiveDocumentsNamingRetiredSubjects(root);
      expect(found).toHaveLength(1);
      expect(found[0]?.file).toBe("docs/how-to.md");
      expect(found[0]?.needle).toBe("packages/local-mcp/src/cli.ts");
      // The finding must carry the remedy. A gate that says "this is wrong" and
      // not "here is what replaced it" gets answered by deleting the sentence.
      expect(found[0]?.replacement).toContain("atlas-mcp");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a superseded document to name what it described", () => {
    const body = "# Local MCP Boundary\n\nStatus: **Superseded by ADR 0017**\n\nThe daemon in packages/local-mcp/src/daemon.ts owned the replica.\n";
    const root = tree({ "docs/architecture/local-mcp-boundary.md": body });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not accept a Superseded marker that appears below the header", () => {
    // Otherwise any document could exempt itself by mentioning the word once,
    // anywhere — including inside a paragraph about some other document.
    const body = `# Live Guide\n\nStatus: Draft\n\n${"filler\n".repeat(40)}\nThat boundary doc is Superseded.\n\nRun packages/local-mcp/src/daemon.ts.\n`;
    const root = tree({ "docs/live-guide.md": body });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows a retirement notice: the old name beside the ADR that removed it", () => {
    // The most useful thing a reader with a stale bookmark can find is the old
    // name next to what replaced it. A rule that forbade writing the old name
    // would delete exactly that.
    const root = tree({
      "docs/live-guide.md":
        "# Live Guide\n\nStatus: Draft\n\n`npm run local-mcp:fixture` is removed (ADR 0017); use\n`npm run atlas-mcp:consumer` instead.\n"
    });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still fails when the same document ALSO gives the old command as an instruction", () => {
    // The exemption is per-paragraph and must hold for every paragraph naming the
    // subject. One retirement notice does not license a live instruction three
    // sections later — which is exactly how a doc rots after a rename.
    const root = tree({
      "docs/live-guide.md":
        "# Live Guide\n\nStatus: Draft\n\n`npm run local-mcp:fixture` is removed (ADR 0017).\n\nTo start the server, run `npm run local-mcp:fixture`.\n"
    });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("excludes the dated plan archive, which records work as it was done", () => {
    const root = tree({
      "docs/superpowers/plans/2026-07-10-local-review-site.md":
        "- Create: `packages/local-review-site/src/server.ts`\n"
    });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports every subject a document names, not just the first", () => {
    const root = tree({
      "README.md": "See packages/local-review-site and run npm run local-mcp:fixture and docs/mcp-tools.md.\n"
    });
    try {
      const found = findLiveDocumentsNamingRetiredSubjects(root);
      expect(found.map((entry) => entry.needle).sort()).toEqual([
        "docs/mcp-tools.md",
        "local-mcp:fixture",
        "packages/local-review-site"
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fire on a word that merely contains a subject as a prefix", () => {
    // `packages/local-mcp` survives as a library and is named all over the repo.
    // Only the deleted PATHS inside it are retired, so the scan must not flag
    // the package itself.
    const root = tree({
      "docs/live.md": "The library `@living-atlas/local-mcp` and packages/local-mcp/src/local-graph.ts are kept.\n"
    });
    try {
      expect(findLiveDocumentsNamingRetiredSubjects(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
