import { describe, expect, it } from "vitest";
import { computeDifferential, type JournalEntry } from "./differential";

const journal: JournalEntry[] = [
  { generation: 1, object_id: "o1", sealed_b64: "AA" },
  { generation: 2, object_id: "o2", sealed_b64: "BB" },
  { generation: 3, object_id: "o1", sealed_b64: "CC" },
];

describe("computeDifferential", () => {
  it("includes only entries after the base generation", () => {
    const diff = computeDifferential(journal, 1);
    expect(diff.entries.map((e) => e.generation)).toEqual([2, 3]);
    expect(diff.base_generation).toBe(1);
    expect(diff.target_generation).toBe(3);
  });

  it("returns an empty diff when nothing is newer", () => {
    expect(computeDifferential(journal, 3).entries).toEqual([]);
  });
});
