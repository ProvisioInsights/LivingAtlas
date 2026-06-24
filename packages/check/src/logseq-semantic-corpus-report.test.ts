import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSemanticCorpusAggregateReport } from "./logseq-semantic-corpus-report";

const baseTotals = {
  bytes: 10,
  pages: 1,
  blocks: 1,
  page_properties: 0,
  block_properties: 0,
  wikilinks: 0,
  hash_tags: 0,
  block_refs: 0,
  edge_candidates: 0,
  valid_edge_candidates: 0,
  quarantined_edge_candidates: 0,
  planned_objects: 3,
  page_objects: 1,
  block_objects: 1,
  reference_index_objects: 0,
  edge_objects: 0,
  quarantine_objects: 0
};

function manifest(input: {
  id: string;
  mode: "markdown-only" | "logseq-extensionless-only";
  rootRef: string;
  refs: Array<{ ref: string; terminal: "pending" | "skipped" | "quarantined"; status?: string }>;
}) {
  return {
    manifest_schema: "living-atlas-logseq-semantic-corpus-manifest:v1",
    manifest_id: input.id,
    root_ref: input.rootRef,
    source_kind: "logseq",
    source_mode: input.mode,
    total_entries: input.refs.length,
    entries: input.refs.map((entry, index) => ({
      ordinal: index,
      source_path_ref: entry.ref,
      discovery_status: entry.status ?? (entry.terminal === "pending" ? "readable" : "ignored-extension"),
      terminal_decision: entry.terminal
    }))
  };
}

