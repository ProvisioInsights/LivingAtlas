import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const receiptSchema = "atlas.canonical-source-refresh-receipt:v1" as const;

type RefreshErrorCode =
  | "destination-exists"
  | "invalid-source"
  | "path-overlap"
  | "receipt-exists"
  | "source-alias"
  | "source-changed-during-refresh"
  | "sources-unrelated"
  | "unsupported-source-entry";

export class CanonicalSourceRefreshError extends Error {
  constructor(readonly code: RefreshErrorCode) {
    super(code);
    this.name = "CanonicalSourceRefreshError";
  }
}

export interface CanonicalSourceRefreshInput {
  live_source_dir: string;
  prior_working_dir: string;
  destination_dir: string;
  receipt_path: string;
}

interface PublicManifest {
  file_count: number;
  byte_count: number;
  tree_hash: string;
}

interface InternalEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  byte_count: number;
  content_hash: string;
  git_oid: string;
}

interface InternalManifest {
  public: PublicManifest;
  entries: Map<string, InternalEntry>;
}

interface DeltaChange {
  path: string;
  kind: "added" | "deleted" | "modified";
}

interface DeltaSummary {
  changed_path_count: number;
  added_count: number;
  modified_count: number;
  deleted_count: number;
  delta_hash: string;
}

export interface CanonicalSourceRefreshReceipt {
  schema: typeof receiptSchema;
  outcome: "refreshed" | "overlap";
  common_base_hash: string;
  live_source: {
    unchanged: true;
    before: PublicManifest;
    after: PublicManifest;
  };
  prior_working: {
    unchanged: true;
    before: PublicManifest;
    after: PublicManifest;
  };
  live_delta: DeltaSummary;
  preserved_working_delta: DeltaSummary;
  overlap: {
    path_count: number;
    path_set_hash: string;
  };
  destination: PublicManifest;
}

interface ResolvedPaths {
  live: string;
  prior: string;
  destination: string;
  receipt: string;
}

function sha256(parts: readonly (string | Buffer)[]) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(String(value.byteLength));
    hash.update(":");
    hash.update(value);
  }
  return `sha256:${hash.digest("hex")}`;
}

function gitBlobOid(bytes: Buffer, objectFormat: "sha1" | "sha256") {
  return createHash(objectFormat)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}

function isWithinOrEqual(candidate: string, root: string) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function comparePath(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function resolveThroughExistingAncestor(path: string) {
  const absolute = resolve(path);
  const suffix: string[] = [];
  let cursor = absolute;
  while (!await exists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new CanonicalSourceRefreshError("invalid-source");
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  return resolve(await realpath(cursor), ...suffix);
}

async function validatePaths(input: CanonicalSourceRefreshInput): Promise<ResolvedPaths> {
  for (const value of Object.values(input)) {
    if (!value || !isAbsolute(value)) throw new CanonicalSourceRefreshError("invalid-source");
  }
  let live: string;
  let prior: string;
  try {
    live = await realpath(input.live_source_dir);
    prior = await realpath(input.prior_working_dir);
    if (!(await stat(live)).isDirectory() || !(await stat(prior)).isDirectory()) {
      throw new CanonicalSourceRefreshError("invalid-source");
    }
  } catch (error) {
    if (error instanceof CanonicalSourceRefreshError) throw error;
    throw new CanonicalSourceRefreshError("invalid-source");
  }
  if (live === prior) throw new CanonicalSourceRefreshError("source-alias");
  if (isWithinOrEqual(live, prior) || isWithinOrEqual(prior, live)) {
    throw new CanonicalSourceRefreshError("path-overlap");
  }

  const destination = await resolveThroughExistingAncestor(input.destination_dir);
  const receipt = await resolveThroughExistingAncestor(input.receipt_path);
  const unsafeDestination = [live, prior].some((source) => (
    isWithinOrEqual(destination, source) || isWithinOrEqual(source, destination)
  ));
  const unsafeReceipt = [live, prior, destination].some((root) => (
    isWithinOrEqual(receipt, root) || isWithinOrEqual(root, receipt)
  ));
  if (unsafeDestination || unsafeReceipt) throw new CanonicalSourceRefreshError("path-overlap");
  if (await exists(destination)) throw new CanonicalSourceRefreshError("destination-exists");
  if (await exists(receipt)) throw new CanonicalSourceRefreshError("receipt-exists");
  if (!await exists(dirname(destination)) || !await exists(dirname(receipt))) {
    throw new CanonicalSourceRefreshError("invalid-source");
  }
  return { live, prior, destination, receipt };
}

function runGit(args: readonly string[], cwd?: string) {
  return new Promise<string>((resolvePromise, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
    }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.trim());
    });
  });
}

