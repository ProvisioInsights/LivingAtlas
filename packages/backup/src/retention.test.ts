import { describe, expect, it } from "vitest";
import { selectForDeletion, type RetentionRule, type BackupRef } from "./retention";

// Rules: keep 15-min diffs 24h; daily fulls 90d. Times are epoch ms.
const rules: RetentionRule[] = [
  { kind: "differential", keepForMs: 24 * 60 * 60 * 1000 },
  { kind: "full", keepForMs: 90 * 24 * 60 * 60 * 1000 },
];

function ref(id: string, kind: BackupRef["kind"], ageMs: number, nowMs: number): BackupRef {
  return { backup_id: id, kind, created_at_ms: nowMs - ageMs, locked_until_ms: 0 };
}

describe("selectForDeletion", () => {
  const now = 1_000_000_000_000;
  it("deletes a differential older than its retention window", () => {
    const old = ref("d1", "differential", 25 * 3600_000, now);
    expect(selectForDeletion([old], rules, now)).toEqual(["d1"]);
  });

  it("keeps a differential within its window", () => {
    const fresh = ref("d2", "differential", 1 * 3600_000, now);
    expect(selectForDeletion([fresh], rules, now)).toEqual([]);
  });

  it("never deletes an object still under Object-Lock (locked_until in the future)", () => {
    const locked = { ...ref("d3", "differential", 999 * 3600_000, now), locked_until_ms: now + 3600_000 };
    expect(selectForDeletion([locked], rules, now)).toEqual([]);
  });

  it("keeps a full within 90d, deletes beyond", () => {
    const keep = ref("f1", "full", 10 * 24 * 3600_000, now);
    const drop = ref("f2", "full", 100 * 24 * 3600_000, now);
    expect(selectForDeletion([keep, drop], rules, now)).toEqual(["f2"]);
  });
});
