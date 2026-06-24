import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createMarkdownSourceRef,
  MarkdownImportSourceKindSchema,
  type MarkdownFileInput
} from "@living-atlas/importer";
import { z } from "zod";
import {
  SemanticSourceModeSchema,
  walkImportableSemanticSourceFiles,
  type SemanticSourceMode
} from "./logseq-semantic-source-files";

const packetAckValue = "write-local-private-review-packet";
const maxFileBytes = 256_000;

const EndpointTypeSchema = z.enum(["person", "organization", "project", "location", "occurrence", "topic"]);
type EndpointType = z.infer<typeof EndpointTypeSchema>;

const BatchRecordSchema = z.object({
  record_schema: z.literal("living-atlas-logseq-semantic-batch:v1"),
  source_kind: MarkdownImportSourceKindSchema.optional(),
  source_mode: SemanticSourceModeSchema.optional(),
  file_offset: z.number().int().nonnegative(),
  requested_file_count: z.number().int().positive(),
  actual_file_count: z.number().int().nonnegative(),
  files: z.array(z.object({
    source_path_ref: z.string(),
    review_status: z.enum(["not-required", "needs-review", "reviewed"])
  })).default([]),
  plaintext_policy: z.literal("hash-counts-refs-only")
}).passthrough();
type BatchRecord = z.infer<typeof BatchRecordSchema>;

type LogseqProperty = {
  key: string;
  value: string;
};

type ParsedReviewFile = {
  source_path_ref: string;
  page_title: string;
  page_properties: LogseqProperty[];
};

type EndpointIndexEntry = {
  type: EndpointType;
  title: string;
  aliases: string[];
  count: number;
};

type ReviewCandidate = {
  reason_code: string;
  value: string;
  suggested_endpoint_types: EndpointType[];
  property_key?: string;
  suffix?: string;
  source_path_ref: string;
};

export type SemanticReviewPacket = {
  packet_schema: "living-atlas-logseq-semantic-review-packet:v1";
  plaintext_policy: "local-private-review-packet";
  source_path_policy: "redacted";
  generated_at: string;
  source_modes: SemanticSourceMode[];
  covered_file_count: number;
  needs_review_file_count: number;
  candidate_count: number;
  grouped_candidate_count: number;
  reason_counts: Record<string, number>;
  groups: Array<{
    reason_code: string;
    suggested_endpoint_types: EndpointType[];
    target_hash: `sha256:${string}`;
    target_value: string;
    occurrence_count: number;
    property_keys: string[];
    suffixes: string[];
    source_refs: string[];
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

function parsePropertyLine(line: string): LogseqProperty | undefined {
  const match = /^\s*(?:[-*]\s+)?([A-Za-z0-9_-]{1,64})::\s*(.*?)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }
  return {
    key: match[1]!.toLowerCase(),
    value: match[2] ?? ""
  };
}

function extractPageProperties(markdown: string): LogseqProperty[] {
  const properties: LogseqProperty[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*[-*]\s+/.test(line) || /^#{1,6}\s+/.test(line)) {
      break;
    }
    const property = parsePropertyLine(line);
    if (property) {
      properties.push(property);
    }
  }
  return properties;
}

function propertyValue(properties: LogseqProperty[], key: string): string | undefined {
  return properties.find((property) => property.key === key)?.value.trim();
}

function propertyValues(properties: LogseqProperty[], key: string): string[] {
  return properties
    .filter((property) => property.key === key)
    .map((property) => property.value.trim())
    .filter((value) => value.length > 0);
}

function parseListValue(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part, index, values) => part.length > 0 && values.indexOf(part) === index);
}

function normalizeEndpointTitle(value: string | undefined): string | undefined {
  const normalized = value?.split("|", 1)[0]?.split("#", 1)[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseWikilinkTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const exact = /^\[\[([^\]\n]{1,256})\]\]$/.exec(normalized);
  return exact ? normalizeEndpointTitle(exact[1]) : undefined;
}

function parseAliasList(value: string | undefined): string[] {
  return parseListValue(value)
    .map((part) => parseWikilinkTitle(part) ?? normalizeEndpointTitle(part) ?? part.trim())
    .filter((part, index, aliases) => part.length > 0 && aliases.indexOf(part) === index);
}

