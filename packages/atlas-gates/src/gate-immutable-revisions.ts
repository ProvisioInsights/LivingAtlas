import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gateResult, type GateResult } from "./finding.js";
import { repoRoot } from "./sources.js";

/**
 * GATE 4 — RELEASED REVISIONS ARE IMMUTABLE.
 *
 * A revision is a promise about bytes. Once `schema/2026.08.0/` is released,
 * every consumer that fetched it is entitled to assume that what it holds is
 * what everybody else holds — and that assumption is the only reason a
 * `record_schema` literal is worth anything in 2031, when no server is present
 * to ask.
 *
 * So a released revision is frozen unconditionally. Not "frozen unless the
 * change is backwards-compatible", not "frozen unless it is only a description":
 * unconditionally. A change is a NEW DIRECTORY. The rule has no exceptions
 * because every exception is a judgement call made under deadline by whoever is
 * currently blocked, and "it's only a description" is exactly how a published
 * artifact becomes a moving target.
 *
 * Two independent checks, because either alone has a way to be wrong:
 *
 *   CONTENT   Every file's SHA-256 must equal the digest recorded in
 *             `schema/released.lock.json`. Works with no git, no history, and no
 *             network. Its weakness is that the lock is a file too, so somebody
 *             could edit both.
 *   GIT       A released revision that is tracked in git must have NO working-
 *             tree change of any kind under it — modified, staged, deleted, or
 *             newly added. This is the literal reading of "any diff touching a
 *             released directory fails", and it fails even when the lock was
 *             updated in the same change, which is precisely the case the
 *             content check cannot catch.
 *
 * The git check skips a directory with no tracked files at all: a revision that
 * has never been committed has no released baseline to diff against, and
 * refusing it would make it impossible to introduce a first one.
 */

export type ReleasedRevision = {
  revision: string;
  released_at: string;
  /** Why freezing this one matters. Not decoration — it is what a reader sees on failure. */
  note: string;
  /** Repo-relative path within the revision directory -> `sha256:<hex>`. */
  files: Record<string, string>;
};

export type ReleasedLock = {
  /** Read this before touching anything under a released directory. */
  contract: string;
  revisions: ReleasedRevision[];
};

export const RELEASED_LOCK_CONTRACT =
  "Released revisions are frozen. Do not edit a file under schema/<revision>/ and do not edit its " +
  "digests here to make a build pass: a consumer that fetched those bytes is entitled to assume " +
  "everybody else has the same ones. To change the contract, create schema/<next-revision>/ and add a " +
  "new entry below. This tool will add an entry for a revision it has never seen; it will never " +
  "modify one it has.";

export function lockPath(root = repoRoot()): string {
  return join(root, "packages", "atlas-contract", "schema", "released.lock.json");
}

export function schemaRoot(root = repoRoot()): string {
  return join(root, "packages", "atlas-contract", "schema");
}

export function readLock(root = repoRoot()): ReleasedLock {
  const path = lockPath(root);
  if (!existsSync(path)) return { contract: RELEASED_LOCK_CONTRACT, revisions: [] };
  return JSON.parse(readFileSync(path, "utf8")) as ReleasedLock;
}

export function serializeLock(lock: ReleasedLock): string {
  const revisions = [...lock.revisions].sort((left, right) => (left.revision < right.revision ? -1 : 1));
  return `${JSON.stringify({ contract: lock.contract, revisions }, null, 2)}\n`;
}

/** Every file under a revision directory, repo-relative to that directory, sorted. */
export function listRevisionFiles(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const next = join(current, entry.name);
      if (entry.isDirectory()) walk(next, `${prefix}${entry.name}/`);
      else if (entry.isFile()) found.push(`${prefix}${entry.name}`);
    }
  };
  walk(directory, "");
  return found;
}

export function digestFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function digestRevision(directory: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const file of listRevisionFiles(directory)) digests[file] = digestFile(join(directory, file));
  return digests;
}

type GitVerdict =
  /** Inside a repository, files are tracked, and nothing under the path differs. */
  | { kind: "clean" }
  | { kind: "dirty"; lines: string[] }
  /** No repository here, or the directory has never been committed: no baseline to diff against. */
  | { kind: "no-baseline" }
  /** Inside a repository and git still would not answer. That is a failure. */
  | { kind: "unavailable"; reason: string };

/**
 * What git says about one path.
 *
 * The four outcomes are kept apart because two of them look alike and mean
 * opposite things. "This directory has never been committed" is not a problem —
 * a revision cannot have a git baseline before its first commit, and refusing it
 * would make introducing one impossible. "Git is here, the directory is tracked,
 * and the command failed" IS a problem, because then the check that does not
 * depend on the lock file did not run, and the lock file lives in the same
 * commit as any change to it.
 */
