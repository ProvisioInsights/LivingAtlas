import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import {
  baitRegistry,
  fixtureAuthorityId,
  fixtureLocalClientId,
  sensitiveBaitRegistry,
  syntheticGraphObjects
} from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "./local-graph-store";

const now = "2026-06-22T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

async function tempStoreDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "living-atlas-local-graph-store-"));
}

async function readStoreFiles(directory: string): Promise<string> {
  const snapshot = await readFile(join(directory, "snapshot.json"), "utf8").catch(() => "");
  const journal = await readFile(join(directory, "journal.jsonl"), "utf8").catch(() => "");
  return `${snapshot}\n${journal}`;
}

function syntheticPlaintextObject(objectId: string): GraphObjectEnvelope {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "remote-safe",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("a"),
    visible_metadata: {
      schema_namespace: "fixture/local-graph-store",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Local graph store plaintext fixture",
        body: "This text must not be written to default store files."
      }
    }
  };
}

describe("file local graph store", () => {
  it("initializes from synthetic fixtures and redacts plaintext payloads on disk by default", async () => {
    const directory = await tempStoreDir();
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });

    await expect(store.initializeFromObjects(syntheticGraphObjects, { created_at: now })).resolves.toEqual({
      ok: true,
      status: expect.objectContaining({
        authority_id: fixtureAuthorityId,
        generation: 0,
        object_count: syntheticGraphObjects.length,
        plaintext_persistence: "redacted"
      }),
      persistence: "snapshot+journal"
    });

    const snapshotContent = await readFile(join(directory, "snapshot.json"), "utf8");
    expect(snapshotContent).not.toContain("plaintext-json");
    for (const bait of baitRegistry) {
      expect(snapshotContent).not.toContain(bait.value);
    }

    const privateObject = store.readObject("la_object_privatepage0001");
    expect(privateObject).toMatchObject({
      payload: expect.objectContaining({ kind: "ciphertext-ref" })
    });
    const remoteSafeObject = store.readObject("la_object_remotesafe0001");
    expect(remoteSafeObject).toMatchObject({
      encryption_class: "client-encrypted",
      payload: expect.objectContaining({ kind: "ciphertext-inline" })
    });

    const snapshotMode = (await stat(join(directory, "snapshot.json"))).mode & 0o777;
    expect(snapshotMode).toBe(0o600);
  });

  it("commits create, update, and tombstone mutations through journal replay", async () => {
    const directory = await tempStoreDir();
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });
    await store.initializeFromObjects(syntheticGraphObjects, { created_at: now });

    const created = await store.createObject({
      object: syntheticPlaintextObject("la_object_storecreate0001"),
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:01:00.000Z"
    });
    expect(created).toEqual({
      ok: true,
      operation: "create",
      object: expect.objectContaining({
        object_id: "la_object_storecreate0001",
        version: 1,
        payload: expect.objectContaining({ kind: "ciphertext-inline" })
      }),
      change: expect.objectContaining({
        operation: "create",
        generation: 1
      }),
      previous_generation: 0,
      generation: 1,
      journal_sequence: 1,
      previous_version: undefined,
      new_version: 1,
      persistence: "snapshot+journal"
    });

    const storedCreated = store.readObject("la_object_storecreate0001")!;
    const updatedObject: GraphObjectEnvelope = {
      ...storedCreated,
      version: 2,
      updated_at: "2026-06-22T12:02:00.000Z",
      content_hash: fixedHash("b"),
      visible_metadata: {
        ...storedCreated.visible_metadata,
        size_class: "medium"
      }
    };

    await expect(store.updateObject({
      object: updatedObject,
      expected_generation: 1,
      expected_version: 1,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:02:00.000Z"
    })).resolves.toMatchObject({
      ok: true,
      operation: "update",
      previous_generation: 1,
      generation: 2,
      journal_sequence: 2,
      previous_version: 1,
      new_version: 2
    });

    await expect(store.tombstoneObject({
      object_id: "la_object_storecreate0001",
      expected_generation: 2,
      expected_version: 2,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:03:00.000Z"
    })).resolves.toMatchObject({
      ok: true,
      operation: "tombstone",
      previous_generation: 2,
      generation: 3,
      journal_sequence: 3,
      previous_version: 2,
      new_version: 3,
      object: expect.objectContaining({
        visible_metadata: expect.objectContaining({ tombstone: true })
      })
    });

    const reopened = await FileLocalGraphStore.open({
      directory,
      now: () => "2026-06-22T12:04:00.000Z"
    });
    expect(reopened.status()).toEqual(expect.objectContaining({
      generation: 3,
      journal_sequence: 3,
      object_count: syntheticGraphObjects.length + 1,
      active_object_count: syntheticGraphObjects.length,
      tombstone_count: 1
    }));
    expect(reopened.readObject("la_object_storecreate0001")).toEqual(expect.objectContaining({
      version: 3,
      visible_metadata: expect.objectContaining({ tombstone: true })
    }));
    expect(reopened.listObjects().map((object) => object.object_id)).not.toContain("la_object_storecreate0001");
    expect(reopened.listObjects({ include_tombstones: true }).map((object) => object.object_id)).toContain("la_object_storecreate0001");

    const files = await readStoreFiles(directory);
    expect(files).not.toContain("Local graph store plaintext fixture");
    expect(files).not.toContain("This text must not be written to default store files.");
    for (const bait of sensitiveBaitRegistry) {
      expect(files).not.toContain(bait.value);
    }
  });

  it("rejects stale generation and version writes without appending to the journal", async () => {
    const directory = await tempStoreDir();
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });
    await store.initializeFromObjects(syntheticGraphObjects, { created_at: now });

    await expect(store.createObject({
      object: syntheticPlaintextObject("la_object_stalecreate0001"),
      expected_generation: 9,
      actor_id: fixtureLocalClientId
    })).resolves.toEqual({
      ok: false,
      reason: "generation-conflict",
      current_generation: 0
    });

    const existing = store.readObject("la_object_remotesafe0001")!;
    await expect(store.updateObject({
      object: {
        ...existing,
        version: 2,
        updated_at: "2026-06-22T12:05:00.000Z"
      },
      expected_generation: 0,
      expected_version: 99,
      actor_id: fixtureLocalClientId
    })).resolves.toEqual({
      ok: false,
      reason: "version-conflict",
      current_generation: 0,
      current_version: 1
    });

    expect(store.status()).toEqual(expect.objectContaining({
      generation: 0,
      journal_sequence: 0,
      object_count: syntheticGraphObjects.length
    }));
    expect(await readFile(join(directory, "journal.jsonl"), "utf8").catch(() => "")).toBe("");
  });

  it("compacts the replayed state into an atomic snapshot", async () => {
    const directory = await tempStoreDir();
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });
    await store.initializeFromObjects(syntheticGraphObjects, { created_at: now });
    await store.createObject({
      object: syntheticPlaintextObject("la_object_compact0001"),
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:06:00.000Z"
    });

    await expect(store.compact()).resolves.toEqual(expect.objectContaining({
      generation: 1,
      journal_sequence: 1,
      object_count: syntheticGraphObjects.length + 1
    }));

    const snapshotContent = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8")) as {
      generation: number;
      journal_sequence: number;
      objects: Array<{ object_id: string }>;
    };
    expect(snapshotContent.generation).toBe(1);
    expect(snapshotContent.journal_sequence).toBe(1);
    expect(snapshotContent.objects.map((object) => object.object_id)).toContain("la_object_compact0001");
  });
});
