import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createMarkdownSourceRef } from "@living-atlas/importer";

const defaultMaxFileBytes = 256_000;

export const SemanticManifestEntrySchema = z.object({
  ordinal: z.number().int().nonnegative(),
  source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
  source_kind: z.enum(["logseq", "obsidian", "generic-markdown"]),
  discovery_status: z.enum(["readable", "empty", "oversized", "unreadable", "ignored-extension"]),
  terminal_decision: z.enum(["pending", "migrated", "skipped", "quarantined"]),
  reason_code: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/),
  byte_size: z.number().int().nonnegative().optional(),
  line_count: z.number().int().nonnegative().optional(),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
}).strict();
export type SemanticManifestEntry = z.infer<typeof SemanticManifestEntrySchema>;

export const SemanticManifestSchema = z.object({
  manifest_schema: z.literal("living-atlas-logseq-semantic-corpus-manifest:v1"),
  manifest_id: z.string().regex(/^la_semantic_manifest_[a-f0-9]{24}$/),
  created_at: z.string(),
  root_ref: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_path_policy: z.literal("redacted"),
  plaintext_policy: z.literal("hash-counts-refs-only"),
  total_entries: z.number().int().nonnegative(),
  entries: z.array(SemanticManifestEntrySchema),
  ordered_manifest_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/)
}).strict();
export type SemanticManifest = z.infer<typeof SemanticManifestSchema>;

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

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function keyedRef(secret: string, label: string, value: string): `sha256:${string}` {
  return sha256(`${label}:v1:${secret}:${value}`);
}

function parseInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected integer from ${min} to ${max}, got ${value}`);
  }
  return parsed;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  const ignored = new Set([".git", "node_modules", "dist", "build", ".wrangler", ".terraform"]);
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          queue.push(path);
        }
        continue;
      }
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  return files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
}

export async function createSemanticCorpusManifest(input: {
  root: string;
  pathRedactionSecret: string;
  sourceKind: "logseq" | "obsidian" | "generic-markdown";
  maxFileBytes?: number;
  now?: string;
}): Promise<SemanticManifest> {
  const maxFileBytes = input.maxFileBytes ?? defaultMaxFileBytes;
  const entries: SemanticManifestEntry[] = [];
  const paths = await walkFiles(input.root);

  for (const path of paths) {
    const sourcePath = relative(input.root, path);
    const sourcePathRef = createMarkdownSourceRef(sourcePath, { path_redaction_secret: input.pathRedactionSecret });
    const info = await stat(path).catch(() => undefined);
    if (!info) {
      entries.push(SemanticManifestEntrySchema.parse({
        ordinal: entries.length,
        source_path_ref: sourcePathRef,
        source_kind: input.sourceKind,
        discovery_status: "unreadable",
        terminal_decision: "quarantined",
        reason_code: "unreadable"
      }));
      continue;
    }

    if (!path.toLowerCase().endsWith(".md")) {
      entries.push(SemanticManifestEntrySchema.parse({
        ordinal: entries.length,
        source_path_ref: sourcePathRef,
        source_kind: input.sourceKind,
        discovery_status: "ignored-extension",
        terminal_decision: "skipped",
        reason_code: "ignored-extension",
        byte_size: info.size
      }));
      continue;
    }

    if (info.size === 0) {
      entries.push(SemanticManifestEntrySchema.parse({
        ordinal: entries.length,
        source_path_ref: sourcePathRef,
        source_kind: input.sourceKind,
        discovery_status: "empty",
        terminal_decision: "skipped",
        reason_code: "empty-file",
        byte_size: 0,
        line_count: 0,
        content_hash: sha256("")
      }));
      continue;
    }

    const content = await readFile(path).catch(() => undefined);
    if (!content) {
      entries.push(SemanticManifestEntrySchema.parse({
        ordinal: entries.length,
        source_path_ref: sourcePathRef,
        source_kind: input.sourceKind,
        discovery_status: "unreadable",
        terminal_decision: "quarantined",
        reason_code: "unreadable",
        byte_size: info.size
      }));
      continue;
    }

    entries.push(SemanticManifestEntrySchema.parse({
      ordinal: entries.length,
      source_path_ref: sourcePathRef,
      source_kind: input.sourceKind,
      discovery_status: info.size > maxFileBytes ? "oversized" : "readable",
      terminal_decision: info.size > maxFileBytes ? "quarantined" : "pending",
      reason_code: info.size > maxFileBytes ? "oversized" : "ready",
      byte_size: info.size,
      line_count: content.toString("utf8").split(/\r?\n/).length,
      content_hash: sha256(content)
    }));
  }

  const rootRef = keyedRef(input.pathRedactionSecret, "semantic-root", input.root);
  const orderedManifestHash = sha256(JSON.stringify(entries.map((entry) => ({
    ordinal: entry.ordinal,
    source_path_ref: entry.source_path_ref,
    discovery_status: entry.discovery_status,
    terminal_decision: entry.terminal_decision,
    reason_code: entry.reason_code,
    byte_size: entry.byte_size,
    content_hash: entry.content_hash
  }))));
  return SemanticManifestSchema.parse({
    manifest_schema: "living-atlas-logseq-semantic-corpus-manifest:v1",
    manifest_id: `la_semantic_manifest_${digest(`${rootRef}:${orderedManifestHash}`)}`,
    created_at: input.now ?? new Date().toISOString(),
    root_ref: rootRef,
    source_path_policy: "redacted",
    plaintext_policy: "hash-counts-refs-only",
    total_entries: entries.length,
    entries,
    ordered_manifest_hash: orderedManifestHash
  });
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const pathRedactionSecret = requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const sourceKind = z.enum(["logseq", "obsidian", "generic-markdown"]).parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const maxFileBytes = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 100_000_000);
  const manifest = await createSemanticCorpusManifest({
    root,
    pathRedactionSecret,
    sourceKind,
    maxFileBytes
  });
  const outputPath = envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MANIFEST_PATH");
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify({
    report_schema: "living-atlas-logseq-semantic-manifest-report:v1",
    manifest_id: manifest.manifest_id,
    root_ref: manifest.root_ref,
    ordered_manifest_hash: manifest.ordered_manifest_hash,
    total_entries: manifest.total_entries,
    readable: manifest.entries.filter((entry) => entry.discovery_status === "readable").length,
    skipped: manifest.entries.filter((entry) => entry.terminal_decision === "skipped").length,
    quarantined: manifest.entries.filter((entry) => entry.terminal_decision === "quarantined").length,
    pending: manifest.entries.filter((entry) => entry.terminal_decision === "pending").length,
    manifest_written: Boolean(outputPath)
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error).replaceAll(process.cwd(), "<cwd>"));
    process.exitCode = 1;
  });
}
