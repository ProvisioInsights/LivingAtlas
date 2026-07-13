import { describe, expect, it } from "vitest";
import { readCanonicalCutoverReportConfig } from "./canonical-cutover-report-cli";

describe("canonical cutover report CLI", () => {
  it("requires an explicit private candidate directory", () => {
    expect(() => readCanonicalCutoverReportConfig({})).toThrow("missing LIVING_ATLAS_CANONICAL_CANDIDATE_DIR");
    expect(readCanonicalCutoverReportConfig({ LIVING_ATLAS_CANONICAL_CANDIDATE_DIR: " /private/candidate/.atlas-isolated-copy " }))
      .toEqual({ candidate_dir: "/private/candidate/.atlas-isolated-copy" });
  });
});
