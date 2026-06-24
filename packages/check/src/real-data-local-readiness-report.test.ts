import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRealDataLocalReadinessReport } from "./real-data-local-readiness-report";

const hashA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const hashB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const hashC = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const hashD = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

const totals = {
  bytes: 20,
  pages: 1,
  blocks: 2,
  page_properties: 1,
  block_properties: 0,
  wikilinks: 1,
  hash_tags: 1,
  block_refs: 0,
  edge_candidates: 1,
  valid_edge_candidates: 1,
  quarantined_edge_candidates: 0,
  planned_objects: 4,
  page_objects: 1,
  block_objects: 2,
  reference_index_objects: 0,
  edge_objects: 1,
  quarantine_objects: 0
};

function semanticManifest() {
  return {
    manifest_schema: "living-atlas-logseq-semantic-corpus-manifest:v1",
    manifest_id: "la_semantic_manifest_fixture0001",
    root_ref: hashA,
    source_kind: "logseq",
    source_mode: "logseq-notes",
    total_entries: 2,
    entries: [
      {
        ordinal: 0,
        source_path_ref: "la_source_aaaaaaaaaaaaaaaaaaaaaaaa",
        terminal_decision: "pending",
        discovery_status: "readable"
      },
      {
        ordinal: 1,
        source_path_ref: "la_source_bbbbbbbbbbbbbbbbbbbbbbbb",
        terminal_decision: "skipped",
        discovery_status: "hidden-artifact"
      }
    ]
  };
}

function semanticLedger(syncAttempted = false) {
  return {
    record_schema: "living-atlas-logseq-semantic-batch:v1",
    recorded_at: "2026-06-24T00:00:00.000Z",
    authority_id: "la_authority_fixture0001",
    root_ref: hashA,
    source_kind: "logseq",
    source_mode: "logseq-notes",
    file_offset: 0,
    requested_file_count: 1,
    actual_file_count: 1,
    ledger_id: "la_semantic_ledger_fixture0001",
    plan_totals: totals,
    crud: {
      ok: true,
      local_generation: 1,
      checked_cases: 4
    },
    sync: syncAttempted
      ? {
          attempted: true,
          generation: 1,
          synced_objects: totals.planned_objects
        }
      : {
          attempted: false
        },
    files: [
      {
        source_path_ref: "la_source_aaaaaaaaaaaaaaaaaaaaaaaa",
        content_hash: hashB,
        migration_status: "migrated",
        review_status: "not-required",
        parity_status: syncAttempted ? "synced" : "local-verified",
        source_capsule_object_id: "la_object_fixture0000000001",
        planned_objects: totals.planned_objects,
        object_plan_hash: hashC
      }
    ],
    decisions: {
      "source-capsule-preserved": 1,
      "typed-edge-promoted": 1
    },
    plaintext_policy: "hash-counts-refs-only"
  };
}

function topicPacket() {
  return {
    packet_schema: "living-atlas-logseq-topic-review-packet:v1",
    plaintext_policy: "local-private-topic-review-packet",
    source_path_policy: "redacted",
    generated_at: "2026-06-24T00:00:00.000Z",
    source_mode: "logseq-notes",
    covered_file_count: 1,
    candidate_count: 1,
    grouped_candidate_count: 1,
    excluded_suffix_tag_count: 0,
    reason_counts: {
      "hash-tag-topic-review": 1
    },
    groups: [
      {
        reason_code: "hash-tag-topic-review",
        target_hash: hashD,
        target_value: "Synthetic Topic Alpha",
        occurrence_count: 1,
        source_refs: ["la_source_aaaaaaaaaaaaaaaaaaaaaaaa"]
      }
    ]
  };
}

function topicResolutions() {
  return {
    resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
    plaintext_policy: "local-private-topic-review-resolution-map",
    generated_at: "2026-06-24T00:01:00.000Z",
    resolutions: [
      {
        target_hash: hashD,
        reason_code: "hash-tag-topic-review",
        decision: "defer",
        confidence: "high"
      }
    ]
  };
}

