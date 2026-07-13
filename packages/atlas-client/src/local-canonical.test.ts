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
    object_type: "entity" as const, version: 1, access_class: "local-private" as const,
    encryption_class: "plaintext" as const, created_at: now, updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json" as const, data: {
      schema: "atlas.entity:v1", entity_id: entityId, type: "organization", subtype: "company",
      name: "Synthetic local canonical export", aliases: [], created_at: now, updated_at: now
    } }
  };
}

function observationDraft(input: { objectId: string; statement: string; supersedes?: string[] }) {
  return {
    schema_version: 1 as const, authority_id: fixtureAuthorityId, object_id: input.objectId,
    object_type: "assertion" as const, version: 1, access_class: "local-private" as const,
    encryption_class: "plaintext" as const, created_at: now, updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json" as const, data: {
      schema: "atlas.observation:v1", assertion_id: input.objectId, statement: input.statement,
      candidate_entity_ids: [entityId], resolution_state: "owner-review", recorded_at: now,
      evidence_refs: ["la_object_localclientevidence0001"],
      ...(input.supersedes ? { supersedes: input.supersedes } : {})
    } }
  };
}

function factDraft() {
  return {
    schema_version: 1 as const, authority_id: fixtureAuthorityId, object_id: "la_object_localclientfact0001",
    object_type: "assertion" as const, version: 1, access_class: "local-private" as const,
    encryption_class: "plaintext" as const, created_at: now, updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json" as const, data: {
      schema: "atlas.fact:v1", assertion_id: "la_object_localclientfact0001", subject_entity_id: entityId,
      predicate: "status", value: { kind: "text", value: "Synthetic active status" }, recorded_at: now,
      lineage_action: "assert", supersedes: [], evidence_links: [{ evidence_id: "la_object_localclientevidence0001", stance: "supports" }],
      confidence: { band: "high", assessment_kind: "assertion", method: "synthetic", assessed_at: now, evidence_refs: ["la_object_localclientevidence0001"] }
    } }
  };
}

function relationshipDraft() {
  return {
    schema_version: 1 as const, authority_id: fixtureAuthorityId, object_id: "la_object_localclientrelationship0001",
    object_type: "edge" as const, version: 1, access_class: "local-private" as const,
    encryption_class: "plaintext" as const, created_at: now, updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json" as const, data: {
      schema: "atlas.relationship:v2", assertion_id: "la_object_localclientrelationship0001",
      edge_id: "la_edge_localclientrelationship0001", source_entity_id: "la_object_localclientperson0001",
      source_type: "person", target_entity_id: entityId, target_type: "organization", predicate: "advises",
      valid_from: "2026", status: "active", attrs: { role: "Synthetic advisor" }, recorded_at: now,
      lineage_action: "assert", supersedes: [], evidence_links: [{ evidence_id: "la_object_localclientevidence0001", stance: "supports" }],
      confidence: { band: "high", assessment_kind: "assertion", method: "synthetic", assessed_at: now, evidence_refs: ["la_object_localclientevidence0001"] }
    } }
  };
}

