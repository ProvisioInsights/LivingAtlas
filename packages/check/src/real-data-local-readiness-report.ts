import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  buildConnectorCoverageReportFromPath,
  type ConnectorCoverageReport
} from "./connector-coverage-report";
import {
  buildConnectorEnrichmentCorpusReport,
  type ConnectorEnrichmentCorpusReport
} from "./connector-enrichment-corpus-report";
import {
  buildSemanticCorpusAggregateReport,
  type SemanticCorpusAggregateReport
} from "./logseq-semantic-corpus-report";
import {
  buildTopicReviewReportFromPaths,
  type TopicReviewReport
} from "./logseq-semantic-topic-review-report";

const ComponentSchema = z.enum([
  "topic-review",
  "topic-local-import",
  "connector-coverage",
  "connector-enrichment"
]);
type Component = z.infer<typeof ComponentSchema>;

const TopicReviewLocalImportLedgerSchema = z.object({
  record_schema: z.literal("living-atlas-logseq-topic-review-local-import:v1"),
  plaintext_policy: z.literal("hash-counts-refs-only"),
  sync: z.object({
    attempted: z.boolean()
  }),
  packet_totals: z.object({
    covered_file_count: z.number().int().nonnegative(),
    candidate_count: z.number().int().nonnegative(),
    grouped_candidate_count: z.number().int().nonnegative(),
    excluded_suffix_tag_count: z.number().int().nonnegative()
  }),
  resolution_totals: z.object({
    resolution_count: z.number().int().nonnegative(),
    promote_topic_count: z.number().int().nonnegative(),
    defer_count: z.number().int().nonnegative(),
    reject_count: z.number().int().nonnegative(),
    unknown_target_count: z.number().int().nonnegative(),
    duplicate_resolution_count: z.number().int().nonnegative()
  }),
  import_totals: z.object({
    created_objects: z.number().int().nonnegative(),
    updated_existing_objects: z.number().int().nonnegative(),
    already_existing_objects: z.number().int().nonnegative(),
    promoted_objects: z.number().int().nonnegative(),
    quarantine_objects: z.number().int().nonnegative(),
    failed_objects: z.number().int().nonnegative()
  }),
  graph_status: z.object({
    generation: z.number().int().nonnegative(),
    object_count: z.number().int().nonnegative(),
    active_object_count: z.number().int().nonnegative(),
    tombstone_count: z.number().int().nonnegative(),
    plaintext_persistence: z.enum(["redacted", "encrypted", "allowed"])
  }),
  object_refs: z.array(z.object({
    object_id: z.string(),
    object_type: z.string(),
    access_class: z.enum(["local-private", "quarantine"]),
    import_status: z.enum(["promoted", "quarantined", "updated-existing", "already-exists", "failed"])
  }).passthrough()),
  by_reason_code: z.record(z.string(), z.number().int().nonnegative()),
  by_decision: z.record(z.string(), z.number().int().nonnegative()),
  by_subtype: z.record(z.string(), z.number().int().nonnegative())
}).passthrough();
type TopicReviewLocalImportLedger = z.infer<typeof TopicReviewLocalImportLedgerSchema>;