function topicLedger(input: { syncAttempted?: boolean; persistence?: "encrypted" | "allowed" } = {}) {
  return {
    record_schema: "living-atlas-logseq-topic-review-local-import:v1",
    recorded_at: "2026-06-24T00:02:00.000Z",
    authority_id: "la_authority_fixture0001",
    packet_hash: hashA,
    resolution_hash: hashB,
    plaintext_policy: "hash-counts-refs-only",
    sync: { attempted: input.syncAttempted ?? false },
    packet_totals: {
      covered_file_count: 1,
      candidate_count: 1,
      grouped_candidate_count: 1,
      excluded_suffix_tag_count: 0
    },
    resolution_totals: {
      resolution_count: 1,
      promote_topic_count: 0,
      defer_count: 1,
      reject_count: 0,
      unknown_target_count: 0,
      duplicate_resolution_count: 0
    },
    import_totals: {
      created_objects: 1,
      updated_existing_objects: 0,
      already_existing_objects: 0,
      promoted_objects: 0,
      quarantine_objects: 1,
      failed_objects: 0
    },
    by_reason_code: { "hash-tag-topic-review": 1 },
    by_decision: { defer: 1 },
    by_subtype: {},
    graph_status: {
      generation: 2,
      object_count: 4,
      active_object_count: 4,
      tombstone_count: 0,
      plaintext_persistence: input.persistence ?? "encrypted"
    },
    object_refs: [
      {
        target_hash: hashD,
        reason_code: "hash-tag-topic-review",
        object_id: "la_object_topicreview0001",
        object_type: "attachment",
        access_class: "quarantine",
        import_status: "quarantined"
      }
    ]
  };
}

function connectorCoverage() {
  return {
    manifest_schema: "living-atlas-connector-coverage-manifest:v1",
    plaintext_policy: "counts-only-connector-coverage-manifest",
    source_path_policy: "redacted",
    generated_at: "2026-06-24T00:00:00.000Z",
    expected_connectors: ["outlook-calendar", "fireflies"],
    coverage_entries: [
      {
        connector: "outlook-calendar",
        status: "queried",
        query_kind: "calendar-window",
        fetched_at: "2026-06-24T00:00:00.000Z",
        result_count: 2,
        evidence_kind: "calendar-event",
        mutation_attempted: false
      },
      {
        connector: "fireflies",
        status: "limited",
        query_kind: "tool-discovery",
        reason_code: "tool-not-exposed",
        mutation_attempted: false
      }
    ]
  };
}