function canonicalizeEndpointType(value: string | undefined): EndpointType | undefined {
  const normalized = value?.trim().toLowerCase();
  const canonical = EndpointTypeSchema.safeParse(normalized);
  if (canonical.success) {
    return canonical.data;
  }
  switch (normalized) {
    case "org":
    case "orgs":
    case "organisation":
    case "company":
      return "organization";
    case "place":
      return "location";
    case "event":
    case "meeting":
    case "appointment":
    case "social":
    case "work-session":
    case "travel":
    case "milestone":
    case "life-event":
    case "observation":
    case "transaction":
      return "occurrence";
    default:
      return undefined;
  }
}

function parsedReviewFile(input: MarkdownFileInput, pathRedactionSecret: string): ParsedReviewFile {
  const normalizedPath = input.source_path.replaceAll("\\", "/");
  const pageTitle = normalizedPath.split("/").at(-1)?.replace(/\.md$/i, "").trim() || "Untitled";
  return {
    source_path_ref: createMarkdownSourceRef(input.source_path, { path_redaction_secret: pathRedactionSecret }),
    page_title: pageTitle,
    page_properties: extractPageProperties(input.markdown)
  };
}

function endpointKey(type: EndpointType, value: string | undefined): string | undefined {
  const normalized = normalizeEndpointTitle(value)?.toLowerCase();
  return normalized ? `${type}:${normalized}` : undefined;
}

function addEndpointIndexEntry(index: Map<string, EndpointIndexEntry>, endpoint: EndpointIndexEntry, value: string | undefined): void {
  const key = endpointKey(endpoint.type, value);
  if (!key) {
    return;
  }
  const existing = index.get(key);
  if (!existing) {
    index.set(key, endpoint);
    return;
  }
  if (existing.title === endpoint.title) {
    return;
  }
  index.set(key, { ...existing, count: existing.count + 1 });
}

function buildEndpointIndex(files: ParsedReviewFile[]): Map<string, EndpointIndexEntry> {
  const index = new Map<string, EndpointIndexEntry>();
  for (const file of files) {
    const type = canonicalizeEndpointType(propertyValue(file.page_properties, "type"));
    if (!type) {
      continue;
    }
    const endpoint = {
      type,
      title: file.page_title,
      aliases: ["alias", "aliases"].flatMap((key) => propertyValues(file.page_properties, key).flatMap(parseAliasList)),
      count: 1
    };
    addEndpointIndexEntry(index, endpoint, endpoint.title);
    for (const alias of endpoint.aliases) {
      addEndpointIndexEntry(index, endpoint, alias);
    }
  }
  return index;
}

function resolvesToEndpoint(index: Map<string, EndpointIndexEntry>, targetTypes: EndpointType[], value: string): boolean {
  if (parseWikilinkTitle(value)) {
    return true;
  }
  return targetTypes.some((targetType) => {
    const key = endpointKey(targetType, value);
    const entry = key ? index.get(key) : undefined;
    return entry !== undefined && entry.count === 1;
  });
}

