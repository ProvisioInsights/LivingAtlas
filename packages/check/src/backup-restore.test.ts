import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRecoveryBundle, LocalWormStore, wrapKeyringForEscrow, writeBackup } from "@living-atlas/backup";
import { restoreRunner, restoreRunnerWithRecoveryKey } from "./backup-restore";

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

  it("rejects a differential backup because it cannot reconstruct a standalone replica", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-backup-restore-differential-"));
    const storeDir = join(root, "store");
    const outDir = join(root, "restored");
    const master = randomBytes(32);
    try {
      await writeBackup([new LocalWormStore(storeDir)], {
        authority_id: "la_authority_test0001",
        kind: "differential",
        base_generation: 3,
        target_generation: 4,
        artifactBytes: Buffer.from("differential-only-bytes"),
        escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow("{}", master)),
        createdAtIso: "2026-07-09T00:00:00.000Z",
        backupId: "la_backup_000002",
        retainUntilMs: 0,
        parentBackupId: "la_backup_000001"
      });

      await expect(restoreRunner({ backupId: "la_backup_000002", storeDir, outDir }, master))
        .rejects.toThrow(/full|differential/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a v2 bundle only after handing its passphrase to an explicit local sink", async () => {
    const root = await mkdtemp(join(tmpdir(), "living-atlas-backup-restore-v2-"));
    const storeDir = join(root, "store");
    const outDir = join(root, "restored");
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const artifact = Buffer.from(JSON.stringify({ schema_version: 1, authority_id: "la_authority_test0001", created_at: "2026-07-09T00:00:00.000Z", updated_at: "2026-07-09T00:00:00.000Z", generation: 3, journal_sequence: 3, plaintext_persistence: "encrypted", objects: [] }));
    try {
      await writeBackup([new LocalWormStore(storeDir)], {
        authority_id: "la_authority_test0001", kind: "full", base_generation: 0, target_generation: 3, artifactBytes: artifact,
        recoveryBundleJson: JSON.stringify(createRecoveryBundle({ authority_id: "la_authority_test0001", sealed_keyring_json: "{\"ciphertext_base64\":\"synthetic\"}", keyring_passphrase: "synthetic-passphrase", recovery_public_key: publicKey })),
        createdAtIso: "2026-07-09T00:00:00.000Z", backupId: "la_backup_v2restore", retainUntilMs: 0
      });
      const installed: string[] = [];
      await restoreRunnerWithRecoveryKey({ backupId: "la_backup_v2restore", storeDir, outDir }, privateKey, async (passphrase) => { installed.push(passphrase); });
      expect(installed).toEqual(["synthetic-passphrase"]);
      await expect(readFile(join(outDir, "graph", "snapshot.json"))).resolves.toEqual(artifact);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
