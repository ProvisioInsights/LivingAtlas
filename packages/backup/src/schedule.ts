export type CadenceConfig = { differentialEveryMs: number; fullEveryMs: number };
export type LastRun = { lastDifferentialMs: number; lastFullMs: number };
export type Level = "full" | "differential";

/** A due full supersedes a due differential for the same tick (the full
 *  captures everything, resetting the differential base). */
export function dueLevels(cadence: CadenceConfig, last: LastRun, nowMs: number): Level[] {
  if (nowMs - last.lastFullMs >= cadence.fullEveryMs) return ["full"];
  if (nowMs - last.lastDifferentialMs >= cadence.differentialEveryMs) return ["differential"];
  return [];
}