async function scanContent(root: string, objectFormat: "sha1" | "sha256"): Promise<InternalManifest> {
  const entries = new Map<string, InternalEntry>();
  async function walk(directory: string, relativeDirectory = ""): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePath(left.name, right.name));
    for (const child of children) {
      if (child.name === ".git") continue;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolutePath = join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      let bytes: Buffer;
      let mode: InternalEntry["mode"];
      if (child.isFile()) {
        bytes = await readFile(absolutePath);
        mode = ((await stat(absolutePath)).mode & 0o111) === 0 ? "100644" : "100755";
      } else if (child.isSymbolicLink()) {
        bytes = Buffer.from(await readlink(absolutePath));
        mode = "120000";
      } else {
        throw new CanonicalSourceRefreshError("unsupported-source-entry");
      }
      entries.set(relativePath, {
        path: relativePath,
        mode,
        byte_count: bytes.byteLength,
        content_hash: sha256([bytes]),
        git_oid: gitBlobOid(bytes, objectFormat)
      });
    }
  }
  await walk(root);
  const ordered = [...entries.values()].sort((left, right) => comparePath(left.path, right.path));
  return {
    entries,
    public: {
      file_count: ordered.length,
      byte_count: ordered.reduce((total, entry) => total + entry.byte_count, 0),
      tree_hash: sha256(ordered.flatMap((entry) => [entry.path, entry.mode, String(entry.byte_count), entry.content_hash]))
    }
  };
}

async function readBaseEntries(repository: string, commonBase: string) {
  const output = await runGit(["-C", repository, "ls-tree", "-rlz", "--full-tree", commonBase]);
  const entries = new Map<string, Pick<InternalEntry, "mode" | "git_oid">>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (\w+) ([a-f0-9]+)\s+(?:\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match || match[2] !== "blob" || !["100644", "100755", "120000"].includes(match[1]!)) {
      throw new CanonicalSourceRefreshError("unsupported-source-entry");
    }
    entries.set(match[4]!, { mode: match[1]! as InternalEntry["mode"], git_oid: match[3]! });
  }
  return entries;
}

function compareTrees(
  base: ReadonlyMap<string, Pick<InternalEntry, "mode" | "git_oid">>,
  current: ReadonlyMap<string, Pick<InternalEntry, "mode" | "git_oid">>
) {
  const changes: DeltaChange[] = [];
  const paths = new Set([...base.keys(), ...current.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = current.get(path);
    if (!before && after) changes.push({ path, kind: "added" });
    else if (before && !after) changes.push({ path, kind: "deleted" });
    else if (before && after && (before.mode !== after.mode || before.git_oid !== after.git_oid)) {
      changes.push({ path, kind: "modified" });
    }
  }
  return changes;
}

function summarizeDelta(changes: readonly DeltaChange[]): DeltaSummary {
  return {
    changed_path_count: changes.length,
    added_count: changes.filter((change) => change.kind === "added").length,
    modified_count: changes.filter((change) => change.kind === "modified").length,
    deleted_count: changes.filter((change) => change.kind === "deleted").length,
    delta_hash: sha256(changes.flatMap((change) => [change.path, change.kind]))
  };
}

function parentPaths(path: string) {
  const parts = path.split("/");
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) parents.push(parts.slice(0, index).join("/"));
  return parents;
}

function canonicalFilesystemPath(path: string) {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC").toUpperCase().toLowerCase())
    .join("/");
}

