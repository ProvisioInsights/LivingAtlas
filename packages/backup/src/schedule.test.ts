import { describe, expect, it } from "vitest";
import { dueLevels, type CadenceConfig, type LastRun } from "./schedule";

const cadence: CadenceConfig = {
  differentialEveryMs: 15 * 60_000,
  fullEveryMs: 24 * 60 * 60_000,
};

describe("dueLevels", () => {
  const now = 100 * 60 * 60_000; // 100h
  it("schedules a differential when overdue", () => {
    const last: LastRun = { lastDifferentialMs: now - 20 * 60_000, lastFullMs: now - 1 * 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual(["differential"]);
  });

  it("schedules a full (and implicitly resets diff) when the full is overdue", () => {
    const last: LastRun = { lastDifferentialMs: now - 1 * 60_000, lastFullMs: now - 25 * 60 * 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual(["full"]);
  });

  it("schedules nothing when both are fresh", () => {
    const last: LastRun = { lastDifferentialMs: now - 60_000, lastFullMs: now - 60_000 };
    expect(dueLevels(cadence, last, now)).toEqual([]);
  });
});
