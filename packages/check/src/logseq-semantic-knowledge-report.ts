import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLogseqSemanticKnowledgeSummary,
  LogseqSemanticReviewResolutionMapSchema,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const defaultMaxFiles = 100_000;
const defaultMaxFileBytes = 256_000;

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

async function main(): Promise<void> {
  const root = requireEnv("LIVING_ATLAS_REAL_MARKDOWN_ROOT");
  const pathRedactionSecret = requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const maxFiles = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_KNOWLEDGE_MAX_FILES"), defaultMaxFiles, 1, 1_000_000);
  const maxFileBytes = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 100_000_000);
  const reviewResolutionPath = envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_RESOLUTION_PATH");
  const reviewResolutions = reviewResolutionPath
    ? LogseqSemanticReviewResolutionMapSchema.parse(JSON.parse(await readFile(reviewResolutionPath, "utf8"))).resolutions
    : undefined;

  const paths = await walkImportableSemanticSourceFiles({
    root,
    sourceKind,
    mode: sourceMode,
    maxFiles,
    offset: 0,
    maxFileBytes
  });
  const files: MarkdownFileInput[] = [];
  for (const path of paths) {
    files.push({
      source_path: relative(root, path),
      markdown: await readFile(path, "utf8"),
      source_kind: sourceKind
    });
  }

  const report = createLogseqSemanticKnowledgeSummary(files, {
    authority_id: envValue("LIVING_ATLAS_LIVE_AUTHORITY_ID") ?? "la_authority_logseqsemantic0001",
    path_redaction_secret: pathRedactionSecret,
    review_resolutions: reviewResolutions
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error).replaceAll(process.cwd(), "<cwd>"));
    process.exitCode = 1;
  });
}
