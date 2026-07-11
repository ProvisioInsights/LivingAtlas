import { createHash } from "node:crypto";
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
import {
  createDefaultLocalKeyring,
  decryptGraphObjectPayload
} from "@living-atlas/local-keyring";
import { FileLocalGraphStore } from "./local-graph-store";

const now = "2026-06-22T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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

function sensitivePlaintextDraft(objectId: string) {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "page",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: now,
    updated_at: now,
    content_hash: fixedHash("e"),
    visible_metadata: {
      schema_namespace: "fixture/local-graph-store",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        title: "Local keyring encrypted graph fixture",
        body: "This sensitive draft must only persist as ciphertext."
      }
    }
  };
}

function canonicalTransactionDraft(objectId: string, recordedAt = now) {
  return {
    schema_version: 1,
    authority_id: fixtureAuthorityId,
    object_id: objectId,
    object_type: "assertion",
    version: 1,
    access_class: "local-private",
    encryption_class: "plaintext",
    created_at: recordedAt,
    updated_at: recordedAt,
    content_hash: fixedHash("b"),
    visible_metadata: {
      tombstone: false,
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json",
      data: {
        schema: "atlas.fact:v1",
        assertion_id: objectId,
        subject_entity_id: "la_object_entity0001",
        predicate: "status",
        value: { kind: "text", value: "Synthetic transaction fact" },
        recorded_at: recordedAt,
        lineage_action: "assert",
        evidence_links: [{ evidence_id: "la_object_evidence0001", stance: "supports" }],
        confidence: {
          band: "high",
          assessment_kind: "assertion",
          method: "synthetic-transaction-test",
          assessed_at: recordedAt,
          evidence_refs: ["la_object_evidence0001"]
        }
      }
    }
  };
}

