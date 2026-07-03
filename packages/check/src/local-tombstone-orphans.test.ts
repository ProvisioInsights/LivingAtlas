import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft
} from "@living-atlas/local-keyring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runLocalDecryptCoverage } from "./local-decrypt-coverage";
import { tombstoneOrphanCiphertext } from "./local-tombstone-orphans";

const now = "2026-07-03T12:00:00.000Z";
const authorityId = "la_authority_orphans0001";

describe("tombstoneOrphanCiphertext", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "living-atlas-orphans-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function seededStore(keyring: ReturnType<typeof createDefaultLocalKeyring>) {
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId,
      plaintextPersistence: "redact"
    });
    const draft = async (objectId: string) => encryptPlaintextGraphObjectDraft({
      schema_version: 1,
      authority_id: authorityId,
      object_id: objectId,
      object_type: "page",
      version: 1,
      access_class: "local-private",
      encryption_class: "plaintext",
      created_at: now,
      updated_at: now,
      content_hash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      payload: { kind: "plaintext-json", data: { title: "synthetic orphan-test page" } }
    }, keyring);

    const covered = await draft("la_object_orphantest0001");
    const orphanA = { ...(await draft("la_object_orphantest0002")), key_ref: "la_key_logseqsemdeadbeef000001" };
    const orphanB = { ...(await draft("la_object_orphantest0003")), key_ref: undefined };

    for (const object of [covered, orphanA, orphanB]) {
      const created = await store.createObject({
        object,
        expected_generation: store.status().generation,
        actor_id: "la_client_orphantest0001",
        recorded_at: now
      });
      expect(created.ok).toBe(true);
    }
    return store;
  }

  it("dry run reports orphans without mutating the store", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const store = await seededStore(keyring);

    const result = await tombstoneOrphanCiphertext({
      store,
      keyring,
      actorId: "la_client_orphantest0001",
      dryRun: true,
      now
    });

    expect(result).toMatchObject({ dry_run: true, scanned: 3, orphans: 2, tombstoned: 0, failed: 0 });
    expect(store.status().tombstone_count).toBe(0);
  });

  it("tombstones every live ciphertext object whose key_ref is not in the keyring", async () => {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const store = await seededStore(keyring);

    const result = await tombstoneOrphanCiphertext({
      store,
      keyring,
      actorId: "la_client_orphantest0001",
      dryRun: false,
      now
    });

    expect(result).toMatchObject({ dry_run: false, scanned: 3, orphans: 2, tombstoned: 2, failed: 0 });
    expect(store.status().tombstone_count).toBe(2);
    expect(store.status().active_object_count).toBe(1);

    // After surgery the coverage gate must go green.
    const coverage = await runLocalDecryptCoverage({
      keyring,
      objects: store.listObjects({ include_tombstones: true })
    });
    expect(coverage.complete).toBe(true);
    expect(coverage.uncovered_objects).toBe(0);
    expect(coverage.tombstoned_objects).toBe(2);

    // Idempotent: a second pass finds nothing to do.
    const again = await tombstoneOrphanCiphertext({
      store,
      keyring,
      actorId: "la_client_orphantest0001",
      dryRun: false,
      now
    });
    expect(again).toMatchObject({ orphans: 0, tombstoned: 0, failed: 0 });
  });
});
