import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  OfferingItemReviewPacketSchema,
  type OfferingItemReviewPacket
} from "./logseq-offering-item-review-packet";

const groupedPacketAckValue = "write-local-private-offering-item-review-grouped-packet";
const maxSnippetsPerGroup = 5;

const HashRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const GroupingStrategySchema = z.enum(["source-kind-shape", "snippet-kind-shape"]);
type GroupingStrategy = z.infer<typeof GroupingStrategySchema>;

export const OfferingItemReviewGroupedPacketSchema = z.object({
  packet_schema: z.literal("living-atlas-logseq-offering-item-review-grouped-packet:v1"),
  plaintext_policy: z.literal("local-private-review-packet"),
  source_path_policy: z.literal("redacted"),
  generated_at: z.string(),
  grouping_strategy: GroupingStrategySchema,
  source_packet: z.object({
    generated_at: z.string(),
    source_mode: z.string(),
    covered_file_count: z.number().int().nonnegative(),
    candidate_count: z.number().int().nonnegative(),
    source_packet_hash: HashRefSchema
  }).strict(),
  group_count: z.number().int().nonnegative(),
  groups: z.array(z.object({
    group_id: z.string().regex(/^la_offeritem_group_[a-f0-9]{24}$/),
    group_hash: HashRefSchema,
    kind: z.enum([
      "explicit-offering-or-item",
      "purchase-or-payment",
      "travel-or-reservation",
      "creation-or-deliverable",
      "provider-or-model-link"
    ]),
    candidate_count: z.number().int().positive(),
    source_ref_count: z.number().int().positive(),
    candidate_ids: z.array(z.string().regex(/^la_offeritem_candidate_[a-f0-9]{24}$/)).min(1),
    confidence_counts: z.record(z.string(), z.number().int().nonnegative()),
    action_counts: z.record(z.string(), z.number().int().nonnegative()),
    proposed_nodes: z.array(z.string()),
    proposed_edges: z.array(z.string()),
    representative_snippets: z.array(z.string().min(1).max(640)).min(1).max(maxSnippetsPerGroup),
    review_hint: z.enum([
      "structured-property",
      "travel-or-reservation",
      "commerce-or-ownership",
      "creation-or-deliverable",
      "manual-review"
    ])
  }).strict())
}).strict();
export type OfferingItemReviewGroupedPacket = z.infer<typeof OfferingItemReviewGroupedPacketSchema>;

export type OfferingItemReviewGroupedReport = {
  report_schema: "living-atlas-logseq-offering-item-review-grouped-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  complete: boolean;
  failures: string[];
  source: {
    candidate_count: number;
    group_count: number;
    reduction_count: number;
    covered_file_count: number;
    source_mode: string;
    grouping_strategy: GroupingStrategy;
  };
  groups: {
    by_kind: Record<string, number>;
    by_review_hint: Record<string, number>;
    by_dominant_confidence: Record<string, number>;
    by_dominant_action: Record<string, number>;
    largest_group_sizes: number[];
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

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortedRecord(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function dominant(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? "unknown";
}

function normalizeGroupingText(snippet: string): string {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "from",
    "in",
    "is",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
    "your"
  ]);
  const normalized = snippet
    .toLowerCase()
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, " ")
    .replace(/\b[a-z0-9]{5,}[-_][a-z0-9-]{5,}\b/g, " ")
    .replace(/\b\d{1,4}([:/.-]\d{1,4}){1,4}\b/g, " ")
    .replace(/\b\d+[a-z]?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token))
    .slice(0, 12);
  return normalized.join(" ") || "ungrouped";
}

function reviewHint(
  kind: OfferingItemReviewPacket["candidates"][number]["kind"]
): OfferingItemReviewGroupedPacket["groups"][number]["review_hint"] {
  switch (kind) {
    case "explicit-offering-or-item":
    case "provider-or-model-link":
      return "structured-property";
    case "travel-or-reservation":
      return "travel-or-reservation";
    case "purchase-or-payment":
      return "commerce-or-ownership";
    case "creation-or-deliverable":
      return "creation-or-deliverable";
  }
}

function groupKey(candidate: OfferingItemReviewPacket["candidates"][number], strategy: GroupingStrategy): string {
  if (strategy === "source-kind-shape") {
    return [
      candidate.kind,
      candidate.source_ref,
      candidate.proposed_nodes.join(","),
      candidate.proposed_edges.join(",")
    ].join("|");
  }
  return [
    candidate.kind,
    candidate.proposed_nodes.join(","),
    candidate.proposed_edges.join(","),
    normalizeGroupingText(candidate.snippet)
  ].join("|");
}

