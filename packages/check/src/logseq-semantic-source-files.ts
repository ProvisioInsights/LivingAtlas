import { readFile, readdir, stat } from "node:fs/promises";
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

export type SemanticSourceClassification =
  | {
      supported: true;
      reason_code: "markdown-file" | "logseq-extensionless-note";
    }
  | {
      supported: false;
      reason_code: "ignored-extension" | "unsupported-extensionless";
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
        if (!ignoredDirectories.has(entry.name)) {
          queue.push(path);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export async function walkImportableSemanticSourceFiles(input: {
  root: string;
  sourceKind: MarkdownImportSourceKind;
  mode: SemanticSourceMode;
  maxFiles: number;
  offset: number;
  maxFileBytes: number;
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
    if (!info || info.size <= 0 || info.size > input.maxFileBytes) {
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