describe("local canonical Atlas client", () => {
  it("reads a decrypted canonical entity by its stable ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-local-entity-read-"));
    try {
      const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const store = await FileLocalGraphStore.open({ directory, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring });
      await store.initializeFromObjects([entityDraft(), factDraft(), relationshipDraft(), observationDraft({ objectId: "la_object_localclientobservation0001", statement: "Synthetic unresolved observation." })]);
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, keyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const client = createLocalCanonicalAtlasClient({ graphStore: store, decryptPayload: decrypt, now }) as unknown as {
        entityGet(entityId: string): Promise<unknown>;
      };

      await expect(client.entityGet(entityId)).resolves.toMatchObject({
        schema: "atlas.entity:v1",
        entity_id: entityId,
        name: "Synthetic local canonical export"
      });
      await expect((client as unknown as { resolveEntityId(id: string): Promise<unknown> }).resolveEntityId(entityId))
        .resolves.toEqual({ entity_id: entityId, canonical_entity_id: entityId, redirect_path: [entityId] });
      await expect((client as unknown as { assertionsForEntity(id: string): Promise<unknown[]> }).assertionsForEntity(entityId))
        .resolves.toEqual([expect.objectContaining({ schema: "atlas.fact:v1", subject_entity_id: entityId })]);
      await expect((client as unknown as { observationsForEntity(id: string): Promise<unknown[]> }).observationsForEntity(entityId))
        .resolves.toEqual([expect.objectContaining({ schema: "atlas.observation:v1", candidate_entity_ids: [entityId] })]);
      await expect((client as unknown as { relationshipsForEntity(id: string): Promise<unknown[]> }).relationshipsForEntity(entityId))
        .resolves.toEqual([expect.objectContaining({ schema: "atlas.relationship:v2", target_entity_id: entityId })]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a canonical import whose declared content hash does not match its payload", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "living-atlas-local-forged-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "living-atlas-local-forged-target-"));
    try {
      const sourceKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const source = await FileLocalGraphStore.open({ directory: sourceDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: sourceKeyring });
      await source.createObject({ object: entityDraft(), expected_generation: 0, actor_id: fixtureLocalClientId, recorded_at: now });
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, sourceKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const exported = await createLocalCanonicalAtlasClient({ graphStore: source, decryptPayload: decrypt, now }).exportCanonical();
      const forgedHashExport = {
        ...exported,
        records: exported.records.map((record) => ({
          ...record,
          content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const
        }))
      };

      const targetKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const target = await FileLocalGraphStore.open({ directory: targetDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: targetKeyring });
      const client = createLocalCanonicalAtlasClient({ graphStore: target, decryptPayload: async () => undefined, now });
      const request = {
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        operation_id: "la_operation_localforged0001",
        idempotency_key: "la_idem_localforged0001"
      };

      await expect(client.importCanonical({ ...request, exported: forgedHashExport }))
        .rejects.toThrow("canonical-import-content-hash-mismatch");
    } finally {
      await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]);
    }
  });

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
      await expect(targetClient.importCanonical({ exported, expected_generation: 1, actor_id: fixtureLocalClientId, operation_id: "la_operation_localimport0002", idempotency_key: "la_idem_localimport0002" })).resolves.toMatchObject({ ok: false, reason: "object-already-exists", current_generation: 1 });
      expect(target.status()).toMatchObject({ generation: 1, object_count: 1 });
    } finally {
      await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]);
    }
  });

  it("preserves inspectable observation correction lineage through export and import", async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "living-atlas-local-lineage-source-"));
    const targetDir = await mkdtemp(join(tmpdir(), "living-atlas-local-lineage-target-"));
    try {
      const originalId = "la_object_localobservation0001";
      const successorId = "la_object_localobservation0002";
      const sourceKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const source = await FileLocalGraphStore.open({ directory: sourceDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: sourceKeyring });
      await source.initializeFromObjects([
        observationDraft({ objectId: originalId, statement: "Synthetic original observation." }),
        observationDraft({ objectId: successorId, statement: "Synthetic corrected observation.", supersedes: [originalId] })
      ]);
      const decrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, sourceKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const exported = await createLocalCanonicalAtlasClient({ graphStore: source, decryptPayload: decrypt, now }).exportCanonical();
      const successor = exported.records.find((record) => record.object_id === successorId);

      expect(successor?.payload).toMatchObject({
        schema: "atlas.observation:v1",
        assertion_id: successorId,
        supersedes: [originalId]
      });

      const targetKeyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const target = await FileLocalGraphStore.open({ directory: targetDir, authorityId: fixtureAuthorityId, plaintextPersistence: "encrypt", keyring: targetKeyring });
      const targetDecrypt = async (object: Parameters<typeof decryptGraphObjectPayload>[0]) => {
        const payload = await decryptGraphObjectPayload(object, targetKeyring);
        return payload?.kind === "plaintext-json" ? payload.data : undefined;
      };
      const targetClient = createLocalCanonicalAtlasClient({ graphStore: target, decryptPayload: targetDecrypt, now });
      await expect(targetClient.importCanonical({
        exported,
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        operation_id: "la_operation_locallineage0001",
        idempotency_key: "la_idem_locallineage0001"
      })).resolves.toMatchObject({ ok: true, generation: 1 });
      await expect(targetClient.exportCanonical()).resolves.toEqual(exported);
    } finally {
      await Promise.all([rm(sourceDir, { recursive: true, force: true }), rm(targetDir, { recursive: true, force: true })]);
    }
  });
});
