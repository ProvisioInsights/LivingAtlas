import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureAuthorityId, fixtureLocalClientId } from "@living-atlas/fixtures";
import { LocalWormStore, restoreBackup, type ImmutableStore } from "@living-atlas/backup";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { assembleBackupStores, fanOutBestEffort, type CloudStoreFactory } from "./backup-run";
import { runBackup } from "./backup-run";

const authorityId = fixtureAuthorityId;
const timestamp = "2026-07-09T00:00:00.000Z";

function backupObject(objectId: string) {
  return {
    schema_version: 1,
    authority_id: authorityId,
    object_id: objectId,
    object_type: "page" as const,
    version: 1,
    access_class: "local-private" as const,
    encryption_class: "plaintext" as const,
    created_at: timestamp,
    updated_at: timestamp,
    content_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    visible_metadata: {
      schema_namespace: "test/backup-run",
      tombstone: false,
      size_class: "tiny" as const,
      remote_indexable: false
    },
    payload: {
      kind: "plaintext-json" as const,
      data: { title: "Synthetic backup graph object" }
    }
  };
}

function withBackupEnv(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    vi.stubEnv(key, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeStore(): ImmutableStore & { puts: string[]; fail?: boolean } {
  const s: ImmutableStore & { puts: string[]; fail?: boolean } = {
    puts: [],
    now: () => 1_000,
    async put(key) {
      if (s.fail) throw new Error("provider down");
      s.puts.push(key);
    },
    async get() {
      return Buffer.alloc(0);
    },
    async remove() {},
  };
  return s;
}

const staging = () => fakeStore();

describe("assembleBackupStores", () => {
  it("includes the R2 hard anchor as REQUIRED when configured", () => {
    const r2 = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => undefined };
    const { required, bestEffort, notes } = assembleBackupStores(staging(), factory);
    expect(required).toContain(r2);
    expect(bestEffort).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/onedrive/i);
  });

  it("puts OneDrive in the best-effort tier, never required", () => {
    const r2 = fakeStore();
    const od = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => od };
    const { required, bestEffort } = assembleBackupStores(staging(), factory);
    expect(required).toContain(r2);
    expect(required).not.toContain(od);
    expect(bestEffort).toContain(od);
  });

  it("fails closed at assembly time if the R2 hard anchor is not configured", () => {
    const factory: CloudStoreFactory = { r2: () => undefined, oneDrive: () => undefined };
    expect(() => assembleBackupStores(staging(), factory)).toThrow(/R2|hard anchor|required/i);
  });

  it("always keeps local staging as a required store", () => {
    const s = staging();
    const r2 = fakeStore();
    const factory: CloudStoreFactory = { r2: () => r2, oneDrive: () => undefined };
    const { required } = assembleBackupStores(s, factory);
    expect(required).toContain(s);
  });
});

describe("fanOutBestEffort", () => {
  const items: Array<[string, Buffer]> = [
    ["b/manifest.json", Buffer.from("{}")],
    ["b/snapshot.enc", Buffer.from("x")],
  ];

  it("writes every item to every best-effort store and reports no errors on success", async () => {
    const od = fakeStore();
    const res = await fanOutBestEffort([od], items, 2_000);
    expect(res.errors).toHaveLength(0);
    expect(od.puts).toEqual(["b/manifest.json", "b/snapshot.enc"]);
  });

  it("collects errors without throwing when a best-effort store fails", async () => {
    const od = fakeStore();
    od.fail = true;
    const res = await fanOutBestEffort([od], items, 2_000);
    expect(res.errors.join()).toMatch(/provider down/);
  });

  it("is a no-op with no best-effort stores", async () => {
    const res = await fanOutBestEffort([], items, 2_000);
    expect(res.errors).toHaveLength(0);
  });
});

