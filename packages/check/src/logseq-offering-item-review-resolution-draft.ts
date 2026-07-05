import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  OfferingItemReviewGroupedPacketSchema,
  type OfferingItemReviewGroupedPacket
} from "./logseq-offering-item-review-grouped-packet";
import {
  buildOfferingItemReviewReport,
  OfferingItemReviewResolutionMapSchema,
  type OfferingItemReviewResolutionMap
} from "./logseq-offering-item-review-report";

const draftAckValue = "write-local-private-offering-item-review-resolution-draft";
const ownerOnlyMode = 0o600;

export type OfferingItemReviewResolutionDraftReport = {
  report_schema: "living-atlas-logseq-offering-item-review-resolution-draft-report:v1";
  plaintext_policy: "hash-counts-refs-only";
  output_written: boolean;
  packet: {
    covered_file_count: number;
    candidate_count: number;
    group_count: number;
  };
  draft: {
    resolution_count: number;
    promote_count: number;
    defer_count: number;
    reject_count: number;
    by_kind: Record<string, number>;
    by_review_hint: Record<string, number>;
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
    throw new Error("offering/item review resolution draft output path must be outside the repository working directory");
  }
}

function sortedRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function buildOfferingItemReviewResolutionDraft(input: {
  groupedPacket: OfferingItemReviewGroupedPacket;
  generatedAt?: string;
}): OfferingItemReviewResolutionMap {
  return OfferingItemReviewResolutionMapSchema.parse({
    resolution_schema: "living-atlas-logseq-offering-item-review-resolution-map:v1",
    plaintext_policy: "local-private-offering-item-review-resolution-map",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    resolutions: input.groupedPacket.groups.map((group) => ({
      group_id: group.group_id,
      group_hash: group.group_hash,
      decision: "defer",
      confidence: "high",
      normalized_facts: []
    }))
  });
}

export function buildOfferingItemReviewResolutionDraftReport(input: {
  groupedPacket: OfferingItemReviewGroupedPacket;
  draft: OfferingItemReviewResolutionMap;
  outputWritten: boolean;
}): OfferingItemReviewResolutionDraftReport {
  const reviewReport = buildOfferingItemReviewReport({
    groupedPacket: input.groupedPacket,
    resolutionMap: input.draft
  });
  const byKind: Record<string, number> = {};
  const byReviewHint: Record<string, number> = {};
  const groupMap = new Map(input.groupedPacket.groups.map((group) => [`${group.group_id}:${group.group_hash}`, group]));
  for (const resolution of input.draft.resolutions) {
    const group = groupMap.get(`${resolution.group_id}:${resolution.group_hash}`);
    if (group) {
      increment(byKind, group.kind);
      increment(byReviewHint, group.review_hint);
    }
  }

  return {
    report_schema: "living-atlas-logseq-offering-item-review-resolution-draft-report:v1",
    plaintext_policy: "hash-counts-refs-only",
    output_written: input.outputWritten,
    packet: {
      covered_file_count: input.groupedPacket.source_packet.covered_file_count,
      candidate_count: input.groupedPacket.source_packet.candidate_count,
      group_count: input.groupedPacket.group_count
    },
    draft: {
      resolution_count: input.draft.resolutions.length,
      promote_count: reviewReport.resolutions.promote_count,
      defer_count: reviewReport.resolutions.defer_count,
      reject_count: reviewReport.resolutions.reject_count,
      by_kind: sortedRecord(byKind),
      by_review_hint: sortedRecord(byReviewHint)
    }
  };
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: ownerOnlyMode });
  await chmod(path, ownerOnlyMode);
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_DRAFT_ACK") !== draftAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_DRAFT_ACK must be ${draftAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_RESOLUTION_PATH");
  assertOutputPathSafe(outputPath);
  const groupedPacket = OfferingItemReviewGroupedPacketSchema.parse(JSON.parse(await readFile(requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_GROUPED_PACKET_PATH"), "utf8")));
  const draft = buildOfferingItemReviewResolutionDraft({ groupedPacket });
  await writeJsonPrivate(outputPath, draft);
  console.log(JSON.stringify(buildOfferingItemReviewResolutionDraftReport({
    groupedPacket,
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
