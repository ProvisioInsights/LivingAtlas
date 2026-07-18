import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureAuthorityId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "./local-graph-store";

const now = "2026-07-18T12:00:00.000Z";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "living-atlas-migration-window-"));
}

async function freshStore(directory?: string): Promise<FileLocalGraphStore> {
  return FileLocalGraphStore.open({
    directory: directory ?? (await tempDir()),
    authorityId: fixtureAuthorityId,
    plaintextPersistence: "allow",
    now: () => now
  });
}

describe("authority lifecycle: migration window", () => {
  it("reports lifecycle 'live' on a fresh store", async () => {
    const store = await freshStore();

    expect(store.status().lifecycle).toEqual({ state: "live" });
  });

  it("opening a migration window moves the authority to 'migrating' with a recorded window", async () => {
    const store = await freshStore();

    const opened = await store.openMigrationWindow({ reason: "geography remodel", actor_id: "owner-1" });

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.window.reason).toBe("geography remodel");
    expect(opened.window.opened_by).toBe("owner-1");
    expect(opened.window.opened_at).toBe(now);
    expect(opened.window.base_generation).toBe(0);
    expect(opened.window.migration_id).toMatch(/^la_migration_[a-f0-9]{24}$/);
    expect(store.status().lifecycle).toEqual({ state: "migrating", window: opened.window });
  });

  it("sealing a migration window returns the authority to 'live'", async () => {
    const store = await freshStore();
    const opened = await store.openMigrationWindow({ reason: "fix", actor_id: "owner-1" });
    if (!opened.ok) throw new Error("open failed");

    const sealed = await store.sealMigrationWindow({ actor_id: "owner-1" });

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.record.migration_id).toBe(opened.window.migration_id);
    expect(sealed.record.sealed_generation).toBe(store.status().generation);
    expect(store.status().lifecycle).toEqual({ state: "live" });
  });

  it("rejects opening a second window while one is already open", async () => {
    const store = await freshStore();
    await store.openMigrationWindow({ reason: "first", actor_id: "owner-1" });

    const again = await store.openMigrationWindow({ reason: "second", actor_id: "owner-1" });

    expect(again).toEqual({ ok: false, reason: "migration-window-already-open" });
  });

  it("rejects sealing when the authority is live (no open window)", async () => {
    const store = await freshStore();

    const sealed = await store.sealMigrationWindow({ actor_id: "owner-1" });

    expect(sealed).toEqual({ ok: false, reason: "no-open-migration-window" });
  });

  it("persists the open window across a store reload", async () => {
    const directory = await tempDir();
    const store = await freshStore(directory);
    const opened = await store.openMigrationWindow({ reason: "durable", actor_id: "owner-1" });
    if (!opened.ok) throw new Error("open failed");

    const reopened = await freshStore(directory);

    expect(reopened.status().lifecycle).toEqual({ state: "migrating", window: opened.window });
  });

  it("records sealed migrations in a durable audit history", async () => {
    const directory = await tempDir();
    const store = await freshStore(directory);
    const opened = await store.openMigrationWindow({ reason: "audited", actor_id: "owner-1" });
    if (!opened.ok) throw new Error("open failed");
    await store.sealMigrationWindow({ actor_id: "owner-1" });

    const reopened = await freshStore(directory);

    expect(reopened.migrationHistory().map((record) => record.migration_id)).toEqual([
      opened.window.migration_id
    ]);
  });
});