function nonWikilinkTargets(properties: LogseqProperty[], keys: string[], splitList: boolean): Array<{ key: string; value: string }> {
  const targets: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const rawValue of propertyValues(properties, key)) {
      const values = splitList ? parseListValue(rawValue) : [rawValue.trim()];
      for (const value of values) {
        if (!value || parseWikilinkTitle(value)) {
          continue;
        }
        const dedupeKey = `${key}:${value.toLowerCase()}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);
        targets.push({ key, value });
      }
    }
  }
  return targets;
}

function suffixReviewReason(suffix: string): string | undefined {
  if (suffix === "adjacent" || suffix === "orbit") {
    return "suffix-tag-weak-tie-needs-note";
  }
  if (suffix === "comparable" || suffix === "fundraise-comparable") {
    return "suffix-tag-comparable-attribute-review";
  }
  if (
    suffix === "fundraise-channel"
    || suffix === "vendor"
    || suffix === "portfolio"
    || suffix === "side-business-past"
    || suffix === "former-employer-parent"
    || suffix.startsWith("warm-intro-")
  ) {
    return "suffix-tag-direction-review";
  }
  return undefined;
}

function addNonWikilinkCandidates(input: {
  candidates: ReviewCandidate[];
  file: ParsedReviewFile;
  index: Map<string, EndpointIndexEntry>;
  keys: string[];
  reasonCode: string;
  targetTypes: EndpointType[];
  splitList?: boolean;
}): void {
  for (const target of nonWikilinkTargets(input.file.page_properties, input.keys, input.splitList ?? false)) {
    if (resolvesToEndpoint(input.index, input.targetTypes, target.value)) {
      continue;
    }
    input.candidates.push({
      reason_code: input.reasonCode,
      value: target.value,
      suggested_endpoint_types: input.targetTypes,
      property_key: target.key,
      source_path_ref: input.file.source_path_ref
    });
  }
}

function reviewCandidates(file: ParsedReviewFile, index: Map<string, EndpointIndexEntry>): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  const endpointType = canonicalizeEndpointType(propertyValue(file.page_properties, "type"));
  const add = (keys: string[], reasonCode: string, targetTypes: EndpointType[], splitList = false) => addNonWikilinkCandidates({
    candidates,
    file,
    index,
    keys,
    reasonCode,
    targetTypes,
    splitList
  });

  if (endpointType === "person") {
    add(["primary-location", "location", "based-in"], "non-wikilink-location-review", ["location"]);
    add(["org", "organization", "employer-current", "employer-historical"], "non-wikilink-organization-review", ["organization"], true);
    add(["spouse", "estranged-from"], "non-wikilink-person-review", ["person"]);
  } else if (endpointType === "organization") {
    add(["primary-location", "headquarters", "location", "based-in"], "non-wikilink-location-review", ["location"]);
    add(["acquired-by", "customer-of"], "non-wikilink-organization-review", ["organization"], true);
    for (const tagValue of propertyValues(file.page_properties, "tags")) {
      for (const match of tagValue.matchAll(/\[\[([^\]\n]{1,256})\]\]-([A-Za-z0-9][A-Za-z0-9-]{0,80})/g)) {
        const title = normalizeEndpointTitle(match[1]);
        const suffix = match[2]?.toLowerCase();
        const reasonCode = suffix ? suffixReviewReason(suffix) : undefined;
        if (!title || !suffix || !reasonCode) {
          continue;
        }
        candidates.push({
          reason_code: reasonCode,
          value: title,
          suggested_endpoint_types: suffix.includes("vendor") ? ["organization"] : ["person", "organization"],
          suffix,
          source_path_ref: file.source_path_ref
        });
      }
    }
  } else if (endpointType === "project") {
    add(["primary-location", "location"], "non-wikilink-location-review", ["location"]);
  } else if (endpointType === "occurrence") {
    add(["location"], "non-wikilink-location-review", ["location"]);
    add(["participants", "participant", "organizers", "organizer", "hosts", "host"], "non-wikilink-participant-review", ["person", "organization"], true);
    add(["projects", "project"], "non-wikilink-project-review", ["project"], true);
  } else if (endpointType === "location") {
    add(["parent-location", "located-in"], "non-wikilink-location-review", ["location"]);
  } else if (endpointType === "topic") {
    add(["parent-topic", "part-of-topic"], "non-wikilink-topic-review", ["topic"]);
  }

  return candidates;
}

function latestRecords(records: BatchRecord[]): BatchRecord[] {
  const byWindow = new Map<string, BatchRecord>();
  for (const record of records) {
    byWindow.set(`${record.source_kind ?? "logseq"}:${record.source_mode ?? "markdown-only"}:${record.file_offset}:${record.requested_file_count}`, record);
  }
  return [...byWindow.values()].sort((left, right) => left.file_offset - right.file_offset || left.requested_file_count - right.requested_file_count);
}

async function readRecords(path: string): Promise<BatchRecord[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => BatchRecordSchema.parse(JSON.parse(line)));
}

export function buildSemanticReviewPacket(input: {
  files: MarkdownFileInput[];
  records: BatchRecord[];
  pathRedactionSecret: string;
  generatedAt?: string;
}): SemanticReviewPacket {
  const latest = latestRecords(input.records);
  const reviewSourceRefs = new Set(latest.flatMap((record) =>
    record.files.filter((file) => file.review_status === "needs-review").map((file) => file.source_path_ref)
  ));
  const coveredSourceRefs = new Set(latest.flatMap((record) => record.files.map((file) => file.source_path_ref)));
  const parsedFiles = input.files
    .map((file) => parsedReviewFile(file, input.pathRedactionSecret))
    .filter((file) => coveredSourceRefs.has(file.source_path_ref));
  const index = buildEndpointIndex(parsedFiles);
  const candidates = parsedFiles
    .filter((file) => reviewSourceRefs.has(file.source_path_ref))
    .flatMap((file) => reviewCandidates(file, index));
  const reasonCounts: Record<string, number> = {};
  const groups = new Map<string, SemanticReviewPacket["groups"][number]>();

  for (const candidate of candidates) {
    reasonCounts[candidate.reason_code] = (reasonCounts[candidate.reason_code] ?? 0) + 1;
    const targetHash = sha256(`semantic-review-packet:v1:${input.pathRedactionSecret}:${candidate.reason_code}:${candidate.value.trim().toLowerCase()}`);
    const key = `${candidate.reason_code}:${targetHash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.occurrence_count += 1;
      for (const propertyKey of candidate.property_key ? [candidate.property_key] : []) {
        if (!existing.property_keys.includes(propertyKey)) {
          existing.property_keys.push(propertyKey);
        }
      }
      for (const suffix of candidate.suffix ? [candidate.suffix] : []) {
        if (!existing.suffixes.includes(suffix)) {
          existing.suffixes.push(suffix);
        }
      }
      if (!existing.source_refs.includes(candidate.source_path_ref)) {
        existing.source_refs.push(candidate.source_path_ref);
      }
      continue;
    }
    groups.set(key, {
      reason_code: candidate.reason_code,
      suggested_endpoint_types: candidate.suggested_endpoint_types,
      target_hash: targetHash,
      target_value: candidate.value,
      occurrence_count: 1,
      property_keys: candidate.property_key ? [candidate.property_key] : [],
      suffixes: candidate.suffix ? [candidate.suffix] : [],
      source_refs: [candidate.source_path_ref]
    });
  }

  return {
    packet_schema: "living-atlas-logseq-semantic-review-packet:v1",
    plaintext_policy: "local-private-review-packet",
    source_path_policy: "redacted",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source_modes: [...new Set(latest.map((record) => record.source_mode ?? "markdown-only"))].sort(),
    covered_file_count: coveredSourceRefs.size,
    needs_review_file_count: reviewSourceRefs.size,
    candidate_count: candidates.length,
    grouped_candidate_count: groups.size,
    reason_counts: Object.fromEntries(Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right))),
    groups: [...groups.values()]
      .map((group) => ({
        ...group,
        property_keys: group.property_keys.sort(),
        suffixes: group.suffixes.sort(),
        source_refs: group.source_refs.sort()
      }))
      .sort((left, right) => left.reason_code.localeCompare(right.reason_code) || right.occurrence_count - left.occurrence_count || left.target_hash.localeCompare(right.target_hash))
  };
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("review packet output path must be outside the repository working directory");
  }
}

