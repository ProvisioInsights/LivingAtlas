import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Reading TypeScript as text, deliberately.
 *
 * These gates lint for a defect that lives in the SOURCE and not in the built
 * behaviour: the same limit written down twice, the same tool list declared
 * twice. A type checker cannot see that — both copies type-check — and a runtime
 * probe cannot see it either, because on the transport under test only one of
 * the two copies is reached. That is precisely how `LocalBatchMaxItems = 100`
 * and `RemoteBatchMaxItems = 10` survived: every test ran on one transport.
 *
 * Text scanning has one failure mode that matters, and it is handled here rather
 * than in each detector: a match inside a COMMENT is not code. A gate that
 * flagged the sentence explaining why a rule exists would make writing the
 * explanation a build failure, so comments are blanked before any detector runs.
 */

export type SourceFile = {
  /** Absolute, for reading. */
  path: string;
  /** Repo-relative with forward slashes, for findings and for the quarantine ledger. */
  relative: string;
  /** As on disk. */
  text: string;
  /** Comments blanked, line numbering and column offsets preserved. */
  code: string;
  /**
   * Comments AND string literals blanked.
   *
   * The two views exist because the detectors disagree about what a string
   * literal is. To the tool-name-set detector a string literal is the evidence:
   * `["review_list", "review_read"]` is the redeclared set. To the
   * literal-constant detector it is prose — a number inside a sentence explaining
   * a limit is not a second copy of that limit, and a lint that made writing the
   * explanation a build failure would be answered by deleting explanations.
   */
  codeWithoutStrings: string;
};

export function repoRoot(): string {
  // packages/atlas-gates/src/sources.ts -> repository root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", ".git", "schema"]);

function walk(directory: string, found: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(full, found);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
}

export type CollectOptions = {
  /** Absolute or repo-relative directories and files to read. */
  roots: readonly string[];
  /**
   * Repo-relative paths that this plane AUTHORS. A file that authors a schema or
   * a limit is not restating one, so the detectors skip it — but it has to be
   * named, because "the file that is allowed to hold the number" is a decision
   * and an unnamed exemption is a hole nobody reviews.
   */
  authoring?: readonly string[];
  /** Repo-relative paths to ignore entirely, such as a plane's own tests. */
  exclude?: readonly RegExp[];
  root?: string;
};

export function collectSources(options: CollectOptions): SourceFile[] {
  const root = options.root ?? repoRoot();
  const authoring = new Set(options.authoring ?? []);
  const files: string[] = [];

  for (const entry of options.roots) {
    const full = entry.startsWith(sep) ? entry : join(root, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, files);
    else files.push(full);
  }

  const collected: SourceFile[] = [];
  for (const path of [...new Set(files)].sort()) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (authoring.has(relativePath)) continue;
    if ((options.exclude ?? []).some((pattern) => pattern.test(relativePath))) continue;
    const text = readFileSync(path, "utf8");
    const code = stripComments(text);
    collected.push({ path, relative: relativePath, text, code, codeWithoutStrings: stripStrings(code) });
  }
  return collected;
}

/**
 * Blank comments; keep string literals, whitespace, and every newline.
 *
 * String literals SURVIVE, and that is not an oversight. A tool name is a string
 * literal — `["review_list", "review_read"]` is the redeclared set, and blanking
 * strings would blank the evidence. Comments are replaced character-for-
 * character with spaces so that a finding's reported line number is the line the
 * reader will open.
 */
export function stripComments(text: string): string {
  let out = "";
  let index = 0;
  const blank = (slice: string): string => slice.replace(/[^\n]/g, " ");

  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];

    if (character === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      let cursor = index + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      out += text.slice(index, cursor);
      index = cursor;
      continue;
    }

    out += character;
    index += 1;
  }
  return out;
}

/**
 * Blank the CONTENTS of every string and template literal, keeping the quotes.
 *
 * Quotes are kept so that a scanner can still tell an empty string from a hole,
 * and every newline inside a template literal survives so line numbers do not
 * shift. Interpolations are blanked along with the rest: a number inside
 * `${...}` is inside a string as far as this view is concerned, and the two
 * detectors that use this view are not looking for expressions.
 */
export function stripStrings(code: string): string {
  let out = "";
  let index = 0;
  const blank = (slice: string): string => slice.replace(/[^\n]/g, " ");

  while (index < code.length) {
    const character = code[index];
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      let cursor = index + 1;
      while (cursor < code.length) {
        if (code[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (code[cursor] === quote) break;
        cursor += 1;
      }
      out += quote + blank(code.slice(index + 1, cursor)) + (cursor < code.length ? quote : "");
      index = cursor + 1;
      continue;
    }
    out += character;
    index += 1;
  }
  return out;
}

/** 1-indexed line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}