function connectorEnrichment() {
  return {
    record_schema: "living-atlas-connector-enrichment-local-import:v1",
    recorded_at: "2026-06-24T00:03:00.000Z",
    authority_id: "la_authority_fixture0001",
    packet_hash: hashC,
    packet_generated_at: "2026-06-24T00:00:00.000Z",
    plaintext_policy: "hash-counts-refs-only",
    sync: { attempted: false },
    packet_totals: {
      candidate_count: 2,
      promote_ready_count: 1,
      held_count: 1,
      duplicate_candidate_id_count: 0
    },
    import_totals: {
      created_objects: 2,
      updated_existing_objects: 0,
      already_existing_objects: 0,
      promoted_objects: 1,
      quarantine_objects: 1,
      failed_objects: 0
    },
    by_connector: { "outlook-calendar": 1, fireflies: 1 },
    by_fact_kind: { occurrence: 1, "source-note": 1 },
    by_decision: { promote: 1, defer: 1 },
    by_confidence: { high: 1, medium: 1 },
    by_endpoint_type: { occurrence: 1 },
    by_predicate: {},
    graph_status: {
      generation: 3,
      object_count: 6,
      active_object_count: 6,
      tombstone_count: 0,
      plaintext_persistence: "encrypted"
    },
    object_refs: [
      {
        candidate_id: "la_enrich_candidate_fixture0001",
        object_id: "la_object_enrich0001",
        object_type: "page",
        access_class: "local-private",
        import_status: "promoted",
        source_id_hash: hashA,
        evidence_hash: hashB
      },
      {
        candidate_id: "la_enrich_candidate_fixture0002",
        object_id: "la_object_enrich0002",
        object_type: "attachment",
        access_class: "quarantine",
        import_status: "quarantined",
        source_id_hash: hashC,
        evidence_hash: hashD
      }
    ]
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFixtureSet(root: string, input: {
  semanticSync?: boolean;
  topicSync?: boolean;
  topicPersistence?: "encrypted" | "allowed";
} = {}) {
  await mkdir(root, { recursive: true });
  const paths = {
    semanticManifest: join(root, "semantic-manifest.json"),
    semanticLedger: join(root, "semantic-ledger.jsonl"),
    topicPacket: join(root, "topic-packet.json"),
    topicResolutions: join(root, "topic-resolutions.json"),
    topicLedger: join(root, "topic-ledger.json"),
    connectorCoverage: join(root, "connector-coverage.json"),
    connectorEnrichment: join(root, "connector-enrichment.json")
  };
  await writeJson(paths.semanticManifest, semanticManifest());
  await writeFile(paths.semanticLedger, `${JSON.stringify(semanticLedger(input.semanticSync))}\n`);
  await writeJson(paths.topicPacket, topicPacket());
  await writeJson(paths.topicResolutions, topicResolutions());
  await writeJson(paths.topicLedger, topicLedger({ syncAttempted: input.topicSync, persistence: input.topicPersistence }));
  await writeJson(paths.connectorCoverage, connectorCoverage());
  await writeJson(paths.connectorEnrichment, connectorEnrichment());
  return paths;
}

describe("real data local readiness report", () => {
  it("composes count-only local readiness across semantic, topic, and connector artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-local-readiness-"));
    try {
      const paths = await writeFixtureSet(root);

      const report = await buildRealDataLocalReadinessReport({
        semanticManifestPaths: [paths.semanticManifest],
        semanticLedgerPaths: [paths.semanticLedger],
        topicReviewPacketPath: paths.topicPacket,
        topicReviewResolutionPath: paths.topicResolutions,
        topicReviewLedgerPath: paths.topicLedger,
        connectorCoverageManifestPath: paths.connectorCoverage,
        connectorEnrichmentLedgerPaths: [paths.connectorEnrichment],
        requiredComponents: ["topic-review", "topic-local-import", "connector-coverage", "connector-enrichment"]
      });

      expect(report.complete).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.semantic.total_entries).toBe(2);
      expect(report.semantic.covered_file_count).toBe(1);
      expect(report.semantic.valid_edge_candidates).toBe(1);
      expect(report.topic_review.review_complete).toBe(true);
      expect(report.topic_local_import.encrypted_persistence).toBe(true);
      expect(report.connector_coverage.queried_count).toBe(1);
      expect(report.connector_enrichment.unique_object_ref_count).toBe(2);
      expect(report.cloudflare_sync_attempted).toBe(false);
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Synthetic Topic Alpha");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails complete mode when required optional artifact families are missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-local-readiness-missing-"));
    try {
      const paths = await writeFixtureSet(root);

      await expect(buildRealDataLocalReadinessReport({
        semanticManifestPaths: [paths.semanticManifest],
        semanticLedgerPaths: [paths.semanticLedger],
        requireComplete: true,
        requiredComponents: ["topic-review", "topic-local-import", "connector-coverage", "connector-enrichment"]
      })).rejects.toThrow("missing-topic-review");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flags cloud sync attempts and non-encrypted local persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-local-readiness-fail-"));
    try {
      const paths = await writeFixtureSet(root, {
        semanticSync: true,
        topicSync: true,
        topicPersistence: "allowed"
      });

      const report = await buildRealDataLocalReadinessReport({
        semanticManifestPaths: [paths.semanticManifest],
        semanticLedgerPaths: [paths.semanticLedger],
        topicReviewPacketPath: paths.topicPacket,
        topicReviewResolutionPath: paths.topicResolutions,
        topicReviewLedgerPath: paths.topicLedger
      });

      expect(report.complete).toBe(false);
      expect(report.cloudflare_sync_attempted).toBe(true);
      expect(report.failures).toContain("semantic-cloudflare-sync-attempted");
      expect(report.failures).toContain("topic-local-import-sync-attempted");
      expect(report.failures).toContain("topic-local-import-not-encrypted");
      expect(report.topic_local_import.encrypted_persistence).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
