import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { repoRoot } from "./sources.js";

/**
 * The subjects ADR 0017 removed, and what a reader should be sent to instead.
 *
 * Every entry is a string that appeared in a live document before the
 * demolition. The `replacement` is not decoration: a finding that says "this is
 * wrong" without saying "here is what replaced it" gets answered by deleting the
 * sentence, and then the documentation is merely shorter rather than true.
 *
 * Note what is NOT here: `packages/local-mcp` itself, and `@living-atlas/local-mcp`.
 * The package survives as a graph-command library. Only the paths inside it that
 * were deleted are retired, which is why the needles are full paths.
 */

export type RetiredSubject = {
  /** The literal string a live document must not contain. */
  needle: string;
  /** What replaced it, in a sentence a reader can act on. */
  replacement: string;
};

export const RETIRED_SUBJECTS: readonly RetiredSubject[] = [
  {
    needle: "packages/local-review-site",
    replacement:
      "The review site is retired (ADR 0017). Its workflow is the operator plane's — see " +
      "atlas.ops.review.queue.read.v1 in packages/atlas-mcp/src/operator. Its exact-preservation " +
      "auto-apply planner moved to packages/check/src/review-auto-apply.ts."
  },
  {
    needle: "@living-atlas/local-review-site",
    replacement:
      "The review site package is deleted (ADR 0017). packages/check/src/review-auto-apply.ts holds " +
      "the only module that survived it."
  },
  {
    needle: "docs/mcp-tools.md",
    replacement:
      "The 30-tool catalog is deleted (ADR 0017). The published consumer contract is " +
      "docs/contract/atlas-knowledge-contract-2026.08.0.md and packages/atlas-contract/schema/."
  },
  {
    needle: "docs/architecture/local-mcp-clients.md",
    replacement:
      "Connection instructions for the retired daemon are deleted (ADR 0017). See " +
      "docs/getting-started.md for the 2026-07-28 surface."
  },
  {
    needle: "packages/local-mcp/src/server.ts",
    replacement:
      "The 30-tool registration is deleted (ADR 0017). The consumer server is packages/atlas-mcp/src/server.ts."
  },
  {
    needle: "packages/local-mcp/src/cli.ts",
    replacement:
      "The legacy stdio entry point is deleted (ADR 0017). Use packages/atlas-mcp/src/cli.ts, or " +
      "npm run atlas-mcp:consumer."
  },
  {
    needle: "packages/local-mcp/src/daemon.ts",
    replacement:
      "The socket daemon is deleted (ADR 0017). The replacement serves stdio only; no daemon, no socket."
  },
  {
    needle: "packages/local-mcp/src/proxy.ts",
    replacement: "The stdio-to-socket proxy is deleted (ADR 0017); there is no daemon left to proxy to."
  },
  {
    needle: "packages/local-mcp/src/http-listener.ts",
    replacement:
      "The loopback Streamable HTTP listener is deleted (ADR 0017). Remote HTTP is the worker's surface, " +
      "not the local one's."
  },
  {
    needle: "packages/local-mcp/src/review.ts",
    replacement:
      "review_list / review_read / review_decide are deleted (ADR 0017). The operator plane serves the " +
      "review queue."
  },
  {
    needle: "local-mcp:fixture",
    replacement:
      "The fixture-server script is removed (ADR 0017). Use npm run atlas-mcp:consumer -- --audit-log <path>."
  },
  {
    needle: "mcp:inspect:local",
    replacement:
      "The Inspector script is removed (ADR 0017): the Inspector opens with a 2025-era initialize and the " +
      "replacement runs legacy: 'reject'. The published schemas under packages/atlas-contract/schema/ are " +
      "the discovery surface."
  },
  {
    needle: "run-local-mcp.sh",
    replacement:
      "The deploy launcher targets a binary that no longer exists (ADR 0017). Client configuration for the " +
      "replacement is written when the durable-store binding lands."
  }
] as const;

export type RetiredSubjectFinding = RetiredSubject & {
  /** Repo-relative path of the offending document. */
  file: string;
};

/**
 * Directories whose Markdown is not a live document.
 *
 * `docs/superpowers` holds dated plan artifacts describing work as it was done.
 * Rewriting them would be editing history, which is the practice the
 * supersede-don't-edit rule exists to prevent.
 */
const NOT_LIVE_DOCUMENTATION = new Set(["node_modules", ".git", "superpowers"]);

/**
 * A document is a SUPERSESSION RECORD if its header says so — either that it was
 * superseded, or that it supersedes something. Records may name what they
 * retired; that is what makes them records.
 *
 * The header, not the body: scanning the whole document would let anything
 * exempt itself by using the word once, anywhere, including in a sentence about
 * some other document.
 */
const HEADER_LINES = 12;

function isSupersessionRecord(body: string): boolean {
  return body
    .split("\n", HEADER_LINES)
    .some((line) => /supersed(ed|es)/i.test(line));
}

/**
 * A live document MAY name a retired subject in a paragraph that also cites the
 * ADR which retired it.
 *
 * Without this the gate makes the documentation worse rather than better: the
 * most useful thing a reader with a stale bookmark can find is the old name next
 * to what replaced it, and a rule that forbids writing the old name deletes
 * exactly that. Requiring the citation in the same paragraph is the difference
 * between a retirement notice and an instruction — instructions do not cite the
 * decision that deleted them, and cannot do so by accident.
 */
const RETIREMENT_CITATION = /ADR[\s-]?0017|adr-0017/i;

/** Markdown blocks, split on blank lines. Paragraph is the unit a claim lives in. */
function paragraphs(body: string): string[] {
  return body.split(/\n\s*\n/);
}

function markdownFiles(root: string, directory: string, found: string[]): void {
  for (const entry of readdirSync(directory)) {
    if (NOT_LIVE_DOCUMENTATION.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      markdownFiles(root, full, found);
    } else if (entry.endsWith(".md")) {
      found.push(full);
    }
  }
}

/**
 * Every live Markdown document under `docs/`, plus `README.md`.
 *
 * Deliberately not the whole tree: `ATLAS-REWRITE-PLAN.md` is a working plan
 * that names, by design, every package it intends to delete — including ones it
 * has not deleted yet. Gating it would force the plan to stop naming its own
 * subjects.
 */
export function findLiveDocumentsNamingRetiredSubjects(root = repoRoot()): RetiredSubjectFinding[] {
  const files: string[] = [];
  try {
    markdownFiles(root, join(root, "docs"), files);
  } catch {
    // A tree with no docs/ directory is a legitimate fixture, not an error.
  }
  const readme = join(root, "README.md");
  try {
    if (statSync(readme).isFile()) files.push(readme);
  } catch {
    // likewise
  }

  const findings: RetiredSubjectFinding[] = [];
  for (const file of files.sort()) {
    const body = readFileSync(file, "utf8");
    if (isSupersessionRecord(body)) continue;
    const blocks = paragraphs(body);
    for (const subject of RETIRED_SUBJECTS) {
      const naming = blocks.filter((block) => block.includes(subject.needle));
      if (naming.length === 0) continue;
      if (naming.every((block) => RETIREMENT_CITATION.test(block))) continue;
      findings.push({ ...subject, file: relative(root, file).split(sep).join("/") });
    }
  }
  return findings;
}
