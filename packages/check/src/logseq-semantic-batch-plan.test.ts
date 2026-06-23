import { describe, expect, it } from "vitest";
import { recommendNextSemanticBatch, type PlanEntry } from "./logseq-semantic-batch-plan";

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
});
