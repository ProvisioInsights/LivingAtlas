import { describe, expect, it } from "vitest";
import { readCanonicalSourceReconciliationConfig } from "./canonical-source-reconciliation-cli";

describe("canonical source reconciliation CLI", () => {
  it("requires both explicit source directories", () => {
    expect(() => readCanonicalSourceReconciliationConfig({})).toThrow("missing LIVING_ATLAS_LIVE_SOURCE_DIR");
    expect(readCanonicalSourceReconciliationConfig({
      LIVING_ATLAS_LIVE_SOURCE_DIR: " /private/live ",
      LIVING_ATLAS_PRIOR_WORKING_DIR: " /private/prior "
    })).toEqual({ live_source_dir: "/private/live", prior_working_dir: "/private/prior" });
  });
});
