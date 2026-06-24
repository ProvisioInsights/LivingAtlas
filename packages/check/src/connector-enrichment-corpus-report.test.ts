import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConnectorEnrichmentCorpusReport } from "./connector-enrichment-corpus-report";

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    record_schema: "living-atlas-connector-enrichment-local-import:v1",
    recorded_at: "2026-06-24T00:00:00.000Z",
    authority_id: "la_authority_fixture0001",
    packet_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      generation: 2,
      object_count: 2,
      active_object_count: 2,
      tombstone_count: 0,
      plaintext_persistence: "encrypted"
    },
    object_refs: [
      {
        candidate_id: "la_enrich_candidate_fixture0001",
        object_id: "la_object_fixture0001",
        object_type: "page",
        access_class: "local-private",
        import_status: "promoted",
        source_id_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        evidence_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      },
      {
        candidate_id: "la_enrich_candidate_fixture0002",
        object_id: "la_object_fixture0002",
        object_type: "attachment",
        access_class: "quarantine",
        import_status: "quarantined",
        source_id_hash: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        evidence_hash: "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
      }
    ],
    ...overrides
  };
}

describe("connector enrichment corpus report", () => {
  it("dedupes packet ledgers and emits counts-only completion status", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-corpus-"));
    try {
      const firstPath = join(root, "first.json");
      const secondPath = join(root, "second.json");
      await writeFile(firstPath, JSON.stringify(ledger({
        recorded_at: "2026-06-24T00:00:00.000Z",
        import_totals: {
          created_objects: 2,
          updated_existing_objects: 0,
          already_existing_objects: 0,
          promoted_objects: 1,
          quarantine_objects: 1,
          failed_objects: 0
        }
      }), null, 2));
      await writeFile(secondPath, JSON.stringify(ledger({
        recorded_at: "2026-06-24T00:01:00.000Z",
        import_totals: {
          created_objects: 0,
          updated_existing_objects: 2,
          already_existing_objects: 0,
          promoted_objects: 0,
          quarantine_objects: 0,
          failed_objects: 0
        },
        object_refs: ledger().object_refs.map((ref) => ({ ...ref, import_status: "updated-existing" }))
      }), null, 2));

      const report = await buildConnectorEnrichmentCorpusReport({
        ledgerPaths: [firstPath, secondPath],
        requireComplete: true
      });

      expect(report.complete).toBe(true);
      expect(report.record_count).toBe(2);
      expect(report.deduped_packet_count).toBe(1);
      expect(report.packet_totals).toMatchObject({
        candidate_count: 2,
        promote_ready_count: 1,
        held_count: 1
      });
      expect(report.import_totals.updated_existing_objects).toBe(2);
      expect(report.object_totals.updated_existing_refs).toBe(2);
      expect(JSON.stringify(report)).not.toContain(root);
      expect(JSON.stringify(report)).not.toContain("Fixture Connector");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the completion gate for failed imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-connector-corpus-fail-"));
    try {
      const path = join(root, "failed.json");
      await writeFile(path, JSON.stringify(ledger({
        import_totals: {
          created_objects: 1,
          updated_existing_objects: 0,
          already_existing_objects: 0,
          promoted_objects: 0,
          quarantine_objects: 0,
          failed_objects: 1
        }
      }), null, 2));

      await expect(buildConnectorEnrichmentCorpusReport({
        ledgerPaths: [path],
        requireComplete: true
      })).rejects.toThrow("connector enrichment corpus incomplete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
