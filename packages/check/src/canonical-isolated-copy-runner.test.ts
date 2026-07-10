import { describe, expect, it } from "vitest";
import { validateCanonicalIsolatedCopyRun } from "./canonical-isolated-copy-runner";

describe("canonical isolated-copy runner guard", () => {
  it("rejects missing acknowledgement, non-copy marker, and live source paths", () => {
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "", live_paths: [] })).toThrow("acknowledgement");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy", source_dir: "/tmp/source", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("copy marker");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/live/profile", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toThrow("live path");
    expect(() => validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/archive-copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: [] })).toThrow("must not overlap");
    expect(validateCanonicalIsolatedCopyRun({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy", acknowledgement: "run-canonical-isolated-copy", live_paths: ["/live/profile"] })).toEqual({ copy_dir: "/tmp/copy/.atlas-isolated-copy", source_dir: "/tmp/archive-copy" });
  });
});
