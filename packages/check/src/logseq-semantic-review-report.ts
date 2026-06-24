import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MarkdownImportSourceKindSchema, type MarkdownImportSourceKind } from "@living-atlas/importer";
import { z } from "zod";
import {
  SemanticSourceModeSchema,
  type SemanticSourceMode
} from "./logseq-semantic-source-files";

const BatchRecordSchema = z.object({
  record_schema: z.literal("living-atlas-logseq-semantic-batch:v1"),
  recorded_at: z.string(),
  authority_id: z.string(),
  root_ref: z.string(),
  source_kind: MarkdownImportSourceKindSchema.optional(),
  source_mode: SemanticSourceModeSchema.optional(),
  file_offset: z.number().int().nonnegative(),
  requested_file_count: z.number().int().positive(),
  actual_file_count: z.number().int().nonnegative(),
  ledger_id: z.string(),
  plan_totals: z.object({
    edge_candidates: z.number().int().nonnegative(),
    valid_edge_candidates: z.number().int().nonnegative(),
    quarantined_edge_candidates: z.number().int().nonnegative(),
    quarantine_objects: z.number().int().nonnegative()
  }).passthrough(),
  sync: z.object({
    attempted: z.boolean()
  }).passthrough(),
  files: z.array(z.object({
    source_path_ref: z.string(),
    migration_status: z.enum(["migrated", "skipped", "quarantined"]),
    review_status: z.enum(["not-required", "needs-review", "reviewed"]),
    parity_status: z.enum(["local-verified", "synced", "blocked"]),
    planned_objects: z.number().int().nonnegative(),
    object_plan_hash: z.string()
  }).passthrough()).default([]),
  decisions: z.record(z.string(), z.number().int().nonnegative()),
  plaintext_policy: z.literal("hash-counts-refs-only")
});

type BatchRecord = z.infer<typeof BatchRecordSchema>;

export type SemanticReviewReport = {
  report_schema: "living-atlas-logseq-semantic-review-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  record_count: number;
  deduped_batch_count: number;
  authority_ids: string[];
  source_kinds: MarkdownImportSourceKind[];
  source_modes: SemanticSourceMode[];
  review_totals: {
    needs_review_files: number;
    quarantined_files: number;
    quarantine_objects: number;
    edge_candidates: number;
    valid_edge_candidates: number;
    quarantined_edge_candidates: number;
    local_only_batches: number;
  };
  reason_counts: Record<string, number>;
  review_windows: Array<{
    file_offset: number;
    actual_file_count: number;
    needs_review_files: number;
    quarantine_objects: number;
    sync_attempted: boolean;
    reason_counts: Record<string, number>;
  }>;
  review_source_refs: Array<{
    source_path_ref: string;
    object_plan_hash: string;
    planned_objects: number;
    parity_status: "local-verified" | "synced" | "blocked";
  }>;
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
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

function recordSourceKind(record: BatchRecord): MarkdownImportSourceKind {
  return record.source_kind ?? "logseq";
}

function recordSourceMode(record: BatchRecord): SemanticSourceMode {
  return record.source_mode ?? "markdown-only";
}

function latestRecords(records: BatchRecord[]): BatchRecord[] {
  const byWindow = new Map<string, BatchRecord>();
  for (const record of records) {
    byWindow.set(`${record.file_offset}:${record.requested_file_count}`, record);
  }
  return [...byWindow.values()].sort((left, right) => left.file_offset - right.file_offset || left.requested_file_count - right.requested_file_count);
}

function isReviewReason(reason: string): boolean {
  return reason.includes("-review") || reason.endsWith("-needs-note");
}

function reviewReasonCounts(record: BatchRecord): Record<string, number> {
  return Object.fromEntries(Object.entries(record.decisions)
    .filter(([reason]) => isReviewReason(reason))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function addReasonCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [reason, count] of Object.entries(source)) {
    target[reason] = (target[reason] ?? 0) + count;
  }
}

async function readRecords(path: string): Promise<BatchRecord[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => BatchRecordSchema.parse(JSON.parse(line)));
}

export async function buildSemanticReviewReport(input: {
  ledgerPath: string;
  maxSourceRefs?: number;
}): Promise<SemanticReviewReport> {
  const records = await readRecords(input.ledgerPath);
  const latest = latestRecords(records);
  const reasonCounts: Record<string, number> = {};
  const reviewSourceRefs: SemanticReviewReport["review_source_refs"] = [];
  const maxSourceRefs = input.maxSourceRefs ?? 50;

  for (const record of latest) {
    addReasonCounts(reasonCounts, reviewReasonCounts(record));
    for (const file of record.files) {
      if (file.review_status !== "needs-review" || reviewSourceRefs.length >= maxSourceRefs) {
        continue;
      }
      reviewSourceRefs.push({
        source_path_ref: file.source_path_ref,
        object_plan_hash: file.object_plan_hash,
        planned_objects: file.planned_objects,
        parity_status: file.parity_status
      });
    }
  }

  return {
    report_schema: "living-atlas-logseq-semantic-review-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    record_count: records.length,
    deduped_batch_count: latest.length,
    authority_ids: [...new Set(latest.map((record) => record.authority_id))].sort(),
    source_kinds: [...new Set(latest.map(recordSourceKind))].sort(),
    source_modes: [...new Set(latest.map(recordSourceMode))].sort(),
    review_totals: {
      needs_review_files: latest.flatMap((record) => record.files).filter((file) => file.review_status === "needs-review").length,
      quarantined_files: latest.flatMap((record) => record.files).filter((file) => file.migration_status === "quarantined").length,
      quarantine_objects: latest.reduce((sum, record) => sum + record.plan_totals.quarantine_objects, 0),
      edge_candidates: latest.reduce((sum, record) => sum + record.plan_totals.edge_candidates, 0),
      valid_edge_candidates: latest.reduce((sum, record) => sum + record.plan_totals.valid_edge_candidates, 0),
      quarantined_edge_candidates: latest.reduce((sum, record) => sum + record.plan_totals.quarantined_edge_candidates, 0),
      local_only_batches: latest.filter((record) => !record.sync.attempted).length
    },
    reason_counts: reasonCounts,
    review_windows: latest.map((record) => ({
      file_offset: record.file_offset,
      actual_file_count: record.actual_file_count,
      needs_review_files: record.files.filter((file) => file.review_status === "needs-review").length,
      quarantine_objects: record.plan_totals.quarantine_objects,
      sync_attempted: record.sync.attempted,
      reason_counts: reviewReasonCounts(record)
    })),
    review_source_refs: reviewSourceRefs
  };
}

async function main(): Promise<void> {
  const report = await buildSemanticReviewReport({
    ledgerPath: requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH"),
    maxSourceRefs: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_MAX_SOURCE_REFS"), 50, 0, 500)
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
