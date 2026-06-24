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

const packetAckValue = "write-local-private-topic-review-packet";
const defaultMaxFileBytes = 256_000;

const TopicCandidateReasonSchema = z.enum([
  "plain-tag-topic-review",
  "hash-tag-topic-review",
  "wikilink-tag-topic-review"
]);
type TopicCandidateReason = z.infer<typeof TopicCandidateReasonSchema>;

type TopicCandidate = {
  reason_code: TopicCandidateReason;
  value: string;
  source_path_ref: string;
};

type LogseqProperty = {
  key: string;
  value: string;
};

export const SemanticTopicReviewPacketSchema = z
  .object({
    packet_schema: z.literal("living-atlas-logseq-topic-review-packet:v1"),
    plaintext_policy: z.literal("local-private-topic-review-packet"),
    source_path_policy: z.literal("redacted"),
    generated_at: z.string(),
    source_mode: SemanticSourceModeSchema,
    covered_file_count: z.number().int().nonnegative(),
    candidate_count: z.number().int().nonnegative(),
    grouped_candidate_count: z.number().int().nonnegative(),
    excluded_suffix_tag_count: z.number().int().nonnegative(),
    reason_counts: z.record(z.string(), z.number().int().nonnegative()),
    groups: z.array(z.object({
      reason_code: TopicCandidateReasonSchema,
      target_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      target_value: z.string().min(1),
      occurrence_count: z.number().int().positive(),
      source_refs: z.array(z.string().regex(/^la_source_[a-f0-9]{24}$/))
    }))
  })
  .strict();
export type SemanticTopicReviewPacket = z.infer<typeof SemanticTopicReviewPacketSchema>;

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

function propertyValues(properties: LogseqProperty[], key: string): string[] {
  return properties
    .filter((property) => property.key === key)
    .map((property) => property.value.trim())
    .filter(Boolean);
}

function parseListValue(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part, index, values) => part.length > 0 && values.indexOf(part) === index);
}

function normalizeCandidateValue(value: string): string | undefined {
  const withoutHash = value.trim().replace(/^#/, "");
  const wikilink = /^\[\[([^\]\n]{1,256})\]\]$/.exec(withoutHash);
  const normalized = (wikilink?.[1] ?? withoutHash).split("|", 1)[0]?.split("#", 1)[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function isSuffixTag(value: string): boolean {
  return /\]\]-[A-Za-z0-9_-]{2,64}$/.test(value.trim());
}

function wikilinkTagTargets(value: string): Array<{ value: string; suffix?: string }> {
  return [...value.matchAll(/\[\[([^\]\n]{1,256})\]\](?:-([A-Za-z0-9_-]{2,64}))?/g)]
    .map((match) => ({
      value: match[1] ?? "",
      suffix: match[2]?.toLowerCase()
    }))
    .filter((target) => target.value.length > 0);
}

