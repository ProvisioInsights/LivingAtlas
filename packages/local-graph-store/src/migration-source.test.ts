import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphObjectEnvelope } from "@living-atlas/contracts";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import {
  FileLocalGraphStore,
  LocalGraphMigrationSource,
  LocalGraphStoreReadOnlyError
} from "./local-graph-store";

/**
 * The migration source, tested as the one thing it claims to be: a handle onto
 * a replica it cannot destroy.
 *
 * Every assertion here compares the replica's BYTES before and after, because
 * "the method threw" is not the property. The property is that the files are
 * unchanged — a mutator that threw after truncating the journal would satisfy
 * the first and fail the thing that matters.
 */

const now = "2026-06-22T12:00:00.000Z";

function fixedHash(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function object(objectId: string, seed: string): GraphObjectEnvelope {
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
    content_hash: fixedHash(seed),
    visible_metadata: {
      schema_namespace: "fixture/migration-source",
      tombstone: false,
      size_class: "tiny",
      remote_indexable: true
    },
    payload: { kind: "plaintext-json", data: { title: `Fixture ${objectId}` } }
  };
}

type ReplicaBytes = { snapshot: string; journal: string };

async function bytes(directory: string): Promise<ReplicaBytes> {
  return {
    snapshot: await readFile(join(directory, "snapshot.json"), "utf8").catch(() => "<absent>"),
    journal: await readFile(join(directory, "journal.jsonl"), "utf8").catch(() => "<absent>")
  };
}

/**
 * A replica in the state a migration source actually finds: a snapshot from an
 * earlier point plus a journal carrying versions the snapshot does not have.
 * That gap is the whole reason compaction is tempting and the whole reason it
 * must not happen here.
 */
async function replicaWithUncompactedJournal(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "living-atlas-migration-source-"));
  const store = await FileLocalGraphStore.open({
    directory,
    authorityId: fixtureAuthorityId,
    plaintextPersistence: "allow",
    now: () => now
  });
  const initialized = await store.initializeFromObjects([object("la_object_migsource0001", "a")], { created_at: now });
  expect(initialized.ok).toBe(true);
  for (const [index, seed] of ["b", "c", "d"].entries()) {
    const updated = await store.updateObject({
      expected_generation: index,
      actor_id: fixtureLocalClientId,
      expected_version: index + 1,
      object: {
        ...object("la_object_migsource0001", seed),
        version: index + 2,
        updated_at: now
      }
    });
    expect(updated.ok, `update ${seed}`).toBe(true);
  }
  const created = await store.createObject({
    expected_generation: 3,
    actor_id: fixtureLocalClientId,
    object: object("la_object_migsource0002", "e")
  });
  expect(created.ok).toBe(true);
  return directory;
}

