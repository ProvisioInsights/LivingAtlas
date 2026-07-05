import { describe, expect, it } from "vitest";
import { currentKeyVersion, selectStaleForRotation } from "./rotation";

describe("key rotation", () => {
  it("reports the active version tag for a tier", () => {
    expect(currentKeyVersion({ T1_KEY_VERSION: "v3", T2_KEY_VERSION: "v2" }, "T1")).toBe("v3");
    expect(currentKeyVersion({ T1_KEY_VERSION: "v3", T2_KEY_VERSION: "v2" }, "T2")).toBe("v2");
  });

  it("selects only objects whose key_version lags the active version, bounded by sweep size", () => {
    const objects = [
      { object_id: "o1", key_version: "v3" },
      { object_id: "o2", key_version: "v2" },
      { object_id: "o3", key_version: "v1" }
    ];
    expect(selectStaleForRotation(objects, "v3", 10).map((o) => o.object_id)).toEqual(["o2", "o3"]);
    expect(selectStaleForRotation(objects, "v3", 1).map((o) => o.object_id)).toEqual(["o2"]);
  });
});
