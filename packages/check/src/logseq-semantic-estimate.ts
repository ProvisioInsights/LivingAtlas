import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLogseqSemanticParityLedger,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const defaultMaxFileBytes = 256_000;
const defaultMaxSyncObjectsPerBatch = 240;
const maxFiles = 1_000_000;

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

type EstimateTotals = {
  files: number;
  bytes: number;
  planned_objects: number;
  pages: number;
  blocks: number;
  reference_index_objects: number;
  edge_candidates: number;
  valid_edge_candidates: number;
  quarantined_edge_candidates: number;
  edge_objects: number;
  quarantine_objects: number;
  wikilinks: number;
  hash_tags: number;
  block_refs: number;
  page_properties: number;
  block_properties: number;
};

function emptyTotals(): EstimateTotals {
  return {
    files: 0,
    bytes: 0,
    planned_objects: 0,
    pages: 0,
    blocks: 0,
    reference_index_objects: 0,
    edge_candidates: 0,
    valid_edge_candidates: 0,
    quarantined_edge_candidates: 0,
    edge_objects: 0,
    quarantine_objects: 0,
    wikilinks: 0,
    hash_tags: 0,
    block_refs: 0,
    page_properties: 0,
    block_properties: 0
  };
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const authorityId = envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? "la_authority_logseqsemantic0001";
  const pathRedactionSecret = envValue("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const maxFileBytes = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 100_000_000);
  const maxSyncObjects = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SYNC_MAX_OBJECTS_PER_BATCH"), defaultMaxSyncObjectsPerBatch, 1, 10_000);
  const paths = await walkImportableSemanticSourceFiles({
    root,
    sourceKind,
    mode: sourceMode,
    maxFiles,
    offset: 0,
    maxFileBytes
  });
  const totals = emptyTotals();
  const objectBuckets = {
    "0-50": 0,
    "51-100": 0,
    "101-200": 0,
    "201-240": 0,
    "241+": 0
  };
  let oversizedSingleFileBatches = 0;
  let maxFile = { offset: 0, planned_objects: 0, bytes: 0 };

  for (const [offset, path] of paths.entries()) {
    const markdown = await readFile(path, "utf8");
    const file: MarkdownFileInput = {
      source_path: relative(root, path),
      markdown,
      source_kind: sourceKind
    };
    const ledger = createLogseqSemanticParityLedger([file], {
      authority_id: authorityId,
      created_at: "2026-01-01T00:00:00.000Z",
      path_redaction_secret: pathRedactionSecret
    });
    const entry = ledger.totals;
    totals.files += 1;
    totals.bytes += entry.bytes;
    totals.planned_objects += entry.planned_objects;
    totals.pages += entry.pages;
    totals.blocks += entry.blocks;
    totals.reference_index_objects += entry.reference_index_objects_planned;
    totals.edge_candidates += entry.edge_candidates;
    totals.valid_edge_candidates += entry.valid_edge_candidates;
    totals.quarantined_edge_candidates += entry.quarantined_edge_candidates;
    totals.edge_objects += entry.edge_objects;
    totals.quarantine_objects += entry.quarantine_objects;
    totals.wikilinks += entry.wikilinks;
    totals.hash_tags += entry.hash_tags;
    totals.block_refs += entry.block_refs;
    totals.page_properties += entry.page_properties;
    totals.block_properties += entry.block_properties;

    if (entry.planned_objects > maxSyncObjects) {
      oversizedSingleFileBatches += 1;
    }
    if (entry.planned_objects > maxFile.planned_objects) {
      maxFile = { offset, planned_objects: entry.planned_objects, bytes: entry.bytes };
    }
    if (entry.planned_objects <= 50) objectBuckets["0-50"] += 1;
    else if (entry.planned_objects <= 100) objectBuckets["51-100"] += 1;
    else if (entry.planned_objects <= 200) objectBuckets["101-200"] += 1;
    else if (entry.planned_objects <= 240) objectBuckets["201-240"] += 1;
    else objectBuckets["241+"] += 1;
  }

  console.log(JSON.stringify({
    report_schema: "living-atlas-logseq-semantic-estimate:v1",
    source_mode: sourceMode,
    source_kind: sourceKind,
    max_sync_objects_per_batch: maxSyncObjects,
    totals,
    oversized_single_file_batches: oversizedSingleFileBatches,
    max_file: maxFile,
    object_buckets: objectBuckets,
    estimated_min_sync_batches: Math.ceil(totals.planned_objects / maxSyncObjects),
    plaintext_policy: "counts-only"
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
