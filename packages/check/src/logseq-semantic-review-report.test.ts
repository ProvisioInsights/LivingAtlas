import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticReviewReport } from "./logseq-semantic-review-report";

const baseRecord = {
  record_schema: "living-atlas-logseq-semantic-batch:v1",
  recorded_at: "2026-06-24T00:00:00.000Z",
  authority_id: "la_authority_fixture0001",
  root_ref: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  source_kind: "logseq",
  source_mode: "markdown-only",
  file_offset: 0,
  requested_file_count: 2,
  actual_file_count: 2,
  ledger_id: "la_semantic_ledger_fixture",
  plan_totals: {
    bytes: 100,
    pages: 2,
    blocks: 2,
    page_properties: 4,
    block_properties: 0,
    wikilinks: 2,
    hash_tags: 1,
    block_refs: 0,
    edge_candidates: 4,
    valid_edge_candidates: 1,
    quarantined_edge_candidates: 3,
    planned_objects: 12,
    page_objects: 2,
    block_objects: 2,
    reference_index_objects: 2,
    edge_objects: 4,
    quarantine_objects: 3
  },
  crud: {
    ok: true,
    local_generation: 12,
    checked_cases: 8
  },
  sync: {
    attempted: false
  },
  files: [
    {
      source_path_ref: "la_source_fixture000000000001",
      content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      migration_status: "quarantined",
      review_status: "needs-review",
      parity_status: "local-verified",
      source_capsule_object_id: "la_object_fixture000000000001",
      planned_objects: 6,
      object_plan_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    },
    {
      source_path_ref: "la_source_fixture000000000002",
      content_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      migration_status: "migrated",
      review_status: "not-required",
      parity_status: "local-verified",
      source_capsule_object_id: "la_object_fixture000000000002",
      planned_objects: 6,
      object_plan_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  ],
  decisions: {
    "source-capsule-preserved": 2,
    "property-edge-promoted": 1,
    "non-wikilink-location-review": 2,
    "suffix-tag-direction-review": 1
  },
  plaintext_policy: "hash-counts-refs-only"
};

describe("Logseq semantic review report", () => {
  it("summarizes review work without source paths or plaintext values", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-review-report-"));
    try {
      const ledgerPath = join(root, "ledger.jsonl");
      await writeFile(ledgerPath, `${JSON.stringify(baseRecord)}\n`);

      const report = await buildSemanticReviewReport({
        ledgerPath,
        maxSourceRefs: 10
      });

      expect(report.report_schema).toBe("living-atlas-logseq-semantic-review-report:v1");
      expect(report.record_count).toBe(1);
      expect(report.deduped_batch_count).toBe(1);
      expect(report.review_totals).toMatchObject({
        needs_review_files: 1,
        quarantined_files: 1,
        quarantine_objects: 3,
        edge_candidates: 4,
        valid_edge_candidates: 1,
        quarantined_edge_candidates: 3,
        local_only_batches: 1
      });
      expect(report.reason_counts).toEqual({
        "non-wikilink-location-review": 2,
        "suffix-tag-direction-review": 1
      });
      expect(report.review_source_refs).toHaveLength(1);
      expect(report.review_source_refs[0]).toMatchObject({
        source_path_ref: "la_source_fixture000000000001",
        object_plan_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      });
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Synthetic");
      expect(JSON.stringify(report)).not.toContain("source-capsule-preserved");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
