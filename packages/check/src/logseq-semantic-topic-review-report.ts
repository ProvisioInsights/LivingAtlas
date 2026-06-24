import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { TopicSubtypeSchema } from "@living-atlas/contracts";
import { z } from "zod";
import {
  SemanticTopicReviewPacketSchema,
  type SemanticTopicReviewPacket
} from "./logseq-semantic-topic-review-packet";

const TopicCandidateReasonSchema = z.enum([
  "plain-tag-topic-review",
  "hash-tag-topic-review",
  "wikilink-tag-topic-review"
]);
type TopicCandidateReason = z.infer<typeof TopicCandidateReasonSchema>;

const TopicReviewDecisionSchema = z.enum(["promote-topic", "defer", "reject"]);
type TopicReviewDecision = z.infer<typeof TopicReviewDecisionSchema>;

export const TopicReviewResolutionSchema = z
  .object({
    target_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reason_code: TopicCandidateReasonSchema,
    decision: TopicReviewDecisionSchema,
    topic_title: z.string().min(1).max(256).optional(),
    subtype: TopicSubtypeSchema.default("other"),
    aliases: z.array(z.string().min(1).max(256)).default([]),
    confidence: z.literal("high"),
    reviewed_at: z.string().refine((value) => value.includes("T") && !Number.isNaN(Date.parse(value))).optional(),
    rationale_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
  })
  .strict()
  .superRefine((resolution, ctx) => {
    if (resolution.decision === "promote-topic" && !resolution.topic_title) {
      ctx.addIssue({
        code: "custom",
        path: ["topic_title"],
        message: "topic_title is required for promote-topic decisions"
      });
    }
    if (resolution.decision !== "promote-topic" && (resolution.topic_title || resolution.aliases.length > 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "defer and reject decisions must not carry topic_title or aliases"
      });
    }
  });
type TopicReviewResolution = z.infer<typeof TopicReviewResolutionSchema>;

export const TopicReviewResolutionMapSchema = z
  .object({
    resolution_schema: z.literal("living-atlas-logseq-topic-review-resolution-map:v1"),
    plaintext_policy: z.literal("local-private-topic-review-resolution-map"),
    generated_at: z.string(),
    resolutions: z.array(TopicReviewResolutionSchema)
  })
  .strict();
export type TopicReviewResolutionMap = z.infer<typeof TopicReviewResolutionMapSchema>;

