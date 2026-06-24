import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextOffsetFromLedger, recommendNextSemanticBatch, type PlanEntry } from "./logseq-semantic-batch-plan";

function entry(plannedObjects: number): PlanEntry {
  return {
    offset: 0,
    planned_objects: plannedObjects,
    bytes: plannedObjects,
    pages: 1,
    blocks: Math.max(0, plannedObjects - 2),
    reference_index_objects: 1,
    edge_objects: 0,
    quarantine_objects: 0,
    oversized: plannedObjects > 240
  };
}

describe("Logseq semantic batch planner", () => {
  it("caps recommended batches to the parity command file-count limit", () => {
    const entries = Array.from({ length: 14 }, () => entry(10));

    expect(recommendNextSemanticBatch(entries, 240, 10)).toEqual({
      file_count: 10,
      planned_objects: 100
    });
  });

  it("allows an oversized first file so the chunked sync path can handle it", () => {
    expect(recommendNextSemanticBatch([entry(257), entry(10)], 240, 10)).toEqual({
      file_count: 1,
      planned_objects: 257
    });
  });

  it("continues legacy markdown-only ledgers only when the requested source mode matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-plan-"));
    const ledgerPath = join(root, "semantic-ledger.jsonl");
    try {
      await writeFile(ledgerPath, `${JSON.stringify({
        file_offset: 0,
        actual_file_count: 3
      })}\n`);

      await expect(nextOffsetFromLedger(ledgerPath, {
        sourceKind: "logseq",
        sourceMode: "markdown-only"
      })).resolves.toBe(3);
      await expect(nextOffsetFromLedger(ledgerPath, {
        sourceKind: "logseq",
        sourceMode: "logseq-extensionless-only"
      })).rejects.toThrow("semantic ledger source mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues explicit extensionless ledgers only for extensionless runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-semantic-plan-"));
    const ledgerPath = join(root, "semantic-ledger.jsonl");
    try {
      await writeFile(ledgerPath, `${JSON.stringify({
        file_offset: 10,
        actual_file_count: 2,
        source_kind: "logseq",
        source_mode: "logseq-extensionless-only"
      })}\n`);

      await expect(nextOffsetFromLedger(ledgerPath, {
        sourceKind: "logseq",
        sourceMode: "logseq-extensionless-only"
      })).resolves.toBe(12);
      await expect(nextOffsetFromLedger(ledgerPath, {
        sourceKind: "logseq",
        sourceMode: "markdown-only"
      })).rejects.toThrow("semantic ledger source mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
