import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  EndpointTypeSchema,
  type EndpointType
} from "@living-atlas/contracts";
import { MarkdownImportSourceKindSchema, type MarkdownImportSourceKind } from "@living-atlas/importer";
import {
  SemanticSourceModeSchema,
  type SemanticSourceMode,
  walkImportableSemanticSourceFiles
} from "./logseq-semantic-source-files";

const defaultMaxFiles = 100_000;
const defaultMaxFileBytes = 256_000;
const knownSchemaPropertyKeys = new Set([
  "alias",
  "aliases",
  "based-in",
  "date",
  "duration",
  "end",
  "end-date",
  "founded",
  "founded-year",
  "headquarters",
  "homepage",
  "host",
  "hosts",
  "location",
  "occurred-on",
  "occurred-until",
  "organizer",
  "organizers",
  "parent-location",
  "parent-topic",
  "participant",
  "participants",
  "part-of-topic",
  "primary-location",
  "project",
  "projects",
  "recurrence-set",
  "recurrence_set",
  "scheduled-end",
  "scheduled-start",
  "start",
  "start-date",
  "status",
  "subtype",
  "tags",
  "timezone",
  "type",
  "website"
]);
const dateLikePropertyKeys = new Set([
  "date",
  "end",
  "end-date",
  "founded",
  "founded-year",
  "occurred-on",
  "occurred-until",
  "scheduled-end",
  "scheduled-start",
  "start",
  "start-date"
]);

export type SemanticInventoryReport = {
  report_schema: "living-atlas-logseq-semantic-inventory-report:v1";
  root_ref: `sha256:${string}`;
  source_kind: MarkdownImportSourceKind;
  source_mode: SemanticSourceMode;
  source_path_policy: "redacted";
  plaintext_policy: "counts-known-keys-hashed-unknowns-only";
  file_count: number;
  totals: {
    bytes: number;
    lines: number;
    page_properties: number;
    known_property_keys: number;
    unknown_property_keys: number;
    accepted_endpoint_type_pages: number;
    rejected_endpoint_type_pages: number;
    wikilinks: number;
    hash_tags: number;
    block_refs: number;
    asset_refs: number;
    date_like_properties: number;
  };
  known_property_key_counts: Record<string, number>;
  unknown_property_key_hash_counts: Record<`sha256:${string}`, number>;
  endpoint_type_counts: Record<EndpointType, number>;
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

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function propertyLine(line: string): { key: string; value: string } | undefined {
  const match = /^\s*(?:[-*]\s+)?([A-Za-z0-9_-]{1,64})::\s*(.*?)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    key: match[1]!.toLowerCase(),
    value: match[2] ?? ""
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function emptyEndpointTypeCounts(): Record<EndpointType, number> {
  return {
    person: 0,
    organization: 0,
    project: 0,
    location: 0,
    occurrence: 0,
    topic: 0
  };
}

export async function buildSemanticInventoryReport(input: {
  root: string;
  pathRedactionSecret: string;
  sourceKind: MarkdownImportSourceKind;
  sourceMode: SemanticSourceMode;
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<SemanticInventoryReport> {
  const paths = await walkImportableSemanticSourceFiles({
    root: input.root,
    sourceKind: input.sourceKind,
    mode: input.sourceMode,
    maxFiles: input.maxFiles ?? defaultMaxFiles,
    offset: 0,
    maxFileBytes: input.maxFileBytes ?? defaultMaxFileBytes
  });
  const knownPropertyKeyCounts: Record<string, number> = {};
  const unknownPropertyKeyHashCounts: Record<`sha256:${string}`, number> = {};
  const endpointTypeCounts = emptyEndpointTypeCounts();
  const totals = {
    bytes: 0,
    lines: 0,
    page_properties: 0,
    known_property_keys: 0,
    unknown_property_keys: 0,
    accepted_endpoint_type_pages: 0,
    rejected_endpoint_type_pages: 0,
    wikilinks: 0,
    hash_tags: 0,
    block_refs: 0,
    asset_refs: 0,
    date_like_properties: 0
  };

  for (const path of paths) {
    const markdown = await readFile(path, "utf8");
    totals.bytes += Buffer.byteLength(markdown, "utf8");
    totals.lines += markdown.length === 0 ? 0 : markdown.split(/\r?\n/).length;
    totals.wikilinks += countMatches(markdown, /\[\[([^\]\n]{1,256})\]\]/g);
    totals.hash_tags += countMatches(markdown, /(^|[\s([{])#([A-Za-z0-9_/-]{1,80})/gm);
    totals.block_refs += countMatches(markdown, /\(\(([A-Za-z0-9_-]{3,128})\)\)/g);
    totals.asset_refs += countMatches(markdown, /(?:\]\(|\s)(?:\.\.?\/)?assets\/[^)\s]+/gi);

    for (const line of markdown.split(/\r?\n/)) {
      if (/^\s*[-*]\s+/.test(line) || /^#{1,6}\s+/.test(line)) {
        break;
      }
      const property = propertyLine(line);
      if (!property) {
        continue;
      }
      totals.page_properties += 1;
      if (knownSchemaPropertyKeys.has(property.key)) {
        totals.known_property_keys += 1;
        increment(knownPropertyKeyCounts, property.key);
      } else {
        totals.unknown_property_keys += 1;
        increment(unknownPropertyKeyHashCounts, sha256(`property-key:v1:${input.pathRedactionSecret}:${property.key}`));
      }
      if (dateLikePropertyKeys.has(property.key)) {
        totals.date_like_properties += 1;
      }
      if (property.key === "type") {
        const endpointType = EndpointTypeSchema.safeParse(property.value.toLowerCase());
        if (endpointType.success) {
          endpointTypeCounts[endpointType.data] += 1;
          totals.accepted_endpoint_type_pages += 1;
        } else {
          totals.rejected_endpoint_type_pages += 1;
        }
      }
    }
  }

  return {
    report_schema: "living-atlas-logseq-semantic-inventory-report:v1",
    root_ref: sha256(`semantic-root:v1:${input.pathRedactionSecret}:${input.root}`),
    source_kind: input.sourceKind,
    source_mode: input.sourceMode,
    source_path_policy: "redacted",
    plaintext_policy: "counts-known-keys-hashed-unknowns-only",
    file_count: paths.length,
    totals,
    known_property_key_counts: Object.fromEntries(Object.entries(knownPropertyKeyCounts).sort(([left], [right]) => left.localeCompare(right))),
    unknown_property_key_hash_counts: Object.fromEntries(Object.entries(unknownPropertyKeyHashCounts).sort(([left], [right]) => left.localeCompare(right))) as Record<`sha256:${string}`, number>,
    endpoint_type_counts: endpointTypeCounts
  };
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const pathRedactionSecret = requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const maxFiles = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_INVENTORY_MAX_FILES"), defaultMaxFiles, 1, 1_000_000);
  const maxFileBytes = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 100_000_000);
  const report = await buildSemanticInventoryReport({
    root,
    pathRedactionSecret,
    sourceKind,
    sourceMode,
    maxFiles,
    maxFileBytes
  });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error).replaceAll(process.cwd(), "<cwd>"));
    process.exitCode = 1;
  });
}
