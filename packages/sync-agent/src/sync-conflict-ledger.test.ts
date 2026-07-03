import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileSyncConflictLedger,
  applyPulledEnvelopes,
  buildCiphertextSyncBatch
} from "./sync-agent";

const now = "2026-06-21T12:00:00.000Z";

describe("FileSyncConflictLedger", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "living-atlas-conflict-ledger-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("records conflict entries durably and deduplicates repeats", async () => {
    const ledger = new FileSyncConflictLedger(join(directory, "sync-conflicts.jsonl"));
    const entry = {
      authority_id: "la_authority_fixture0001",
      object_id: "la_object_privatepage0001",
      remote_generation: 2,
      remote_version: 1,
      local_version: 1,
      reason: "version-conflict" as const,
      batch_id: "la_sync_batch_conflict0001",
      submitted_at: now,
      recorded_at: now,
      envelope: { object_id: "la_object_privatepage0001", version: 1 }
    };

    expect(await ledger.record(entry)).toBe("recorded");
    expect(await ledger.record(entry)).toBe("duplicate");

    const entries = await ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      object_id: "la_object_privatepage0001",
      reason: "version-conflict",
      envelope: { object_id: "la_object_privatepage0001" }
    });

    const raw = await readFile(join(directory, "sync-conflicts.jsonl"), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
  });

  it("persists the conflicting remote envelope when applyPulledEnvelopes hits a version conflict", async () => {
    const controlState = await createFixtureLocalControlState("sync-conflict-ledger-token-0001");
    const { batch } = buildCiphertextSyncBatch({
      controlState,
      baseGeneration: 0,
      targetGeneration: 1,
      now
    });
    const localObject = batch.objects[0]!;

    const store = await FileLocalGraphStore.open({
      directory: join(directory, "graph"),
      authorityId: batch.authority_id,
      plaintextPersistence: "redact"
    });
    const created = await store.createObject({
      object: localObject,
      expected_generation: store.status().generation,
      actor_id: batch.client_id,
      recorded_at: now
    });
    expect(created.ok).toBe(true);

    const remoteObject = {
      ...localObject,
      content_hash: "sha256:1111111111111111111111111111111111111111111111111111111111111111" as const
    };
    const response = {
      ok: true as const,
      authority_id: batch.authority_id,
      from_generation: 1,
      latest_generation: 2,
      objects: [
        {
          batch_id: "la_sync_batch_conflict0002",
          generation: 2,
          submitted_at: now,
          object: remoteObject
        }
      ],
      next_cursor: {
        authority_id: batch.authority_id,
        generation: 2,
        batch_id: "la_sync_batch_conflict0002"
      },
      has_more: false
    };

    const ledgerPath = join(directory, "sync-conflicts.jsonl");
    const ledger = new FileSyncConflictLedger(ledgerPath);
    const applied = await applyPulledEnvelopes({
      store,
      response,
      actorId: batch.client_id,
      conflictLedger: ledger
    });

    expect(applied.ok).toBe(false);
    expect(applied.conflict_count).toBe(1);

    const entries = await ledger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      object_id: localObject.object_id,
      remote_generation: 2,
      remote_version: localObject.version,
      local_version: localObject.version,
      reason: "version-conflict",
      batch_id: "la_sync_batch_conflict0002",
      envelope: {
        object_id: localObject.object_id,
        content_hash: remoteObject.content_hash
      }
    });

    // A daemon retrying the same pull must not grow the ledger.
    const replay = await applyPulledEnvelopes({
      store,
      response,
      actorId: batch.client_id,
      conflictLedger: ledger
    });
    expect(replay.ok).toBe(false);
    expect(await ledger.list()).toHaveLength(1);
  });
});
