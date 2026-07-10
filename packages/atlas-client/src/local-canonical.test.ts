import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring, decryptGraphObjectPayload } from "@living-atlas/local-keyring";
import { createLocalCanonicalAtlasClient } from "./local-canonical";

const now = "2026-07-10T12:00:00.000Z";
const entityId = "la_object_localcliententity0001";

function entityDraft() {
  return {
    schema_version: 1 as const, authority_id: fixtureAuthorityId, object_id: entityId,
    object_type: "entity", version: 1, access_class: "local-private" as const,
    encryption_class: "plaintext" as const, created_at: now, updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json" as const, data: {
      schema: "atlas.entity:v1", entity_id: entityId, type: "organization", subtype: "company",
      name: "Synthetic local canonical export", aliases: [], created_at: now, updated_at: now
    } }
  };
}

describe("local canonical Atlas client", () => {
  it("round-trips canonical records atomically between encrypted local stores", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "living-atlas-local-export-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "living-atlas-local-export-target-"));
    try {
      const sourceKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const source = await FileLocalGraphStore.open({ directory: sourceDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: sourceKeyring });
      await source.createObject({ object: entityDraft(), expected_generation: 0, actor_id: fixtureLocalClientId, recorded_at: now });
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, sourceKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const exported = await createLocalCanonicalAtlasClient({ graphStore: source, decryptPayload: decrypt, now }).exportCanonical();

      const targetKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const target = await FileLocalGraphStore.open({ directory: targetDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: targetKeyring });
      const targetDecrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, targetKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const targetClient = createLocalCanonicalAtlasClient({ graphStore: target, decryptPayload: targetDecrypt, now });
      await expect(targetClient.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_localimport0001", idempotency_key: "la_idem_localimport0001" })).resolves.toMatchObject({ ok: true, generation: 1 });
      await expect(targetClient.exportCanonical()).resolves.toEqual(exported);
    } finally {
      await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]);
    }
  });
});
