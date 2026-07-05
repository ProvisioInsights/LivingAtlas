import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  EndpointRecordSchema,
  IsoTimestampSchema,
  ObjectIdSchema,
  TemporalEdgeSchema
} from "@living-atlas/contracts";
import { z } from "zod";
import {
  OfferingItemReviewGroupedPacketSchema,
  type OfferingItemReviewGroupedPacket
} from "./logseq-offering-item-review-grouped-packet";

const HashRefSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const OfferingItemDecisionSchema = z.enum(["promote", "defer", "reject"]);
type OfferingItemDecision = z.infer<typeof OfferingItemDecisionSchema>;

const NormalizedFactSchema = z.discriminatedUnion("fact_kind", [
  z.object({
    fact_kind: z.literal("endpoint"),
    object_id: ObjectIdSchema.optional(),
    endpoint: EndpointRecordSchema
  }).strict(),
  z.object({
    fact_kind: z.literal("edge"),
    object_id: ObjectIdSchema.optional(),
    edge: TemporalEdgeSchema
  }).strict()
]);
export type OfferingItemNormalizedFact = z.infer<typeof NormalizedFactSchema>;

export const OfferingItemReviewResolutionSchema = z
  .object({
    group_id: z.string().regex(/^la_offeritem_group_[a-f0-9]{24}$/),
    group_hash: HashRefSchema,
    decision: OfferingItemDecisionSchema,
    confidence: z.literal("high"),
    normalized_facts: z.array(NormalizedFactSchema).default([]),
    reviewed_at: IsoTimestampSchema.optional(),
    rationale_hash: HashRefSchema.optional()
  })
  .strict()
  .superRefine((resolution, ctx) => {
    if (resolution.decision === "promote" && resolution.normalized_facts.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["normalized_facts"],
        message: "promote decisions require one or more normalized facts"
      });
    }
    if (resolution.decision !== "promote" && resolution.normalized_facts.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["decision"],
        message: "defer and reject decisions must not carry normalized facts"
      });
    }
  });
export type OfferingItemReviewResolution = z.infer<typeof OfferingItemReviewResolutionSchema>;

export const OfferingItemReviewResolutionMapSchema = z
  .object({
    resolution_schema: z.literal("living-atlas-logseq-offering-item-review-resolution-map:v1"),
    plaintext_policy: z.literal("local-private-offering-item-review-resolution-map"),
    generated_at: IsoTimestampSchema,
    resolutions: z.array(OfferingItemReviewResolutionSchema)
  })
  .strict();
export type OfferingItemReviewResolutionMap = z.infer<typeof OfferingItemReviewResolutionMapSchema>;

