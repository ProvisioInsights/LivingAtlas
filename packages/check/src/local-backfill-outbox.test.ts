import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GraphObjectEnvelopeSchema } from "@living-atlas/contracts";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import {
  createDefaultLocalKeyring,
  encryptPlaintextGraphObjectDraft
} from "@living-atlas/local-keyring";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { armBackfillOutbox, stageBackfillOutbox } from "./local-backfill-outbox";

const now = "2026-07-03T12:00:00.000Z";
const authorityId = "la_authority_backfill0001";

describe("stageBackfillOutbox", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "living-atlas-backfill-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function seededStore() {
    const keyring = createDefaultLocalKeyring({ authorityId, createdAt: now });
    const store = await FileLocalGraphStore.open({
      directory: join(directory, "graph"),
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
      content_hash: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      payload: { kind: "plaintext-json", data: { title: "synthetic backfill page" } }
    }, keyring);

    for (const id of ["la_object_backfill0001", "la_object_backfill0002", "la_object_backfill0003", "la_object_backfill0004"]) {
      const created = await store.createObject({
        object: await draft(id),
        expected_generation: store.status().generation,
        actor_id: "la_client_backfill0001",
        recorded_at: now
      });
      expect(created.ok).toBe(true);
    }
    const tombstoned = await store.tombstoneObject({
      object_id: "la_object_backfill0004",
      expected_generation: store.status().generation,
      actor_id: "la_client_backfill0001",
      recorded_at: now
    });
    expect(tombstoned.ok).toBe(true);
    return store;
  }

  it("stages live objects into bounded outbox-format files and excludes tombstones", async () => {
    const store = await seededStore();
    const stagingDir = join(directory, "outbox-staging");

    const result = await stageBackfillOutbox({ store, stagingDir, objectsPerFile: 2, now });

    expect(result).toMatchObject({
      live_objects: 3,
      objects_staged: 3,
      files_written: 2,
      skipped_existing_files: 0
    });

    const files = (await readdir(stagingDir)).sort();
    expect(files).toHaveLength(2);
    let total = 0;
    for (const file of files) {
      const parsed = JSON.parse(await readFile(join(stagingDir, file), "utf8")) as {
        record_schema: string;
        objects: unknown[];
      };
      // Must match the queued-outbox contract readQueuedObjects expects.
      expect(parsed.record_schema).toBe("living-atlas-local-mcp-outbox:v1");
      for (const object of parsed.objects) {
        const envelope = GraphObjectEnvelopeSchema.parse(object);
        expect(envelope.visible_metadata.tombstone).toBe(false);
        expect(envelope.object_id).not.toBe("la_object_backfill0004");
        total += 1;
      }
    }
    expect(total).toBe(3);
  });

  it("is idempotent: restaging skips already-written files", async () => {
    const store = await seededStore();
    const stagingDir = join(directory, "outbox-staging");

    await stageBackfillOutbox({ store, stagingDir, objectsPerFile: 2, now });
    const again = await stageBackfillOutbox({ store, stagingDir, objectsPerFile: 2, now });

    expect(again).toMatchObject({ files_written: 0, skipped_existing_files: 2 });
    expect(await readdir(stagingDir)).toHaveLength(2);
  });

  it("arms by moving staged files into the live outbox directory", async () => {
    const store = await seededStore();
    const stagingDir = join(directory, "outbox-staging");
    const outboxDir = join(directory, "outbox");

    await stageBackfillOutbox({ store, stagingDir, objectsPerFile: 2, now });
    const armed = await armBackfillOutbox({ stagingDir, outboxDir });

    expect(armed).toMatchObject({ moved_files: 2 });
    expect(await readdir(outboxDir)).toHaveLength(2);
    expect(await readdir(stagingDir)).toHaveLength(0);
  });
});
