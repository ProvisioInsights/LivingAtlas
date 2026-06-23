import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const BatchRecordSchema = z.object({
  record_schema: z.literal("living-atlas-logseq-semantic-batch:v1"),
  recorded_at: z.string(),
  authority_id: z.string(),
  root_ref: z.string(),
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

type BatchRecord = z.infer<typeof BatchRecordSchema>;

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

function emptyTotals(): BatchRecord["plan_totals"] {
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

function addTotals(target: BatchRecord["plan_totals"], source: BatchRecord["plan_totals"]): BatchRecord["plan_totals"] {
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
    byWindow.set(`${record.file_offset}:${record.requested_file_count}`, record);
  }
  return [...byWindow.values()].sort((left, right) => left.file_offset - right.file_offset || left.requested_file_count - right.requested_file_count);
}

function coverage(records: BatchRecord[]): Array<{ start: number; end: number; count: number; synced: boolean }> {
  return records.map((record) => ({
    start: record.file_offset,
    end: record.file_offset + record.actual_file_count,
    count: record.actual_file_count,
    synced: record.sync.attempted && record.sync.synced_objects === record.plan_totals.planned_objects
  }));
}

function gaps(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const output: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of ranges.sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (range.start > cursor) {
      output.push({ start: cursor, end: range.start });
    }
    cursor = Math.max(cursor, range.end);
  }
  return output;
}

const ManifestSchema = z.object({
  manifest_schema: z.literal("living-atlas-logseq-semantic-corpus-manifest:v1"),
  manifest_id: z.string(),
  root_ref: z.string(),
  total_entries: z.number().int().nonnegative(),
  entries: z.array(z.object({
    ordinal: z.number().int().nonnegative(),
    source_path_ref: z.string(),
    terminal_decision: z.enum(["pending", "migrated", "skipped", "quarantined"]),
    discovery_status: z.string()
  }))
});

async function main(): Promise<void> {
  const path = requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH");
  const content = await readFile(path, "utf8");
  const records = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => BatchRecordSchema.parse(JSON.parse(line)));
  const latest = latestRecords(records);
  const totals = latest.reduce((sum, record) => addTotals(sum, record.plan_totals), emptyTotals());
  const decisions: Record<string, number> = {};
  for (const record of latest) {
    for (const [key, value] of Object.entries(record.decisions)) {
      decisions[key] = (decisions[key] ?? 0) + value;
    }
  }
  const ranges = coverage(latest);
  const coveredSourceRefs = new Set(latest.flatMap((record) => record.files.map((file) => file.source_path_ref)));
  const fileStatuses = latest.flatMap((record) => record.files);
  const manifestPath = envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MANIFEST_PATH");
  const manifest = manifestPath
    ? ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
    : undefined;
  const manifestPending = manifest?.entries.filter((entry) => entry.terminal_decision === "pending" && !coveredSourceRefs.has(entry.source_path_ref)) ?? [];
  const manifestTerminalSkipped = manifest?.entries.filter((entry) => entry.terminal_decision === "skipped" && !coveredSourceRefs.has(entry.source_path_ref)) ?? [];
  const manifestTerminalQuarantined = manifest?.entries.filter((entry) => entry.terminal_decision === "quarantined" && !coveredSourceRefs.has(entry.source_path_ref)) ?? [];
  const unsynced = latest.filter((record) => record.sync.attempted && record.sync.synced_objects !== record.plan_totals.planned_objects);
  const localOnly = latest.filter((record) => !record.sync.attempted);
  const synced = latest.filter((record) => record.sync.attempted);
  const latestGeneration = Math.max(0, ...synced.flatMap((record) => [
    record.sync.generation ?? 0,
    ...(record.sync.generations ?? [])
  ]));
  const summary = {
    report_schema: "living-atlas-logseq-semantic-ledger-report:v1",
    record_count: records.length,
    deduped_batch_count: latest.length,
    authority_id: latest[0]?.authority_id ?? null,
    root_ref: latest[0]?.root_ref ?? null,
    covered_file_count: latest.reduce((sum, record) => sum + record.actual_file_count, 0),
    synced_batch_count: synced.length,
    latest_sync_generation: latestGeneration,
    manifest: manifest ? {
      manifest_id: manifest.manifest_id,
      total_entries: manifest.total_entries,
      accounted_entries: coveredSourceRefs.size,
      pending_entries: manifestPending.length,
      terminal_skipped_entries: manifestTerminalSkipped.length,
      terminal_quarantined_entries: manifestTerminalQuarantined.length
    } : null,
    coverage: ranges,
    gaps: gaps(ranges),
    file_statuses: {
      migrated: fileStatuses.filter((file) => file.migration_status === "migrated").length,
      skipped: fileStatuses.filter((file) => file.migration_status === "skipped").length,
      quarantined: fileStatuses.filter((file) => file.migration_status === "quarantined").length,
      needs_review: fileStatuses.filter((file) => file.review_status === "needs-review").length,
      synced: fileStatuses.filter((file) => file.parity_status === "synced").length,
      local_verified: fileStatuses.filter((file) => file.parity_status === "local-verified").length,
      blocked: fileStatuses.filter((file) => file.parity_status === "blocked").length
    },
    totals,
    decisions
  };

  console.log(JSON.stringify(summary, null, 2));
  if (envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REQUIRE_COMPLETE") === "1") {
    const failures = [
      ...(gaps(ranges).length > 0 ? ["coverage-gaps"] : []),
      ...(localOnly.length > 0 ? ["local-only-batches"] : []),
      ...(unsynced.length > 0 ? ["synced-object-count-mismatch"] : []),
      ...(manifest && manifestPending.length > 0 ? ["manifest-pending-entries"] : [])
    ];
    if (failures.length > 0) {
      throw new Error(`semantic ledger incomplete: ${failures.join(",")}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