async function sourceFilesForRecords(input: {
  root: string;
  records: BatchRecord[];
  pathRedactionSecret: string;
}): Promise<MarkdownFileInput[]> {
  const latest = latestRecords(input.records);
  const sourceKind = MarkdownImportSourceKindSchema.parse(latest[0]?.source_kind ?? envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(latest[0]?.source_mode ?? envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "markdown-only");
  const maxEnd = Math.max(0, ...latest.map((record) => record.file_offset + record.actual_file_count));
  const paths = await walkImportableSemanticSourceFiles({
    root: input.root,
    sourceKind,
    mode: sourceMode,
    maxFiles: maxEnd,
    offset: 0,
    maxFileBytes
  });
  return Promise.all(paths.map(async (path) => ({
    source_path: relative(input.root, path),
    markdown: await readFile(path, "utf8"),
    source_kind: sourceKind
  })));
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_PACKET_ACK") !== packetAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_PACKET_ACK must be ${packetAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_REVIEW_PACKET_PATH");
  assertOutputPathSafe(outputPath);
  const pathRedactionSecret = requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET");
  const records = await readRecords(requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_LEDGER_PATH"));
  const files = await sourceFilesForRecords({
    root: requireEnv("LIVING_ATLAS_REAL_MARKDOWN_ROOT"),
    records,
    pathRedactionSecret
  });
  const packet = buildSemanticReviewPacket({
    files,
    records,
    pathRedactionSecret
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    packet_schema: packet.packet_schema,
    output_path: outputPath,
    plaintext_policy: packet.plaintext_policy,
    covered_file_count: packet.covered_file_count,
    needs_review_file_count: packet.needs_review_file_count,
    candidate_count: packet.candidate_count,
    grouped_candidate_count: packet.grouped_candidate_count,
    reason_counts: packet.reason_counts
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
