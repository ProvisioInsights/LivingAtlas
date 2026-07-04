import { describe, expect, it } from "vitest";
import { BackupManifestSchema, type BackupManifest } from "./manifest";

const base: BackupManifest = {
  backup_id: "la_backup_000001",
  kind: "full",
  authority_id: "la_authority_test0001",
  base_generation: 0,
  target_generation: 100,
  created_at: "2026-07-04T00:00:00.000Z",
  artifacts: [{ name: "snapshot.enc", sha256: "a".repeat(64), bytes: 1024 }],
  parent_backup_id: undefined,
};

describe("BackupManifestSchema", () => {
  it("accepts a valid full manifest", () => {
    expect(BackupManifestSchema.parse(base)).toMatchObject({ kind: "full" });
  });

  it("requires a parent_backup_id for differentials", () => {
    const diff = { ...base, kind: "differential" as const, parent_backup_id: undefined };
    expect(() => BackupManifestSchema.parse(diff)).toThrow();
  });

  it("rejects a non-64-char sha256", () => {
    const bad = { ...base, artifacts: [{ name: "x", sha256: "short", bytes: 1 }] };
    expect(() => BackupManifestSchema.parse(bad)).toThrow();
  });
});
