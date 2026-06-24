import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { MarkdownImportSourceKindSchema, type MarkdownImportSourceKind } from "@living-atlas/importer";
import { z } from "zod";
import {
  SemanticSourceModeSchema,
  type SemanticSourceMode
} from "./logseq-semantic-source-files";

const CompletionModeSchema = z.enum(["local", "synced"]);
type CompletionMode = z.infer<typeof CompletionModeSchema>;

const ManifestSchema = z.object({
  manifest_schema: z.literal("living-atlas-logseq-semantic-corpus-manifest:v1"),
  manifest_id: z.string(),
  root_ref: z.string(),
  source_kind: MarkdownImportSourceKindSchema.optional(),
  source_mode: SemanticSourceModeSchema.optional(),
  total_entries: z.number().int().nonnegative(),
  entries: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    source_path_ref: z.string(),
    terminal_decision: z.enum(["pending", "migrated", "skipped", "quarantined"]),
    discovery_status: z.string()
  }))
});

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
    bytes: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    page_properties: z.number().int().nonnegative(),
    block_properties: z.number().int().nonnegative(),
    wikilinks: z.number().int().nonnegative(),
    hash_tags: z.number().int().nonnegative(),
    block_refs: z.number().int().nonnegative(),
    edge_candidates: z.number().int().nonnegative(),
    valid_edge_candidates: z.number().int().nonnegative(),
    quarantined_edge_candidates: z.number().int().nonnegative(),
    planned_objects: z.number().int().nonnegative(),
    page_objects: z.number().int().nonnegative(),
    block_objects: z.number().int().nonnegative(),
    reference_index_objects: z.number().int().nonnegative(),
    edge_objects: z.number().int().nonnegative(),
    quarantine_objects: z.number().int().nonnegative()
  }),
  crud: z.object({
    ok: z.boolean(),
    local_generation: z.number().int().nonnegative(),
    checked_cases: z.number().int().nonnegative()
  }),
  sync: z.object({
    attempted: z.boolean(),
    generation: z.number().int().nonnegative().optional(),
    generations: z.array(z.number().int().nonnegative()).optional(),
    batch_count: z.number().int().positive().optional(),
    synced_objects: z.number().int().nonnegative().optional()
  }),
  files: z.array(z.object({
    source_path_ref: z.string(),
    content_hash: z.string(),
    migration_status: z.enum(["migrated", "skipped", "quarantined"]),
    review_status: z.enum(["not-required", "needs-review", "reviewed"]),
    parity_status: z.enum(["local-verified", "synced", "blocked"]),
    source_capsule_object_id: z.string(),
    planned_objects: z.number().int().nonnegative(),
    object_plan_hash: z.string()
  })).default([]),
  decisions: z.record(z.string(), z.number().int().nonnegative()),
  plaintext_policy: z.literal("hash-counts-refs-only")
});

type Manifest = z.infer<typeof ManifestSchema>;
type BatchRecord = z.infer<typeof BatchRecordSchema>;

type CorpusInput = {
  manifest_path: string;
  ledger_path: string;
};

type Totals = BatchRecord["plan_totals"];