export function summarizeCanonicalPathOverlaps(
  input: {
    live_delta_paths: readonly string[];
    prior_delta_paths: readonly string[];
    live_current_paths: readonly string[];
    prior_deleted_paths: readonly string[];
    prior_write_paths: readonly string[];
  }
) {
  const liveCanonical = input.live_delta_paths.map(canonicalFilesystemPath);
  const priorCanonical = input.prior_delta_paths.map(canonicalFilesystemPath);
  const live = new Set(liveCanonical);
  const prior = new Set(priorCanonical);
  const overlap = new Set<string>();
  const addInternalAliases = (rawPaths: readonly string[]) => {
    const paths = rawPaths.map(canonicalFilesystemPath);
    const unique = new Set(paths);
    if (paths.length !== unique.size) {
      const seen = new Set<string>();
      for (const path of paths) {
        if (seen.has(path)) overlap.add(path);
        seen.add(path);
      }
    }
    for (const path of unique) {
      for (const parent of parentPaths(path)) {
        if (unique.has(parent)) {
          overlap.add(path);
          overlap.add(parent);
        }
      }
    }
  };
  addInternalAliases(input.live_current_paths);
  for (const path of live) {
    if (prior.has(path)) overlap.add(path);
    for (const parent of parentPaths(path)) {
      if (prior.has(parent)) {
        overlap.add(path);
        overlap.add(parent);
      }
    }
  }
  for (const path of prior) {
    for (const parent of parentPaths(path)) {
      if (live.has(parent)) {
        overlap.add(path);
        overlap.add(parent);
      }
    }
  }
  const intendedFinalPaths = new Set(input.live_current_paths);
  for (const path of input.prior_deleted_paths) intendedFinalPaths.delete(path);
  for (const path of input.prior_write_paths) intendedFinalPaths.add(path);
  addInternalAliases([...intendedFinalPaths]);
  const paths = [...overlap].sort();
  return { path_count: paths.length, path_set_hash: sha256(paths) };
}

async function copyLiveContent(live: string, destination: string) {
  const children = await readdir(live, { withFileTypes: true });
  for (const child of children) {
    if (child.name === ".git") continue;
    await cp(join(live, child.name), join(destination, child.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: (source) => basename(source) !== ".git"
    });
  }
}

async function importExplicitHead(source: string, destination: string, label: "live" | "prior") {
  const bundlePath = join(destination, ".git", `atlas-${label}-head.bundle`);
  try {
    await runGit(["-C", source, "bundle", "create", bundlePath, "HEAD"]);
    await runGit(["-C", destination, "fetch", "--quiet", "--no-tags", bundlePath, "HEAD"]);
  } finally {
    await rm(bundlePath, { force: true });
  }
}

function assertDestinationPath(destination: string, relativePath: string) {
  const target = resolve(destination, relativePath);
  if (!isWithinOrEqual(target, destination) || target === destination) {
    throw new CanonicalSourceRefreshError("unsupported-source-entry");
  }
  return target;
}

async function applyPriorDelta(
  prior: string,
  destination: string,
  changes: readonly DeltaChange[]
) {
  const deletions = changes
    .filter((change) => change.kind === "deleted")
    .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
  for (const change of deletions) {
    await rm(assertDestinationPath(destination, change.path), { recursive: true, force: true });
  }
  const writes = changes
    .filter((change) => change.kind !== "deleted")
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
  for (const change of writes) {
    const target = assertDestinationPath(destination, change.path);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(join(prior, change.path), target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
  }
}

function sameManifest(left: PublicManifest, right: PublicManifest) {
  return left.file_count === right.file_count
    && left.byte_count === right.byte_count
    && left.tree_hash === right.tree_hash;
}

async function writeReceipt(path: string, receipt: CanonicalSourceRefreshReceipt) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
    }
    throw error;
  }
}

