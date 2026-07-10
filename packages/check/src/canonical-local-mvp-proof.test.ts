import { describe, expect, it } from "vitest";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalCanonicalAtlasClient } from "@living-atlas/atlas-client";
import { createCanonicalMarkdownMigration, createCanonicalMarkdownMigrationExport } from "@living-atlas/importer";
import { loadCanonicalParityInputsFromObjects, projectCanonicalParity } from "@living-atlas/graph-service";
import { createDefaultLocalKeyring, decryptGraphObjectPayload } from "@living-atlas/local-keyring";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import { randomBytes } from "node:crypto";
import { LocalWormStore, wrapKeyringForEscrow, writeBackup } from "@living-atlas/backup";
import { restoreRunner } from "./backup-restore";
import { FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { createCanonicalSyntheticMvpFixture } from "./canonical-local-mvp-proof";

describe("canonical local MVP proof", () => {
  it("creates an encrypted canonical-only fixture without legacy payload types", async () => {
    const fixture = await createCanonicalSyntheticMvpFixture();
    try {
      const objects = fixture.store.listObjects({ include_tombstones: true });
      expect(objects.map((object) => object.object_type)).not.toContain("page");
      expect(objects.map((object) => object.object_type)).not.toContain("block");
      expect(objects.every((object) => object.access_class === "local-private" && object.payload.kind === "ciphertext-inline")).toBe(true);
      await expect(readFile(fixture.keyringPath, "utf8")).resolves.not.toContain(fixture.keyringPassphrase);
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

  it("imports a canonical-only source conversion into an encrypted store without legacy writes", async () => {
    const targetDir = await mkdtemp(join(tmpdir(), "living-atlas-canonical-source-target-"));
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: "2026-07-10T12:00:00.000Z" });
    try {
      const migration = createCanonicalMarkdownMigration([{
        source_path: "/synthetic/private-vault/pages/Private Contact.md",
        markdown: "Reach an example contact at person@example.test.\n\nDo not infer a relationship from this source.",
        source_kind: "logseq"
      }], {
        authority_id: fixtureAuthorityId,
        created_at: "2026-07-10T12:00:00.000Z",
        path_redaction_secret: "synthetic-canonical-source-secret"
      });
      const exported = createCanonicalMarkdownMigrationExport(migration);
      const target = await FileLocalGraphStore.open({ directory: targetDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring });
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, keyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const client = createLocalCanonicalAtlasClient({ graphStore: target, decryptPayload: decrypt, now: "2026-07-10T12:00:00.000Z" });
      await expect(client.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_canonicalsource0001", idempotency_key: "la_idem_canonicalsource0001" })).resolves.toMatchObject({ ok: true });
      await expect(client.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_canonicalsource0001", idempotency_key: "la_idem_canonicalsource0001" })).resolves.toMatchObject({ ok: true, idempotent: true, generation: 1 });
      expect(target.listObjects().every((object) => object.access_class === "local-private" && object.payload.kind === "ciphertext-inline")).toBe(true);
      expect(target.listObjects().map((object) => object.object_type)).not.toEqual(expect.arrayContaining(["page", "block", "attachment", "index"]));
      await expect(client.exportCanonical()).resolves.toEqual(exported);
      const parity = projectCanonicalParity({
        ...await loadCanonicalParityInputsFromObjects(target.listObjects(), decrypt),
        operational_gates: {
          resolution_transactions_verified: true,
          canonical_integrity_verified: true,
          no_legacy_dependencies_verified: true,
          idempotency_verified: true,
          restart_verified: true,
          backup_restore_verified: true,
          manifest_comparison_verified: true,
          owner_accepted: false
        }
      });
      expect(parity).toMatchObject({ semantic_parity_ready: true, cutover_ready: false, blockers: [], cutover_blockers: ["owner-acceptance-required"] });
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("preserves canonical export through a local immutable backup and isolated restore", async () => {
    const fixture = await createCanonicalSyntheticMvpFixture();
    const staging = await mkdtemp(join(tmpdir(), "living-atlas-canonical-mvp-backup-"));
    const restoredDir = join(staging, "restored");
    const recoveryMaster = randomBytes(32);
    try {
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, fixture.keyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const sourceExport = await createLocalCanonicalAtlasClient({ graphStore: fixture.store, decryptPayload: decrypt, now: "2026-07-10T12:00:00.000Z" }).exportCanonical();
      await writeBackup([new LocalWormStore(staging)], { authority_id: fixtureAuthorityId, kind: "full", base_generation: 0, target_generation: fixture.store.status().generation, artifactBytes: await readFile(join(fixture.directory, "snapshot.json")), escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow(await readFile(fixture.keyringPath, "utf8"), recoveryMaster)), createdAtIso: "2026-07-10T12:00:00.000Z", backupId: "la_backup_canonicalmvp0001", retainUntilMs: 0 });
      await restoreRunner({ backupId: "la_backup_canonicalmvp0001", storeDir: staging, outDir: restoredDir }, recoveryMaster);
      const restoredKeyring = await new FileLocalKeyringStore(join(restoredDir, "keyring.json")).read(fixture.keyringPassphrase);
      const restored = await FileLocalGraphStore.open({ directory: join(restoredDir, "graph"), authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: restoredKeyring });
      const restoredDecrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, restoredKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      await expect(createLocalCanonicalAtlasClient({ graphStore: restored, decryptPayload: restoredDecrypt, now: "2026-07-10T12:00:00.000Z" }).exportCanonical()).resolves.toEqual(sourceExport);
    } finally {
      await fixture.dispose();
      await rm(staging, { recursive: true, force: true });
    }
  });
});
