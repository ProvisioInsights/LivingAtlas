import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  refreshCanonicalSource,
  summarizeCanonicalPathOverlaps
} from "./canonical-source-refresh";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(directory: string, ...args: string[]) {
  return execFileAsync("git", ["-C", directory, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Synthetic Source Refresh",
      GIT_AUTHOR_EMAIL: "source-refresh@example.test",
      GIT_COMMITTER_NAME: "Synthetic Source Refresh",
      GIT_COMMITTER_EMAIL: "source-refresh@example.test",
      GIT_AUTHOR_DATE: "2026-07-11T12:00:00.000Z",
      GIT_COMMITTER_DATE: "2026-07-11T12:00:00.000Z",
      GIT_OPTIONAL_LOCKS: "0"
    }
  });
}

async function makeSharedCopies() {
  const root = await mkdtemp(join(tmpdir(), "living-atlas-source-refresh-"));
  roots.push(root);
  const seed = join(root, "seed");
  const live = join(root, "live");
  const prior = join(root, "prior");
  await mkdir(seed);
  await git(seed, "init", "--initial-branch=main");
  await writeFile(join(seed, "shared.md"), "base shared\n");
  await writeFile(join(seed, "live-tracked.md"), "base live\n");
  await writeFile(join(seed, "prior-tracked.md"), "base prior\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-m", "synthetic base");
  await execFileAsync("git", ["clone", "--quiet", seed, live]);
  await execFileAsync("git", ["clone", "--quiet", seed, prior]);
  return {
    root,
    live,
    prior,
    destination: join(root, "refreshed"),
    receipt: join(root, "refresh-receipt.json")
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("canonical source refresh", () => {
  it("treats case and Unicode aliases within one preserved delta as overlap", () => {
    expect(summarizeCanonicalPathOverlaps({
      live_delta_paths: [],
      prior_delta_paths: ["Synthetic/A.md", "Synthetic/a.md"],
      live_current_paths: [],
      prior_deleted_paths: [],
      prior_write_paths: ["Synthetic/A.md", "Synthetic/a.md"]
    })).toMatchObject({
      path_count: 1,
      path_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("treats a prior write aliased to an unchanged live path as overlap", () => {
    expect(summarizeCanonicalPathOverlaps({
      live_delta_paths: [],
      prior_delta_paths: ["Synthetic/a.md"],
      live_current_paths: ["Synthetic/A.md"],
      prior_deleted_paths: [],
      prior_write_paths: ["Synthetic/a.md"]
    })).toMatchObject({ path_count: 1 });
  });

  it("allows an exact-path update and a complete case-only rename", () => {
    expect(summarizeCanonicalPathOverlaps({
      live_delta_paths: [],
      prior_delta_paths: ["Synthetic/A.md"],
      live_current_paths: ["Synthetic/A.md"],
      prior_deleted_paths: [],
      prior_write_paths: ["Synthetic/A.md"]
    })).toMatchObject({ path_count: 0 });
    expect(summarizeCanonicalPathOverlaps({
      live_delta_paths: [],
      prior_delta_paths: ["Synthetic/A.md", "Synthetic/a.md"],
      live_current_paths: ["Synthetic/A.md"],
      prior_deleted_paths: ["Synthetic/A.md"],
      prior_write_paths: ["Synthetic/a.md"]
    })).toMatchObject({ path_count: 0 });
  });

  it("three-way applies a preserved tracked and untracked delta onto a new live copy", async () => {
    const fixture = await makeSharedCopies();
    await writeFile(join(fixture.live, "live-committed.md"), "current live committed\n");
    await git(fixture.live, "add", "live-committed.md");
    await git(fixture.live, "commit", "-m", "synthetic live commit");
    await writeFile(join(fixture.prior, "prior-committed.md"), "preserved prior committed\n");
    await git(fixture.prior, "add", "prior-committed.md");
    await git(fixture.prior, "commit", "-m", "synthetic prior commit");
    await writeFile(join(fixture.live, "live-tracked.md"), "current live\n");
    await writeFile(join(fixture.live, "live-untracked.md"), "current live untracked\n");
    await writeFile(join(fixture.prior, "prior-tracked.md"), "preserved prior\n");
    await writeFile(join(fixture.prior, "prior-untracked.md"), "preserved prior untracked\n");
    const liveBefore = await readFile(join(fixture.live, "live-tracked.md"), "utf8");
    const priorBefore = await readFile(join(fixture.prior, "prior-tracked.md"), "utf8");

    const result = await refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    });

    expect(result).toMatchObject({
      schema: "atlas.canonical-source-refresh-receipt:v1",
      outcome: "refreshed",
      common_base_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      live_source: {
        unchanged: true,
        before: { file_count: 5, tree_hash: expect.stringMatching(/^sha256:/) },
        after: { file_count: 5, tree_hash: expect.stringMatching(/^sha256:/) }
      },
      live_delta: { changed_path_count: 3, modified_count: 1, added_count: 2, deleted_count: 0 },
      preserved_working_delta: { changed_path_count: 3, modified_count: 1, added_count: 2, deleted_count: 0 },
      overlap: { path_count: 0 },
      destination: { file_count: 7, tree_hash: expect.stringMatching(/^sha256:/) }
    });
    expect(result.live_source.before).toEqual(result.live_source.after);
    expect(result.prior_working.before).toEqual(result.prior_working.after);
    await expect(readFile(join(fixture.destination, "live-tracked.md"), "utf8")).resolves.toBe("current live\n");
    await expect(readFile(join(fixture.destination, "prior-tracked.md"), "utf8")).resolves.toBe("preserved prior\n");
    await expect(readFile(join(fixture.destination, "live-committed.md"), "utf8")).resolves.toBe("current live committed\n");
    await expect(readFile(join(fixture.destination, "prior-committed.md"), "utf8")).resolves.toBe("preserved prior committed\n");
    await expect(readFile(join(fixture.destination, "live-untracked.md"), "utf8")).resolves.toBe("current live untracked\n");
    await expect(readFile(join(fixture.destination, "prior-untracked.md"), "utf8")).resolves.toBe("preserved prior untracked\n");
    await expect(readFile(join(fixture.live, "live-tracked.md"), "utf8")).resolves.toBe(liveBefore);
    await expect(readFile(join(fixture.prior, "prior-tracked.md"), "utf8")).resolves.toBe(priorBefore);
  });

  it("stops on a same-path overlap and leaves both byte variants intact", async () => {
    const fixture = await makeSharedCopies();
    await writeFile(join(fixture.live, "shared.md"), "live variant\n");
    await writeFile(join(fixture.prior, "shared.md"), "prior variant\n");

    const result = await refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    });

    expect(result).toMatchObject({
      outcome: "overlap",
      live_source: { unchanged: true },
      prior_working: { unchanged: true },
      overlap: {
        path_count: 1,
        path_set_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      }
    });
    await expect(readFile(join(fixture.destination, "shared.md"), "utf8")).resolves.toBe("live variant\n");
    await expect(readFile(join(fixture.live, "shared.md"), "utf8")).resolves.toBe("live variant\n");
    await expect(readFile(join(fixture.prior, "shared.md"), "utf8")).resolves.toBe("prior variant\n");
  });

  it("stops before case or Unicode path aliases can replace the live variant", async () => {
    const fixture = await makeSharedCopies();
    await writeFile(join(fixture.live, "CaseAlias.md"), "live case variant\n");
    await writeFile(join(fixture.prior, "casealias.md"), "prior case variant\n");

    const result = await refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    });

    expect(result).toMatchObject({ outcome: "overlap", overlap: { path_count: 1 } });
    await expect(readFile(join(fixture.live, "CaseAlias.md"), "utf8")).resolves.toBe("live case variant\n");
    await expect(readFile(join(fixture.prior, "casealias.md"), "utf8")).resolves.toBe("prior case variant\n");
    await expect(readFile(join(fixture.destination, "CaseAlias.md"), "utf8")).resolves.toBe("live case variant\n");
  });

  it("writes only counts and hashes to the receipt", async () => {
    const fixture = await makeSharedCopies();
    const privatePathToken = "private-prior-item.md";
    const privateContentToken = "private prior content marker";
    await writeFile(join(fixture.prior, privatePathToken), privateContentToken);

    await refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    });

    const receipt = await readFile(fixture.receipt, "utf8");
    expect(receipt).not.toContain(privatePathToken);
    expect(receipt).not.toContain(privateContentToken);
    expect(receipt).not.toContain(fixture.root);
    expect(receipt).not.toContain(fixture.live);
    expect(receipt).not.toContain(fixture.prior);
    expect(receipt).not.toContain(fixture.destination);
  });

  it("never copies nested Git metadata into the refreshed data tree", async () => {
    const fixture = await makeSharedCopies();
    await mkdir(join(fixture.live, "nested", ".git"), { recursive: true });
    await writeFile(join(fixture.live, "nested", ".git", "private-metadata"), "must not copy\n");

    await refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    });

    await expect(readFile(join(fixture.destination, "nested", ".git", "private-metadata"), "utf8")).rejects.toThrow();
  });

  it("rejects an existing or source-aliased destination before copying", async () => {
    const fixture = await makeSharedCopies();
    await symlink(fixture.live, fixture.destination);

    await expect(refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    })).rejects.toMatchObject({ code: "path-overlap" });
    await expect(readlink(fixture.destination)).resolves.toBe(fixture.live);
    await expect(readFile(fixture.receipt, "utf8")).rejects.toThrow();
  });

  it("removes only its newly claimed destination when histories are unrelated", async () => {
    const fixture = await makeSharedCopies();
    await rm(fixture.prior, { recursive: true, force: true });
    await mkdir(fixture.prior);
    await git(fixture.prior, "init", "--initial-branch=main");
    await writeFile(join(fixture.prior, "unrelated.md"), "unrelated prior\n");
    await git(fixture.prior, "add", ".");
    await git(fixture.prior, "commit", "-m", "synthetic unrelated root");

    await expect(refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    })).rejects.toMatchObject({ code: "sources-unrelated" });
    await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(fixture.live, "shared.md"), "utf8")).resolves.toBe("base shared\n");
    await expect(readFile(join(fixture.prior, "unrelated.md"), "utf8")).resolves.toBe("unrelated prior\n");
  });

  it.each([
    ["a destination nested inside live", (fixture: Awaited<ReturnType<typeof makeSharedCopies>>) => ({
      ...fixture,
      destination: join(fixture.live, "new-copy")
    })],
    ["a destination containing live", (fixture: Awaited<ReturnType<typeof makeSharedCopies>>) => ({
      ...fixture,
      destination: fixture.root
    })],
    ["a receipt inside live", (fixture: Awaited<ReturnType<typeof makeSharedCopies>>) => ({
      ...fixture,
      receipt: join(fixture.live, "receipt.json")
    })]
  ])("rejects %s before creating output", async (_label, arrange) => {
    const arranged = arrange(await makeSharedCopies());
    await expect(refreshCanonicalSource({
      live_source_dir: arranged.live,
      prior_working_dir: arranged.prior,
      destination_dir: arranged.destination,
      receipt_path: arranged.receipt
    })).rejects.toMatchObject({ code: "path-overlap" });
  });

  it("rejects live and prior paths that resolve to the same source", async () => {
    const fixture = await makeSharedCopies();
    const priorAlias = join(fixture.root, "prior-alias");
    await rm(fixture.prior, { recursive: true, force: true });
    await symlink(fixture.live, priorAlias);
    await expect(refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: priorAlias,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    })).rejects.toMatchObject({ code: "source-alias" });
  });

  it("rejects one source nested inside the other before scanning or copying", async () => {
    const fixture = await makeSharedCopies();
    const nestedPrior = join(fixture.live, "nested-prior");
    await rm(fixture.prior, { recursive: true, force: true });
    await execFileAsync("git", ["clone", "--quiet", fixture.root + "/seed", nestedPrior]);

    await expect(refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: nestedPrior,
      destination_dir: fixture.destination,
      receipt_path: fixture.receipt
    })).rejects.toMatchObject({ code: "path-overlap" });
    await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resolves a destination symlink through its nearest existing ancestor", async () => {
    const fixture = await makeSharedCopies();
    const liveAlias = join(fixture.root, "live-alias");
    await symlink(fixture.live, liveAlias);
    await expect(refreshCanonicalSource({
      live_source_dir: fixture.live,
      prior_working_dir: fixture.prior,
      destination_dir: join(liveAlias, "new-copy"),
      receipt_path: fixture.receipt
    })).rejects.toMatchObject({ code: "path-overlap" });
  });
});
