import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalWormStore, wrapKeyringForEscrow, writeBackup } from "@living-atlas/backup";
import { restoreRunner } from "./backup-restore";

describe("backup restore runner", () => {
  it("restores a verified backup into a separate local replica layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-backup-restore-runner-"));
    const storeDir = join(root, "store");
    const outDir = join(root, "restored");
    const master = randomBytes(32);
    const artifact = Buffer.from(JSON.stringify({
      schema_version: 1,
      authority_id: "la_authority_test0001",
      created_at: "2026-07-09T00:00:00.000Z",
      updated_at: "2026-07-09T00:00:00.000Z",
      generation: 3,
      journal_sequence: 3,
      plaintext_persistence: "encrypted",
      objects: []
    }));
    const keyringJson = JSON.stringify({ ciphertext_base64: "synthetic-sealed-keyring" });
    try {
      await writeBackup([new LocalWormStore(storeDir)], {
        authority_id: "la_authority_test0001",
        kind: "full",
        base_generation: 0,
        target_generation: 3,
        artifactBytes: artifact,
        escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow(keyringJson, master)),
        createdAtIso: "2026-07-09T00:00:00.000Z",
        backupId: "la_backup_000001",
        retainUntilMs: 0
      });

      await restoreRunner({ backupId: "la_backup_000001", storeDir, outDir }, master);

      await expect(readFile(join(outDir, "graph", "snapshot.json"))).resolves.toEqual(artifact);
      await expect(readFile(join(outDir, "graph", "journal.jsonl"), "utf8")).resolves.toBe("");
      await expect(readFile(join(outDir, "keyring.json"), "utf8")).resolves.toBe(keyringJson);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
