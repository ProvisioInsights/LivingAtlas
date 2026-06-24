import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  createLogseqSemanticParityLedger,
  type MarkdownImportSourceKind,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import {
  SemanticSourceModeSchema,
  type SemanticSourceMode,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const defaultMaxObjects = 240;
const hardMaxObjects = 250;
const defaultMaxFilesPerBatch = 10;
const defaultLookaheadFiles = 25;
const maxLookaheadFiles = 200;
const maxFileOffset = 1_000_000;
const maxFileBytes = 256_000;

const BatchRecordSchema = z.object({
  file_offset: z.number().int().nonnegative(),
  actual_file_count: z.number().int().nonnegative(),
  source_kind: MarkdownImportSourceKindSchema.optional(),
  source_mode: SemanticSourceModeSchema.optional()
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

function isCompatibleLedgerRecord(record: z.infer<typeof BatchRecordSchema>, expected: {
  sourceKind: MarkdownImportSourceKind;
  sourceMode: SemanticSourceMode;
}): boolean {
  const recordSourceKind = record.source_kind ?? "logseq";
  const recordSourceMode = record.source_mode ?? "markdown-only";
  return recordSourceKind === expected.sourceKind && recordSourceMode === expected.sourceMode;
}

export async function nextOffsetFromLedger(path: string | undefined, expected: {
  sourceKind: MarkdownImportSourceKind;
  sourceMode: SemanticSourceMode;
}): Promise<number | undefined> {
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
    if (!isCompatibleLedgerRecord(parsed.data, expected)) {
      const recordSourceKind = parsed.data.source_kind ?? "logseq";
      const recordSourceMode = parsed.data.source_mode ?? "markdown-only";
      throw new Error(`semantic ledger source mismatch: record has ${recordSourceKind}/${recordSourceMode}, requested ${expected.sourceKind}/${expected.sourceMode}`);
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
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const inferredOffset = await nextOffsetFromLedger(ledgerPath, { sourceKind, sourceMode });
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
  const paths = await walkImportableSemanticSourceFiles({
    root,
    sourceKind,
    mode: sourceMode,
    maxFiles: lookaheadFiles,
    offset,
    maxFileBytes
  });
  if (paths.length === 0) {
    throw new Error(`no semantic source files found under configured root at offset ${offset}`);
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
    root_ref: `sha256:${digest(`semantic-root:v1:${pathRedactionSecret}:${root}`)}`,
    authority_id: authorityId,
    source_mode: sourceMode,
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
