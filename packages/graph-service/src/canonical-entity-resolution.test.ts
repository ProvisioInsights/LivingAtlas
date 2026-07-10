import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CanonicalEntityResolutionPayload, GraphObjectEnvelope } from "@living-atlas/contracts";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring, decryptGraphObjectPayload, type PlaintextGraphObjectDraft } from "@living-atlas/local-keyring";
import {
  loadCanonicalEntityResolutionsFromObjects,
  projectCanonicalEntityResolutions,
  resolveCanonicalEntityId
} from "./canonical-entity-resolution";

const now = "2026-07-10T12:00:00.000Z";
const evidenceId = "la_object_resolutionevidence0001";
const entityA = "la_object_resolutionentitya0001";
const entityB = "la_object_resolutionentityb0001";
const entityC = "la_object_resolutionentityc0001";

function resolution(input: Pick<CanonicalEntityResolutionPayload, "resolution_id" | "decision"> & Partial<CanonicalEntityResolutionPayload>): CanonicalEntityResolutionPayload {
  const { resolution_id, decision, ...overrides } = input;
  return {
    schema: "atlas.entity-resolution:v1",
    resolution_id,
    observed_identifiers: ["synthetic-identity"],
    candidate_entity_ids: [entityA, entityB],
    decision,
    canonical_entity_id: decision === "merge" || decision === "link" ? entityA : undefined,
    evidence_refs: [evidenceId],
    confidence: {
      band: "high",
      assessment_kind: "identity",
      method: "synthetic-resolution-test",
      assessed_at: now,
      evidence_refs: [evidenceId]
    },
    recorded_at: now,
    supersedes: [],
    ...overrides
  };
}

function encryptedEnvelope(objectId: string, objectType: GraphObjectEnvelope["object_type"]): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: "la_authority_resolution0001",
    object_id: objectId,
    object_type: objectType,
    version: 1,
    access_class: "local-private",
    encryption_class: "client-encrypted",
    created_at: now,
    updated_at: now,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    key_ref: "la_key_resolution0001",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "ciphertext-inline", ciphertext: "synthetic-ciphertext", nonce: "synthetic-nonce", algorithm: "xchacha20-poly1305" }
  };
}

function resolutionDraft(payload: CanonicalEntityResolutionPayload): PlaintextGraphObjectDraft {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: payload.resolution_id,
    object_type: "review",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: payload.recorded_at,
    updated_at: payload.recorded_at,
    content_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    visible_metadata: { tombstone: false, remote_indexable: false },
    payload: { kind: "plaintext-json", data: payload }
  };
}

function decryptCanonicalPayload(keyring: ReturnType<typeof createDefaultLocalKeyring>) {
  return async (object: GraphObjectEnvelope): Promise<Record<string, unknown> | undefined> => {
    const payload = await decryptGraphObjectPayload(object, keyring);
    return payload?.kind === "plaintext-json" ? payload.data : undefined;
  };
}