describe("a local graph migration source", () => {
  it("replays the journal the snapshot does not carry, and writes nothing doing it", async () => {
    const directory = await replicaWithUncompactedJournal();
    const before = await bytes(directory);
    // The snapshot on disk still describes generation 0 — one object at version
    // 1 — because a mutation appends to the journal and does not rewrite the
    // snapshot. A reader that trusted the snapshot alone would miss four
    // generations.
    expect(JSON.parse(before.snapshot).generation).toBe(0);

    const source = await LocalGraphMigrationSource.open({
      directory,
      plaintextPersistence: "allow",
      now: () => now
    });
    expect(source.status().generation).toBe(4);
    expect(source.status().object_count).toBe(2);
    expect(source.readObject("la_object_migsource0001")?.version).toBe(4);
    expect((await source.journalEntries()).length).toBe(4);

    expect(await bytes(directory)).toEqual(before);
  });

  it("refuses compact() and leaves the journal it would have truncated intact", async () => {
    const directory = await replicaWithUncompactedJournal();
    const before = await bytes(directory);
    expect(before.journal.trim().split("\n")).toHaveLength(4);

    const source = await LocalGraphMigrationSource.open({
      directory,
      plaintextPersistence: "allow",
      now: () => now
    });
    await expect(source.compact()).rejects.toBeInstanceOf(LocalGraphStoreReadOnlyError);

    const after = await bytes(directory);
    expect(after).toEqual(before);
    expect(after.journal.trim().split("\n")).toHaveLength(4);
  });

  it("refuses every mutating member by name, with the replica byte-identical afterwards", async () => {
    const directory = await replicaWithUncompactedJournal();
    const before = await bytes(directory);
    const source = await LocalGraphMigrationSource.open({
      directory,
      plaintextPersistence: "allow",
      now: () => now
    });

    // Named individually rather than reflected over the prototype: the list is
    // the assertion. A mutator added to FileLocalGraphStore and forgotten here
    // is exactly the gap this is for, and a reflective loop over THIS object
    // would not notice one.
    for (const name of [
      "createObject",
      "updateObject",
      "tombstoneObject",
      "commitTransaction",
      "initializeFromObjects",
      "openMigrationWindow",
      "sealMigrationWindow",
      "compact"
    ] as const) {
      await expect(source[name](), name).rejects.toMatchObject({ code: "local-graph-store-read-only" });
    }

    expect(await bytes(directory)).toEqual(before);
  });

  it("carries a refusing member for every mutator FileLocalGraphStore has", () => {
    const mutators = Object.getOwnPropertyNames(FileLocalGraphStore.prototype).filter((name) =>
      ["createObject", "updateObject", "tombstoneObject", "commitTransaction", "initializeFromObjects", "openMigrationWindow", "sealMigrationWindow", "compact"].includes(name)
    );
    // Both directions. If a mutator is renamed or added on the writing store and
    // this list is not updated, the two sets stop matching and this fails before
    // anybody points a migration source at a real replica.
    expect(mutators.sort()).toEqual(
      [
        "commitTransaction",
        "compact",
        "createObject",
        "initializeFromObjects",
        "openMigrationWindow",
        "sealMigrationWindow",
        "tombstoneObject",
        "updateObject"
      ]
    );
    for (const name of mutators) {
      expect(typeof (LocalGraphMigrationSource.prototype as unknown as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("refuses a directory that does not exist instead of creating an empty one", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-migration-source-absent-"));
    const absent = join(root, "not-a-replica");

    await expect(LocalGraphMigrationSource.open({ directory: absent, authorityId: fixtureAuthorityId }))
      .rejects.toThrow(/does not exist/);
    expect(existsSync(absent)).toBe(false);

    // The contrast that makes the rule worth having: the writing store mkdir's,
    // so a typo'd path reads as "the replica is empty" rather than "the replica
    // is not there", and a migration against nothing looks like a migration that
    // found nothing to do.
    await FileLocalGraphStore.open({ directory: absent, authorityId: fixtureAuthorityId, now: () => now });
    expect(existsSync(absent)).toBe(true);
  });

  it("materializes the full snapshot a compaction would have produced, without producing one", async () => {
    const directory = await replicaWithUncompactedJournal();
    const source = await LocalGraphMigrationSource.open({
      directory,
      plaintextPersistence: "allow",
      now: () => now
    });
    const materialized = source.materializedSnapshot();
    const before = await bytes(directory);

    // Same directory, opened by the writing store, compacted. The read-only
    // handle already had everything compaction writes — which is the argument
    // for refusing compaction rather than allowing it "just to read".
    const writable = await FileLocalGraphStore.open({
      directory,
      plaintextPersistence: "allow",
      now: () => now
    });
    await writable.compact();
    const compacted = JSON.parse((await bytes(directory)).snapshot) as unknown;

    expect(materialized).toEqual(compacted);
    expect((await bytes(directory)).journal).not.toEqual(before.journal);
    expect((await bytes(directory)).journal.trim()).toBe("");
  });
});