export type OfferingItemReviewReport = {
  report_schema: "living-atlas-logseq-offering-item-review-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  complete: boolean;
  review_complete: boolean;
  failures: string[];
  packet: {
    generated_at: string;
    source_mode: string;
    grouping_strategy: string;
    covered_file_count: number;
    candidate_count: number;
    group_count: number;
  };
  resolutions: {
    provided: boolean;
    resolution_count: number;
    matched_resolution_count: number;
    unknown_group_resolution_count: number;
    duplicate_resolution_count: number;
    promote_count: number;
    defer_count: number;
    reject_count: number;
    normalized_fact_count: number;
    unresolved_group_count: number;
    unresolved_candidate_count: number;
    by_decision: Record<string, number>;
    by_kind: Record<string, number>;
    by_review_hint: Record<string, number>;
    by_fact_kind: Record<string, number>;
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

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function groupKey(groupId: string, groupHash: string): string {
  return `${groupId}:${groupHash}`;
}

export function buildOfferingItemReviewReport(input: {
  groupedPacket: OfferingItemReviewGroupedPacket;
  resolutionMap?: OfferingItemReviewResolutionMap;
  requireComplete?: boolean;
}): OfferingItemReviewReport {
  const packetGroupKeys = new Set(input.groupedPacket.groups.map((group) => groupKey(group.group_id, group.group_hash)));
  const groupsByKey = new Map(input.groupedPacket.groups.map((group) => [groupKey(group.group_id, group.group_hash), group]));
  const seenResolutions = new Set<string>();
  const failures: string[] = [];
  const byDecision: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byReviewHint: Record<string, number> = {};
  const byFactKind: Record<string, number> = {};
  let matchedResolutionCount = 0;
  let unknownGroupResolutionCount = 0;
  let duplicateResolutionCount = 0;
  let normalizedFactCount = 0;

  for (const resolution of input.resolutionMap?.resolutions ?? []) {
    const key = groupKey(resolution.group_id, resolution.group_hash);
    if (seenResolutions.has(key)) {
      duplicateResolutionCount += 1;
      failures.push(`duplicate offering/item review resolution for ${key}`);
      continue;
    }
    seenResolutions.add(key);
    if (!packetGroupKeys.has(key)) {
      unknownGroupResolutionCount += 1;
      failures.push(`offering/item review resolution references unknown group ${key}`);
      continue;
    }

    const group = groupsByKey.get(key);
    matchedResolutionCount += 1;
    increment(byDecision, resolution.decision);
    if (group) {
      increment(byKind, group.kind);
      increment(byReviewHint, group.review_hint);
    }
    for (const fact of resolution.normalized_facts) {
      normalizedFactCount += 1;
      increment(byFactKind, fact.fact_kind);
    }
  }

  const unresolvedGroups = input.groupedPacket.groups.filter((group) => !seenResolutions.has(groupKey(group.group_id, group.group_hash)));
  if (input.requireComplete && unresolvedGroups.length > 0) {
    failures.push(`offering/item review has ${unresolvedGroups.length} unresolved grouped candidates`);
  }

  return {
    report_schema: "living-atlas-logseq-offering-item-review-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    complete: failures.length === 0 && (!input.requireComplete || unresolvedGroups.length === 0),
    review_complete: unresolvedGroups.length === 0,
    failures,
    packet: {
      generated_at: input.groupedPacket.generated_at,
      source_mode: input.groupedPacket.source_packet.source_mode,
      grouping_strategy: input.groupedPacket.grouping_strategy,
      covered_file_count: input.groupedPacket.source_packet.covered_file_count,
      candidate_count: input.groupedPacket.source_packet.candidate_count,
      group_count: input.groupedPacket.group_count
    },
    resolutions: {
      provided: input.resolutionMap !== undefined,
      resolution_count: input.resolutionMap?.resolutions.length ?? 0,
      matched_resolution_count: matchedResolutionCount,
      unknown_group_resolution_count: unknownGroupResolutionCount,
      duplicate_resolution_count: duplicateResolutionCount,
      promote_count: byDecision.promote ?? 0,
      defer_count: byDecision.defer ?? 0,
      reject_count: byDecision.reject ?? 0,
      normalized_fact_count: normalizedFactCount,
      unresolved_group_count: unresolvedGroups.length,
      unresolved_candidate_count: unresolvedGroups.reduce((total, group) => total + group.candidate_count, 0),
      by_decision: sortedRecord(byDecision),
      by_kind: sortedRecord(byKind),
      by_review_hint: sortedRecord(byReviewHint),
      by_fact_kind: sortedRecord(byFactKind)
    }
  };
}

export async function buildOfferingItemReviewReportFromPaths(input: {
  groupedPacketPath: string;
  resolutionPath?: string;
  requireComplete?: boolean;
}): Promise<OfferingItemReviewReport> {
  const groupedPacket = OfferingItemReviewGroupedPacketSchema.parse(JSON.parse(await readFile(input.groupedPacketPath, "utf8")));
  const resolutionMap = input.resolutionPath
    ? OfferingItemReviewResolutionMapSchema.parse(JSON.parse(await readFile(input.resolutionPath, "utf8")))
    : undefined;
  return buildOfferingItemReviewReport({ groupedPacket, resolutionMap, requireComplete: input.requireComplete });
}

async function main(): Promise<void> {
  const report = await buildOfferingItemReviewReportFromPaths({
    groupedPacketPath: requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_PATH"),
    resolutionPath: envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_PATH"),
    requireComplete: envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_REQUIRE_COMPLETE") === "1"
  });
  if (!report.complete && envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_REQUIRE_COMPLETE") === "1") {
    throw new Error(`offering/item review incomplete: ${report.failures.join(", ")}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
