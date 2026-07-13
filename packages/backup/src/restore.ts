import { createHash, type KeyObject } from "node:crypto";
import type { ImmutableStore } from "./immutable-store";
import { BackupManifestSchema } from "./manifest";
import { openRecoveryBundle, unwrapKeyringFromEscrow, type EscrowEnvelope, type RecoveryBundleV2 } from "./escrow";

export type RestoreResult = {
  kind: "full" | "differential";
  artifactBytes: Buffer;
  keyringJson: string;
};

export type RecoveryRestoreResult = RestoreResult & { keyringPassphrase: string };

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function restoreBackup(
  store: ImmutableStore,
  backupId: string,
  master: Buffer,
): Promise<RestoreResult> {
  const manifest = BackupManifestSchema.parse(
    JSON.parse((await store.get(`${backupId}/manifest.json`)).toString("utf8")),
  );
  const artifactName = manifest.artifacts.find((a) => a.name.endsWith(".enc"))!.name;
  const artifactBytes = await store.get(`${backupId}/${artifactName}`);
  const escrowBytes = await store.get(`${backupId}/keyring.escrow.json`);

  for (const a of manifest.artifacts) {
    const bytes = a.name === "keyring.escrow.json" ? escrowBytes : artifactBytes;
    if (sha256(bytes) !== a.sha256) throw new Error(`checksum mismatch for ${a.name}`);
  }

  const env = JSON.parse(escrowBytes.toString("utf8")) as EscrowEnvelope;
  const keyringJson = unwrapKeyringFromEscrow(env, master);
  return { kind: manifest.kind, artifactBytes, keyringJson };
}

export async function restoreBackupWithRecoveryKey(store: ImmutableStore, backupId: string, recoveryPrivateKey: KeyObject): Promise<RecoveryRestoreResult> {
  const manifest = BackupManifestSchema.parse(JSON.parse((await store.get(`${backupId}/manifest.json`)).toString("utf8")));
  const artifact = manifest.artifacts.find((item) => item.name.endsWith(".enc"));
  const bundleArtifact = manifest.artifacts.find((item) => item.name === "recovery-bundle.json");
  if (!artifact || !bundleArtifact) throw new Error("recovery-bundle-missing");
  const [artifactBytes, bundleBytes] = await Promise.all([store.get(`${backupId}/${artifact.name}`), store.get(`${backupId}/recovery-bundle.json`)]);
  if (sha256(artifactBytes) !== artifact.sha256 || sha256(bundleBytes) !== bundleArtifact.sha256) throw new Error("checksum mismatch for recovery bundle");
  const recovered = openRecoveryBundle(JSON.parse(bundleBytes.toString("utf8")) as RecoveryBundleV2, recoveryPrivateKey);
  if (recovered.authority_id !== manifest.authority_id) throw new Error("recovery-bundle-authority-mismatch");
  return { kind: manifest.kind, artifactBytes, keyringJson: recovered.sealed_keyring_json, keyringPassphrase: recovered.keyring_passphrase };
}
