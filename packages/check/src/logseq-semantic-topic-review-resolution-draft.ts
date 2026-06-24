import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SemanticTopicReviewPacketSchema
} from "./logseq-semantic-topic-review-packet";
import {
  TopicReviewResolutionMapSchema,
  type TopicReviewResolutionMap
} from "./logseq-semantic-topic-review-report";

const draftAckValue = "write-local-private-topic-review-resolution-draft";
const ownerOnlyMode = 0o600;

export type TopicReviewResolutionDraftReport = {
  report_schema: "living-atlas-logseq-topic-review-resolution-draft-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  output_written: boolean;
  packet: {
    covered_file_count: number;
    candidate_count: number;
    grouped_candidate_count: number;
  };
  draft: {
    resolution_count: number;
    promote_topic_count: number;
    defer_count: number;
    reject_count: number;
    by_reason_code: Record<string, number>;
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

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("topic review resolution draft output path must be outside the repository working directory");
  }
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

export function buildTopicReviewResolutionDraft(input: {
  packet: ReturnType<typeof SemanticTopicReviewPacketSchema.parse>;
  generatedAt?: string;
}): TopicReviewResolutionMap {
  return TopicReviewResolutionMapSchema.parse({
    resolution_schema: "living-atlas-logseq-topic-review-resolution-map:v1",
    plaintext_policy: "local-private-topic-review-resolution-map",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    resolutions: input.packet.groups.map((group) => ({
      target_hash: group.target_hash,
      reason_code: group.reason_code,
      decision: "defer",
      confidence: "high"
    }))
  });
}

export function buildTopicReviewResolutionDraftReport(input: {
  packet: ReturnType<typeof SemanticTopicReviewPacketSchema.parse>;
  draft: TopicReviewResolutionMap;
  outputWritten: boolean;
}): TopicReviewResolutionDraftReport {
  const byReasonCode: Record<string, number> = {};
  let promoteTopicCount = 0;
  let deferCount = 0;
  let rejectCount = 0;
  for (const resolution of input.draft.resolutions) {
    increment(byReasonCode, resolution.reason_code);
    if (resolution.decision === "promote-topic") {
      promoteTopicCount += 1;
    } else if (resolution.decision === "defer") {
      deferCount += 1;
    } else if (resolution.decision === "reject") {
      rejectCount += 1;
    }
  }

  return {
    report_schema: "living-atlas-logseq-topic-review-resolution-draft-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    output_written: input.outputWritten,
    packet: {
      covered_file_count: input.packet.covered_file_count,
      candidate_count: input.packet.candidate_count,
      grouped_candidate_count: input.packet.grouped_candidate_count
    },
    draft: {
      resolution_count: input.draft.resolutions.length,
      promote_topic_count: promoteTopicCount,
      defer_count: deferCount,
      reject_count: rejectCount,
      by_reason_code: sortedRecord(byReasonCode)
    }
  };
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(path, ownerOnlyMode);
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_DRAFT_ACK") !== draftAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_DRAFT_ACK must be ${draftAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_RESOLUTION_PATH");
  assertOutputPathSafe(outputPath);
  const packet = SemanticTopicReviewPacketSchema.parse(JSON.parse(await readFile(requireEnv("LIVING_ATLAS_LOGSEQ_TOPIC_REVIEW_PACKET_PATH"), "utf8")));
  const draft = buildTopicReviewResolutionDraft({ packet });
  await writeJsonPrivate(outputPath, draft);
  console.log(JSON.stringify(buildTopicReviewResolutionDraftReport({
    packet,
    draft,
    outputWritten: true
  }), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