describe("canonical entity-resolution projection", () => {
  it("derives redirects without rewriting identities and reverses only a superseded merge", () => {
    const mergeBIntoA = resolution({ resolution_id: "la_object_resolutionmerge0001", decision: "merge" });
    const mergeCIntoB = resolution({
      resolution_id: "la_object_resolutionmerge0002",
      decision: "merge",
      candidate_entity_ids: [entityB, entityC],
      canonical_entity_id: entityB,
      recorded_at: "2026-07-10T12:01:00.000Z"
    });
    const splitBFromA = resolution({
      resolution_id: "la_object_resolutionsplit0001",
      decision: "split",
      candidate_entity_ids: [entityA, entityB],
      canonical_entity_id: undefined,
      supersedes: [mergeBIntoA.resolution_id],
      recorded_at: "2026-07-10T12:02:00.000Z"
    });

    expect(resolveCanonicalEntityId(entityC, projectCanonicalEntityResolutions([mergeBIntoA, mergeCIntoB]))).toEqual({
      entity_id: entityC,
      canonical_entity_id: entityA,
      redirect_path: [entityC, entityB, entityA]
    });
    expect(resolveCanonicalEntityId(entityB, projectCanonicalEntityResolutions([mergeBIntoA, mergeCIntoB, splitBFromA]))).toEqual({
      entity_id: entityB,
      canonical_entity_id: entityB,
      redirect_path: [entityB]
    });
    expect(resolveCanonicalEntityId(entityC, projectCanonicalEntityResolutions([mergeBIntoA, mergeCIntoB, splitBFromA]))).toMatchObject({
      canonical_entity_id: entityB,
      redirect_path: [entityC, entityB]
    });
  });

  it("rejects cycle-forming redirects and respects knowledge time", () => {
    const first = resolution({ resolution_id: "la_object_resolutioncycle0001", decision: "merge" });
    const cycle = resolution({
      resolution_id: "la_object_resolutioncycle0002",
      decision: "merge",
      canonical_entity_id: entityB,
      recorded_at: "2026-07-10T12:01:00.000Z"
    });
    const projection = projectCanonicalEntityResolutions([first, cycle]);

    expect(projection.invalid_resolution_ids).toEqual([cycle.resolution_id]);
    expect(resolveCanonicalEntityId(entityB, projection).canonical_entity_id).toBe(entityA);
    expect(projectCanonicalEntityResolutions([first, cycle], { known_at: now }).invalid_resolution_ids).toEqual([]);
  });

  it("loads only decrypted canonical resolution records from review envelopes", async () => {
    const decision = resolution({ resolution_id: "la_object_resolutionloader0001", decision: "merge" });
    const legacy = encryptedEnvelope("la_object_legacypage0001", "page");
    const envelope = encryptedEnvelope(decision.resolution_id, "review");

    await expect(loadCanonicalEntityResolutionsFromObjects([legacy, envelope], async (object) => {
      if (object.object_type === "page") throw new Error("legacy objects must not be decrypted");
      return decision;
    })).resolves.toEqual([decision]);
  });

  it("preserves local-private redirects through encrypted reopen and compaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "living-atlas-entity-resolution-"));
    try {
      const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
      const merge = resolution({ resolution_id: "la_object_resolutiondurable0001", decision: "merge" });
      const split = resolution({
        resolution_id: "la_object_resolutiondurable0002",
        decision: "split",
        canonical_entity_id: undefined,
        supersedes: [merge.resolution_id],
        recorded_at: "2026-07-10T12:01:00.000Z"
      });
      const store = await FileLocalGraphStore.open({
        directory,
        authorityId: fixtureAuthorityId,
        plaintextPersistence: "encrypt",
        keyring
      });
      await expect(store.createObject({
        object: resolutionDraft(merge),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: merge.recorded_at
      })).resolves.toMatchObject({ ok: true });
      await expect(store.createObject({
        object: resolutionDraft(split),
        expected_generation: 1,
        actor_id: fixtureLocalClientId,
        recorded_at: split.recorded_at
      })).resolves.toMatchObject({ ok: true });

      const before = projectCanonicalEntityResolutions(await loadCanonicalEntityResolutionsFromObjects(
        store.listObjects(), decryptCanonicalPayload(keyring)
      ));
      await store.compact();
      const reopened = await FileLocalGraphStore.open({
        directory,
        authorityId: fixtureAuthorityId,
        plaintextPersistence: "encrypt",
        keyring
      });
      const after = projectCanonicalEntityResolutions(await loadCanonicalEntityResolutionsFromObjects(
        reopened.listObjects(), decryptCanonicalPayload(keyring)
      ));

      expect(after).toEqual(before);
      const persisted = [
        await readFile(join(directory, "snapshot.json"), "utf8"),
        await readFile(join(directory, "journal.jsonl"), "utf8")
      ].join("\n");
      expect(persisted).toContain("AES-GCM-256+local-keyring-v1");
      expect(persisted).not.toContain("synthetic-identity");
      expect(persisted).not.toContain("synthetic-resolution-test");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