export type SemanticCorpusAggregateReport = {
  report_schema: "living-atlas-logseq-semantic-corpus-aggregate-report:v1";
  completion_mode: CompletionMode;
  complete: boolean;
  failures: string[];
  source_count: number;
  source_modes: SemanticSourceMode[];
  source_kinds: MarkdownImportSourceKind[];
  manifest_ids: string[];
  authority_ids: string[];
  root_refs: string[];
  manifests: {
    total_entries: number;
    pending_entries: number;
    terminal_skipped_entries: number;
    terminal_quarantined_entries: number;
    duplicate_source_refs: number;
    manifest_ledger_root_mismatches: number;
  };
  ledgers: {
    record_count: number;
    deduped_batch_count: number;
    covered_file_count: number;
    local_verified_file_count: number;
    synced_file_count: number;
    blocked_file_count: number;
    local_only_batch_count: number;
    synced_batch_count: number;
    crud_failed_batch_count: number;
    unsynced_batch_count: number;
    coverage_gap_count: number;
  };
  quarantine: {
    manifest_terminal_quarantined: number;
    migrated_file_quarantined: number;
    needs_review: number;
    quarantine_objects: number;
  };
  totals: Totals;
  decisions: Record<string, number>;
  plaintext_policy: "hash-counts-refs-only";
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

function parsePathList(key: string): string[] {
  return requireEnv(key)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function recordSourceKind(record: BatchRecord): MarkdownImportSourceKind {
  return record.source_kind ?? "logseq";
}

function recordSourceMode(record: BatchRecord): SemanticSourceMode {
  return record.source_mode ?? "markdown-only";
}

function manifestSourceKind(manifest: Manifest): MarkdownImportSourceKind {
  return manifest.source_kind ?? "logseq";
}

function manifestSourceMode(manifest: Manifest): SemanticSourceMode {
  return manifest.source_mode ?? "markdown-only";
}

function emptyTotals(): Totals {
  return {
    bytes: 0,
    pages: 0,
    blocks: 0,
    page_properties: 0,
    block_properties: 0,
    wikilinks: 0,
    hash_tags: 0,
    block_refs: 0,
    edge_candidates: 0,
    valid_edge_candidates: 0,
    quarantined_edge_candidates: 0,
    planned_objects: 0,
    page_objects: 0,
    block_objects: 0,
    reference_index_objects: 0,
    edge_objects: 0,
    quarantine_objects: 0
  };
}

function addTotals(target: Totals, source: Totals): Totals {
  return {
    bytes: target.bytes + source.bytes,
    pages: target.pages + source.pages,
    blocks: target.blocks + source.blocks,
    page_properties: target.page_properties + source.page_properties,
    block_properties: target.block_properties + source.block_properties,
    wikilinks: target.wikilinks + source.wikilinks,
    hash_tags: target.hash_tags + source.hash_tags,
    block_refs: target.block_refs + source.block_refs,
    edge_candidates: target.edge_candidates + source.edge_candidates,
    valid_edge_candidates: target.valid_edge_candidates + source.valid_edge_candidates,
    quarantined_edge_candidates: target.quarantined_edge_candidates + source.quarantined_edge_candidates,
    planned_objects: target.planned_objects + source.planned_objects,
    page_objects: target.page_objects + source.page_objects,
    block_objects: target.block_objects + source.block_objects,
    reference_index_objects: target.reference_index_objects + source.reference_index_objects,
    edge_objects: target.edge_objects + source.edge_objects,
    quarantine_objects: target.quarantine_objects + source.quarantine_objects
  };
}

function latestRecords(records: BatchRecord[]): BatchRecord[] {
  const byWindow = new Map<string, BatchRecord>();
  for (const record of records) {
    byWindow.set(`${recordSourceKind(record)}:${recordSourceMode(record)}:${record.file_offset}:${record.requested_file_count}`, record);
  }
  return [...byWindow.values()].sort((left, right) => (
    recordSourceMode(left).localeCompare(recordSourceMode(right))
    || left.file_offset - right.file_offset
    || left.requested_file_count - right.requested_file_count
  ));
}

function gapCount(records: BatchRecord[]): number {
  let cursor = 0;
  let gaps = 0;
  for (const record of [...records].sort((left, right) => left.file_offset - right.file_offset || left.requested_file_count - right.requested_file_count)) {
    if (record.file_offset > cursor) {
      gaps += 1;
    }
    cursor = Math.max(cursor, record.file_offset + record.actual_file_count);
  }
  return gaps;
}

async function readLedger(path: string): Promise<BatchRecord[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => BatchRecordSchema.parse(JSON.parse(line)));
}

export async function buildSemanticCorpusAggregateReport(input: {
  sources: CorpusInput[];
  completionMode?: CompletionMode;
}): Promise<SemanticCorpusAggregateReport> {
  const completionMode = input.completionMode ?? "local";
  const manifests: Manifest[] = [];
  const rawRecords: BatchRecord[] = [];
  const failures = new Set<string>();
  const sourceRefsByMode = new Map<string, Set<string>>();
  const sourceRefOccurrences = new Map<string, number>();
  const manifestPendingRefs = new Set<string>();
  let manifestLedgerRootMismatches = 0;
  let terminalSkippedEntries = 0;
  let terminalQuarantinedEntries = 0;

  for (const source of input.sources) {
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(source.manifest_path, "utf8")));
    const records = await readLedger(source.ledger_path);
    manifests.push(manifest);
    rawRecords.push(...records);

    const mode = manifestSourceMode(manifest);
    const manifestRefs = sourceRefsByMode.get(mode) ?? new Set<string>();
    sourceRefsByMode.set(mode, manifestRefs);
    for (const entry of manifest.entries) {
      if (manifestRefs.has(entry.source_path_ref)) {
        failures.add("duplicate-source-refs-within-mode");
      }
      manifestRefs.add(entry.source_path_ref);
      if (entry.terminal_decision === "pending") {
        manifestPendingRefs.add(entry.source_path_ref);
        sourceRefOccurrences.set(entry.source_path_ref, (sourceRefOccurrences.get(entry.source_path_ref) ?? 0) + 1);
      } else if (entry.terminal_decision === "skipped") {
        terminalSkippedEntries += 1;
      } else if (entry.terminal_decision === "quarantined") {
        terminalQuarantinedEntries += 1;
      }
    }

    for (const record of records) {
      if (recordSourceKind(record) !== manifestSourceKind(manifest) || recordSourceMode(record) !== mode) {
        failures.add("manifest-ledger-source-mismatch");
      }
      if (record.root_ref !== manifest.root_ref) {
        manifestLedgerRootMismatches += 1;
      }
    }
  }

  const latest = latestRecords(rawRecords);
  const coveredRefs = new Set(latest.flatMap((record) => record.files.map((file) => file.source_path_ref)));
  const pendingUncovered = [...manifestPendingRefs].filter((sourceRef) => !coveredRefs.has(sourceRef));
  if (pendingUncovered.length > 0) {
    failures.add("manifest-pending-entries");
  }

  const duplicateSourceRefs = [...sourceRefOccurrences.values()].filter((count) => count > 1).length;
  if (duplicateSourceRefs > 0) {
    failures.add("duplicate-source-refs-across-sources");
  }

  const recordsByMode = new Map<SemanticSourceMode, BatchRecord[]>();
  for (const record of latest) {
    const mode = recordSourceMode(record);
    const records = recordsByMode.get(mode) ?? [];
    records.push(record);
    recordsByMode.set(mode, records);
  }
  const coverageGapCount = [...recordsByMode.values()].reduce((sum, records) => sum + gapCount(records), 0);
  if (coverageGapCount > 0) {
    failures.add("coverage-gaps");
  }

  const crudFailed = latest.filter((record) => !record.crud.ok);
  if (crudFailed.length > 0) {
    failures.add("crud-failed-batches");
  }

  const unsynced = latest.filter((record) => record.sync.attempted && record.sync.synced_objects !== record.plan_totals.planned_objects);
  if (unsynced.length > 0) {
    failures.add("synced-object-count-mismatch");
  }

  const localOnly = latest.filter((record) => !record.sync.attempted);
  if (completionMode === "synced" && localOnly.length > 0) {
    failures.add("local-only-batches");
  }

  const fileStatuses = latest.flatMap((record) => record.files);
  if (fileStatuses.some((file) => file.parity_status === "blocked")) {
    failures.add("blocked-files");
  }
  if (completionMode === "synced" && fileStatuses.some((file) => file.parity_status !== "synced")) {
    failures.add("unsynced-files");
  }

  const totals = latest.reduce((sum, record) => addTotals(sum, record.plan_totals), emptyTotals());
  const decisions: Record<string, number> = {};
  for (const record of latest) {
    for (const [key, value] of Object.entries(record.decisions)) {
      decisions[key] = (decisions[key] ?? 0) + value;
    }
  }

  return {
    report_schema: "living-atlas-logseq-semantic-corpus-aggregate-report:v1",
    completion_mode: completionMode,
    complete: failures.size === 0,
    failures: [...failures].sort(),
    source_count: input.sources.length,
    source_modes: [...new Set(manifests.map(manifestSourceMode))].sort(),
    source_kinds: [...new Set(manifests.map(manifestSourceKind))].sort(),
    manifest_ids: manifests.map((manifest) => manifest.manifest_id).sort(),
    authority_ids: [...new Set(latest.map((record) => record.authority_id))].sort(),
    root_refs: [...new Set(manifests.map((manifest) => manifest.root_ref))].sort(),
    manifests: {
      total_entries: manifests.reduce((sum, manifest) => sum + manifest.total_entries, 0),
      pending_entries: pendingUncovered.length,
      terminal_skipped_entries: terminalSkippedEntries,
      terminal_quarantined_entries: terminalQuarantinedEntries,
      duplicate_source_refs: duplicateSourceRefs,
      manifest_ledger_root_mismatches: manifestLedgerRootMismatches
    },
    ledgers: {
      record_count: rawRecords.length,
      deduped_batch_count: latest.length,
      covered_file_count: latest.reduce((sum, record) => sum + record.actual_file_count, 0),
      local_verified_file_count: fileStatuses.filter((file) => file.parity_status === "local-verified").length,
      synced_file_count: fileStatuses.filter((file) => file.parity_status === "synced").length,
      blocked_file_count: fileStatuses.filter((file) => file.parity_status === "blocked").length,
      local_only_batch_count: localOnly.length,
      synced_batch_count: latest.filter((record) => record.sync.attempted).length,
      crud_failed_batch_count: crudFailed.length,
      unsynced_batch_count: unsynced.length,
      coverage_gap_count: coverageGapCount
    },
    quarantine: {
      manifest_terminal_quarantined: terminalQuarantinedEntries,
      migrated_file_quarantined: fileStatuses.filter((file) => file.migration_status === "quarantined").length,
      needs_review: fileStatuses.filter((file) => file.review_status === "needs-review").length,
      quarantine_objects: totals.quarantine_objects
    },
    totals,
    decisions,
    plaintext_policy: "hash-counts-refs-only"
  };
}

async function main(): Promise<void> {
  const manifestPaths = parsePathList("LIVING_ATLAS_LOGSEQ_SEMANTIC_AGGREGATE_MANIFEST_PATHS");
  const ledgerPaths = parsePathList("LIVING_ATLAS_LOGSEQ_SEMANTIC_AGGREGATE_LEDGER_PATHS");
  if (manifestPaths.length !== ledgerPaths.length) {
    throw new Error("aggregate manifest and ledger path counts must match");
  }
  const completionMode = CompletionModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_COMPLETION_MODE") ?? "local");
  const report = await buildSemanticCorpusAggregateReport({
    sources: manifestPaths.map((manifestPath, index) => ({
      manifest_path: manifestPath,
      ledger_path: ledgerPaths[index]!
    })),
    completionMode
  });
  console.log(JSON.stringify(report, null, 2));
  if (envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REQUIRE_COMPLETE") === "1" && !report.complete) {
    throw new Error(`semantic corpus aggregate incomplete: ${report.failures.join(",")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