describe("runBackup local encrypted graph capture", () => {
  it("backs up the replayed encrypted generation instead of the stale on-disk snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-backup-run-"));
    const graphDir = join(root, "graph");
    const keyringPath = join(root, "keyring.json");
    const stagingDir = join(root, "staging");
    const master = randomBytes(32);
    try {
      const keyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
      await new FileLocalKeyringStore(keyringPath).write(keyring, "fixture-keyring-passphrase");
      const graph = await FileLocalGraphStore.open({
        directory: graphDir,
        authorityId,
        plaintextPersistence: "encrypt",
        keyring,
        now: () => timestamp
      });
      await graph.initializeFromObjects([], { created_at: timestamp });
      await graph.createObject({
        object: backupObject("la_object_backuprun0001"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: "2026-07-09T00:01:00.000Z"
      });

      withBackupEnv({
        LIVING_ATLAS_BACKUP_STAGING_DIR: stagingDir,
        LIVING_ATLAS_BACKUP_RECOVERY_MASTER: master.toString("base64"),
        LIVING_ATLAS_LOCAL_KEYRING: keyringPath,
        LIVING_ATLAS_LOCAL_GRAPH_DIR: graphDir,
        LIVING_ATLAS_BACKUP_AUTHORITY_ID: authorityId,
        LIVING_ATLAS_BACKUP_FULL_EVERY_MS: "1"
      });

      await expect(runBackup(1_000)).resolves.toBe(0);
      const restored = await restoreBackup(new LocalWormStore(stagingDir, () => 1_000), "la_backup_000001", master);
      const snapshot = JSON.parse(restored.artifactBytes.toString("utf8")) as {
        generation: number;
        objects: Array<{ object_id: string; payload: { kind: string } }>;
      };

      expect(snapshot.generation).toBe(1);
      expect(snapshot.objects).toEqual(expect.arrayContaining([
        expect.objectContaining({
          object_id: "la_object_backuprun0001",
          payload: expect.objectContaining({ kind: "ciphertext-inline" })
        })
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("advances the backup serial after an immutable partial-write failure so retry uses a new ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-backup-retry-"));
    const graphDir = join(root, "graph");
    const keyringPath = join(root, "keyring.json");
    const stagingDir = join(root, "staging");
    const master = randomBytes(32);
    try {
      const keyring = createDefaultLocalKeyring({ authorityId, createdAt: timestamp });
      await new FileLocalKeyringStore(keyringPath).write(keyring, "fixture-keyring-passphrase");
      const graph = await FileLocalGraphStore.open({
        directory: graphDir,
        authorityId,
        plaintextPersistence: "encrypt",
        keyring,
        now: () => timestamp
      });
      await graph.initializeFromObjects([], { created_at: timestamp });
      await graph.createObject({
        object: backupObject("la_object_backupretry0001"),
        expected_generation: 0,
        actor_id: fixtureLocalClientId,
        recorded_at: "2026-07-09T00:01:00.000Z"
      });
      await new LocalWormStore(stagingDir, () => 0).put(
        "la_backup_000001/snapshot.enc",
        Buffer.from("partial immutable artifact"),
        { retainUntilMs: 10_000 }
      );
      withBackupEnv({
        LIVING_ATLAS_BACKUP_STAGING_DIR: stagingDir,
        LIVING_ATLAS_BACKUP_RECOVERY_MASTER: master.toString("base64"),
        LIVING_ATLAS_LOCAL_KEYRING: keyringPath,
        LIVING_ATLAS_LOCAL_GRAPH_DIR: graphDir,
        LIVING_ATLAS_BACKUP_AUTHORITY_ID: authorityId,
        LIVING_ATLAS_BACKUP_FULL_EVERY_MS: "1"
      });

      await expect(runBackup(1_000)).resolves.toBe(1);
      await expect(runBackup(2_000)).resolves.toBe(0);
      const state = JSON.parse(await readFile(join(stagingDir, "backup-state.json"), "utf8")) as {
        serial: number;
        backups: Array<{ backup_id: string }>;
      };
      expect(state.serial).toBe(2);
      expect(state.backups).toEqual([{ backup_id: "la_backup_000002", kind: "full", created_at_ms: 2_000, locked_until_ms: expect.any(Number) }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
