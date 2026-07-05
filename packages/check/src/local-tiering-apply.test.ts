import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload,
  encryptPlaintextGraphObjectDraft,
  addTieringKeysToKeyring,
  type LocalKeyringState
} from "@living-atlas/local-keyring";
import { DEFAULT_TIERING_RULESET } from "@living-atlas/policy";

import {
  applyRetierToStore,
  RETIER_APPLY_ACK,
  type TieringOptions
} from "./local-tiering";

const authorityId = "la_authority_retierapply01";
const now = "2026-07-04T00:00:00.000Z";
const actorId = "la_client_retierapply01";

function primaryKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) % 256))).toString("base64");
}
function escalationKey(): string {
  return Buffer.from(new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 11 + 41) % 256))).toString("base64");
}

function keyring(): LocalKeyringState {
  const base = createDefaultLocalKeyring({ authorityId, createdAt: now });
  return addTieringKeysToKeyring(
    base,
    { primary_cloud_unlock_key_base64: primaryKey(), escalation_key_base64: escalationKey() },
    { createdAt: now }
  );
}

async function localDraft(
  kr: LocalKeyringState,
  objectId: string,
  data: Record<string, unknown>
): Promise<GraphObjectEnvelope> {
  const key = kr.keys.find((k) => k.access_class === "local-private")!;
  return encryptPlaintextGraphObjectDraft(
    {
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "block",
      version: 1,
      access_class: "local-private",
      encryption_class: "client-encrypted",
      created_at: now,
      updated_at: now,
      content_hash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      key_ref: key.key_id,
      visible_metadata: { tombstone: false, remote_indexable: false },
      payload: { kind: "plaintext-json", data }
    },
    kr
  );
}

describe("applyRetierToStore (ack-gated write)", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "living-atlas-retier-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function seededStore(kr: LocalKeyringState, entries: Array<{ id: string; data: Record<string, unknown> }>) {
    const store = await FileLocalGraphStore.open({
      directory: join(directory, "graph"),
      authorityId,
      plaintextPersistence: "encrypt",
      keyring: kr
    });
    for (const entry of entries) {
      const created = await store.createObject({
        object: await localDraft(kr, entry.id, entry.data),
        expected_generation: store.status().generation,
        actor_id: actorId,
        recorded_at: now
      });
      expect(created.ok).toBe(true);
    }
    return store;
  }

  function options(kr: LocalKeyringState): TieringOptions {
    return { keyring: kr, ruleset: DEFAULT_TIERING_RULESET, unlockKey: primaryKey(), escalationKey: escalationKey() };
  }

  it("refuses to write with an absent ack (default OFF)", async () => {
    const kr = keyring();
    const store = await seededStore(kr, [{ id: "la_object_retier_norm1", data: { text: "public roadmap" } }]);
    const before = store.readObject("la_object_retier_norm1")!;

    const result = await applyRetierToStore(store, before, { ...options(kr), actorId, recordedAt: now });
    expect(result.action).toBe("refused-no-ack");

    const after = store.readObject("la_object_retier_norm1")!;
    expect(after.version).toBe(before.version);
    if (after.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(after.payload.algorithm).toBe("AES-GCM-256+local-keyring-v1");
  });

  it("refuses to write with a WRONG ack", async () => {
    const kr = keyring();
    const store = await seededStore(kr, [{ id: "la_object_retier_norm2", data: { text: "public roadmap" } }]);
    const before = store.readObject("la_object_retier_norm2")!;

    const result = await applyRetierToStore(store, before, {
      ...options(kr),
      actorId,
      recordedAt: now,
      ack: "not-the-ack"
    });
    expect(result.action).toBe("refused-no-ack");
    expect(store.readObject("la_object_retier_norm2")!.version).toBe(before.version);
  });

  it("with the correct ack, a local-keyring-v1 NORMAL object becomes cloud-unlock-v1, same id, version+1", async () => {
    const kr = keyring();
    const store = await seededStore(kr, [{ id: "la_object_retier_norm3", data: { text: "public roadmap" } }]);
    const before = store.readObject("la_object_retier_norm3")!;
    const originalPlaintext = await decryptGraphObjectPayload(before, kr);

    const result = await applyRetierToStore(store, before, {
      ...options(kr),
      actorId,
      recordedAt: now,
      ack: RETIER_APPLY_ACK
    });
    expect(result.action).toBe("written-normal");

    const after = store.readObject("la_object_retier_norm3")!;
    expect(after.object_id).toBe(before.object_id);
    expect(after.authority_id).toBe(before.authority_id);
    expect(after.version).toBe(before.version + 1);
    if (after.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(after.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-v1");

    // Lossless: the persisted cloud-tier object decrypts back to the original.
    const roundtrip = await decryptGraphObjectPayload(after, kr);
    expect(roundtrip).toEqual(originalPlaintext);
  });

  it("with the correct ack, a SUPER-SENSITIVE object becomes cloud-unlock-escalated-v1 per the classifier, version+1", async () => {
    const kr = keyring();
    const store = await seededStore(kr, [
      { id: "la_object_retier_esc01", data: { text: "immigration visa timeline notes" } }
    ]);
    const before = store.readObject("la_object_retier_esc01")!;
    const originalPlaintext = await decryptGraphObjectPayload(before, kr);

    const result = await applyRetierToStore(store, before, {
      ...options(kr),
      actorId,
      recordedAt: now,
      ack: RETIER_APPLY_ACK
    });
    expect(result.action).toBe("written-escalated");

    const after = store.readObject("la_object_retier_esc01")!;
    expect(after.object_id).toBe(before.object_id);
    expect(after.version).toBe(before.version + 1);
    if (after.payload.kind !== "ciphertext-inline") throw new Error("bad payload");
    expect(after.payload.algorithm).toBe("AES-GCM-256+cloud-unlock-escalated-v1");

    const roundtrip = await decryptGraphObjectPayload(after, kr);
    expect(roundtrip).toEqual(originalPlaintext);
  });
});
