import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TopicSubtypeSchema } from "@living-atlas/contracts";
import { z } from "zod";
import {
  SemanticTopicReviewPacketSchema
} from "./logseq-semantic-topic-review-packet";
import {
  TopicReviewResolutionMapSchema,
  type TopicReviewResolutionMap
} from "./logseq-semantic-topic-review-report";

const curatedDraftAckValue = "write-local-private-topic-review-curated-draft";
const ownerOnlyMode = 0o600;

const TopicPromotionReasonSchema = z.enum([
  "wikilink-tag-topic-review",
  "plain-tag-topic-review",
  "hash-tag-topic-review"
]);

export type TopicReviewCuratedDraftReport = {
  report_schema: "living-atlas-logseq-topic-review-curated-draft-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  output_written: boolean;
  policy: {
    min_occurrences: number;
    promote_reasons: string[];
    subtype: z.infer<typeof TopicSubtypeSchema>;
  };
  packet: {
    covered_file_count: number;
    candidate_count: number;
    grouped_candidate_count: number;
    excluded_suffix_tag_count: number;
  };
  draft: {
    resolution_count: number;
    promote_topic_count: number;
    defer_count: number;
    reject_count: number;
    by_reason_code: Record<string, number>;
    promoted_by_reason_code: Record<string, number>;
    deferred_by_reason_code: Record<string, number>;
    promoted_by_occurrence_bucket: Record<string, number>;
    deferred_by_occurrence_bucket: Record<string, number>;
  };
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

function parsePromoteReasons(value: string | undefined): Set<z.infer<typeof TopicPromotionReasonSchema>> {
  const reasons = value
    ? value.split(",").map((entry) => entry.trim()).filter(Boolean)
    : ["wikilink-tag-topic-review"];
  return new Set(reasons.map((reason) => TopicPromotionReasonSchema.parse(reason)));
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("topic review curated draft output path must be outside the repository working directory");
  }
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function occurrenceBucket(count: number): string {
  if (count === 1) return "1";
  if (count <= 3) return "2-3";
  if (count <= 10) return "4-10";
  return "11+";
}

function cleanTopicTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function canPromoteTopicTitle(value: string): boolean {
  const cleaned = cleanTopicTitle(value);
  return cleaned.length > 0
    && cleaned.length <= 256
    && !/^#/.test(cleaned)
    && !/[\r\n]/.test(cleaned);
}

export function buildTopicReviewCuratedDraft(input: {
  packet: ReturnType<typeof SemanticTopicReviewPacketSchema.parse>;
  generatedAt?: string;
  minOccurrences?: number;
  promoteReasons?: Set<z.infer<typeof TopicPromotionReasonSchema>>;
  subtype?: z.infer<typeof TopicSubtypeSchema>;
}): TopicReviewResolutionMap {
  const minOccurrences = input.minOccurrences ?? 2;
  const promoteReasons = input.promoteReasons ?? new Set<z.infer<typeof TopicPromotionReasonSchema>>(["wikilink-tag-topic-review"]);
  const subtype = input.subtype ?? "theme";

  return TopicReviewResolutionMapSchema.parse({
    resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
    plaintext_policy: "local-private-topic-review-resolution-map",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    resolutions: input.packet.groups.map((group) => {
      const promote = promoteReasons.has(group.reason_code)
        && group.occurrence_count >= minOccurrences
        && canPromoteTopicTitle(group.target_value);
      if (!promote) {
        return {
          target_hash: group.target_hash,
          reason_code: group.reason_code,
          decision: "defer",
          confidence: "high" as const
        };
      }
      return {
        target_hash: group.target_hash,
        reason_code: group.reason_code,
        decision: "promote-topic",
        topic_title: cleanTopicTitle(group.target_value),
        subtype,
        aliases: [],
        confidence: "high" as const
      };
    })
  });
}

export function buildTopicReviewCuratedDraftReport(input: {
  packet: ReturnType<typeof SemanticTopicReviewPacketSchema.parse>;
  draft: TopicReviewResolutionMap;
  outputWritten: boolean;
  minOccurrences: number;
  promoteReasons: Set<z.infer<typeof TopicPromotionReasonSchema>>;
  subtype: z.infer<typeof TopicSubtypeSchema>;
}): TopicReviewCuratedDraftReport {
  const byReasonCode: Record<string, number> = {};
  const promotedByReasonCode: Record<string, number> = {};
  const deferredByReasonCode: Record<string, number> = {};
  const promotedByOccurrenceBucket: Record<string, number> = {};
  const deferredByOccurrenceBucket: Record<string, number> = {};
  const packetGroupByKey = new Map(input.packet.groups.map((group) => [`${group.reason_code}:${group.target_hash}`, group]));
  let promoteTopicCount = 0;
  let deferCount = 0;
  let rejectCount = 0;

  for (const resolution of input.draft.resolutions) {
    increment(byReasonCode, resolution.reason_code);
    const group = packetGroupByKey.get(`${resolution.reason_code}:${resolution.target_hash}`);
    const bucket = group ? occurrenceBucket(group.occurrence_count) : "unknown";
    if (resolution.decision === "promote-topic") {
      promoteTopicCount += 1;
      increment(promotedByReasonCode, resolution.reason_code);
      increment(promotedByOccurrenceBucket, bucket);
    } else if (resolution.decision === "defer") {
      deferCount += 1;
      increment(deferredByReasonCode, resolution.reason_code);
      increment(deferredByOccurrenceBucket, bucket);
    } else if (resolution.decision === "reject") {
      rejectCount += 1;
    }
  }

  return {
    report_schema: "living-atlas-logseq-topic-review-curated-draft-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    output_written: input.outputWritten,
    policy: {
      min_occurrences: input.minOccurrences,
      promote_reasons: [...input.promoteReasons].sort(),
      subtype: input.subtype
    },
    packet: {
      covered_file_count: input.packet.covered_file_count,
      candidate_count: input.packet.candidate_count,
      grouped_candidate_count: input.packet.grouped_candidate_count,
      excluded_suffix_tag_count: input.packet.excluded_suffix_tag_count
    },
    draft: {
      resolution_count: input.draft.resolutions.length,
      promote_topic_count: promoteTopicCount,
      defer_count: deferCount,
      reject_count: rejectCount,
      by_reason_code: sortedRecord(byReasonCode),
      promoted_by_reason_code: sortedRecord(promotedByReasonCode),
      deferred_by_reason_code: sortedRecord(deferredByReasonCode),
      promoted_by_occurrence_bucket: sortedRecord(promotedByOccurrenceBucket),
      deferred_by_occurrence_bucket: sortedRecord(deferredByOccurrenceBucket)
    }
  };
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(path, ownerOnlyMode);
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_DRAFT_ACK") !== curatedDraftAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_DRAFT_ACK must be ${curatedDraftAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH");
  assertOutputPathSafe(outputPath);
  const packet = SemanticTopicReviewPacketSchema.parse(JSON.parse(await readFile(requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH"), "utf8")));
  const minOccurrences = parseInteger(envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_MIN_OCCURRENCES"), 2, 1, 1_000_000);
  const promoteReasons = parsePromoteReasons(envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_PROMOTE_REASONS"));
  const subtype = TopicSubtypeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_CURATED_SUBTYPE") ?? "theme");
  const draft = buildTopicReviewCuratedDraft({
    packet,
    minOccurrences,
    promoteReasons,
    subtype
  });
  await writeJsonPrivate(outputPath, draft);
  console.log(JSON.stringify(buildTopicReviewCuratedDraftReport({
    packet,
    draft,
    outputWritten: true,
    minOccurrences,
    promoteReasons,
    subtype
  }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
