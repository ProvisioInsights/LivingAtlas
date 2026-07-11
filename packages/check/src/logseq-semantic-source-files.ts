import { open, readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  classifyMarkdownSourcePath,
  MarkdownSourceModeSchema as SemanticSourceModeSchema,
  type MarkdownImportSourceKind,
  type MarkdownFileInput,
  type MarkdownSourceMode as SemanticSourceMode
} from "@living-atlas/importer";

export { SemanticSourceModeSchema, type SemanticSourceMode };

const ignoredDirectories = new Set([".git", "node_modules", "dist", "build", ".wrangler", ".terraform"]);

function isHiddenFilesystemArtifact(name: string): boolean {
  return name.startsWith(".");
}

export type SemanticSourceClassification =
  | {
      supported: true;
      reason_code: "markdown-file" | "logseq-extensionless-note";
    }
  | {
      supported: false;
      reason_code: "ignored-extension" | "unsupported-extensionless";
    };

export type SemanticSourceDiscoveryCounts = {
  selected: number;
  unsupported: number;
  hidden: number;
  oversize: number;
  unreadable: number;
  cap: number;
};

export type SemanticSourceDiscovery = {
  selected_paths: string[];
  counts: SemanticSourceDiscoveryCounts;
};

export function classifySemanticSourcePath(input: {
  root: string;
  path: string;
  sourceKind: MarkdownImportSourceKind;
  mode: SemanticSourceMode;
}): SemanticSourceClassification {
  const sourcePath = relative(input.root, input.path);
  return classifyMarkdownSourcePath({
    source_path: sourcePath,
    source_kind: input.sourceKind,
    mode: input.mode
  });
}

export function isLikelyTextBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }
  if (buffer.length === 0) {
    return true;
  }
  let suspicious = 0;
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index]!;
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isAllowedControl) {
      suspicious += 1;
    }
  }
  return suspicious / sampleLength < 0.02;
}

export async function walkAllSemanticSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !isHiddenFilesystemArtifact(entry.name)) {
          queue.push(path);
        }
        continue;
      }
      if (entry.isFile() && !isHiddenFilesystemArtifact(entry.name)) {
        files.push(path);
      }
    }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export async function discoverImportableSemanticSourceFiles(input: {
  root: string;
  sourceKind: MarkdownImportSourceKind;
  mode: SemanticSourceMode;
  maxFiles: number;
  offset: number;
  maxFileBytes: number;
  include_empty?: boolean;
}): Promise<SemanticSourceDiscovery> {
  const counts: SemanticSourceDiscoveryCounts = {
    selected: 0,
    unsupported: 0,
    hidden: 0,
    oversize: 0,
    unreadable: 0,
    cap: 0
  };
  const files: string[] = [];
  const queue = [input.root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
    if (!entries) {
      counts.unreadable += 1;
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (isHiddenFilesystemArtifact(entry.name)) {
        counts.hidden += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) counts.hidden += 1;
        else queue.push(path);
        continue;
      }
      if (entry.isFile()) files.push(path);
    }
  }

  const eligible: string[] = [];
  for (const path of files.sort((left, right) => relative(input.root, left).localeCompare(relative(input.root, right)))) {
    const classification = classifySemanticSourcePath({
      root: input.root,
      path,
      sourceKind: input.sourceKind,
      mode: input.mode
    });
    if (!classification.supported) {
      counts.unsupported += 1;
      continue;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info) {
      counts.unreadable += 1;
      continue;
    }
    if (info.size > input.maxFileBytes) {
      counts.oversize += 1;
      continue;
    }
    if (info.size === 0 && !input.include_empty) {
      counts.unsupported += 1;
      continue;
    }
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) {
      counts.unreadable += 1;
      continue;
    }
    await handle.close();
    if (classification.reason_code === "logseq-extensionless-note") {
      const content = await readFile(path).catch(() => undefined);
      if (!content) {
        counts.unreadable += 1;
        continue;
      }
      if (!isLikelyTextBuffer(content)) {
        counts.unsupported += 1;
        continue;
      }
    }
    eligible.push(path);
  }
  const selectedPaths = eligible.slice(input.offset, input.offset + input.maxFiles);
  counts.selected = selectedPaths.length;
  counts.cap = Math.max(0, eligible.length - (input.offset + selectedPaths.length));
  return { selected_paths: selectedPaths, counts };
}

export function assertSemanticSourceDiscoveryComplete(counts: SemanticSourceDiscoveryCounts): void {
  if (counts.oversize > 0 || counts.unreadable > 0 || counts.cap > 0) {
    throw new Error(`semantic source discovery incomplete: oversize=${counts.oversize} unreadable=${counts.unreadable} cap=${counts.cap}`);
  }
}

export async function walkImportableSemanticSourceFiles(input: {
  root: string;
  sourceKind: MarkdownImportSourceKind;
  mode: SemanticSourceMode;
  maxFiles: number;
  offset: number;
  maxFileBytes: number;
  include_empty?: boolean;
}): Promise<string[]> {
  const selected: string[] = [];
  const paths = await walkAllSemanticSourceFiles(input.root);
  const scanLimit = input.offset + input.maxFiles;

  for (const path of paths) {
    const classification = classifySemanticSourcePath({
      root: input.root,
      path,
      sourceKind: input.sourceKind,
      mode: input.mode
    });
    if (!classification.supported) {
      continue;
    }
    const info = await stat(path).catch(() => undefined);
    if (!info || info.size > input.maxFileBytes || (info.size === 0 && !input.include_empty)) {
      continue;
    }
    if (classification.reason_code === "logseq-extensionless-note") {
      const content = await readFile(path).catch(() => undefined);
      if (!content || !isLikelyTextBuffer(content)) {
        continue;
      }
    }
    selected.push(path);
    if (selected.length >= scanLimit) {
      break;
    }
  }

  return selected.slice(input.offset);
}
