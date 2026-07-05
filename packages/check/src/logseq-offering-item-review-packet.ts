import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const packetAckValue = "write-local-private-offering-item-review-packet";
const defaultMaxFileBytes = 256_000;
const defaultMaxCandidates = 2_000;

const CandidateKindSchema = z.enum([
  "explicit-offering-or-item",
  "purchase-or-payment",
  "travel-or-reservation",
  "creation-or-deliverable",
  "provider-or-model-link"
]);
type CandidateKind = z.infer<typeof CandidateKindSchema>;

const CandidateConfidenceSchema = z.enum(["high", "medium", "low"]);
type CandidateConfidence = z.infer<typeof CandidateConfidenceSchema>;

export const OfferingItemReviewPacketSchema = z.object({
  packet_schema: z.literal("living-atlas-logseq-offering-item-review-packet:v1"),
  plaintext_policy: z.literal("local-private-review-packet"),
  source_path_policy: z.literal("redacted"),
  generated_at: z.string(),
  source_mode: SemanticSourceModeSchema,
  covered_file_count: z.number().int().nonnegative(),
  candidate_count: z.number().int().nonnegative(),
  truncated: z.boolean(),
  reason_counts: z.record(z.string(), z.number().int().nonnegative()),
  candidates: z.array(z.object({
    candidate_id: z.string().regex(/^la_offeritem_candidate_[a-f0-9]{24}$/),
    kind: CandidateKindSchema,
    confidence: CandidateConfidenceSchema,
    source_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    source_line: z.number().int().positive(),
    snippet: z.string().min(1).max(640),
    suggested_action: z.enum(["review", "promote-if-confirmed", "ignore-if-noisy"]),
    proposed_nodes: z.array(z.enum(["offering", "item", "occurrence", "organization", "location", "person", "project", "topic"])),
    proposed_edges: z.array(z.enum(["offered-by", "instance-of", "purchased-from", "purchased", "owns", "created", "created-for", "occurred-at"]))
  }).strict())
}).strict();
export type OfferingItemReviewPacket = z.infer<typeof OfferingItemReviewPacketSchema>;

