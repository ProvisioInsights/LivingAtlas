import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createCanonicalMarkdownMigration, createCanonicalMarkdownMigrationExport, type MarkdownImportSourceKind, type MarkdownSourceMode } from "@living-atlas/importer";
import { fixtureLocalClientId } from "@living-atlas/fixtures";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { createDefaultLocalKeyring, FileLocalKeyringStore } from "@living-atlas/local-keyring";
import { createLocalCanonicalAtlasClient } from "@living-atlas/atlas-client";
import { walkImportableSemanticSourceFiles } from "./logseq-semantic-source-files";

export const canonicalIsolatedCopyAcknowledgement = "run-canonical-isolated-copy";

export type CanonicalIsolatedCopyRun = {
  copy_dir: string;
  source_dir: string;
  acknowledgement: string;
  live_paths: string[];
};

export function validateCanonicalIsolatedCopyRun(input: CanonicalIsolatedCopyRun): Pick<CanonicalIsolatedCopyRun, "copy_dir" | "source_dir"> {
  if (input.acknowledgement !== canonicalIsolatedCopyAcknowledgement) {
    throw new Error("canonical isolated-copy acknowledgement is required");
  }
  const copyDir = resolve(input.copy_dir);
  const sourceDir = resolve(input.source_dir);
  if (basename(copyDir) !== ".atlas-isolated-copy") {
    throw new Error("canonical isolated-copy output requires the .atlas-isolated-copy marker");
  }
  if (pathsOverlap(copyDir, sourceDir)) {
    throw new Error("canonical isolated-copy source and output paths must not overlap");
  }
  for (const livePath of input.live_paths.map((path) => resolve(path))) {
    if (isWithin(copyDir, livePath) || isWithin(sourceDir, livePath)) {
      throw new Error("canonical isolated-copy path is a configured live path");
    }
  }
  return { copy_dir: copyDir, source_dir: sourceDir };
}

export async function runCanonicalIsolatedCopy(input: CanonicalIsolatedCopyRun & {
  authority_id: string;
  keyring_passphrase: string;
  source_kind: MarkdownImportSourceKind;
  source_mode: MarkdownSourceMode;
}): Promise<{ source_file_count: number; canonical_object_count: number; generation: number }> {
  const paths = validateCanonicalIsolatedCopyRun(input);
  await mkdir(paths.copy_dir, { recursive: true, mode: 0o700 });
  if ((await readdir(paths.copy_dir)).length > 0) throw new Error("canonical isolated-copy output must be empty");
  const sourcePaths = await walkImportableSemanticSourceFiles({ root: paths.source_dir, sourceKind: input.source_kind, mode: input.source_mode, maxFiles: 100_000, offset: 0, maxFileBytes: 16 * 1024 * 1024 });
  const files = await Promise.all(sourcePaths.map(async (path) => ({
    source_path: relative(paths.source_dir, path),
    markdown: await readFile(path, "utf8"),
    source_kind: input.source_kind
  })));
  const migration = createCanonicalMarkdownMigration(files, { authority_id: input.authority_id, path_redaction_secret: input.keyring_passphrase });
  const exported = createCanonicalMarkdownMigrationExport(migration);
  const keyring = createDefaultLocalKeyring({ authorityId: input.authority_id, createdAt: migration.created_at });
  await new FileLocalKeyringStore(join(paths.copy_dir, "keyring.json")).write(keyring, input.keyring_passphrase);
  const store = await FileLocalGraphStore.open({ directory: join(paths.copy_dir, "graph"), authorityId: input.authority_id, plaintextPersistence: "encrypt", keyring });
  const client = createLocalCanonicalAtlasClient({ graphStore: store, decryptPayload: async () => undefined, now: migration.created_at });
  const result = await client.importCanonical({ exported, expected_generation: 0, actor_id: fixtureLocalClientId, operation_id: "la_operation_isolatedcopy0001", idempotency_key: "la_idem_isolatedcopy0001", recorded_at: migration.created_at });
  if (!result.ok) throw new Error(`canonical isolated-copy import failed: ${result.reason}`);
  return { source_file_count: files.length, canonical_object_count: result.objects.length, generation: result.generation };
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(path: string, parent: string): boolean {
  const pathRelativeToParent = relative(parent, path);
  return pathRelativeToParent === "" || (!pathRelativeToParent.startsWith("..") && !pathRelativeToParent.startsWith("../"));
}