function isPlainTagCandidate(value: string): boolean {
  const normalized = value.trim().replace(/^#/, "");
  return /^[A-Za-z0-9][A-Za-z0-9_/-]{1,80}$/.test(normalized);
}

function hashTags(markdown: string): string[] {
  return [...markdown.matchAll(/(^|[\s([{])#([A-Za-z0-9_/-]{1,80})/gm)]
    .map((match) => match[2]!)
    .filter(Boolean);
}

function topicCandidatesForFile(file: MarkdownFileInput, pathRedactionSecret: string): {
  candidates: TopicCandidate[];
  excludedSuffixTagCount: number;
} {
  const source_path_ref = createMarkdownSourceRef(file.source_path.replaceAll("\\", "/"), { path_redaction_secret: pathRedactionSecret });
  const candidates: TopicCandidate[] = [];
  let excludedSuffixTagCount = 0;

  for (const hashTag of hashTags(file.markdown)) {
    const value = normalizeCandidateValue(hashTag);
    if (value) {
      candidates.push({ reason_code: "hash-tag-topic-review", value, source_path_ref });
    }
  }

  for (const tagProperty of propertyValues(extractPageProperties(file.markdown), "tags")) {
    for (const tagValue of parseListValue(tagProperty)) {
      const wikilinkTargets = wikilinkTagTargets(tagValue);
      if (wikilinkTargets.length > 0) {
        for (const target of wikilinkTargets) {
          if (target.suffix) {
            excludedSuffixTagCount += 1;
            continue;
          }
          const value = normalizeCandidateValue(`[[${target.value}]]`);
          if (value) {
            candidates.push({ reason_code: "wikilink-tag-topic-review", value, source_path_ref });
          }
        }
        continue;
      }
      if (isSuffixTag(tagValue)) {
        excludedSuffixTagCount += 1;
        continue;
      }
      const value = normalizeCandidateValue(tagValue);
      if (!value) {
        continue;
      }
      if (isPlainTagCandidate(tagValue)) {
        candidates.push({ reason_code: "plain-tag-topic-review", value, source_path_ref });
      }
    }
  }

  return { candidates, excludedSuffixTagCount };
}

export function buildSemanticTopicReviewPacket(input: {
  files: MarkdownFileInput[];
  pathRedactionSecret: string;
  sourceMode: SemanticSourceMode;
  generatedAt?: string;
}): SemanticTopicReviewPacket {
  const reasonCounts: Record<string, number> = {};
  const groups = new Map<string, SemanticTopicReviewPacket["groups"][number]>();
  let candidateCount = 0;
  let excludedSuffixTagCount = 0;

  for (const file of input.files) {
    const extracted = topicCandidatesForFile(file, input.pathRedactionSecret);
    excludedSuffixTagCount += extracted.excludedSuffixTagCount;
    for (const candidate of extracted.candidates) {
      candidateCount += 1;
      reasonCounts[candidate.reason_code] = (reasonCounts[candidate.reason_code] ?? 0) + 1;
      const targetHash = sha256(`topic-review:v1:${input.pathRedactionSecret}:${candidate.reason_code}:${candidate.value.toLowerCase()}`);
      const key = `${candidate.reason_code}:${targetHash}`;
      const existing = groups.get(key);
      if (existing) {
        existing.occurrence_count += 1;
        if (!existing.source_refs.includes(candidate.source_path_ref)) {
          existing.source_refs.push(candidate.source_path_ref);
        }
        continue;
      }
      groups.set(key, {
        reason_code: candidate.reason_code,
        target_hash: targetHash,
        target_value: candidate.value,
        occurrence_count: 1,
        source_refs: [candidate.source_path_ref]
      });
    }
  }

  return {
    packet_schema: "living-atlas-logseq-topic-review-packet:v1",
    plaintext_policy: "local-private-topic-review-packet",
    source_path_policy: "redacted",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source_mode: input.sourceMode,
    covered_file_count: input.files.length,
    candidate_count: candidateCount,
    grouped_candidate_count: groups.size,
    excluded_suffix_tag_count: excludedSuffixTagCount,
    reason_counts: Object.fromEntries(Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right))),
    groups: [...groups.values()]
      .map((group) => ({ ...group, source_refs: group.source_refs.sort() }))
      .sort((left, right) => right.occurrence_count - left.occurrence_count || left.reason_code.localeCompare(right.reason_code) || left.target_hash.localeCompare(right.target_hash))
  };
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("topic review packet output path must be outside the repository working directory");
  }
}

async function sourceFiles(input: {
  root: string;
  sourceKind: z.infer<typeof MarkdownImportSourceKindSchema>;
  sourceMode: SemanticSourceMode;
  maxFiles: number;
  maxFileBytes: number;
}): Promise<MarkdownFileInput[]> {
  const paths = await walkImportableSemanticSourceFiles({
    root: input.root,
    sourceKind: input.sourceKind,
    mode: input.sourceMode,
    maxFiles: input.maxFiles,
    offset: 0,
    maxFileBytes: input.maxFileBytes
  });
  return Promise.all(paths.map(async (path) => ({
    source_path: relative(input.root, path),
    markdown: await readFile(path, "utf8"),
    source_kind: input.sourceKind
  })));
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_ACK") !== packetAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_ACK must be ${packetAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH");
  assertOutputPathSafe(outputPath);
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const files = await sourceFiles({
    root: requireEnv("LIVING_ATLAS_REAL_MARKDOWN_ROOT"),
    sourceKind: MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq"),
    sourceMode,
    maxFiles: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_MAX_FILES"), 100_000, 1, 1_000_000),
    maxFileBytes: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 100_000_000)
  });
  const packet = buildSemanticTopicReviewPacket({
    files,
    pathRedactionSecret: requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET"),
    sourceMode
  });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    packet_schema: packet.packet_schema,
    plaintext_policy: packet.plaintext_policy,
    source_path_policy: packet.source_path_policy,
    source_mode: packet.source_mode,
    covered_file_count: packet.covered_file_count,
    candidate_count: packet.candidate_count,
    grouped_candidate_count: packet.grouped_candidate_count,
    excluded_suffix_tag_count: packet.excluded_suffix_tag_count,
    reason_counts: packet.reason_counts
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
