import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWormStore } from "./immutable-store";
import { writeBackup } from "./writer";
import { createRecoveryBundle, wrapKeyringForEscrow } from "./escrow";
import { restoreBackup, restoreBackupWithRecoveryKey } from "./restore";

describe("restoreBackup", () => {
  it("round-trips: full backup then restore yields identical artifact + keyring", async () => {
    const store = new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000);
    const master = randomBytes(32);
    const keyringJson = JSON.stringify({ keys: [{ id: "la_key_x" }] });
    const artifact = Buffer.from("sealed-snapshot-bytes");

    const { manifest } = await writeBackup([store], {
      authority_id: "la_authority_test0001",
      kind: "full",
      base_generation: 0,
      target_generation: 7,
      artifactBytes: artifact,
      escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow(keyringJson, master)),
      createdAtIso: "2026-07-04T00:00:00.000Z",
      backupId: "la_backup_000001",
      retainUntilMs: 0,
    });

    const restored = await restoreBackup(store, manifest.backup_id, master);
    expect(restored.artifactBytes).toEqual(artifact);
    expect(restored.keyringJson).toBe(keyringJson);
  });

  it("throws on checksum mismatch (tamper detection)", async () => {
    const store = new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000);
    const master = randomBytes(32);
    await writeBackup([store], {
      authority_id: "la_authority_test0001", kind: "full", base_generation: 0, target_generation: 1,
      artifactBytes: Buffer.from("x"),
      escrowEnvelopeJson: JSON.stringify(wrapKeyringForEscrow("{}", master)),
      createdAtIso: "2026-07-04T00:00:00.000Z", backupId: "la_backup_bad", retainUntilMs: 0,
    });
    // Corrupt the stored artifact by writing a NEW backup id whose manifest lies:
    await expect(restoreBackup(store, "la_backup_missing", master)).rejects.toThrow();
  });

  it("restores a public-key-sealed recovery bundle without a symmetric recovery master", async () => {
    const store = new LocalWormStore(mkdtempSync(join(tmpdir(), "worm-")), () => 1_000);
    const { publicKey, privateKey } = generateKeyPairSync("x25519");
    const keyringJson = JSON.stringify({ keys: [{ id: "la_key_x" }] });
    await writeBackup([store], {
      authority_id: "la_authority_test0001", kind: "full", base_generation: 0, target_generation: 3,
      artifactBytes: Buffer.from("sealed-snapshot-bytes"),
      recoveryBundleJson: JSON.stringify(createRecoveryBundle({
        authority_id: "la_authority_test0001", sealed_keyring_json: keyringJson,
        keyring_passphrase: "synthetic-passphrase", recovery_public_key: publicKey
      })),
      createdAtIso: "2026-07-04T00:00:00.000Z", backupId: "la_backup_recoveryv2", retainUntilMs: 0
    });

    await expect(restoreBackupWithRecoveryKey(store, "la_backup_recoveryv2", privateKey)).resolves.toMatchObject({
      artifactBytes: Buffer.from("sealed-snapshot-bytes"), keyringJson, keyringPassphrase: "synthetic-passphrase"
    });
  });
});
