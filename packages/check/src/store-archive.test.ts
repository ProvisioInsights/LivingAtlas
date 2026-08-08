import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProjectionPlan,
  buildProjectionPlan,
  createLogseqBlockFixture,
  legacyFixtureAuthorityId,
  legacyFixturePayloadResolver,
  openDurableMigrationPlane
} from "@living-atlas/atlas-migrate";
import { openAtlasStore } from "@living-atlas/atlas-mcp";
import {
  StoreBackupManifestFileName,
  StoreBackupManifestSchema,
  StoreBackupPayloadDirName,
  backupStore,
  restoreStore
} from "./store-archive";

/**
 * A BACKUP THAT CANNOT BE PROVEN TO RESTORE IS A BACKUP NOBODY SHOULD TRUST.
 *
 * Every case here runs against a store the REAL durable plane actually wrote —
 * two segment logs and both sidecars — never a hand-assembled directory. The
 * round trip is proven three ways at once: byte-identity of every file, equality
 * of the manifest's identity markers, and — the one that matters — the restored
 * store OPENING through `openAtlasStore` and answering a read identically to the
 * original. Byte-identity is necessary but not sufficient; the store has to serve.
 *
 * The second half of the file is the half that earns the first: each guard is
 * shown FAILING on a specific mutation — a dropped sidecar, a single flipped byte,
 * a non-empty target, a missing manifest, a lying marker — because a verifier that
 * has only ever passed may be looking at nothing.
 */

const temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `la-store-archive-${prefix}-`));
  temps.push(dir);
  return dir;
}

/** A path under a temp root that does NOT yet exist — a fresh backup/restore target. */
function freshTarget(prefix: string): string {
  return join(tempDir(prefix), "out");
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A store the migration really wrote, from the block fixture (has both sidecars). */
async function populatedStore(): Promise<string> {
  const root = tempDir("src");
  const store = join(root, "store");
  const plane = openDurableMigrationPlane({ directory: store, authority_id: legacyFixtureAuthorityId });
  const plan = buildProjectionPlan(createLogseqBlockFixture(), {
    authority_id: legacyFixtureAuthorityId,
    resolve_payload: legacyFixturePayloadResolver
  });
  const result = await applyProjectionPlan({
    plan,
    actor_id: "la_user_backup01",
    registry: plane.registry,
    alias_ledger: plane.alias_ledger,
    sink: plane.sink,
    audit: plane.audit,
    now: () => "2026-08-06T10:00:00.000Z"
  });
  plane.close();
  if (!result.ok) throw new Error("fixture migration did not apply");
  return store;
}

function relativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(root, abs).split(sep).join(posix.sep));
    }
  };
  walk(root);
  return out.sort();
}

/** What the store answers to a read, in a form two stores can be compared by. */
function serveSnapshot(directory: string): unknown {
  const store = openAtlasStore({ directory, mode: "read-only" });
  try {
    const page = store.graph.assertions.query({ include_superseded: true });
    const hits = page.ok
      ? page.hits.map((hit) => ({
          assertion_id: hit.assertion.assertion_id,
          seq: hit.assertion.seq,
          predicate: hit.assertion.predicate,
          claim_digest: hit.assertion.claim_digest
        }))
      : { refusal: page.code };
    const entities = [...store.graph.searchableEntities()].map((entity) => entity.entity_id).sort();
    return { status: store.status(), hits, entities };
  } finally {
    store.close();
  }
}