function ledgerRecord(input: {
  mode: "markdown-only" | "logseq-extensionless-only";
  rootRef: string;
  offset: number;
  refs: string[];
  synced?: boolean;
  crudOk?: boolean;
  totals?: Partial<typeof baseTotals>;
  decisions?: Record<string, number>;
}) {
  const totals = {
    ...baseTotals,
    ...input.totals
  };
  return {
    record_schema: "living-atlas-logseq-semantic-batch:v1",
    recorded_at: "2026-06-23T00:00:00.000Z",
    authority_id: "la_authority_test00000001",
    root_ref: input.rootRef,
    source_kind: "logseq",
    source_mode: input.mode,
    file_offset: input.offset,
    requested_file_count: input.refs.length,
    actual_file_count: input.refs.length,
    ledger_id: `la_semantic_ledger_${input.mode}_${input.offset}`,
    plan_totals: {
      ...totals,
      bytes: input.totals?.bytes ?? baseTotals.bytes * input.refs.length,
      planned_objects: input.totals?.planned_objects ?? baseTotals.planned_objects * input.refs.length
    },
    crud: {
      ok: input.crudOk ?? true,
      local_generation: input.refs.length,
      checked_cases: 4
    },
    sync: input.synced
      ? {
          attempted: true,
          generation: input.offset + 1,
          synced_objects: input.totals?.planned_objects ?? baseTotals.planned_objects * input.refs.length
        }
      : {
          attempted: false
        },
    files: input.refs.map((ref) => ({
      source_path_ref: ref,
      content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      migration_status: "migrated",
      review_status: "not-required",
      parity_status: input.synced ? "synced" : "local-verified",
      source_capsule_object_id: `la_object_${ref.replace(/^la_source_/, "").slice(0, 24)}`,
      planned_objects: baseTotals.planned_objects,
      object_plan_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    })),
    decisions: input.decisions ?? {
      "captured-encrypted": input.refs.length
    },
    plaintext_policy: "hash-counts-refs-only"
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Logseq semantic corpus aggregate report", () => {
  it("proves local completion across separate markdown and extensionless ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      await mkdir(join(root, "markdown"));
      await mkdir(join(root, "extensionless"));
      const markdownManifest = join(root, "markdown", "manifest.json");
      const markdownLedger = join(root, "markdown", "ledger.jsonl");
      const extensionlessManifest = join(root, "extensionless", "manifest.json");
      const extensionlessLedger = join(root, "extensionless", "ledger.jsonl");

      await writeJson(markdownManifest, manifest({
        id: "la_semantic_manifest_markdown000001",
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        refs: [
          { ref: "la_source_markdown000000000001", terminal: "pending" },
          { ref: "la_source_markdown000000000002", terminal: "skipped" },
          { ref: "la_source_markdown000000000003", terminal: "quarantined", status: "oversized" }
        ]
      }));
      await writeFile(markdownLedger, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001"]
      }))}\n`);

      await writeJson(extensionlessManifest, manifest({
        id: "la_semantic_manifest_extension001",
        mode: "logseq-extensionless-only",
        rootRef: "sha256:extensionless",
        refs: [
          { ref: "la_source_extensionless000001", terminal: "pending" }
        ]
      }));
      await writeFile(extensionlessLedger, `${JSON.stringify(ledgerRecord({
        mode: "logseq-extensionless-only",
        rootRef: "sha256:extensionless",
        offset: 0,
        refs: ["la_source_extensionless000001"]
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [
          { manifest_path: markdownManifest, ledger_path: markdownLedger },
          { manifest_path: extensionlessManifest, ledger_path: extensionlessLedger }
        ],
        completionMode: "local"
      });

      expect(report.complete).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.manifests).toMatchObject({
        total_entries: 4,
        pending_entries: 0,
        terminal_skipped_entries: 1,
        terminal_quarantined_entries: 1
      });
      expect(report.ledgers).toMatchObject({
        record_count: 2,
        deduped_batch_count: 2,
        covered_file_count: 2,
        local_only_batch_count: 2,
        synced_batch_count: 0,
        coverage_gap_count: 0
      });
      expect(report.totals.planned_objects).toBe(6);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps local completion false when a pending manifest entry is uncovered", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const ledgerPath = join(root, "ledger.jsonl");
      await writeJson(manifestPath, manifest({
        id: "la_semantic_manifest_markdown000001",
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        refs: [
          { ref: "la_source_markdown000000000001", terminal: "pending" },
          { ref: "la_source_markdown000000000002", terminal: "pending" }
        ]
      }));
      await writeFile(ledgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001"]
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [{ manifest_path: manifestPath, ledger_path: ledgerPath }],
        completionMode: "local"
      });

      expect(report.complete).toBe(false);
      expect(report.failures).toContain("manifest-pending-entries");
      expect(report.manifests.pending_entries).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps local completion false when manifest and ledger roots differ", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const ledgerPath = join(root, "ledger.jsonl");
      await writeJson(manifestPath, manifest({
        id: "la_semantic_manifest_markdown000001",
        mode: "markdown-only",
        rootRef: "sha256:manifest",
        refs: [{ ref: "la_source_markdown000000000001", terminal: "pending" }]
      }));
      await writeFile(ledgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:ledger",
        offset: 0,
        refs: ["la_source_markdown000000000001"]
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [{ manifest_path: manifestPath, ledger_path: ledgerPath }],
        completionMode: "local"
      });

      expect(report.complete).toBe(false);
      expect(report.failures).toContain("manifest-ledger-root-mismatch");
      expect(report.manifests.manifest_ledger_root_mismatches).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects overlapping source refs across selected corpus slices", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      const firstManifest = join(root, "manifest-a.json");
      const firstLedger = join(root, "ledger-a.jsonl");
      const secondManifest = join(root, "manifest-b.json");
      const secondLedger = join(root, "ledger-b.jsonl");
      const duplicateRef = "la_source_duplicate0000000001";
      await writeJson(firstManifest, manifest({
        id: "la_semantic_manifest_a0000000001",
        mode: "markdown-only",
        rootRef: "sha256:root-a",
        refs: [{ ref: duplicateRef, terminal: "pending" }]
      }));
      await writeFile(firstLedger, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:root-a",
        offset: 0,
        refs: [duplicateRef]
      }))}\n`);
      await writeJson(secondManifest, manifest({
        id: "la_semantic_manifest_b0000000001",
        mode: "logseq-extensionless-only",
        rootRef: "sha256:root-b",
        refs: [{ ref: duplicateRef, terminal: "pending" }]
      }));
      await writeFile(secondLedger, `${JSON.stringify(ledgerRecord({
        mode: "logseq-extensionless-only",
        rootRef: "sha256:root-b",
        offset: 0,
        refs: [duplicateRef]
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [
          { manifest_path: firstManifest, ledger_path: firstLedger },
          { manifest_path: secondManifest, ledger_path: secondLedger }
        ],
        completionMode: "local"
      });

      expect(report.complete).toBe(false);
      expect(report.failures).toContain("duplicate-source-refs-across-sources");
      expect(report.manifests.duplicate_source_refs).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports supplemental semantic passes without double-counting corpus coverage", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const ledgerPath = join(root, "ledger.jsonl");
      const supplementalLedgerPath = join(root, "supplemental-ledger.jsonl");
      await writeJson(manifestPath, manifest({
        id: "la_semantic_manifest_markdown000001",
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        refs: [
          { ref: "la_source_markdown000000000001", terminal: "pending" },
          { ref: "la_source_markdown000000000002", terminal: "pending" }
        ]
      }));
      await writeFile(ledgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001", "la_source_markdown000000000002"]
      }))}\n`);
      await writeFile(supplementalLedgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001", "la_source_markdown000000000002"],
        totals: {
          edge_candidates: 4,
          valid_edge_candidates: 3,
          quarantined_edge_candidates: 1,
          edge_objects: 4,
          quarantine_objects: 1,
          planned_objects: 8
        },
        decisions: {
          "property-edge-promoted": 3,
          "direction-review": 1
        }
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [{ manifest_path: manifestPath, ledger_path: ledgerPath }],
        supplementalLedgerPaths: [supplementalLedgerPath],
        completionMode: "local"
      });

      expect(report.complete).toBe(true);
      expect(report.ledgers.covered_file_count).toBe(2);
      expect(report.totals.edge_objects).toBe(0);
      expect(report.supplemental).toMatchObject({
        record_count: 1,
        deduped_batch_count: 1,
        local_only_batch_count: 1,
        crud_failed_batch_count: 0,
        needs_review: 0,
        quarantine_objects: 1
      });
      expect(report.supplemental.totals.edge_objects).toBe(4);
      expect(report.supplemental.decisions).toEqual({
        "direction-review": 1,
        "property-edge-promoted": 3
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails completion when a supplemental semantic pass failed CRUD", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-corpus-report-"));
    try {
      const manifestPath = join(root, "manifest.json");
      const ledgerPath = join(root, "ledger.jsonl");
      const supplementalLedgerPath = join(root, "supplemental-ledger.jsonl");
      await writeJson(manifestPath, manifest({
        id: "la_semantic_manifest_markdown000001",
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        refs: [{ ref: "la_source_markdown000000000001", terminal: "pending" }]
      }));
      await writeFile(ledgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001"]
      }))}\n`);
      await writeFile(supplementalLedgerPath, `${JSON.stringify(ledgerRecord({
        mode: "markdown-only",
        rootRef: "sha256:markdown",
        offset: 0,
        refs: ["la_source_markdown000000000001"],
        crudOk: false
      }))}\n`);

      const report = await buildSemanticCorpusAggregateReport({
        sources: [{ manifest_path: manifestPath, ledger_path: ledgerPath }],
        supplementalLedgerPaths: [supplementalLedgerPath],
        completionMode: "local"
      });

      expect(report.complete).toBe(false);
      expect(report.failures).toContain("supplemental-crud-failed-batches");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
