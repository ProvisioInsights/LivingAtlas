import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_LIMITS, CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { baselinePath } from "./baseline.js";
import { corpusPath } from "./gate-corpus.js";
import { runCorpusGate } from "./gate-corpus.js";
import { goldenPath, runGoldenGate } from "./gate-golden.js";
import {
  digestRevision,
  freezeUnseenRevisions,
  lockPath,
  runImmutableRevisionGate,
  schemaRoot,
  serializeLock
} from "./gate-immutable-revisions.js";
import { runLiteralConstantGate } from "./gate-literal-constants.js";
import { runSingleSourceGate } from "./gate-single-source.js";
import { makeTemporaryRepo } from "./harness.test-helpers.js";
import { GATED_PLANES } from "./registry.js";

/**
 * Every gate, run twice: once against this repository, where it must pass, and
 * once against a copy with the defect it exists to catch seeded into it, where
 * it must fail and must say what is wrong.
 *
 * The negative controls are the reason this file exists. A gate that has never
 * been seen to fail is a gate nobody can distinguish from `return true`, and the
 * whole value of the five is that they are the thing standing between a quiet
 * edit and a shipped contract change.
 */

describe("gate 1 — single source", () => {
  it("passes against this repository", async () => {
    const result = await runSingleSourceGate();
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("holds the consumer plane to zero findings and the legacy plane to its ledger", async () => {
    const result = await runSingleSourceGate();
    expect(result.examined[`consumer-${CONTRACT_REVISION}.findings`]).toBe(0);
    // The legacy count is not asserted as a specific number here — the ledger
    // does that, entry by entry, and asserting it twice would mean editing two
    // places when the surface is demolished.
    expect(Number(result.examined["legacy-30-tool.findings"])).toBeGreaterThan(0);
  });

  it("gives the enforced plane no place to record an exception", () => {
    const consumer = GATED_PLANES.find((plane) => plane.id === `consumer-${CONTRACT_REVISION}`);
    expect(consumer?.enforcement).toBe("enforced");
    // Not a lint and not a convention: `EnforcedPlane` has no `quarantine`
    // member, so this cannot be added without changing the type.
    expect(Object.keys(consumer ?? {})).not.toContain("quarantine");
  });

  it("requires every detector a plane does not run to say why", () => {
    for (const plane of GATED_PLANES) {
      for (const detector of ["redeclared-tool-name-set", "transport-varying-limit", "literal-contract-constant"]) {
        if (plane.detectors.includes(detector as never)) continue;
        expect(plane.notApplicable[detector], `${plane.id} silently skips ${detector}`).toBeDefined();
      }
    }
  });
});

describe("gate 2 — golden fixtures", () => {
  it("passes against this repository", async () => {
    const result = await runGoldenGate();
    expect(result.failures).toEqual([]);
    expect(Number(result.examined["cases"])).toBeGreaterThanOrEqual(12);
  });

  it("fails when a recorded response changes shape", async () => {
    const root = makeTemporaryRepo();
    const path = goldenPath("atlas.assertion.query.v1", root);
    const golden = JSON.parse(readFileSync(path, "utf8")) as {
      response: { structuredContent: { coverage: Record<string, unknown> } };
    };
    // The single most consequential number on a read result: how many rows the
    // credential was not allowed to see.
    golden.response.structuredContent.coverage["withheld"] = 0;
    writeFileSync(path, JSON.stringify(golden, null, 2), "utf8");

    const result = await runGoldenGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("/response/structuredContent/coverage/withheld");
  });

  it("fails when a published tool has no recorded response", async () => {
    const root = makeTemporaryRepo();
    rmSync(goldenPath("atlas.changes.read.v1", root));

    const result = await runGoldenGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("has no golden");
  });

  it("fails when a golden records a case nothing produces any more", async () => {
    const root = makeTemporaryRepo();
    writeFileSync(goldenPath("atlas.retired.tool.v1", root), "{}", "utf8");

    const result = await runGoldenGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("the fixture no longer produces");
  });
});

describe("gate 3 — answer reproducibility", () => {
  it("passes against this repository", async () => {
    const result = await runCorpusGate();
    expect(result.failures).toEqual([]);
    expect(Number(result.examined["queries"])).toBeGreaterThanOrEqual(18);
  });

  it("fails, and says BREAKING, when a pinned answer changes", async () => {
    const root = makeTemporaryRepo();
    const corpus = JSON.parse(readFileSync(corpusPath(root), "utf8")) as {
      answers: { query: { id: string }; matched: unknown[] }[];
    };
    // This is what "fix approximate-date comparison" looks like from the
    // outside: one query that used to answer `possible` now answers nothing.
    const target = corpus.answers.find((answer) => answer.query.id === "valid-2018");
    expect(target).toBeDefined();
    if (target) target.matched = [];
    writeFileSync(corpusPath(root), JSON.stringify(corpus, null, 2), "utf8");

    const result = await runCorpusGate(root);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    expect(text).toContain("BREAKING");
    expect(text).toContain("valid-2018");
    expect(text).toContain("new revision");
  });

  it("fails when a pinned query is dropped from the corpus", async () => {
    const root = makeTemporaryRepo();
    const corpus = JSON.parse(readFileSync(corpusPath(root), "utf8")) as {
      answers: { query: { id: string } }[];
    };
    corpus.answers = corpus.answers.filter((answer) => answer.query.id !== "belief-before-floor");
    writeFileSync(corpusPath(root), JSON.stringify(corpus, null, 2), "utf8");

    const result = await runCorpusGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("has no recorded answer");
  });
});

describe("gate 4 — released revisions are immutable", () => {
  it("passes against this repository", () => {
    const result = runImmutableRevisionGate();
    expect(result.failures).toEqual([]);
    expect(Number(result.examined["files"])).toBeGreaterThan(30);
  });

  it("runs its GIT leg here, not only the content leg", () => {
    // ADR 0016 OPEN-1: while `packages/atlas-contract/` was untracked the git
    // leg reported `no-baseline` and silently contributed nothing, so only the
    // content check ran — and that check reads a lock file which travels in the
    // same commit as any change to it. A hand-edit plus a re-freeze passed.
    //
    // The schema directory is tracked now, so the leg runs. Asserted rather
    // than assumed, because the failure mode is SILENT: `gitStatusUnder`
    // returns `no-baseline` for an untracked path and pushes no failure, so
    // gitignoring the directory would take the second leg away with every gate
    // still green. This is the guard that would notice.
    const result = runImmutableRevisionGate();
    const released = Number(result.examined["released"]);
    expect(released).toBeGreaterThan(0);
    expect(Number(result.examined["git_checked_revisions"])).toBe(released);
  });

  it("fails when one byte of a released schema changes", () => {
    const root = makeTemporaryRepo();
    const path = join(schemaRoot(root), CONTRACT_REVISION, "tools", "atlas.assertion.query.v1.input.json");
    const schema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    schema["description"] = "an entirely harmless documentation improvement";
    writeFileSync(path, `${JSON.stringify(schema, null, 2)}\n`, "utf8");

    const result = runImmutableRevisionGate(root);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    expect(text).toContain("MODIFIED in a released revision");
    expect(text).toContain("copy schema/");
  });

  it("fails when a document is added to a released revision", () => {
    const root = makeTemporaryRepo();
    writeFileSync(join(schemaRoot(root), CONTRACT_REVISION, "tools", "atlas.new.tool.v1.input.json"), "{}", "utf8");

    const result = runImmutableRevisionGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("ADDED to a released revision");
  });

  it("fails when a document is removed from a released revision", () => {
    const root = makeTemporaryRepo();
    rmSync(join(schemaRoot(root), CONTRACT_REVISION, "records", "atlas.horizon-v1.json"));

    const result = runImmutableRevisionGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("was removed from a RELEASED revision");
  });

  it("fails on a working-tree diff even when the lock file was updated to agree with it", () => {
    const root = makeTemporaryRepo();
    const git = (...args: string[]): void => {
      execFileSync("git", ["-C", root, "-c", "user.email=gate@example.invalid", "-c", "user.name=gate", ...args], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    };
    git("init", "--initial-branch=main");
    git("add", "-A");
    git("commit", "-m", "freeze");

    // The move this test exists for: edit a released document and re-freeze the
    // lock in the same change, so the content check is satisfied. The git check
    // is the one that is not, and it is why there are two.
    const path = join(schemaRoot(root), CONTRACT_REVISION, "records", "atlas.error-v1.json");
    writeFileSync(path, `${readFileSync(path, "utf8").replace(/\n$/, "")}\n`, "utf8");
    writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}  \n`, "utf8");
    const { lock } = freezeUnseenRevisions(root);
    const relocked = {
      ...lock,
      revisions: lock.revisions.map((released) =>
        released.revision === CONTRACT_REVISION
          ? { ...released, files: digestRevision(join(schemaRoot(root), CONTRACT_REVISION)) }
          : released
      )
    };
    writeFileSync(lockPath(root), serializeLock(relocked), "utf8");

    const result = runImmutableRevisionGate(root);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    expect(text).toContain("The working tree touches released revision");
    expect(text).toContain("regardless of whether");
    // And the content check is silent, which is the point: without the git half
    // this edit would have shipped green.
    expect(text).not.toContain("MODIFIED in a released revision");
  });

  it("fails when a published directory is not frozen at all", () => {
    const root = makeTemporaryRepo();
    const lock = JSON.parse(readFileSync(lockPath(root), "utf8")) as { revisions: unknown[] };
    lock.revisions = [];
    writeFileSync(lockPath(root), JSON.stringify(lock, null, 2), "utf8");

    const result = runImmutableRevisionGate(root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("not recorded in released.lock.json");
  });
});

describe("gate 5 — literal-constant lint", () => {
  it("passes against this repository", async () => {
    const result = await runLiteralConstantGate();
    expect(result.failures).toEqual([]);
  });

  it("fails when the committed baseline is not what regenerating produces", async () => {
    const root = makeTemporaryRepo();
    const path = baselinePath(CONTRACT_REVISION, root);
    const baseline = JSON.parse(readFileSync(path, "utf8")) as { limits: Record<string, number> };
    // The exact drift the old surface had: a batch cap quietly reduced.
    baseline.limits["max_batch_items"] = 10;
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const result = await runLiteralConstantGate([], root);
    expect(result.ok).toBe(false);
    const text = result.failures.join("\n");
    expect(text).toContain("is not what regenerating it");
    expect(text).toContain("max_batch_items");
  });

  it("fails when the authored constant and the published bytes disagree", async () => {
    const root = makeTemporaryRepo();
    const path = baselinePath(CONTRACT_REVISION, root);
    const baseline = JSON.parse(readFileSync(path, "utf8")) as { limits: Record<string, number> };
    baseline.limits["max_page_size"] = CONTRACT_LIMITS.max_page_size + 100;
    writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");

    const result = await runLiteralConstantGate([], root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("CONTRACT_LIMITS.max_page_size");
  });

  it("fails when there is no generated baseline to read from at all", async () => {
    const root = makeTemporaryRepo();
    rmSync(baselinePath(CONTRACT_REVISION, root));

    const result = await runLiteralConstantGate([], root);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("No generated baseline");
  });
});
