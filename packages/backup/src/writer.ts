import { createHash } from "node:crypto";
import type { ImmutableStore } from "./immutable-store";
import { BackupManifestSchema, type BackupManifest } from "./manifest";

export type WriteBackupInput = {
  authority_id: string;
  kind: "full" | "differential";
  base_generation: number;
  target_generation: number;
  artifactBytes: Buffer;
  escrowEnvelopeJson?: string;
  recoveryBundleJson?: string;
  createdAtIso: string;
  backupId: string;
  retainUntilMs: number;
  parentBackupId?: string;
};

export type WriteBackupResult = { durable: boolean; errors: string[]; manifest: BackupManifest };

function sha256(b: Buffer): string {
  return createHash("sha256").update(b).digest("hex");
}

export async function writeBackup(
  stores: ImmutableStore[],
  input: WriteBackupInput,
): Promise<WriteBackupResult> {
  const artifactName = input.kind === "full" ? "snapshot.enc" : "differential.enc";
  if ((input.escrowEnvelopeJson === undefined) === (input.recoveryBundleJson === undefined)) {
    throw new Error("backup requires exactly one key recovery artifact");
  }
  const keyArtifactName = input.recoveryBundleJson === undefined ? "keyring.escrow.json" : "recovery-bundle.json";
  const keyArtifactBytes = Buffer.from(input.recoveryBundleJson ?? input.escrowEnvelopeJson!, "utf8");
  const manifest: BackupManifest = BackupManifestSchema.parse({
    backup_id: input.backupId,
    kind: input.kind,
    authority_id: input.authority_id,
    base_generation: input.base_generation,
    target_generation: input.target_generation,
    created_at: input.createdAtIso,
    parent_backup_id: input.parentBackupId,
    artifacts: [
      { name: artifactName, sha256: sha256(input.artifactBytes), bytes: input.artifactBytes.length },
      { name: keyArtifactName, sha256: sha256(keyArtifactBytes), bytes: keyArtifactBytes.length },
    ],
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const items: Array<[string, Buffer]> = [
    [`${input.backupId}/${artifactName}`, input.artifactBytes],
    [`${input.backupId}/${keyArtifactName}`, keyArtifactBytes],
    [`${input.backupId}/manifest.json`, manifestBytes],
  ];

  const errors: string[] = [];
  for (const store of stores) {
    for (const [key, data] of items) {
      try {
        await store.put(key, data, { retainUntilMs: input.retainUntilMs });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }
  return { durable: errors.length === 0, errors, manifest };
}
