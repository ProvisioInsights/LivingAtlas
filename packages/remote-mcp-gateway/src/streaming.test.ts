import { describe, expect, it } from "vitest";
import { runStreamingTool } from "./streaming";

describe("runStreamingTool", () => {
  it("emits progress updates before the final result for a long call", async () => {
    const progress: number[] = [];
    const result = await runStreamingTool({
      totalSteps: 3,
      onProgress: async (p) => {
        progress.push(p.progress);
      },
      work: async (step) => ({ step })
    });
    expect(progress).toEqual([1, 2, 3]);
    expect(result).toEqual({ ok: true, steps: [{ step: 0 }, { step: 1 }, { step: 2 }] });
  });

  it("reports the total alongside each progress tick", async () => {
    const totals: number[] = [];
    await runStreamingTool({
      totalSteps: 2,
      onProgress: async (p) => {
        totals.push(p.total);
      },
      work: async () => ({})
    });
    expect(totals).toEqual([2, 2]);
  });

  it("does no work and emits no progress for a zero-step call", async () => {
    let progressCalls = 0;
    const result = await runStreamingTool({
      totalSteps: 0,
      onProgress: async () => {
        progressCalls += 1;
      },
      work: async () => ({})
    });
    expect(progressCalls).toBe(0);
    expect(result).toEqual({ ok: true, steps: [] });
  });
});
