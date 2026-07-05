import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LogseqSemanticReviewResolutionMapSchema } from "@living-atlas/importer";
import { z } from "zod";

const packetAckValue = "write-local-private-review-resolution-map";

const EndpointTypeSchema = z.enum(["person", "organization", "project", "location", "occurrence", "topic", "offering", "item"]);

const SemanticReviewPacketSchema = z.object({
  packet_schema: z.literal("living-atlas-logseq-semantic-review-packet:v1"),
  plaintext_policy: z.literal("local-private-review-packet"),
  groups: z.array(z.object({
    reason_code: z.string(),
    suggested_endpoint_types: z.array(EndpointTypeSchema),
    target_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    target_value: z.string(),
    occurrence_count: z.number().int().positive()
  }).passthrough())
}).passthrough();

type SemanticReviewPacket = z.infer<typeof SemanticReviewPacketSchema>;
type ReviewResolutionMap = z.infer<typeof LogseqSemanticReviewResolutionMapSchema>;

export type ReviewResolutionRekeyReport = {
  report_schema: "living-atlas-logseq-semantic-review-resolution-rekey-report:v1";
  plaintext_policy: "hash-counts-only";
  old_group_count: number;
  new_group_count: number;
  old_resolution_count: number;
  rekeyed_resolution_count: number;
  skipped_missing_old_group_count: number;
  skipped_missing_new_group_count: number;
  skipped_endpoint_type_mismatch_count: number;
  skipped_duplicate_normalized_target_count: number;
  by_decision: Record<string, number>;
  by_reason_code: Record<string, number>;
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

function normalizedTargetKey(input: { reason_code: string; target_value: string }): string {
  return `${input.reason_code}:${input.target_value.trim().toLowerCase()}`;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedRecord(source: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)));
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("rekeyed review resolution output path must be outside the repository working directory");
  }
}

async function readPacket(path: string): Promise<SemanticReviewPacket> {
  return SemanticReviewPacketSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function readResolutionMap(path: string): Promise<ReviewResolutionMap> {
  return LogseqSemanticReviewResolutionMapSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function rekeyReviewResolutions(input: {
  oldPacket: SemanticReviewPacket;
  oldResolutionMap: ReviewResolutionMap;
  newPacket: SemanticReviewPacket;
}): Promise<{ report: ReviewResolutionRekeyReport; resolutionMap: ReviewResolutionMap }> {
  const oldGroupsByHash = new Map(input.oldPacket.groups.map((group) => [group.target_hash, group]));
  const newGroupsByNormalizedTarget = new Map<string, SemanticReviewPacket["groups"][number]>();
  const duplicateTargets = new Set<string>();

  for (const group of input.newPacket.groups) {
    const key = normalizedTargetKey(group);
    if (newGroupsByNormalizedTarget.has(key)) {
      duplicateTargets.add(key);
      continue;
    }
    newGroupsByNormalizedTarget.set(key, group);
  }

  const byDecision: Record<string, number> = {};
  const byReasonCode: Record<string, number> = {};
  const resolutions: ReviewResolutionMap["resolutions"] = [];
  let skippedMissingOldGroupCount = 0;
  let skippedMissingNewGroupCount = 0;
  let skippedEndpointTypeMismatchCount = 0;
  let skippedDuplicateNormalizedTargetCount = 0;

  for (const resolution of input.oldResolutionMap.resolutions) {
    const oldGroup = oldGroupsByHash.get(resolution.target_hash);
    if (!oldGroup) {
      skippedMissingOldGroupCount += 1;
      continue;
    }

    const key = normalizedTargetKey(oldGroup);
    if (duplicateTargets.has(key)) {
      skippedDuplicateNormalizedTargetCount += 1;
      continue;
    }

    const newGroup = newGroupsByNormalizedTarget.get(key);
    if (!newGroup) {
      skippedMissingNewGroupCount += 1;
      continue;
    }

    if (resolution.endpoint_type && !newGroup.suggested_endpoint_types.includes(resolution.endpoint_type)) {
      skippedEndpointTypeMismatchCount += 1;
      continue;
    }

    resolutions.push({
      ...resolution,
      target_hash: newGroup.target_hash,
      reason_code: newGroup.reason_code
    });
    increment(byDecision, resolution.decision);
    increment(byReasonCode, newGroup.reason_code);
  }

  const resolutionMap: ReviewResolutionMap = {
    resolution_schema: "living-atlas-logseq-semantic-review-resolution-map:v1",
    plaintext_policy: "local-private-review-resolution-map",
    resolutions
  };

  const report: ReviewResolutionRekeyReport = {
    report_schema: "living-atlas-logseq-semantic-review-resolution-rekey-report:v1",
    plaintext_policy: "hash-counts-only",
    old_group_count: input.oldPacket.groups.length,
    new_group_count: input.newPacket.groups.length,
    old_resolution_count: input.oldResolutionMap.resolutions.length,
    rekeyed_resolution_count: resolutions.length,
    skipped_missing_old_group_count: skippedMissingOldGroupCount,
    skipped_missing_new_group_count: skippedMissingNewGroupCount,
    skipped_endpoint_type_mismatch_count: skippedEndpointTypeMismatchCount,
    skipped_duplicate_normalized_target_count: skippedDuplicateNormalizedTargetCount,
    by_decision: sortedRecord(byDecision),
    by_reason_code: sortedRecord(byReasonCode)
  };

  return { report, resolutionMap };
}

async function main(): Promise<void> {
  if (envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_REKEY_RESOLUTIONS_ACK") !== packetAckValue) {
    throw new Error(`LIVING_ATLAS_LOGSEQ_SEMANTIC_REKEY_RESOLUTIONS_ACK must be ${packetAckValue}`);
  }
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_REKEYED_RESOLUTION_PATH");
  assertOutputPathSafe(outputPath);
  const { report, resolutionMap } = await rekeyReviewResolutions({
    oldPacket: await readPacket(requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_OLD_REVIEW_PACKET_PATH")),
    oldResolutionMap: await readResolutionMap(requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_OLD_REVIEW_RESOLUTION_PATH")),
    newPacket: await readPacket(requireEnv("LIVING_ATLAS_LOGSEQ_SEMANTIC_NEW_REVIEW_PACKET_PATH"))
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(resolutionMap, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