export type TopicReviewReport = {
  report_schema: "living-atlas-logseq-topic-review-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  complete: boolean;
  review_complete: boolean;
  failures: string[];
  packet: {
    generated_at: string;
    source_mode: string;
    covered_file_count: number;
    candidate_count: number;
    grouped_candidate_count: number;
    excluded_suffix_tag_count: number;
    reason_counts: Record<string, number>;
  };
  resolutions: {
    provided: boolean;
    resolution_count: number;
    matched_resolution_count: number;
    unknown_target_resolution_count: number;
    duplicate_resolution_count: number;
    promoted_topic_count: number;
    deferred_count: number;
    rejected_count: number;
    unresolved_group_count: number;
    unresolved_candidate_count: number;
    by_decision: Record<TopicReviewDecision, number>;
    by_reason_code: Record<string, number>;
    by_subtype: Record<string, number>;
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

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedRecord<T extends string>(counts: Record<T, number>): Record<T, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))) as Record<T, number>;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function buildTopicReviewReport(input: {
  packet: SemanticTopicReviewPacket;
  resolutionMap?: TopicReviewResolutionMap;
  requireComplete?: boolean;
}): TopicReviewReport {
  const packetGroupKeys = new Set(input.packet.groups.map((group) => `${group.reason_code}:${group.target_hash}`));
  const byDecision = {} as Record<TopicReviewDecision, number>;
  const byReasonCode: Record<string, number> = {};
  const bySubtype: Record<string, number> = {};
  const failures: string[] = [];
  const seenResolutions = new Set<string>();
  let duplicateResolutionCount = 0;
  let matchedResolutionCount = 0;
  let unknownTargetResolutionCount = 0;

  for (const resolution of input.resolutionMap?.resolutions ?? []) {
    const key = `${resolution.reason_code}:${resolution.target_hash}`;
    if (seenResolutions.has(key)) {
      duplicateResolutionCount += 1;
      failures.push(`duplicate topic review resolution for ${key}`);
      continue;
    }
    seenResolutions.add(key);
    if (packetGroupKeys.has(key)) {
      matchedResolutionCount += 1;
    } else {
      unknownTargetResolutionCount += 1;
      failures.push(`topic review resolution references unknown target ${key}`);
    }
    increment(byDecision, resolution.decision);
    increment(byReasonCode, resolution.reason_code);
    if (resolution.decision === "promote-topic") {
      bySubtype[resolution.subtype] = (bySubtype[resolution.subtype] ?? 0) + 1;
    }
  }

  const unresolvedGroups = input.packet.groups.filter((group) => !seenResolutions.has(`${group.reason_code}:${group.target_hash}`));
  const unresolvedCandidateCount = unresolvedGroups.reduce((total, group) => total + group.occurrence_count, 0);
  const reviewComplete = unresolvedGroups.length === 0;

  if (input.requireComplete && unresolvedGroups.length > 0) {
    failures.push(`topic review has ${unresolvedGroups.length} unresolved grouped candidates`);
  }

  const report: TopicReviewReport = {
    report_schema: "living-atlas-logseq-topic-review-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    complete: failures.length === 0 && (!input.requireComplete || unresolvedGroups.length === 0),
    review_complete: reviewComplete,
    failures,
    packet: {
      generated_at: input.packet.generated_at,
      source_mode: input.packet.source_mode,
      covered_file_count: input.packet.covered_file_count,
      candidate_count: input.packet.candidate_count,
      grouped_candidate_count: input.packet.grouped_candidate_count,
      excluded_suffix_tag_count: input.packet.excluded_suffix_tag_count,
      reason_counts: input.packet.reason_counts
    },
    resolutions: {
      provided: input.resolutionMap !== undefined,
      resolution_count: input.resolutionMap?.resolutions.length ?? 0,
      matched_resolution_count: matchedResolutionCount,
      unknown_target_resolution_count: unknownTargetResolutionCount,
      duplicate_resolution_count: duplicateResolutionCount,
      promoted_topic_count: byDecision["promote-topic"] ?? 0,
      deferred_count: byDecision.defer ?? 0,
      rejected_count: byDecision.reject ?? 0,
      unresolved_group_count: unresolvedGroups.length,
      unresolved_candidate_count: unresolvedCandidateCount,
      by_decision: sortedRecord(byDecision),
      by_reason_code: sortedRecord(byReasonCode),
      by_subtype: sortedRecord(bySubtype)
    }
  };

  return report;
}

export async function buildTopicReviewReportFromPaths(input: {
  packetPath: string;
  resolutionPath?: string;
  requireComplete?: boolean;
}): Promise<TopicReviewReport> {
  const packet = SemanticTopicReviewPacketSchema.parse(await readJson(input.packetPath));
  const resolutionMap = input.resolutionPath
    ? TopicReviewResolutionMapSchema.parse(await readJson(input.resolutionPath))
    : undefined;
  return buildTopicReviewReport({ packet, resolutionMap, requireComplete: input.requireComplete });
}

async function main(): Promise<void> {
  const report = await buildTopicReviewReportFromPaths({
    packetPath: requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH"),
    resolutionPath: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH"),
    requireComplete: envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_REQUIRE_COMPLETE") === "1"
  });
  if (!report.complete && envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_REQUIRE_COMPLETE") === "1") {
    throw new Error(`topic review incomplete: ${report.failures.join(", ")}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
