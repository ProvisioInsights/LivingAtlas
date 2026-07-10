import { describe, expect, it } from "vitest";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalCanonicalAtlasClient } from "@living-atlas/atlas-client";
import { createDefaultLocalKeyring, decryptGraphObjectPayload } from "@living-atlas/local-keyring";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
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

  it("preserves canonical export exactly through a fresh encrypted import", async () => {
    const fixture = await createCanonicalSyntheticMvpFixture();
    const targetDir = await mkdtemp(join(tmpdir(), "living-atlas-canonical-mvp-target-"));
    try {
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, fixture.keyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const exported = await createLocalCanonicalAtlasClient({ graphStore: fixture.store, decryptPayload: decrypt, now: "2026-07-10T12:00:00.000Z" }).exportCanonical();
      const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: "2026-07-10T12:00:00.000Z" });
      const target = await FileLocalGraphStore.open({ directory: targetDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring });
      const targetDecrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, keyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const client = createLocalCanonicalAtlasClient({ graphStore: target, decryptPayload: targetDecrypt, now: "2026-07-10T12:00:00.000Z" });
      await expect(client.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_canonicalmvpimport0001", idempotency_key: "la_idem_canonicalmvpimport0001" })).resolves.toMatchObject({ ok: true });
      await expect(client.exportCanonical()).resolves.toEqual(exported);
    } finally {
      await fixture.dispose();
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
