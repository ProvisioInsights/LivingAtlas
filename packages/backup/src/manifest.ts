import { z } from "zod";

export const BackupArtifactSchema = z.object({
  name: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
});

export const BackupManifestSchema = z
  .object({
    backup_id: z.string().min(1),
    kind: z.enum(["full", "differential"]),
    authority_id: z.string().min(1),
    base_generation: z.number().int().nonnegative(),
    target_generation: z.number().int().nonnegative(),
    created_at: z.string().datetime(),
    artifacts: z.array(BackupArtifactSchema).min(1),
    parent_backup_id: z.string().min(1).optional(),
  })
  .refine((m) => m.kind === "full" || !!m.parent_backup_id, {
    message: "differential backups require parent_backup_id",
    path: ["parent_backup_id"],
  })
  .refine((m) => m.target_generation >= m.base_generation, {
    message: "target_generation must be >= base_generation",
    path: ["target_generation"],
  });

export type BackupArtifact = z.infer<typeof BackupArtifactSchema>;
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
