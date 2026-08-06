import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { baselinePath } from "./baseline.js";
import { goldenDirectory } from "./gate-golden.js";
import { corpusPath } from "./gate-corpus.js";
import { lockPath, schemaRoot } from "./gate-immutable-revisions.js";
import { repoRoot } from "./sources.js";

/**
 * A throwaway copy of everything a gate reads, so a test can BREAK one of them.
 *
 * Every gate here takes a repository root rather than finding its own, and this
 * is why. A gate nobody can point at a broken tree is a gate nobody can prove
 * fails, and the whole argument for these five is that they fail — so each one
 * has a permanent, committed negative control that seeds the exact defect it
 * exists to catch and asserts the wording of the refusal.
 *
 * Under `os.tmpdir()`, always. Nothing in this package reads or writes anything
 * outside the repository and a temporary directory.
 */
export function makeTemporaryRepo(): string {
  const source = repoRoot();
  const root = mkdtempSync(join(tmpdir(), "atlas-gates-"));

  mkdirSync(join(root, "packages", "atlas-contract", "schema"), { recursive: true });
  cpSync(join(schemaRoot(source), CONTRACT_REVISION), join(schemaRoot(root), CONTRACT_REVISION), {
    recursive: true
  });
  cpSync(lockPath(source), lockPath(root));

  mkdirSync(join(root, "packages", "atlas-gates", "baseline"), { recursive: true });
  cpSync(baselinePath(CONTRACT_REVISION, source), baselinePath(CONTRACT_REVISION, root));

  cpSync(goldenDirectory(source), goldenDirectory(root), { recursive: true });

  mkdirSync(join(root, "packages", "atlas-gates", "corpus"), { recursive: true });
  cpSync(corpusPath(source), corpusPath(root));

  return root;
}

/** Write a synthetic source file into a temporary tree, creating its directory. */
export function seedSource(root: string, relativePath: string, contents: string): void {
  const full = join(root, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}