type CandidateDraft = Omit<OfferingItemReviewPacket["candidates"][number], "candidate_id" | "source_ref"> & {
  source_ref: string;
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

function digest(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function normalizeSnippet(line: string): string {
  return line.replace(/\s+/g, " ").trim().slice(0, 640);
}

function isPropertyLine(line: string, key: string): boolean {
  return new RegExp(`^\\s*(?:[-*]\\s+)?${key}::`, "i").test(line);
}

function candidateId(input: {
  pathRedactionSecret: string;
  kind: CandidateKind;
  sourceRef: string;
  sourceLine: number;
  snippet: string;
}): string {
  return `la_offeritem_candidate_${digest(`offering-item-review:v1:${input.pathRedactionSecret}:${input.kind}:${input.sourceRef}:${input.sourceLine}:${input.snippet}`)}`;
}

function addCandidate(
  candidates: CandidateDraft[],
  seen: Set<string>,
  input: CandidateDraft
): void {
  const dedupeKey = `${input.kind}:${input.source_ref}:${input.source_line}:${input.snippet.toLowerCase()}`;
  if (seen.has(dedupeKey)) {
    return;
  }
  seen.add(dedupeKey);
  candidates.push(input);
}

function candidatesForFile(file: MarkdownFileInput, pathRedactionSecret: string): CandidateDraft[] {
  const sourceRef = createMarkdownSourceRef(file.source_path.replaceAll("\\", "/"), { path_redaction_secret: pathRedactionSecret });
  const lines = file.markdown.split(/\r?\n/);
  const candidates: CandidateDraft[] = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const snippet = normalizeSnippet(rawLine);
    if (!snippet || snippet.length < 8) {
      continue;
    }
    const lower = snippet.toLowerCase();

    if (isPropertyLine(snippet, "type") && /\b(offering|item|product|service|subscription|membership|device|document|ticket|reservation|receipt|seat|room|suite|podcast)\b/i.test(snippet)) {
      addCandidate(candidates, seen, {
        kind: "explicit-offering-or-item",
        confidence: "high",
        source_ref: sourceRef,
        source_line: lineNumber,
        snippet,
        suggested_action: "promote-if-confirmed",
        proposed_nodes: lower.includes("device") || lower.includes("ticket") || lower.includes("reservation") || lower.includes("receipt") || lower.includes("seat") || lower.includes("room")
          ? ["item"]
          : ["offering"],
        proposed_edges: []
      });
      continue;
    }

    if (
      isPropertyLine(snippet, "provider")
      || isPropertyLine(snippet, "vendor")
      || isPropertyLine(snippet, "product")
      || isPropertyLine(snippet, "model")
      || isPropertyLine(snippet, "offering")
      || isPropertyLine(snippet, "owner")
      || isPropertyLine(snippet, "acquired[-_]on")
      || isPropertyLine(snippet, "purchased[-_]on")
    ) {
      addCandidate(candidates, seen, {
        kind: "provider-or-model-link",
        confidence: "high",
        source_ref: sourceRef,
        source_line: lineNumber,
        snippet,
        suggested_action: "promote-if-confirmed",
        proposed_nodes: ["offering", "item", "organization", "person", "location"],
        proposed_edges: ["offered-by", "instance-of", "owns", "purchased"]
      });
      continue;
    }

    if (/\b(bought|purchased|paid|receipt|invoice|refund|renewal|subscription|charge|payment|card-on-file)\b/i.test(snippet)) {
      addCandidate(candidates, seen, {
        kind: "purchase-or-payment",
        confidence: /\b(receipt|invoice|paid|payment|refund)\b/i.test(snippet) ? "medium" : "low",
        source_ref: sourceRef,
        source_line: lineNumber,
        snippet,
        suggested_action: "review",
        proposed_nodes: ["offering", "item", "occurrence", "organization"],
        proposed_edges: ["purchased", "purchased-from", "owns"]
      });
      continue;
    }

    if (/\b(flight|hotel|reservation|suite|seat|ticket|check-in|checkin|boarding|airfare|delta|southwest|united|american airlines|marriott|hilton|hyatt|wynn|encore|vdara)\b/i.test(snippet)) {
      addCandidate(candidates, seen, {
        kind: "travel-or-reservation",
        confidence: /\b(confirmation|reservation|flight|ticket|seat|check-in|checkin)\b/i.test(snippet) ? "medium" : "low",
        source_ref: sourceRef,
        source_line: lineNumber,
        snippet,
        suggested_action: "review",
        proposed_nodes: ["offering", "item", "occurrence", "organization", "location"],
        proposed_edges: ["purchased", "purchased-from", "instance-of", "occurred-at"]
      });
      continue;
    }

    if (/\b(made|created|built|drafted|wrote|prepared|produced|delivered|deck|proposal|deliverable)\b.{0,120}\b(for|to)\b/i.test(snippet)) {
      addCandidate(candidates, seen, {
        kind: "creation-or-deliverable",
        confidence: /\b(deck|proposal|deliverable|drafted|prepared)\b/i.test(snippet) ? "medium" : "low",
        source_ref: sourceRef,
        source_line: lineNumber,
        snippet,
        suggested_action: "review",
        proposed_nodes: ["item", "person", "organization", "project"],
        proposed_edges: ["created", "created-for"]
      });
    }
  }

  return candidates;
}

export function buildOfferingItemReviewPacket(input: {
  files: MarkdownFileInput[];
  pathRedactionSecret: string;
  sourceMode: SemanticSourceMode;
  generatedAt?: string;
  maxCandidates?: number;
}): OfferingItemReviewPacket {
  const maxCandidates = input.maxCandidates ?? defaultMaxCandidates;
  const reasonCounts: Record<string, number> = {};
  const candidates: OfferingItemReviewPacket["candidates"] = [];
  let truncated = false;

  for (const file of input.files) {
    for (const candidate of candidatesForFile(file, input.pathRedactionSecret)) {
      if (candidates.length >= maxCandidates) {
        truncated = true;
        break;
      }
      reasonCounts[candidate.kind] = (reasonCounts[candidate.kind] ?? 0) + 1;
      candidates.push({
        ...candidate,
        source_ref: candidate.source_ref as `la_source_${string}`,
        candidate_id: candidateId({
          pathRedactionSecret: input.pathRedactionSecret,
          kind: candidate.kind,
          sourceRef: candidate.source_ref,
          sourceLine: candidate.source_line,
          snippet: candidate.snippet
        })
      });
    }
    if (truncated) {
      break;
    }
  }

  return OfferingItemReviewPacketSchema.parse({
    packet_schema: "living-atlas-logseq-offering-item-review-packet:v1",
    plaintext_policy: "local-private-review-packet",
    source_path_policy: "redacted",
    generated_at: input.generatedAt ?? new Date().toISOString(),
    source_mode: input.sourceMode,
    covered_file_count: input.files.length,
    candidate_count: candidates.length,
    truncated,
    reason_counts: Object.fromEntries(Object.entries(reasonCounts).sort(([left], [right]) => left.localeCompare(right))),
    candidates
  });
}

function assertOutputPathSafe(outputPath: string): void {
  const resolvedOutput = resolve(outputPath);
  const cwd = resolve(process.cwd());
  if (resolvedOutput === cwd || resolvedOutput.startsWith(`${cwd}/`)) {
    throw new Error("offering/item review packet output path must be outside the repository working directory");
  }
}

async function readMarkdownFiles(input: {
  root: string;
  sourceKind: "logseq" | "obsidian" | "generic-markdown";
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
  const files: MarkdownFileInput[] = [];
  for (const path of paths) {
    files.push({
      source_path: path,
      markdown: await readFile(path, "utf8"),
      source_kind: input.sourceKind
    });
  }
  return files;
}

async function main(): Promise<void> {
  const root = envValue("LIVING_ATLAS_REAL_MARKDOWN_ROOT") ?? "./private-markdown-root";
  const outputPath = requireEnv("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_PACKET_PATH");
  if (envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_PACKET_ACK") !== packetAckValue) {
    throw new Error(`set LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_PACKET_ACK=${packetAckValue}`);
  }
  assertOutputPathSafe(outputPath);
  const sourceKind = MarkdownImportSourceKindSchema.parse(envValue("LIVING_ATLAS_REAL_MARKDOWN_SOURCE_KIND") ?? "logseq");
  const sourceMode = SemanticSourceModeSchema.parse(envValue("LIVING_ATLAS_LOGSEQ_SEMANTIC_SOURCE_MODE") ?? "logseq-notes");
  const files = await readMarkdownFiles({
    root,
    sourceKind,
    sourceMode,
    maxFiles: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_MAX_FILES"), 100_000, 1, 1_000_000),
    maxFileBytes: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_MAX_FILE_BYTES"), defaultMaxFileBytes, 1, 10_000_000)
  });
  const packet = buildOfferingItemReviewPacket({
    files,
    pathRedactionSecret: requireEnv("LIVING_ATLAS_REAL_DATA_PATH_REDACTION_SECRET"),
    sourceMode,
    maxCandidates: parseInteger(envValue("LIVING_ATLAS_LOGSEQ_OFFERING_ITEM_REVIEW_MAX_CANDIDATES"), defaultMaxCandidates, 1, 100_000)
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(packet, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    packet_schema: packet.packet_schema,
    plaintext_policy: packet.plaintext_policy,
    source_mode: packet.source_mode,
    covered_file_count: packet.covered_file_count,
    candidate_count: packet.candidate_count,
    truncated: packet.truncated,
    reason_counts: packet.reason_counts,
    packet_written: true
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