export function buildOfferingItemReviewGroupedPacket(input: {
  packet: OfferingItemReviewPacket;
  generatedAt?: string;
  groupingStrategy?: GroupingStrategy;
}): OfferingItemReviewGroupedPacket {
  const groupingStrategy = input.groupingStrategy ?? "source-kind-shape";
  const buckets = new Map<string, OfferingItemReviewPacket["candidates"]>();
  for (const candidate of input.packet.candidates) {
    const key = groupKey(candidate, groupingStrategy);
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }

  const groups = [...buckets.entries()]
    .sort(([leftKey, leftCandidates], [rightKey, rightCandidates]) => rightCandidates.length - leftCandidates.length || leftKey.localeCompare(rightKey))
    .map(([key, candidates]) => {
      const first = candidates[0];
      if (!first) {
        throw new Error("empty offering/item candidate group");
      }
      const candidateIds = candidates.map((candidate) => candidate.candidate_id).sort();
      const sourceRefs = new Set(candidates.map((candidate) => candidate.source_ref));
      const confidenceCounts: Record<string, number> = {};
      const actionCounts: Record<string, number> = {};
      const proposedNodes = new Set<string>();
      const proposedEdges = new Set<string>();
      const representativeSnippets: string[] = [];
      const seenSnippets = new Set<string>();
      for (const candidate of candidates) {
        increment(confidenceCounts, candidate.confidence);
        increment(actionCounts, candidate.suggested_action);
        for (const node of candidate.proposed_nodes) {
          proposedNodes.add(node);
        }
        for (const edge of candidate.proposed_edges) {
          proposedEdges.add(edge);
        }
        const snippetKey = candidate.snippet.toLowerCase();
        if (representativeSnippets.length < maxSnippetsPerGroup && !seenSnippets.has(snippetKey)) {
          representativeSnippets.push(candidate.snippet);
          seenSnippets.add(snippetKey);
        }
      }
      const groupHash = sha256(`offering-item-group:v1:${key}:${candidateIds.join(",")}`);
      return {
        group_id: `la_offeritem_group_${digest(groupHash)}`,
        group_hash: groupHash,
        kind: first.kind,
        candidate_count: candidates.length,
        source_ref_count: sourceRefs.size,
        candidate_ids: candidateIds,
        confidence_counts: sortedRecord(confidenceCounts),
        action_counts: sortedRecord(actionCounts),
        proposed_nodes: [...proposedNodes].sort(),
        proposed_edges: [...proposedEdges].sort(),
        representative_snippets: representativeSnippets,
        review_hint: reviewHint(first.kind)
      };
    });

  return OfferingItemReviewGroupedPacketSchema.parse({
    packet_schema: "living-atlas-logseq-offering-item-review-grouped-packet:v1",
    plaintext_policy: "local-private-review-packet",
    source_path_policy: "redacted",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    grouping_strategy: groupingStrategy,
    source_packet: {
      generated_at: input.packet.generated_at,
      source_mode: input.packet.source_mode,
      covered_file_count: input.packet.covered_file_count,
      candidate_count: input.packet.candidate_count,
      source_packet_hash: sha256(JSON.stringify(input.packet))
    },
    group_count: groups.length,
    groups
  });
}

export function buildOfferingItemReviewGroupedReport(
  groupedPacket: OfferingItemReviewGroupedPacket
): OfferingItemReviewGroupedReport {
  const byKind: Record<string, number> = {};
  const byReviewHint: Record<string, number> = {};
  const byDominantConfidence: Record<string, number> = {};
  const byDominantAction: Record<string, number> = {};
  const failures: string[] = [];

  const groupIds = new Set<string>();
  for (const group of groupedPacket.groups) {
    if (groupIds.has(group.group_id)) {
      failures.push(`duplicate group id ${group.group_id}`);
    }
    groupIds.add(group.group_id);
    increment(byKind, group.kind);
    increment(byReviewHint, group.review_hint);
    increment(byDominantConfidence, dominant(group.confidence_counts));
    increment(byDominantAction, dominant(group.action_counts));
  }

  return {
    report_schema: "living-atlas-logseq-offering-item-review-grouped-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    complete: failures.length === 0,
    failures,
    source: {
      candidate_count: groupedPacket.source_packet.candidate_count,
      group_count: groupedPacket.group_count,
      reduction_count: groupedPacket.source_packet.candidate_count - groupedPacket.group_count,
      covered_file_count: groupedPacket.source_packet.covered_file_count,
      source_mode: groupedPacket.source_packet.source_mode,
      grouping_strategy: groupedPacket.grouping_strategy
    },
    groups: {
      by_kind: sortedRecord(byKind),
      by_review_hint: sortedRecord(byReviewHint),
      by_dominant_confidence: sortedRecord(byDominantConfidence),
      by_dominant_action: sortedRecord(byDominantAction),
      largest_group_sizes: groupedPacket.groups
        .map((group) => group.candidate_count)
        .sort((left, right) => right - left)
        .slice(0, 10)
    }
  };
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("offering/item grouped review packet output path must be outside the repository working directory");
  }
}

async function main(): Promise<void> {
  const inputPath = requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_PACKET_PATH");
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_PATH");
  if (envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_ACK") !== groupedPacketAckValue) {
    throw new Error(`set LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_ACK=${groupedPacketAckValue}`);
  }
  assertOutputPathSafe(outputPath);
  const packet = OfferingItemReviewPacketSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  const groupingStrategy = GroupingStrategySchema.parse(envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPING_STRATEGY") ?? "source-kind-shape");
  const groupedPacket = buildOfferingItemReviewGroupedPacket({ packet, groupingStrategy });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(groupedPacket, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(buildOfferingItemReviewGroupedReport(groupedPacket), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