export async function refreshCanonicalSource(
  input: CanonicalSourceRefreshInput
): Promise<CanonicalSourceRefreshReceipt> {
  const paths = await validatePaths(input);
  const objectFormat = (await runGit(["-C", paths.live, "rev-parse", "--show-object-format"])) as "sha1" | "sha256";
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new CanonicalSourceRefreshError("unsupported-source-entry");
  }
  const priorObjectFormat = await runGit(["-C", paths.prior, "rev-parse", "--show-object-format"]);
  if (priorObjectFormat !== objectFormat) throw new CanonicalSourceRefreshError("sources-unrelated");

  const liveBefore = await scanContent(paths.live, objectFormat);
  const priorBefore = await scanContent(paths.prior, objectFormat);
  const liveAliases = summarizeCanonicalPathOverlaps({
    live_delta_paths: [],
    prior_delta_paths: [],
    live_current_paths: [...liveBefore.entries.keys()],
    prior_deleted_paths: [],
    prior_write_paths: []
  });
  if (liveAliases.path_count > 0) throw new CanonicalSourceRefreshError("path-overlap");
  const liveHead = await runGit(["-C", paths.live, "rev-parse", "HEAD"]);
  const priorHead = await runGit(["-C", paths.prior, "rev-parse", "HEAD"]);

  let destinationClaimed = false;
  let keepDestination = false;
  try {
    try {
      await mkdir(paths.destination);
      destinationClaimed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CanonicalSourceRefreshError("destination-exists");
      }
      throw error;
    }
    await runGit([
      "-C",
      paths.destination,
      "init",
      "--quiet",
      "--initial-branch=main",
      `--object-format=${objectFormat}`
    ]);
    await importExplicitHead(paths.live, paths.destination, "live");
    await runGit(["-C", paths.destination, "update-ref", "refs/heads/main", liveHead]);
    await runGit(["-C", paths.destination, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await runGit(["-C", paths.destination, "read-tree", liveHead]);
    await copyLiveContent(paths.live, paths.destination);
    const copiedLive = await scanContent(paths.destination, objectFormat);
    if (!sameManifest(copiedLive.public, liveBefore.public)) {
      throw new CanonicalSourceRefreshError("source-changed-during-refresh");
    }

    await importExplicitHead(paths.prior, paths.destination, "prior");
    let commonBase: string;
    try {
      commonBase = await runGit(["-C", paths.destination, "merge-base", liveHead, priorHead]);
    } catch {
      throw new CanonicalSourceRefreshError("sources-unrelated");
    }
    if (!commonBase) throw new CanonicalSourceRefreshError("sources-unrelated");
    const baseEntries = await readBaseEntries(paths.destination, commonBase);
    const liveChanges = compareTrees(baseEntries, liveBefore.entries);
    const priorChanges = compareTrees(baseEntries, priorBefore.entries);
    const overlap = summarizeCanonicalPathOverlaps({
      live_delta_paths: liveChanges.map((change) => change.path),
      prior_delta_paths: priorChanges.map((change) => change.path),
      live_current_paths: [...liveBefore.entries.keys()],
      prior_deleted_paths: priorChanges
        .filter((change) => change.kind === "deleted")
        .map((change) => change.path),
      prior_write_paths: priorChanges
        .filter((change) => change.kind !== "deleted")
        .map((change) => change.path)
    });

    if (overlap.path_count === 0) await applyPriorDelta(paths.prior, paths.destination, priorChanges);
    const destination = await scanContent(paths.destination, objectFormat);
    const liveAfter = await scanContent(paths.live, objectFormat);
    const priorAfter = await scanContent(paths.prior, objectFormat);
    const liveHeadAfter = await runGit(["-C", paths.live, "rev-parse", "HEAD"]);
    const priorHeadAfter = await runGit(["-C", paths.prior, "rev-parse", "HEAD"]);
    if (
      liveHead !== liveHeadAfter
      || priorHead !== priorHeadAfter
      || !sameManifest(liveBefore.public, liveAfter.public)
      || !sameManifest(priorBefore.public, priorAfter.public)
    ) {
      throw new CanonicalSourceRefreshError("source-changed-during-refresh");
    }

    const receipt: CanonicalSourceRefreshReceipt = {
      schema: receiptSchema,
      outcome: overlap.path_count === 0 ? "refreshed" : "overlap",
      common_base_hash: sha256([commonBase]),
      live_source: { unchanged: true, before: liveBefore.public, after: liveAfter.public },
      prior_working: { unchanged: true, before: priorBefore.public, after: priorAfter.public },
      live_delta: summarizeDelta(liveChanges),
      preserved_working_delta: summarizeDelta(priorChanges),
      overlap,
      destination: destination.public
    };
    await writeReceipt(paths.receipt, receipt);
    keepDestination = true;
    return receipt;
  } finally {
    if (destinationClaimed && !keepDestination) {
      await rm(paths.destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  }
}

function readFlag(args: readonly string[], name: string) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new CanonicalSourceRefreshError("invalid-source");
  return resolve(args[index + 1]!);
}

async function main() {
  try {
    const receipt = await refreshCanonicalSource({
      live_source_dir: readFlag(process.argv.slice(2), "--live-source"),
      prior_working_dir: readFlag(process.argv.slice(2), "--prior-working"),
      destination_dir: readFlag(process.argv.slice(2), "--destination"),
      receipt_path: readFlag(process.argv.slice(2), "--receipt")
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = receipt.outcome === "refreshed" ? 0 : 2;
  } catch (error) {
    const code = error instanceof CanonicalSourceRefreshError ? error.code : "refresh-failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  void main();
}