describe("store backup round trip", () => {
  it("captures the whole store, including both sidecars", async () => {
    const source = await populatedStore();
    const backupDir = freshTarget("backup");

    const result = backupStore({
      store_directory: source,
      backup_directory: backupDir,
      authority_id: "la_authority_test"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const captured = new Set(relativeFiles(join(backupDir, StoreBackupPayloadDirName)));
    // The two logs and BOTH sidecars are present — a backup that silently dropped
    // the carried blocks or the audit trail is the failure this asserts against.
    expect(captured.has("provisional-blocks.jsonl")).toBe(true);
    expect(captured.has("migration-apply.jsonl")).toBe(true);
    expect([...captured].some((p) => p.startsWith("assertions/"))).toBe(true);
    expect([...captured].some((p) => p.startsWith("identity/"))).toBe(true);
    expect(result.artifact_count).toBe(captured.size);
  });

  it("restores a byte-identical store that opens and serves the same reads", async () => {
    const source = await populatedStore();
    const backupDir = freshTarget("backup");
    const restored = freshTarget("restore");

    const backup = backupStore({ store_directory: source, backup_directory: backupDir, authority_id: "la_authority_test" });
    expect(backup.ok).toBe(true);

    const restore = restoreStore({ backup_directory: backupDir, store_directory: restored });
    expect(restore.ok).toBe(true);
    if (!restore.ok) return;

    // 1. Byte-identity of every file.
    const sourceFiles = relativeFiles(source);
    expect(relativeFiles(restored)).toEqual(sourceFiles);
    for (const relPath of sourceFiles) {
      expect(readFileSync(join(restored, relPath))).toEqual(readFileSync(join(source, relPath)));
    }

    // 2. The identity markers the manifest recorded came back.
    if (backup.ok) expect(restore.store).toEqual(backup.store);

    // 3. The restored store OPENS and ANSWERS a read identically. This is the
    //    proof byte-identity alone cannot give: the store actually serves.
    expect(serveSnapshot(restored)).toEqual(serveSnapshot(source));
  });
});

describe("restore refuses a backup it cannot vouch for", () => {
  async function madeBackup(): Promise<{ backupDir: string; source: string }> {
    const source = await populatedStore();
    const backupDir = freshTarget("backup");
    const backup = backupStore({ store_directory: source, backup_directory: backupDir, authority_id: "la_authority_test" });
    expect(backup.ok).toBe(true);
    return { backupDir, source };
  }

  it("reports a dropped sidecar as artifact-missing", async () => {
    const { backupDir } = await madeBackup();
    rmSync(join(backupDir, StoreBackupPayloadDirName, "provisional-blocks.jsonl"));

    const restore = restoreStore({ backup_directory: backupDir, store_directory: freshTarget("restore") });
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.code).toBe("artifact-missing");
      expect(restore.path).toBe("provisional-blocks.jsonl");
    }
  });

  it("catches a single flipped byte with the manifest digest", async () => {
    const { backupDir } = await madeBackup();
    const victim = relativeFiles(join(backupDir, StoreBackupPayloadDirName)).find((p) => p.startsWith("assertions/"))!;
    const path = join(backupDir, StoreBackupPayloadDirName, victim);
    const bytes = readFileSync(path);
    bytes[0] = bytes[0]! ^ 0x01; // flip one bit of one byte
    writeFileSync(path, bytes);

    const restore = restoreStore({ backup_directory: backupDir, store_directory: freshTarget("restore") });
    expect(restore.ok).toBe(false);
    if (!restore.ok) {
      expect(restore.code).toBe("digest-mismatch");
      expect(restore.path).toBe(victim);
    }
  });

  it("refuses to restore into a non-empty target", async () => {
    const { backupDir } = await madeBackup();
    const target = freshTarget("restore");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "occupied.txt"), "not empty");

    const restore = restoreStore({ backup_directory: backupDir, store_directory: target });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.code).toBe("target-not-empty");

    // The occupant is untouched — restore never wrote a partial store over it.
    expect(readFileSync(join(target, "occupied.txt"), "utf8")).toBe("not empty");
  });

  it("treats a backup with no manifest as incomplete", async () => {
    const { backupDir } = await madeBackup();
    rmSync(join(backupDir, StoreBackupManifestFileName));

    const restore = restoreStore({ backup_directory: backupDir, store_directory: freshTarget("restore") });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.code).toBe("manifest-missing");
  });

  it("catches a manifest whose markers lie about the store, even when every digest matches", async () => {
    const { backupDir } = await madeBackup();
    const manifestPath = join(backupDir, StoreBackupManifestFileName);
    const manifest = StoreBackupManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
    // Change ONLY the recorded watermark. Every file — and therefore every
    // digest — is untouched, so only the re-derivation catches it.
    manifest.store.published_watermark = manifest.store.published_watermark + 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const restore = restoreStore({ backup_directory: backupDir, store_directory: freshTarget("restore") });
    expect(restore.ok).toBe(false);
    if (!restore.ok) expect(restore.code).toBe("store-metadata-mismatch");
  });

  it("leaves no partial store behind when it refuses", async () => {
    const { backupDir } = await madeBackup();
    rmSync(join(backupDir, StoreBackupPayloadDirName, "provisional-blocks.jsonl"));
    const target = freshTarget("restore");

    const restore = restoreStore({ backup_directory: backupDir, store_directory: target });
    expect(restore.ok).toBe(false);
    // The target was never created — a refusal is not a half-written store.
    expect(existsSync(target)).toBe(false);
  });
});

describe("backup refuses to run where it cannot produce a clean artifact", () => {
  it("refuses an absent store directory", () => {
    const result = backupStore({
      store_directory: join(tempDir("src"), "does-not-exist"),
      backup_directory: freshTarget("backup"),
      authority_id: "la_authority_test"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("store-directory-missing");
  });

  it("refuses a store missing the identity log", async () => {
    const source = await populatedStore();
    rmSync(join(source, "identity"), { recursive: true, force: true });

    const result = backupStore({ store_directory: source, backup_directory: freshTarget("backup"), authority_id: "la_authority_test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("store-incomplete-layout");
  });

  it("refuses a non-empty backup directory", async () => {
    const source = await populatedStore();
    const backupDir = freshTarget("backup");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "leftover"), "old backup");

    const result = backupStore({ store_directory: source, backup_directory: backupDir, authority_id: "la_authority_test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("backup-target-not-empty");
  });

  it("writes a content-free manifest: paths, counts and digests only", async () => {
    const source = await populatedStore();
    const backupDir = freshTarget("backup");
    backupStore({ store_directory: source, backup_directory: backupDir, authority_id: "la_authority_test" });

    const manifestText = readFileSync(join(backupDir, StoreBackupManifestFileName), "utf8");
    const manifest = StoreBackupManifestSchema.parse(JSON.parse(manifestText));

    // The manifest's digests are honest — recompute one and check it matches.
    const first = manifest.artifacts[0]!;
    const bytes = readFileSync(join(backupDir, StoreBackupPayloadDirName, first.path));
    expect(first.sha256).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);

    // Every artifact key is one of the four allowed, content-free keys.
    for (const artifact of manifest.artifacts) {
      expect(Object.keys(artifact).sort()).toEqual(["bytes", "path", "sha256"]);
    }
  });
});