export type RealDataLocalReadinessReport = {
  report_schema: "living-atlas-real-data-local-readiness-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  complete: boolean;
  failures: string[];
  known_gaps: string[];
  cloudflare_sync_attempted: boolean;
  semantic: {
    complete: boolean;
    failures: string[];
    source_count: number;
    source_modes: string[];
    total_entries: number;
    covered_file_count: number;
    local_verified_file_count: number;
    synced_file_count: number;
    skipped_entries: number;
    manifest_quarantined_entries: number;
    pending_entries: number;
    coverage_gap_count: number;
    needs_review: number;
    valid_edge_candidates: number;
    quarantined_edge_candidates: number;
    edge_objects: number;
    quarantine_objects: number;
    planned_objects: number;
    crud_failed_batch_count: number;
    sync_attempted_batch_count: number;
    supplemental: {
      record_count: number;
      deduped_batch_count: number;
      needs_review: number;
      quarantine_objects: number;
      crud_failed_batch_count: number;
      sync_attempted_batch_count: number;
      planned_objects: number;
    };
  };
  topic_review: {
    provided: boolean;
    complete?: boolean;
    review_complete?: boolean;
    failures?: string[];
    candidate_count?: number;
    grouped_candidate_count?: number;
    excluded_suffix_tag_count?: number;
    resolution_count?: number;
    promoted_topic_count?: number;
    deferred_count?: number;
    rejected_count?: number;
    unresolved_group_count?: number;
    unresolved_candidate_count?: number;
  };
  topic_local_import: {
    provided: boolean;
    complete?: boolean;
    sync_attempted?: boolean;
    encrypted_persistence?: boolean;
    resolution_count?: number;
    promoted_topic_count?: number;
    deferred_count?: number;
    rejected_count?: number;
    imported_ref_count?: number;
    created_objects?: number;
    updated_existing_objects?: number;
    already_existing_objects?: number;
    promoted_objects?: number;
    quarantine_objects?: number;
    failed_objects?: number;
    graph_generation?: number;
    graph_object_count?: number;
    graph_active_object_count?: number;
    graph_tombstone_count?: number;
  };
  connector_coverage: {
    provided: boolean;
    complete?: boolean;
    failures?: string[];
    expected_connector_count?: number;
    connector_count?: number;
    entry_count?: number;
    queried_count?: number;
    limited_count?: number;
    unavailable_count?: number;
    skipped_count?: number;
    failed_count?: number;
    mutation_attempted_count?: number;
    total_result_count?: number;
  };
  connector_enrichment: {
    provided: boolean;
    complete?: boolean;
    failures?: string[];
    record_count?: number;
    deduped_packet_count?: number;
    sync_attempted_count?: number;
    encrypted_persistence?: boolean;
    candidate_count?: number;
    promote_ready_count?: number;
    held_count?: number;
    created_objects?: number;
    updated_existing_objects?: number;
    already_existing_objects?: number;
    promoted_objects?: number;
    quarantine_objects?: number;
    failed_objects?: number;
    unique_object_ref_count?: number;
    latest_graph_generation?: number;
    latest_graph_object_count?: number;
  };
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

function parsePathListFromEnv(key: string): string[] {
  return requireEnv(key)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalPathList(key: string): string[] {
  const value = envValue(key);
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseRequiredComponents(value: string | undefined): Component[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => ComponentSchema.parse(entry.trim()))
    .filter(Boolean);
}

async function readTopicLocalImportLedger(path: string): Promise<TopicReviewLocalImportLedger> {
  return TopicReviewLocalImportLedgerSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function semanticSection(report: SemanticCorpusAggregateReport): RealDataLocalReadinessReport["semantic"] {
  return {
    complete: report.complete,
    failures: report.failures,
    source_count: report.source_count,
    source_modes: report.source_modes,
    total_entries: report.manifests.total_entries,
    covered_file_count: report.ledgers.covered_file_count,
    local_verified_file_count: report.ledgers.local_verified_file_count,
    synced_file_count: report.ledgers.synced_file_count,
    skipped_entries: report.manifests.terminal_skipped_entries,
    manifest_quarantined_entries: report.manifests.terminal_quarantined_entries,
    pending_entries: report.manifests.pending_entries,
    coverage_gap_count: report.ledgers.coverage_gap_count,
    needs_review: report.quarantine.needs_review,
    valid_edge_candidates: report.totals.valid_edge_candidates,
    quarantined_edge_candidates: report.totals.quarantined_edge_candidates,
    edge_objects: report.totals.edge_objects,
    quarantine_objects: report.quarantine.quarantine_objects,
    planned_objects: report.totals.planned_objects,
    crud_failed_batch_count: report.ledgers.crud_failed_batch_count,
    sync_attempted_batch_count: report.ledgers.synced_batch_count,
    supplemental: {
      record_count: report.supplemental.record_count,
      deduped_batch_count: report.supplemental.deduped_batch_count,
      needs_review: report.supplemental.needs_review,
      quarantine_objects: report.supplemental.quarantine_objects,
      crud_failed_batch_count: report.supplemental.crud_failed_batch_count,
      sync_attempted_batch_count: report.supplemental.synced_batch_count,
      planned_objects: report.supplemental.totals.planned_objects
    }
  };
}

function topicReviewSection(report: TopicReviewReport): Required<RealDataLocalReadinessReport["topic_review"]> {
  return {
    provided: true,
    complete: report.complete,
    review_complete: report.review_complete,
    failures: report.failures,
    candidate_count: report.packet.candidate_count,
    grouped_candidate_count: report.packet.grouped_candidate_count,
    excluded_suffix_tag_count: report.packet.excluded_suffix_tag_count,
    resolution_count: report.resolutions.resolution_count,
    promoted_topic_count: report.resolutions.promoted_topic_count,
    deferred_count: report.resolutions.deferred_count,
    rejected_count: report.resolutions.rejected_count,
    unresolved_group_count: report.resolutions.unresolved_group_count,
    unresolved_candidate_count: report.resolutions.unresolved_candidate_count
  };
}

function topicLocalImportSection(ledger: TopicReviewLocalImportLedger): Required<RealDataLocalReadinessReport["topic_local_import"]> {
  const syncAttempted = ledger.sync.attempted;
  const encryptedPersistence = ledger.graph_status.plaintext_persistence === "encrypted";
  const failedObjects = ledger.import_totals.failed_objects + ledger.object_refs.filter((ref) => ref.import_status === "failed").length;
  return {
    provided: true,
    complete: !syncAttempted && encryptedPersistence && failedObjects === 0
      && ledger.resolution_totals.unknown_target_count === 0
      && ledger.resolution_totals.duplicate_resolution_count === 0,
    sync_attempted: syncAttempted,
    encrypted_persistence: encryptedPersistence,
    resolution_count: ledger.resolution_totals.resolution_count,
    promoted_topic_count: ledger.resolution_totals.promote_topic_count,
    deferred_count: ledger.resolution_totals.defer_count,
    rejected_count: ledger.resolution_totals.reject_count,
    imported_ref_count: ledger.object_refs.length,
    created_objects: ledger.import_totals.created_objects,
    updated_existing_objects: ledger.import_totals.updated_existing_objects,
    already_existing_objects: ledger.import_totals.already_existing_objects,
    promoted_objects: ledger.import_totals.promoted_objects,
    quarantine_objects: ledger.import_totals.quarantine_objects,
    failed_objects: ledger.import_totals.failed_objects,
    graph_generation: ledger.graph_status.generation,
    graph_object_count: ledger.graph_status.object_count,
    graph_active_object_count: ledger.graph_status.active_object_count,
    graph_tombstone_count: ledger.graph_status.tombstone_count
  };
}

function connectorCoverageSection(report: ConnectorCoverageReport): Required<RealDataLocalReadinessReport["connector_coverage"]> {
  return {
    provided: true,
    complete: report.complete,
    failures: report.failures,
    expected_connector_count: report.expected_connectors.length,
    connector_count: report.connector_count,
    entry_count: report.entry_count,
    queried_count: report.queried_count,
    limited_count: report.limited_count,
    unavailable_count: report.unavailable_count,
    skipped_count: report.skipped_count,
    failed_count: report.failed_count,
    mutation_attempted_count: report.mutation_attempted_count,
    total_result_count: report.total_result_count
  };
}

function connectorEnrichmentSection(report: ConnectorEnrichmentCorpusReport): Required<RealDataLocalReadinessReport["connector_enrichment"]> {
  const encryptedPersistence = report.graph.persistence_modes.length > 0
    && report.graph.persistence_modes.every((mode) => mode === "encrypted");
  return {
    provided: true,
    complete: report.complete,
    failures: report.failures,
    record_count: report.record_count,
    deduped_packet_count: report.deduped_packet_count,
    sync_attempted_count: report.sync_attempted_count,
    encrypted_persistence: encryptedPersistence,
    candidate_count: report.packet_totals.candidate_count,
    promote_ready_count: report.packet_totals.promote_ready_count,
    held_count: report.packet_totals.held_count,
    created_objects: report.import_totals.created_objects,
    updated_existing_objects: report.import_totals.updated_existing_objects,
    already_existing_objects: report.import_totals.already_existing_objects,
    promoted_objects: report.import_totals.promoted_objects,
    quarantine_objects: report.import_totals.quarantine_objects,
    failed_objects: report.import_totals.failed_objects,
    unique_object_ref_count: report.object_totals.unique_object_ref_count,
    latest_graph_generation: report.graph.latest_generation,
    latest_graph_object_count: report.graph.latest_object_count
  };
}

export async function buildRealDataLocalReadinessReport(input: {
  semanticManifestPaths: string[];
  semanticLedgerPaths: string[];
  semanticSupplementalLedgerPaths?: string[];
  topicReviewPacketPath?: string;
  topicReviewResolutionPath?: string;
  topicReviewLedgerPath?: string;
  connectorCoverageManifestPath?: string;
  connectorEnrichmentLedgerPaths?: string[];
  requireComplete?: boolean;
  requiredComponents?: Component[];
}): Promise<RealDataLocalReadinessReport> {
  if (input.semanticManifestPaths.length !== input.semanticLedgerPaths.length) {
    throw new Error("semantic manifest and ledger path counts must match");
  }

  const semantic = await buildSemanticCorpusAggregateReport({
    sources: input.semanticManifestPaths.map((manifestPath, index) => ({
      manifest_path: manifestPath,
      ledger_path: input.semanticLedgerPaths[index]!
    })),
    supplementalLedgerPaths: input.semanticSupplementalLedgerPaths ?? [],
    completionMode: "local"
  });
  const topicReview = input.topicReviewPacketPath
    ? await buildTopicReviewReportFromPaths({
        packetPath: input.topicReviewPacketPath,
        resolutionPath: input.topicReviewResolutionPath,
        requireComplete: input.requireComplete
      })
    : undefined;
  const topicLocalImport = input.topicReviewLedgerPath
    ? await readTopicLocalImportLedger(input.topicReviewLedgerPath)
    : undefined;
  const connectorCoverage = input.connectorCoverageManifestPath
    ? await buildConnectorCoverageReportFromPath(input.connectorCoverageManifestPath)
    : undefined;
  const connectorEnrichment = input.connectorEnrichmentLedgerPaths && input.connectorEnrichmentLedgerPaths.length > 0
    ? await buildConnectorEnrichmentCorpusReport({ ledgerPaths: input.connectorEnrichmentLedgerPaths })
    : undefined;

  const failures = new Set<string>();
  const knownGaps = new Set<string>();
  const required = new Set(input.requiredComponents ?? []);

  if (!semantic.complete) {
    failures.add(`semantic:${semantic.failures.join(",") || "incomplete"}`);
  }
  if (semantic.ledgers.synced_batch_count > 0 || semantic.supplemental.synced_batch_count > 0) {
    failures.add("semantic-cloudflare-sync-attempted");
  }

  if (!topicReview) {
    knownGaps.add("topic-review-not-provided");
    if (required.has("topic-review")) failures.add("missing-topic-review");
  } else if (!topicReview.complete || !topicReview.review_complete) {
    failures.add(`topic-review:${topicReview.failures.join(",") || "incomplete"}`);
  }

  if (!topicLocalImport) {
    knownGaps.add("topic-local-import-not-provided");
    if (required.has("topic-local-import")) failures.add("missing-topic-local-import");
  } else {
    const topicImport = topicLocalImportSection(topicLocalImport);
    if (!topicImport.complete) failures.add("topic-local-import-incomplete");
    if (topicImport.sync_attempted) failures.add("topic-local-import-sync-attempted");
    if (!topicImport.encrypted_persistence) failures.add("topic-local-import-not-encrypted");
  }

  if (!connectorCoverage) {
    knownGaps.add("connector-coverage-not-provided");
    if (required.has("connector-coverage")) failures.add("missing-connector-coverage");
  } else if (!connectorCoverage.complete) {
    failures.add(`connector-coverage:${connectorCoverage.failures.join(",") || "incomplete"}`);
  }

  if (!connectorEnrichment) {
    knownGaps.add("connector-enrichment-not-provided");
    if (required.has("connector-enrichment")) failures.add("missing-connector-enrichment");
  } else if (!connectorEnrichment.complete) {
    failures.add(`connector-enrichment:${connectorEnrichment.failures.join(",") || "incomplete"}`);
  }

  if (topicReview && topicReview.resolutions.promoted_topic_count === 0) {
    knownGaps.add("topic-review-promoted-zero-topics");
  }
  if (connectorEnrichment && connectorEnrichment.packet_totals.candidate_count <= 10) {
    knownGaps.add("connector-enrichment-seed-sized");
  }

  const topicImportSection: RealDataLocalReadinessReport["topic_local_import"] = topicLocalImport
    ? topicLocalImportSection(topicLocalImport)
    : { provided: false };
  const connectorEnrichmentSummary: RealDataLocalReadinessReport["connector_enrichment"] = connectorEnrichment
    ? connectorEnrichmentSection(connectorEnrichment)
    : { provided: false };
  const cloudflareSyncAttempted = semantic.ledgers.synced_batch_count > 0
    || semantic.supplemental.synced_batch_count > 0
    || topicImportSection.sync_attempted === true
    || connectorEnrichmentSummary.sync_attempted_count !== undefined && connectorEnrichmentSummary.sync_attempted_count > 0;

  const report: RealDataLocalReadinessReport = {
    report_schema: "living-atlas-real-data-local-readiness-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    complete: failures.size === 0,
    failures: [...failures].sort(),
    known_gaps: [...knownGaps].sort(),
    cloudflare_sync_attempted: cloudflareSyncAttempted,
    semantic: semanticSection(semantic),
    topic_review: topicReview ? topicReviewSection(topicReview) : { provided: false },
    topic_local_import: topicImportSection,
    connector_coverage: connectorCoverage ? connectorCoverageSection(connectorCoverage) : { provided: false },
    connector_enrichment: connectorEnrichmentSummary
  };

  if (input.requireComplete && !report.complete) {
    throw new Error(`real data local readiness incomplete: ${report.failures.join(",")}`);
  }

  return report;
}

async function main(): Promise<void> {
  const report = await buildRealDataLocalReadinessReport({
    semanticManifestPaths: parsePathListFromEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_AGGREGATE_MANIFEST_PATHS"),
    semanticLedgerPaths: parsePathListFromEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_AGGREGATE_LEDGER_PATHS"),
    semanticSupplementalLedgerPaths: parseOptionalPathList("LIVING_ATLAS_LOGSEQ_SEMANTIC_SUPPLEMENTAL_LEDGER_PATHS"),
    topicReviewPacketPath: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH"),
    topicReviewResolutionPath: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH"),
    topicReviewLedgerPath: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_LEDGER_PATH"),
    connectorCoverageManifestPath: envValue("LIVING_ATLAS_CONNECTOR_COVERAGE_MANIFEST_PATH"),
    connectorEnrichmentLedgerPaths: parseOptionalPathList("LIVING_ATLAS_CONNECTOR_ENRICHMENT_LEDGER_PATHS"),
    requireComplete: envValue("LIVING_ATLAS_REAL_DATA_LOCAL_READINESS_REQUIRE_COMPLETE") === "1",
    requiredComponents: parseRequiredComponents(envValue("LIVING_ATLAS_REAL_DATA_LOCAL_READINESS_REQUIRED_COMPONENTS"))
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
