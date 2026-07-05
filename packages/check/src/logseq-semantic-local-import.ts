import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  AuthorityIdSchema,
  type ObjectType
} from "@living-atlas/contracts";
import {
  createLogseqSemanticPlaintextGraphObjects,
  LogseqSemanticReviewResolutionMapSchema,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { FileLocalKeyringStore } from "@living-atlas/local-keyring";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const importAckValue = "write-encrypted-local-semantic-objects";
const updateExistingAckValue = "update-existing-encrypted-local-semantic-objects";
const ownerOnlyMode = 0o600;
const defaultMaxFileBytes = 256_000;
const defaultFileCount = 500;
const hardFileCountLimit = 5_000;

export type LogseqSemanticLocalImportScope = "all" | "edges-only";

export type LogseqSemanticLocalImportLedger = {
  record_schema: "living-atlas-logseq-semantic-local-import:v1";
  recorded_at: string;
  authority_id: string;
  source_root_ref: `sha256:${string}`;
  source_kind: "logseq" | "obsidian" | "generic-markdown";
  source_mode: "markdown-only" | "logseq-notes" | "logseq-extensionless-only";
  scope: LogseqSemanticLocalImportScope;
  file_count: number;
  object_totals: {
    planned_objects: number;
    selected_objects: number;
    created_objects: number;
    updated_existing_objects: number;
    already_existing_objects: number;
    failed_objects: number;
  };
  by_object_type: Record<string, number>;
  by_semantic_kind: Record<string, number>;
  graph_status: {
    generation: number;
    object_count: number;
    active_object_count: number;
    tombstone_count: number;
    plaintext_persistence: "redacted" | "encrypted" | "allowed";
  };
  sync: { attempted: false };
  plaintext_policy: "hash-counts-refs-only";
  object_refs: Array<{
    object_id: string;
    object_type: ObjectType;
    semantic_kind: string;
    import_status: "created" | "updated-existing" | "already-exists" | "failed";
  }>;
};

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function requireEnv(key: string): string {
  const value = envValue(key);
  if (!value) {
    throw new Error(`missing ${key}`);
  }
  return value;
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected integer in range ${min}-${max}`);
  }
  return parsed;
}

function parseScope(value: string | undefined): LogseqSemanticLocalImportScope {
  if (!value || value === "edges-only") {
    return "edges-only";
  }
  if (value === "all") {
    return "all";
  }
  throw new Error("LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_SCOPE must be all or edges-only");
}

function semanticKindFromNamespace(namespace: string | undefined): string {
  return namespace?.replace(/^import\/logseq-semantic\//, "") ?? "unknown";
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(path, ownerOnlyMode);
}

export async function importLogseqSemanticLocalObjects(input: {
  files: MarkdownFileInput[];
  sourceRootRef: `sha256:${string}`;
  sourceKind: "logseq" | "obsidian" | "generic-markdown";
  sourceMode: "markdown-only" | "logseq-notes" | "logseq-extensionless-only";
  pathRedactionSecret: string;
  localGraphDir: string;
  keyringPath: string;
  keyringPassphrase: string;
  authorityId?: string;
  reviewResolutionPath?: string;
  ledgerPath?: string;
  recordedAt?: string;
  scope?: LogseqSemanticLocalImportScope;
  updateExisting?: boolean;
}): Promise<LogseqSemanticLocalImportLedger> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const keyring = await new FileLocalKeyringStore(input.keyringPath).read(input.keyringPassphrase);
  const authorityId = AuthorityIdSchema.parse(input.authorityId ?? keyring.authority_id);
  if (keyring.authority_id !== authorityId) {
    throw new Error("semantic local import keyring authority mismatch");
  }
  const reviewResolutions = input.reviewResolutionPath
    ? LogseqSemanticReviewResolutionMapSchema.parse(JSON.parse(await readFile(input.reviewResolutionPath, "utf8"))).resolutions
    : undefined;
  const built = createLogseqSemanticPlaintextGraphObjects(input.files, {
    authority_id: authorityId,
    created_at: recordedAt,
    path_redaction_secret: input.pathRedactionSecret,
    review_resolutions: reviewResolutions
  });
  const scope = input.scope ?? "edges-only";
  const selected = scope === "all"
    ? built.objects
    : built.objects.filter((object) => object.object_type === "edge");
  const store = await FileLocalGraphStore.open({
    directory: input.localGraphDir,
    authorityId,
    plaintextPersistence: "encrypt",
    keyring
  });

  let createdObjects = 0;
  let updatedExistingObjects = 0;
  let alreadyExistingObjects = 0;
  let failedObjects = 0;
  const byObjectType: Record<string, number> = {};
  const bySemanticKind: Record<string, number> = {};
  const objectRefs: LogseqSemanticLocalImportLedger["object_refs"] = [];

  for (const object of selected) {
    increment(byObjectType, object.object_type);
    const semanticKind = semanticKindFromNamespace(object.visible_metadata.schema_namespace);
    increment(bySemanticKind, semanticKind);
    const existing = store.readObject(object.object_id);
    const draft = existing && input.updateExisting
      ? {
          ...object,
          version: existing.version + 1,
          created_at: existing.created_at,
          updated_at: recordedAt
        }
      : object;
    let importStatus: LogseqSemanticLocalImportLedger["object_refs"][number]["import_status"] = "created";

    if (existing && !input.updateExisting) {
      alreadyExistingObjects += 1;
      importStatus = "already-exists";
    } else if (existing && input.updateExisting) {
      const result = await store.updateObject({
        expected_generation: store.status().generation,
        expected_version: existing.version,
        actor_id: "logseq-semantic-local-import",
        operation_id: `la_operation_${digest(`semantic-local:${object.object_id}:update:${existing.version}`, 24)}`,
        trace_id: `la_trace_${digest(`semantic-local:${input.sourceRootRef}:${object.object_id}:update`, 24)}`,
        recorded_at: recordedAt,
        object: draft
      });
      if (result.ok) {
        updatedExistingObjects += 1;
        importStatus = "updated-existing";
      } else {
        failedObjects += 1;
        importStatus = "failed";
      }
    } else {
      const result = await store.createObject({
        expected_generation: store.status().generation,
        actor_id: "logseq-semantic-local-import",
        operation_id: `la_operation_${digest(`semantic-local:${object.object_id}:create`, 24)}`,
        trace_id: `la_trace_${digest(`semantic-local:${input.sourceRootRef}:${object.object_id}`, 24)}`,
        recorded_at: recordedAt,
        object: draft
      });
      if (result.ok) {
        createdObjects += 1;
      } else {
        failedObjects += 1;
        importStatus = "failed";
      }
    }

    objectRefs.push({
      object_id: object.object_id,
      object_type: object.object_type,
      semantic_kind: semanticKind,
      import_status: importStatus
    });
  }

  const graphStatus = store.status();
  await store.compact();
  const compactedStatus = store.status();
  const ledger: LogseqSemanticLocalImportLedger = {
    record_schema: "living-atlas-logseq-semantic-local-import:v1",
    recorded_at: recordedAt,
    authority_id: authorityId,
    source_root_ref: input.sourceRootRef,
    source_kind: input.sourceKind,
    source_mode: input.sourceMode,
    scope,
    file_count: input.files.length,
    object_totals: {
      planned_objects: built.objects.length,
      selected_objects: selected.length,
      created_objects: createdObjects,
      updated_existing_objects: updatedExistingObjects,
      already_existing_objects: alreadyExistingObjects,
      failed_objects: failedObjects
    },
    by_object_type: sortedRecord(byObjectType),
    by_semantic_kind: sortedRecord(bySemanticKind),
    graph_status: {
      generation: compactedStatus.generation,
      object_count: compactedStatus.object_count,
      active_object_count: compactedStatus.active_object_count,
      tombstone_count: graphStatus.tombstone_count,
      plaintext_persistence: compactedStatus.plaintext_persistence
    },
    sync: { attempted: false },
    plaintext_policy: "hash-counts-refs-only",
    object_refs: objectRefs
  };

  if (input.ledgerPath) {
    await writeJsonPrivate(input.ledgerPath, ledger);
  }
  return ledger;
}

async function readFilesFromRoot(input: {
  root: string;
  sourceKind: "logseq" | "obsidian" | "generic-markdown";
  sourceMode: "markdown-only" | "logseq-notes" | "logseq-extensionless-only";
  maxFiles: number;
  offset: number;
  maxFileBytes: number;
}): Promise<MarkdownFileInput[]> {
  const paths = await walkImportableSemanticSourceFiles({
    root: input.root,
    sourceKind: input.sourceKind,
    mode: input.sourceMode,
    maxFiles: input.maxFiles,
    offset: input.offset,
    maxFileBytes: input.maxFileBytes
  });
  return Promise.all(paths.map(async (path) => ({
    source_path: relative(input.root, path),
    source_kind: input.sourceKind,
    markdown: await readFile(path, "utf8")
  })));
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_ACK") !== importAckValue) {
    throw new Error(`set LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_ACK=${importAckValue}`);
  }
  const root = requireEnv("LIVING_ATLAS_REAL_MARKDOWN_ROOT");
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const fileCount = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_COUNT"), defaultFileCount, 1, hardFileCountLimit);
  const fileOffset = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_FILE_OFFSET"), 0, 0, 1_000_000);
  const maxFileBytes = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 10_000_000);
  const files = await readFilesFromRoot({
    root,
    sourceKind,
    sourceMode,
    maxFiles: fileCount,
    offset: fileOffset,
    maxFileBytes
  });
  const ledger = await importLogseqSemanticLocalObjects({
    files,
    sourceRootRef: sha256(root),
    sourceKind,
    sourceMode,
    pathRedactionSecret: requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET"),
    localGraphDir: requireEnv("LIVING_ATLAS_LOCAL_GRAPH_DIR"),
    keyringPath: requireEnv("LIVING_ATLAS_LOCAL_KEYRING"),
    keyringPassphrase: requireEnv("LIVING_ATLAS_LOCAL_KEYRING_PASSPHRASE"),
    authorityId: envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID"),
    reviewResolutionPath: envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_RESOLUTION_PATH"),
    ledgerPath: envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_LEDGER_PATH"),
    scope: parseScope(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_SCOPE")),
    updateExisting: envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_LOCAL_IMPORT_UPDATE_EXISTING_ACK") === updateExistingAckValue
  });
  const { object_refs: objectRefs, ...summary } = ledger;
  console.log(JSON.stringify({
    ...summary,
    object_ref_count: objectRefs.length
  }, null, 2));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