describe("file local graph store", () => {
  it("commits a complete local operation group once or leaves no partial objects", async () => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    const first = canonicalTransactionDraft("la_object_transaction0001");
    const second = canonicalTransactionDraft("la_object_transaction0002");

    await expect(store.commitTransaction({
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolution0001",
      idempotency_key: "la_idem_resolution0001",
      recorded_at: now,
      writes: [
        { kind: "create", object: first },
        { kind: "create", object: second }
      ]
    })).resolves.toMatchObject({
      ok: true,
      generation: 1,
      objects: [
        expect.objectContaining({ object_id: first.object_id }),
        expect.objectContaining({ object_id: second.object_id })
      ]
    });
    expect(store.listObjects().map((object) => object.object_id)).toEqual([first.object_id, second.object_id]);

    await expect(store.commitTransaction({
      expected_generation: 1,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolution0002",
      idempotency_key: "la_idem_resolution0002",
      recorded_at: now,
      writes: [
        { kind: "create", object: canonicalTransactionDraft("la_object_transaction0003") },
        { kind: "create", object: canonicalTransactionDraft("la_object_transaction0003") }
      ]
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      reason: "object-already-exists",
      current_generation: 1
    }));
    expect(store.listObjects().map((object) => object.object_id)).toEqual([first.object_id, second.object_id]);

    await expect(store.commitTransaction({
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolution0001",
      idempotency_key: "la_idem_resolution0001",
      recorded_at: now,
      writes: [{ kind: "create", object: first }]
    })).resolves.toMatchObject({
      ok: true,
      generation: 1
    });
    expect(store.status().generation).toBe(1);
  });

  it("returns an isolated operation record lookup by idempotency key", async () => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    const object = canonicalTransactionDraft("la_object_transactionlookup0001");

    await expect(store.commitTransaction({
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolutionlookup0001",
      idempotency_key: "la_idem_resolutionlookup0001",
      recorded_at: now,
      writes: [{ kind: "create", object }]
    })).resolves.toMatchObject({ ok: true, generation: 1 });

    const first = store.operationRecordForIdempotency("la_idem_resolutionlookup0001");
    expect(first).toMatchObject({
      operation_id: "la_operation_resolutionlookup0001",
      actor_id: fixtureLocalClientId,
      generation: 1,
      journal_sequence: 1
    });
    first!.objects[0]!.visible_metadata.tombstone = true;

    expect(store.operationRecordForIdempotency("la_idem_resolutionlookup0001")).toMatchObject({
      objects: [expect.objectContaining({
        object_id: object.object_id,
        visible_metadata: expect.objectContaining({ tombstone: false })
      })]
    });
    expect(store.operationRecordForIdempotency("la_idem_missinglookup0001")).toBeUndefined();
  });

  it("persists a versioned request fingerprint and fails closed on missing or changed retry fingerprints", async () => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    const object = canonicalTransactionDraft("la_object_transactionfingerprint0001");
    const requestFingerprint = {
      schema: "living-atlas-resolution-request-fingerprint:v1" as const,
      candidate_id: "la_candidate_resolutionfingerprint0001",
      digest: fixedHash("c")
    };
    const transaction = {
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolutionfingerprint0001",
      idempotency_key: "la_idem_resolutionfingerprint0001",
      request_fingerprint: requestFingerprint,
      recorded_at: now,
      writes: [{ kind: "create" as const, object }]
    };

    await expect(store.commitTransaction(transaction)).resolves.toMatchObject({ ok: true, generation: 1 });
    expect(store.operationRecordForIdempotency(transaction.idempotency_key)).toMatchObject({
      request_fingerprint: requestFingerprint
    });

    await expect(store.commitTransaction({
      ...transaction,
      request_fingerprint: { ...requestFingerprint, digest: fixedHash("d") }
    })).resolves.toEqual({
      ok: false,
      reason: "idempotency-conflict",
      current_generation: 1
    });
    const { request_fingerprint: _fingerprint, ...missingFingerprintRetry } = transaction;
    await expect(store.commitTransaction(missingFingerprintRetry)).resolves.toEqual({
      ok: false,
      reason: "idempotency-conflict",
      current_generation: 1
    });

    const reopened = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    expect(reopened.operationRecordForIdempotency(transaction.idempotency_key)).toMatchObject({
      request_fingerprint: requestFingerprint
    });
  });

  it.each([
    {
      label: "operation id",
      operation_id: "la_operation_resolutionconflict0002",
      actor_id: fixtureLocalClientId
    },
    {
      label: "actor",
      operation_id: "la_operation_resolutionconflict0001",
      actor_id: "la_client_resolutionconflict0002"
    }
  ])("rejects idempotency-key reuse with another $label", async ({ operation_id, actor_id }) => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    const first = canonicalTransactionDraft("la_object_transactionconflict0001");

    await expect(store.commitTransaction({
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      operation_id: "la_operation_resolutionconflict0001",
      idempotency_key: "la_idem_resolutionconflict0001",
      recorded_at: now,
      writes: [{ kind: "create", object: first }]
    })).resolves.toMatchObject({ ok: true, generation: 1 });

    await expect(store.commitTransaction({
      expected_generation: 0,
      actor_id,
      operation_id,
      idempotency_key: "la_idem_resolutionconflict0001",
      recorded_at: now,
      writes: [{ kind: "create", object: first }]
    })).resolves.toEqual({
      ok: false,
      reason: "idempotency-conflict",
      current_generation: 1
    });
    expect(store.status()).toMatchObject({ generation: 1, object_count: 1 });
  });

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
	    const redactedFixture = syntheticGraphObjects.find((object) => object.payload.kind === "plaintext-json");
	    if (!redactedFixture || redactedFixture.payload.kind !== "plaintext-json") {
	      throw new Error("expected a plaintext fixture to prove redacted hash handling");
	    }
	    expect(snapshotContent).not.toContain(sha256(JSON.stringify(redactedFixture.payload.data)));
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
    expect(reopened.listObjects({ include_tombstones: false }).map((object) => object.object_id)).not.toContain("la_object_storecreate0001");
    expect(reopened.listObjects({ include_tombstones: false })).toHaveLength(syntheticGraphObjects.length);
    expect(reopened.listObjects({ include_tombstones: true }).map((object) => object.object_id)).toContain("la_object_storecreate0001");

    const files = await readStoreFiles(directory);
    expect(files).not.toContain("Local graph store plaintext fixture");
    expect(files).not.toContain("This text must not be written to default store files.");
    for (const bait of sensitiveBaitRegistry) {
      expect(files).not.toContain(bait.value);
    }
  });

  it("encrypts local graph persistence when an unlocked local keyring is provided", async () => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });

    await expect(store.createObject({
      object: sensitivePlaintextDraft("la_object_storeencrypted0001"),
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:01:00.000Z"
    })).resolves.toMatchObject({
      ok: true,
      object: expect.objectContaining({
        access_class: "local-private",
        encryption_class: "client-encrypted",
        key_ref: expect.stringMatching(/^la_key_/),
        payload: expect.objectContaining({
          kind: "ciphertext-inline",
          algorithm: "AES-GCM-256+local-keyring-v1"
        })
      }),
      generation: 1
    });

    expect(store.status()).toEqual(expect.objectContaining({
      plaintext_persistence: "encrypted"
    }));

    const stored = store.readObject("la_object_storeencrypted0001")!;
    await expect(decryptGraphObjectPayload(stored, keyring)).resolves.toEqual({
      kind: "plaintext-json",
      data: {
        title: "Local keyring encrypted graph fixture",
        body: "This sensitive draft must only persist as ciphertext."
      }
    });

    const files = await readStoreFiles(directory);
    expect(files).toContain("AES-GCM-256+local-keyring-v1");
    expect(files).not.toContain("plaintext-json");
    expect(files).not.toContain("Local keyring encrypted graph fixture");
    expect(files).not.toContain("This sensitive draft must only persist as ciphertext.");
    for (const bait of sensitiveBaitRegistry) {
      expect(files).not.toContain(bait.value);
    }

    const reopened = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => "2026-06-22T12:04:00.000Z"
    });
    expect(reopened.status()).toEqual(expect.objectContaining({
      generation: 1,
      object_count: 1,
      plaintext_persistence: "encrypted"
    }));
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

  it("serializes concurrent mutations before assigning generation and journal sequence", async () => {
    const directory = await tempStoreDir();
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });
    await store.initializeFromObjects(syntheticGraphObjects, { created_at: now });

    const results = await Promise.all([
      store.createObject({
        object: syntheticPlaintextObject("la_object_concurrent0001"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: "2026-06-22T12:01:00.000Z"
      }),
      store.createObject({
        object: syntheticPlaintextObject("la_object_concurrent0002"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: "2026-06-22T12:01:00.000Z"
      })
    ]);

    const successful = results.filter((result) => result.ok);
    const conflicted = results.filter((result) => !result.ok);
    expect(successful).toHaveLength(1);
    expect(conflicted).toEqual([{
      ok: false,
      reason: "generation-conflict",
      current_generation: 1
    }]);
    expect(successful[0]).toEqual(expect.objectContaining({
      ok: true,
      generation: 1,
      journal_sequence: 1
    }));

    const journalLines = (await readFile(join(directory, "journal.jsonl"), "utf8")).trim().split("\n");
    expect(journalLines).toHaveLength(1);
    expect(JSON.parse(journalLines[0]!)).toEqual(expect.objectContaining({
      sequence: 1,
      previous_generation: 0,
      generation: 1
    }));
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

    await expect(readFile(join(directory, "journal.jsonl"), "utf8")).resolves.toBe("");

    const reopened = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      now: () => now
    });
    expect(reopened.status()).toEqual(expect.objectContaining({
      generation: 1,
      journal_sequence: 1,
      object_count: syntheticGraphObjects.length + 1
    }));
  });

  it("materializes the replayed encrypted state without changing source snapshot or journal files", async () => {
    const directory = await tempStoreDir();
    const keyring = createDefaultLocalKeyring({ authorityId: fixtureAuthorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory,
      authorityId: fixtureAuthorityId,
      plaintextPersistence: "encrypt",
      keyring,
      now: () => now
    });
    await store.initializeFromObjects(syntheticGraphObjects, { created_at: now });
    await store.createObject({
      object: sensitivePlaintextDraft("la_object_materialized0001"),
      expected_generation: 0,
      actor_id: fixtureLocalClientId,
      recorded_at: "2026-06-22T12:07:00.000Z"
    });
    const sourceBefore = await readStoreFiles(directory);

    const materialized = store.materializedSnapshot();

    expect(materialized).toEqual(expect.objectContaining({
      generation: 1,
      journal_sequence: 1,
      plaintext_persistence: "encrypted"
    }));
    expect(materialized.objects.map((object) => object.object_id)).toContain("la_object_materialized0001");
    expect(JSON.stringify(materialized)).toContain("AES-GCM-256+local-keyring-v1");
    expect(JSON.stringify(materialized)).not.toContain("Local keyring encrypted graph fixture");
    expect(await readStoreFiles(directory)).toBe(sourceBefore);
  });
});
