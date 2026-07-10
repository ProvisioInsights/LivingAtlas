import { describe, expect, it } from "vitest";
import { createCanonicalSyntheticMvpFixture } from "./canonical-local-mvp-proof";

describe("canonical local MVP proof", () => {
  it("creates an encrypted canonical-only fixture without legacy payload types", async () => {
    const fixture = await createCanonicalSyntheticMvpFixture();
    try {
      const objects = fixture.store.listObjects({ include_tombstones: true });
      expect(objects.map((object) => object.object_type)).not.toContain("page");
      expect(objects.map((object) => object.object_type)).not.toContain("block");
      expect(objects.every((object) => object.access_class === "local-private" && object.payload.kind === "ciphertext-inline")).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