function gitStatusUnder(root: string, path: string): GitVerdict {
  // stderr is discarded: `git` writes "not a git repository" to it, and that
  // sentence is an answer here, not an error worth printing in a test log.
  const run = (args: string[]): string =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  try {
    if (run(["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { kind: "no-baseline" };
  } catch {
    return { kind: "no-baseline" };
  }

  try {
    if (run(["ls-files", "--", path]).trim().length === 0) return { kind: "no-baseline" };
    const lines = run(["status", "--porcelain", "--", path])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length === 0 ? { kind: "clean" } : { kind: "dirty", lines };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function runImmutableRevisionGate(root = repoRoot()): GateResult {
  const lock = readLock(root);
  const failures: string[] = [];
  const schemas = schemaRoot(root);
  const examined: Record<string, number | string> = { released: lock.revisions.length };

  if (lock.revisions.length === 0) {
    failures.push(
      `No released revisions are recorded in ${relative(root, lockPath(root))}. A published contract ` +
        "directory that nothing freezes is a directory anybody may edit. Freeze it with " +
        "`npm run gates -- --freeze-revision`."
    );
  }

  let checkedFiles = 0;
  let gitChecked = 0;

  for (const released of lock.revisions) {
    const directory = join(schemas, released.revision);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) {
      failures.push(
        `Released revision ${released.revision} is recorded as frozen and its directory is gone. ` +
          "Deleting a published revision is a stronger break than editing one: every consumer holding " +
          "its bytes now holds bytes nothing acknowledges."
      );
      continue;
    }

    const actual = digestRevision(directory);
    for (const [file, expected] of Object.entries(released.files)) {
      checkedFiles += 1;
      const found = actual[file];
      if (found === undefined) {
        failures.push(
          `${released.revision}/${file} was removed from a RELEASED revision. A released revision is ` +
            "immutable: create a new directory instead."
        );
        continue;
      }
      if (found !== expected) {
        failures.push(
          `${released.revision}/${file} was MODIFIED in a released revision (recorded ${expected}, ` +
            `found ${found}).\n` +
            `    Released ${released.released_at}. ${released.note}\n` +
            "    A released revision is immutable and this is not negotiable per-change: copy " +
            `schema/${released.revision}/ to a new revision directory, make the change there, bump ` +
            "CONTRACT_REVISION, and freeze the new one."
        );
      }
    }
    for (const file of Object.keys(actual)) {
      if (released.files[file] === undefined) {
        failures.push(
          `${released.revision}/${file} was ADDED to a released revision. Adding a document is a ` +
            "change to what the revision publishes, which is what a new revision is for."
        );
      }
    }

    const verdict = gitStatusUnder(root, relative(root, directory));
    if (verdict.kind === "unavailable") {
      failures.push(
        `git is present and would not answer about ${released.revision} (${verdict.reason}), so only ` +
          "the content check ran. That check reads a lock file which travels in the same commit as " +
          "any change to it; the git check is the one that does not."
      );
    } else if (verdict.kind === "dirty") {
      gitChecked += 1;
      failures.push(
        `The working tree touches released revision ${released.revision}:\n` +
          verdict.lines.map((line) => `      ${line}`).join("\n") +
          "\n    Any diff under a released revision fails, unconditionally and regardless of whether " +
          "the lock file agrees with it. A change is a new directory."
      );
    } else if (verdict.kind === "clean") {
      gitChecked += 1;
    }
  }

  // A published directory that no lock entry covers is a directory anyone may
  // edit while every gate stays green, which is the unversioned drift this whole
  // exercise exists to stop.
  if (existsSync(schemas)) {
    const frozen = new Set(lock.revisions.map((released) => released.revision));
    for (const entry of readdirSync(schemas, { withFileTypes: true })) {
      if (!entry.isDirectory() || frozen.has(entry.name)) continue;
      failures.push(
        `schema/${entry.name}/ is published and not recorded in released.lock.json. Freeze it with ` +
          "`npm run gates -- --freeze-revision`, or delete it — an unfrozen published directory is " +
          "exactly the unversioned surface these gates exist to prevent."
      );
    }
  }

  examined["files"] = checkedFiles;
  examined["git_checked_revisions"] = gitChecked;
  return gateResult("4. released revisions are immutable", failures, examined);
}

/**
 * Add an entry for a revision the lock has never seen. Never modifies one it
 * has — the whole point is that freezing is one-way, so the tool that writes the
 * lock cannot be the tool that unfreezes it.
 */
export function freezeUnseenRevisions(root = repoRoot(), releasedAt = new Date().toISOString().slice(0, 10)): {
  lock: ReleasedLock;
  added: string[];
} {
  const lock = readLock(root);
  const known = new Set(lock.revisions.map((released) => released.revision));
  const schemas = schemaRoot(root);
  const added: string[] = [];

  if (existsSync(schemas)) {
    for (const entry of readdirSync(schemas, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!entry.isDirectory() || known.has(entry.name)) continue;
      lock.revisions.push({
        revision: entry.name,
        released_at: releasedAt,
        note:
          "Frozen on release. Every file below is byte-identical to what consumers fetched; a change " +
          "to any of them is a new revision.",
        files: digestRevision(join(schemas, entry.name))
      });
      added.push(entry.name);
    }
  }

  lock.contract = RELEASED_LOCK_CONTRACT;
  return { lock, added };
}
