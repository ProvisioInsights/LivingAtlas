import { createHash } from "node:crypto";
import type { ImmutableStore } from "./immutable-store";
import { BackupManifestSchema } from "./manifest";
import { unwrapKeyringFromEscrow, type EscrowEnvelope } from "./escrow";

export type RestoreResult = { artifactBytes: Buffer; keyringJson: string };

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
  const artifactName = manifest.artifacts.find((a) => a.name !== "keyring.escrow.json")!.name;
  const artifactBytes = await store.get(`${backupId}/${artifactName}`);
  const escrowBytes = await store.get(`${backupId}/keyring.escrow.json`);

  for (const a of manifest.artifacts) {
    const bytes = a.name === "keyring.escrow.json" ? escrowBytes : artifactBytes;
    if (sha256(bytes) !== a.sha256) throw new Error(`checksum mismatch for ${a.name}`);
  }

  const env = JSON.parse(escrowBytes.toString("utf8")) as EscrowEnvelope;
  const keyringJson = unwrapKeyringFromEscrow(env, master);
  return { artifactBytes, keyringJson };
}
