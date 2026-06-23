import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createLogseqSemanticParityLedger,
  type MarkdownFileInput
} from "@living-atlas/importer";

const defaultMaxObjects = 240;
const hardMaxObjects = 250;
const defaultMaxFilesPerBatch = 10;
const defaultLookaheadFiles = 25;
const maxLookaheadFiles = 200;
const maxFileOffset = 1_000_000;
const maxFileBytes = 256_000;

const BatchRecordSchema = z.object({
  file_offset: z.number().int().nonnegative(),
  actual_file_count: z.number().int().nonnegative()
});

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected integer from ${min} to ${max}, got ${value}`);
  }
  return parsed;
}

function digest(value: string, length = 64): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

async function walkMarkdown(root: string, maxFiles: number, offset: number): Promise<string[]> {
  const selected: string[] = [];
  const queue = [root];
  const ignored = new Set([".git", "node_modules", "dist", "build", ".wrangler", ".terraform"]);
  const scanLimit = offset + maxFiles;

  while (queue.length > 0 && selected.length < scanLimit) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          queue.push(path);
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const info = await stat(path).catch(() => undefined);
      if (!info || info.size <= 0 || info.size > maxFileBytes) {
        continue;
      }
      selected.push(path);
      if (selected.length >= scanLimit) {
        break;
      }
    }
  }

  return selected.slice(offset);
}

async function nextOffsetFromLedger(path: string | undefined): Promise<number | undefined> {
  if (!path) {
    return undefined;
  }
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  let nextOffset = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const parsed = BatchRecordSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      continue;
    }
    nextOffset = Math.max(nextOffset, parsed.data.file_offset + parsed.data.actual_file_count);
  }
  return nextOffset;
}

async function readMarkdownInput(root: string, path: string, sourceKind: MarkdownFileInput["source_kind"]): Promise<MarkdownFileInput> {
  return {
    source_path: relative(root, path),
    markdown: await readFile(path, "utf8"),
    source_kind: sourceKind
  };
}

export type PlanEntry = {
  offset: number;
  planned_objects: number;
  bytes: number;
  pages: number;
  blocks: number;
  reference_index_objects: number;
  edge_objects: number;
  quarantine_objects: number;
  oversized: boolean;
};

export function recommendNextSemanticBatch(entries: PlanEntry[], maxObjects: number, maxFilesPerBatch: number): {
  file_count: number;
  planned_objects: number;
} {
  let recommendedCount = 0;
  let recommendedObjects = 0;
  for (const entry of entries) {
    if (recommendedCount >= maxFilesPerBatch) {
      break;
    }
    if (entry.oversized && recommendedCount === 0) {
      recommendedCount = 1;
      recommendedObjects = entry.planned_objects;
      break;
    }
    if (entry.oversized) {
      break;
    }
    if (recommendedObjects + entry.planned_objects > maxObjects) {
      break;
    }
    recommendedCount += 1;
    recommendedObjects += entry.planned_objects;
  }
  return {
    file_count: recommendedCount,
    planned_objects: recommendedObjects
  };
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const ledgerPath = envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH");
  const inferredOffset = await nextOffsetFromLedger(ledgerPath);
  const offset = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_OFFSET"), inferredOffset ?? 0, 0, maxFileOffset);
  const lookaheadFiles = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_PLAN_LOOKAHEAD_FILES"), defaultLookaheadFiles, 1, maxLookaheadFiles);
  const maxObjects = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_PLAN_MAX_OBJECTS"), defaultMaxObjects, 1, hardMaxObjects);
  const maxFilesPerBatch = parseInteger(
    envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_PLAN_MAX_FILE_COUNT"),
    defaultMaxFilesPerBatch,
    1,
    defaultMaxFilesPerBatch
  );
  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? "la_authority_logseqsemantic0001";
  const pathRedactionSecret = envValue("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET") ?? `planner:${digest(`${authorityId}:${root}`, 32)}`;
  const sourceKind = (envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq") as MarkdownFileInput["source_kind"];
  const paths = await walkMarkdown(root, lookaheadFiles, offset);
  if (paths.length === 0) {
    throw new Error(`no markdown files found under configured root at offset ${offset}`);
  }

  const entries: PlanEntry[] = [];

  for (const [index, path] of paths.entries()) {
    const input = await readMarkdownInput(root, path, sourceKind);
    const ledger = createLogseqSemanticParityLedger([input], {
      authority_id: authorityId,
      created_at: "2026-01-01T00:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    entries.push({
      offset: offset + index,
      planned_objects: ledger.totals.planned_objects,
      bytes: ledger.totals.bytes,
      pages: ledger.totals.pages,
      blocks: ledger.totals.blocks,
      reference_index_objects: ledger.totals.reference_index_objects_planned,
      edge_objects: ledger.totals.edge_objects,
      quarantine_objects: ledger.totals.quarantine_objects,
      oversized: ledger.totals.planned_objects > maxObjects
    });
  }

  const recommended = recommendNextSemanticBatch(entries, maxObjects, maxFilesPerBatch);

  const summary = {
    report_schema: "living-atlas-logseq-semantic-batch-plan:v1",
    root_ref: `sha256:${digest(`${pathRedactionSecret}:semantic-root:v1:${root}`)}`,
    authority_id: authorityId,
    start_offset: offset,
    max_objects: maxObjects,
    max_files_per_batch: maxFilesPerBatch,
    lookahead_files: paths.length,
    recommended_next_batch: recommended.file_count > 0
      ? {
          file_offset: offset,
          file_count: recommended.file_count,
          planned_objects: recommended.planned_objects,
          requires_chunked_sync: recommended.planned_objects > maxObjects
        }
      : null,
    first_blocker: recommended.file_count === 0
      ? entries[0]
      : entries.find((entry, index) => index >= recommended.file_count),
    entries
  };

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
