import { describe, expect, it } from "vitest";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
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

  it("preserves the canonical-only fixture through compaction and encrypted reopen", async () => {
    const fixture = await createCanonicalSyntheticMvpFixture();
    try {
      await fixture.store.compact();
      const reopened = await FileLocalGraphStore.open({ directory: fixture.directory, authorityId: fixture.store.status().authority_id, plaintextPersistence: "encrypt", keyring: fixture.keyring });
      expect(reopened.status()).toMatchObject({ generation: 1, object_count: 5, plaintext_persistence: "encrypted" });
      expect(reopened.listObjects().every((object) => ["entity", "evidence", "assertion", "review", "manifest"].includes(object.object_type))).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
});
