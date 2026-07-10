import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import {
  AccessClassSchema,
  EndpointTypeSchema,
  AuthorityIdSchema,
  EndpointRecordSchema,
  GraphObjectEnvelopeSchema,
  ObjectIdSchema,
  TemporalEdgeSchema,
  type AccessClass,
  type EndpointRecord,
  type EndpointType,
  type GraphObjectEnvelope,
  type ObjectType,
  type TemporalEdge
} from "@living-atlas/contracts";
import { canonicalizePredicate } from "@living-atlas/contracts";
import {
  createMarkdownObjectId,
  createMarkdownSourceRef,
  MarkdownFileInputSchema,
  type MarkdownFileInput,
  type MarkdownImportSourceKind,
  normalizeMarkdownSourcePath
} from "./markdown";

export const LogseqSemanticObjectKindSchema = z.enum([
  "source-capsule",
  "page",
  "block",
  "reference-index",
  "typed-endpoint",
  "edge-candidate",
  "typed-edge"
]);
export type LogseqSemanticObjectKind = z.infer<typeof LogseqSemanticObjectKindSchema>;

export const LogseqSemanticDecisionSchema = z.enum([
  "planned",
  "captured-encrypted",
  "quarantined",
  "unsupported"
]);
export type LogseqSemanticDecision = z.infer<typeof LogseqSemanticDecisionSchema>;

export const LogseqSemanticObjectPlanSchema = z
  .object({
    object_id: ObjectIdSchema,
    object_type: z.enum(["page", "block", "edge", "index", "attachment"]),
    semantic_kind: LogseqSemanticObjectKindSchema,
    access_class: AccessClassSchema,
    source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    source_block_ref: z.string().regex(/^la_block_[a-f0-9]{24}$/).optional(),
    decision: LogseqSemanticDecisionSchema,
    reason_code: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/),
    plaintext_in_plan: z.literal(false)
  })
  .strict();
export type LogseqSemanticObjectPlan = z.infer<typeof LogseqSemanticObjectPlanSchema>;

export const LogseqSemanticFileLedgerSchema = z
  .object({
    source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    source_kind: z.enum(["logseq", "obsidian", "generic-markdown"]),
    migration_status: z.enum(["planned", "migrated", "skipped", "quarantined"]),
    review_status: z.enum(["not-required", "needs-review", "reviewed"]),
    parity_status: z.enum(["planned", "local-verified", "synced", "blocked"]),
    source_capsule_object_id: ObjectIdSchema,
    byte_size: z.number().int().nonnegative(),
    line_count: z.number().int().nonnegative(),
    content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source_hash_before: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    source_hash_after: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    counts: z
      .object({
        source_capsules: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        blocks: z.number().int().nonnegative(),
        page_properties: z.number().int().nonnegative(),
        block_properties: z.number().int().nonnegative(),
        wikilinks: z.number().int().nonnegative(),
        hash_tags: z.number().int().nonnegative(),
        block_refs: z.number().int().nonnegative(),
        reference_index_objects: z.number().int().nonnegative(),
        edge_candidates: z.number().int().nonnegative(),
        valid_edge_candidates: z.number().int().nonnegative(),
        quarantined_edge_candidates: z.number().int().nonnegative(),
        terminal_migrated: z.number().int().nonnegative(),
        terminal_skipped: z.number().int().nonnegative(),
        terminal_quarantined: z.number().int().nonnegative()
      })
      .strict(),
    objects: z.array(LogseqSemanticObjectPlanSchema)
  })
  .strict();
export type LogseqSemanticFileLedger = z.infer<typeof LogseqSemanticFileLedgerSchema>;

export const LogseqSemanticParityLedgerSchema = z
  .object({
    ledger_schema: z.literal("living-atlas-logseq-semantic-parity-ledger:v1"),
    ledger_id: z.string().regex(/^la_semantic_ledger_[a-f0-9]{24}$/),
    authority_id: AuthorityIdSchema,
    created_at: z.string().refine((value) => value.includes("T") && !Number.isNaN(Date.parse(value))),
    source_path_policy: z.literal("redacted"),
    plaintext_policy: z.literal("hash-counts-refs-only"),
    file_count: z.number().int().nonnegative(),
    totals: z
      .object({
        bytes: z.number().int().nonnegative(),
        lines: z.number().int().nonnegative(),
        pages: z.number().int().nonnegative(),
        blocks: z.number().int().nonnegative(),
        page_properties: z.number().int().nonnegative(),
        block_properties: z.number().int().nonnegative(),
        wikilinks: z.number().int().nonnegative(),
        hash_tags: z.number().int().nonnegative(),
        block_refs: z.number().int().nonnegative(),
        reference_index_objects: z.number().int().nonnegative(),
        edge_candidates: z.number().int().nonnegative(),
        valid_edge_candidates: z.number().int().nonnegative(),
        quarantined_edge_candidates: z.number().int().nonnegative(),
        planned_objects: z.number().int().nonnegative(),
        page_objects: z.number().int().nonnegative(),
        block_objects: z.number().int().nonnegative(),
        reference_index_objects_planned: z.number().int().nonnegative(),
        source_capsule_objects: z.number().int().nonnegative(),
        edge_objects: z.number().int().nonnegative(),
        quarantine_objects: z.number().int().nonnegative(),
        terminal_migrated: z.number().int().nonnegative(),
        terminal_skipped: z.number().int().nonnegative(),
        terminal_quarantined: z.number().int().nonnegative()
      })
      .strict(),
    decisions: z.record(z.string(), z.number().int().nonnegative()),
    files: z.array(LogseqSemanticFileLedgerSchema)
  })
  .strict();
export type LogseqSemanticParityLedger = z.infer<typeof LogseqSemanticParityLedgerSchema>;

export type LogseqSemanticEncryptedPayload = {
  ciphertext: string;
  nonce: string;
  hash: `sha256:${string}`;
  algorithm?: string;
  key_ref?: string;
};

export type LogseqSemanticPayloadToEncrypt = {
  object_id: string;
  object_type: ObjectType;
  semantic_kind: LogseqSemanticObjectKind;
  source_path_ref: string;
  plaintext: string;
  aad: string;
};

export type LogseqSemanticEncryptor = (input: LogseqSemanticPayloadToEncrypt) => Promise<LogseqSemanticEncryptedPayload>;

export const LogseqSemanticReviewResolutionSchema = z
  .object({
    target_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    reason_code: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,95}$/),
    decision: z.enum(["map-to-endpoint", "create-endpoint", "defer"]),
    endpoint_type: EndpointTypeSchema.optional(),
    endpoint_title: z.string().min(1).max(256).optional(),
    aliases: z.array(z.string().min(1).max(256)).default([]),
    confidence: z.literal("high"),
    reviewed_at: z.string().refine((value) => value.includes("T") && !Number.isNaN(Date.parse(value))).optional(),
    rationale_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision === "defer") {
      return;
    }
    if (!value.endpoint_type) {
      ctx.addIssue({ code: "custom", path: ["endpoint_type"], message: "endpoint_type is required for promoted review resolutions" });
    }
    if (!value.endpoint_title) {
      ctx.addIssue({ code: "custom", path: ["endpoint_title"], message: "endpoint_title is required for promoted review resolutions" });
    }
  });
export type LogseqSemanticReviewResolution = z.infer<typeof LogseqSemanticReviewResolutionSchema>;

export const LogseqSemanticReviewResolutionMapSchema = z
  .object({
    resolution_schema: z.literal("living-atlas-logseq-semantic-review-resolution-map:v1"),
    plaintext_policy: z.literal("local-private-review-resolution-map"),
    resolutions: z.array(LogseqSemanticReviewResolutionSchema)
  })
  .strict();
export type LogseqSemanticReviewResolutionMap = z.infer<typeof LogseqSemanticReviewResolutionMapSchema>;

export type CreateLogseqSemanticImportOptions = {
  authority_id: string;
  created_at?: string;
  path_redaction_secret?: string;
  default_access_class?: AccessClass;
  review_resolutions?: LogseqSemanticReviewResolution[];
};

export type CreateLogseqSemanticGraphObjectsOptions = CreateLogseqSemanticImportOptions & {
  encrypt: LogseqSemanticEncryptor;
};

export type LogseqSemanticGraphObjectsResult = {
  ledger: LogseqSemanticParityLedger;
  objects: GraphObjectEnvelope[];
};

export type LogseqSemanticPlaintextGraphObject = {
  schema_version: 1;
  authority_id: string;
  object_id: string;
  object_type: ObjectType;
  version: number;
  access_class: AccessClass;
  encryption_class: "plaintext";
  created_at: string;
  updated_at: string;
  content_hash: `sha256:${string}`;
  visible_metadata: {
    schema_namespace: string;
    tombstone: false;
    remote_indexable: false;
    size_class?: "tiny" | "small" | "medium" | "large" | "huge";
  };
  payload: {
    kind: "plaintext-json";
    data: Record<string, unknown>;
  };
};

export type LogseqSemanticPlaintextGraphObjectsResult = {
  ledger: LogseqSemanticParityLedger;
  objects: LogseqSemanticPlaintextGraphObject[];
};

export type LogseqSemanticKnowledgeSummary = {
  report_schema: "living-atlas-logseq-semantic-knowledge-summary:v1";
  plaintext_policy: "counts-only";
  source_file_count: number;
  object_count: number;
  semantic_kind_counts: Record<LogseqSemanticObjectKind, number>;
  object_type_counts: Record<ObjectType, number>;
  endpoint_type_counts: Record<EndpointType, number>;
  endpoint_subtype_counts: Record<string, number>;
  endpoints_with_aliases: number;
  occurrence_count: number;
  occurrence_with_recurrence_count: number;
  occurrence_with_timezone_count: number;
  occurrence_with_participants_count: number;
  topic_count: number;
  edge_count: number;
  edge_predicate_counts: Record<string, number>;
  edge_source_type_counts: Record<EndpointType, number>;
  edge_target_type_counts: Record<EndpointType, number>;
  quarantine_object_count: number;
  quarantine_reason_counts: Record<string, number>;
};

type LogseqProperty = {
  key: string;
  value: string;
};

type LogseqBlock = {
  index: number;
  depth: number;
  text: string;
  properties: LogseqProperty[];
  source_block_ref: string;
};

type Reference = {
  kind: "wikilink" | "hash-tag" | "block-ref";
  value: string;
};

type EdgeCandidate = {
  index: number;
  source_text: string;
  predicate_text?: string;
  canonical_predicate?: string;
  canonicalization: "canonical" | "safe-alias" | "unknown-predicate" | "direction-unsafe-alias";
};

type TypedEdgeEndpoint = {
  title: string;
  type: TemporalEdge["source_type"];
};

type TypedEdgeParseResult =
  | { kind: "not-typed-edge" }
  | { kind: "promoted"; edge: TemporalEdge }
  | { kind: "rejected"; reason: "invalid-endpoint-type" | "invalid-temporal-edge-schema" };

type TypedEndpointParseResult =
  | { kind: "not-typed-endpoint" }
  | { kind: "promoted"; endpoint: EndpointRecord };

type EndpointTypeCanonicalization =
  | { ok: true; type: EndpointType; subtype?: string; source: "canonical" | "safe-alias" }
  | { ok: false; reason: "unknown-endpoint-type" };

type ParsedLogseqFile = {
  source_path_ref: string;
  source_kind: MarkdownImportSourceKind;
  page_title: string;
  byte_size: number;
  line_count: number;
  content_hash: `sha256:${string}`;
  source_markdown: string;
  page_properties: LogseqProperty[];
  blocks: LogseqBlock[];
  references: Reference[];
  edge_candidates: EdgeCandidate[];
};

type DraftObject = {
  plan: LogseqSemanticObjectPlan;
  object_type: ObjectType;
  semantic_kind: LogseqSemanticObjectKind;
  plaintext_payload: unknown;
};

type EndpointTitleIndexEntry = {
  endpoint?: EndpointRecord;
  count: number;
  resolution?: "exact-typed-title" | "exact-typed-alias";
};

type EndpointTitleIndex = Map<string, EndpointTitleIndexEntry>;
type ReviewResolutionIndex = Map<string, LogseqSemanticReviewResolution>;
type ReviewDeferralIndex = Map<string, LogseqSemanticReviewResolution>;
type PropertyTargetResolution = "wikilink" | "exact-typed-title" | "exact-typed-alias" | "review-resolution";
type PropertyEdgeTarget = {
  key: string;
  title: string;
  endpointType: EndpointType;
  resolution: PropertyTargetResolution;
  reviewTargetHash?: `sha256:${string}`;
  reviewDecision?: "map-to-endpoint" | "create-endpoint";
  aliases?: string[];
};

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function createLogseqSemanticReviewTargetHash(input: {
  pathRedactionSecret: string;
  reasonCode: string;
  value: string;
}): `sha256:${string}` {
  return sha256(`semantic-review-packet:v1:${input.pathRedactionSecret}:${input.reasonCode}:${input.value.trim().toLowerCase()}`);
}

function shortHash(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function sizeClass(byteSize: number): "tiny" | "small" | "medium" | "large" | "huge" {
  if (byteSize < 4_096) return "tiny";
  if (byteSize < 64_000) return "small";
  if (byteSize < 512_000) return "medium";
  if (byteSize < 5_000_000) return "large";
  return "huge";
}

function semanticObjectId(authorityId: string, kind: string, sourcePathRef: string, localRef: string): string {
  return ObjectIdSchema.parse(`la_object_${shortHash(`${authorityId}:logseq-semantic:v1:${kind}:${sourcePathRef}:${localRef}`)}`);
}

function semanticTitleObjectId(authorityId: string, pathRedactionSecret: string, title: string): string {
  return ObjectIdSchema.parse(`la_object_${shortHash(`${authorityId}:logseq-title-ref:v1:${pathRedactionSecret}:${title.trim().toLowerCase()}`)}`);
}

function semanticEdgeId(authorityId: string, sourcePathRef: string, index: number, sourceText: string): string {
  return `la_edge_${shortHash(`${authorityId}:logseq-edge:v1:${sourcePathRef}:${index}:${sourceText}`, 24)}`;
}

function sourceBlockRef(sourcePathRef: string, index: number, text: string): string {
  return `la_block_${shortHash(`${sourcePathRef}:${index}:${text}`, 24)}`;
}

function normalizedTitleFromSourcePath(sourcePath: string): string {
  const normalized = normalizeMarkdownSourcePath(sourcePath);
  const name = basename(normalized);
  return name.replace(/\.md$/i, "").trim() || "Untitled";
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

function extractPageProperties(lines: string[]): LogseqProperty[] {
  const properties: LogseqProperty[] = [];
  for (const line of lines) {
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

function extractBlocks(lines: string[], sourcePathRef: string): LogseqBlock[] {
  const blocks: LogseqBlock[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = /^(\s*)[-*]\s+(.*?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const text = match[2] ?? "";
    const property = parsePropertyLine(line);
    const depth = Math.floor((match[1] ?? "").replaceAll("\t", "  ").length / 2);
    const index = blocks.length + 1;
    blocks.push({
      index,
      depth,
      text,
      properties: property ? [property] : [],
      source_block_ref: sourceBlockRef(sourcePathRef, lineIndex + 1, text)
    });
  }
  return blocks;
}

function addReference(references: Reference[], kind: Reference["kind"], value: string | undefined): void {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }
  references.push({ kind, value: normalized });
}

function extractReferences(markdown: string): Reference[] {
  const references: Reference[] = [];
  for (const match of markdown.matchAll(/\[\[([^\]\n]{1,256})\]\]/g)) {
    addReference(references, "wikilink", match[1]?.split("|", 1)[0]?.split("#", 1)[0]);
  }
  for (const match of markdown.matchAll(/(^|[\s([{])#([A-Za-z0-9_/-]{1,80})/gm)) {
    addReference(references, "hash-tag", match[2]);
  }
  for (const match of markdown.matchAll(/\(\(([A-Za-z0-9_-]{3,128})\)\)/g)) {
    addReference(references, "block-ref", match[1]);
  }
  return references;
}

function edgeSectionLines(lines: string[]): string[] {
  const start = lines.findIndex((line) => /^#{2,6}\s+Edges\s*$/i.test(line.trim()));
  if (start < 0) {
    return [];
  }
  const output: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s+\S/.test(line)) {
      break;
    }
    if (/^\s*[-*]\s+\S/.test(line)) {
      output.push(line.replace(/^\s*[-*]\s+/, "").trim());
    }
  }
  return output;
}

function extractEdgeCandidates(lines: string[]): EdgeCandidate[] {
  const candidates: EdgeCandidate[] = [];
  for (const sourceText of edgeSectionLines(lines)) {
    let selected: EdgeCandidate | undefined;
    for (const token of sourceText.matchAll(/[A-Za-z][A-Za-z0-9-]{1,64}/g)) {
      const canonical = canonicalizePredicate(token[0]!.toLowerCase());
      if (canonical.ok) {
        selected = {
          index: candidates.length + 1,
          source_text: sourceText,
          predicate_text: token[0]!.toLowerCase(),
          canonical_predicate: canonical.predicate,
          canonicalization: canonical.source
        };
        break;
      }
      if (canonical.reason === "direction-unsafe-alias") {
        selected = {
          index: candidates.length + 1,
          source_text: sourceText,
          predicate_text: token[0]!.toLowerCase(),
          canonicalization: "direction-unsafe-alias"
        };
        break;
      }
    }
    candidates.push(selected ?? {
      index: candidates.length + 1,
      source_text: sourceText,
      canonicalization: "unknown-predicate"
    });
  }
  return candidates;
}

function normalizeEndpointTitle(value: string | undefined): string | undefined {
  const normalized = value?.split("|", 1)[0]?.split("#", 1)[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function endpointTitleIndexKey(type: EndpointType, title: string | undefined): string | undefined {
  const normalized = normalizeEndpointTitle(title)?.toLowerCase();
  return normalized ? `${type}:${normalized}` : undefined;
}

function parseTypedEndpoint(title: string | undefined, type: string | undefined): TypedEdgeEndpoint | undefined {
  const normalizedTitle = normalizeEndpointTitle(title);
  const parsedType = EndpointTypeSchema.safeParse(type?.toLowerCase());
  if (!normalizedTitle || !parsedType.success) {
    return undefined;
  }
  return {
    title: normalizedTitle,
    type: parsedType.data
  };
}

function parseTypedEdgeCandidate(edge: EdgeCandidate, options: {
  authorityId: string;
  sourcePathRef: string;
  sourceContentHash: `sha256:${string}`;
  pathRedactionSecret: string;
}): TypedEdgeParseResult {
  if (!edge.canonical_predicate) {
    return { kind: "not-typed-edge" };
  }

  const match = /^\s*(?:\[\[([^\]\n]{1,256})\]\]|([^()[\]\n]{1,256}?))\s+\(([A-Za-z][A-Za-z0-9-]{1,64})\)\s+([A-Za-z][A-Za-z0-9-]{1,64})\s+(?:\[\[([^\]\n]{1,256})\]\]|([^()[\]\n]{1,256}?))\s+\(([A-Za-z][A-Za-z0-9-]{1,64})\)(?:\s+(?:from|valid-from|valid_from)\s+(unknown|~?\d{4}(?:-\d{2}(?:-\d{2})?)?))?\s*$/i.exec(edge.source_text);
  if (!match) {
    return { kind: "not-typed-edge" };
  }

  const source = parseTypedEndpoint(match[1] ?? match[2], match[3]);
  const target = parseTypedEndpoint(match[5] ?? match[6], match[7]);
  if (!source || !target) {
    return { kind: "rejected", reason: "invalid-endpoint-type" };
  }

  const parsed = TemporalEdgeSchema.safeParse({
    edge_id: semanticEdgeId(options.authorityId, options.sourcePathRef, edge.index, edge.source_text),
    source_object_id: semanticTitleObjectId(options.authorityId, options.pathRedactionSecret, source.title),
    source_type: source.type,
    target_object_id: semanticTitleObjectId(options.authorityId, options.pathRedactionSecret, target.title),
    target_type: target.type,
    predicate: edge.canonical_predicate,
    valid_from: match[8] ?? "unknown",
    status: "active",
    confidence: "high",
    source: "logseq-edge-section",
    attrs: {
      source_path_ref: options.sourcePathRef,
      source_capsule_object_id: semanticObjectId(options.authorityId, "source-capsule", options.sourcePathRef, "source-capsule"),
      source_content_hash: options.sourceContentHash,
      source_text_hash: sha256(edge.source_text),
      canonicalization: edge.canonicalization
    }
  });
  return parsed.success
    ? { kind: "promoted", edge: parsed.data }
    : { kind: "rejected", reason: "invalid-temporal-edge-schema" };
}

function propertyValue(properties: LogseqProperty[], key: string): string | undefined {
  return properties.find((property) => property.key === key)?.value.trim();
}

function propertyValues(properties: LogseqProperty[], keys: string[]): string[] {
  const values: string[] = [];
  for (const key of keys) {
    const value = propertyValue(properties, key);
    if (value) {
      values.push(value);
    }
  }
  return values;
}

function allPropertyValues(properties: LogseqProperty[], key: string): string[] {
  return properties
    .filter((property) => property.key === key)
    .map((property) => property.value.trim())
    .filter((value) => value.length > 0);
}

function parseAliasList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return parseListValue(value)
    .map((part) => parseWikilinkTitle(part) ?? normalizeEndpointTitle(part) ?? part.trim())
    .filter((part, index, aliases) => part.length > 0 && aliases.indexOf(part) === index);
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

function parseWikilinkTitle(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const exact = /^\[\[([^\]\n]{1,256})\]\]$/.exec(normalized);
  if (!exact) {
    return undefined;
  }
  return normalizeEndpointTitle(exact[1]);
}

function parseWikilinkObjectId(value: string | undefined, options: {
  authorityId: string;
  pathRedactionSecret: string;
}): string | undefined {
  const title = parseWikilinkTitle(value);
  return title ? semanticTitleObjectId(options.authorityId, options.pathRedactionSecret, title) : undefined;
}

function parseWikilinkObjectIds(value: string | undefined, options: {
  authorityId: string;
  pathRedactionSecret: string;
}): string[] {
  return parseListValue(value)
    .map((part) => parseWikilinkObjectId(part, options))
    .filter((objectId): objectId is string => objectId !== undefined);
}

function unescapePropertyBlock(value: string | undefined): string | undefined {
  return value?.replaceAll("\\n", "\n").trim();
}

function addDefinedFields(target: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && (!Array.isArray(value) || value.length > 0)) {
      target[key] = value;
    }
  }
  return target;
}

function parseEndpointWithSubtypeFallback(
  candidate: Record<string, unknown>,
  subtype: string | undefined,
  minimalCandidate?: Record<string, unknown>
): TypedEndpointParseResult {
  const withSubtype = subtype ? { ...candidate, subtype } : candidate;
  const parsed = EndpointRecordSchema.safeParse(withSubtype);
  if (parsed.success) {
    return { kind: "promoted", endpoint: parsed.data };
  }
  if (subtype) {
    const withoutSubtype = EndpointRecordSchema.safeParse(candidate);
    if (withoutSubtype.success) {
      return { kind: "promoted", endpoint: withoutSubtype.data };
    }
  }
  if (minimalCandidate) {
    return parseEndpointWithSubtypeFallback(minimalCandidate, subtype);
  }
  return { kind: "not-typed-endpoint" };
}

function canonicalizeEndpointType(value: string | undefined): EndpointTypeCanonicalization {
  const normalized = value?.trim().toLowerCase();
  const canonical = EndpointTypeSchema.safeParse(normalized);
  if (canonical.success) {
    return { ok: true, type: canonical.data, source: "canonical" };
  }
  switch (normalized) {
    case "org":
    case "orgs":
    case "organisation":
    case "company":
      return { ok: true, type: "organization", source: "safe-alias" };
    case "place":
      return { ok: true, type: "location", source: "safe-alias" };
    case "event":
      return { ok: true, type: "occurrence", source: "safe-alias" };
    case "meeting":
      return { ok: true, type: "occurrence", subtype: "meeting", source: "safe-alias" };
    case "appointment":
      return { ok: true, type: "occurrence", subtype: "appointment", source: "safe-alias" };
    case "social":
      return { ok: true, type: "occurrence", subtype: "social", source: "safe-alias" };
    case "work-session":
      return { ok: true, type: "occurrence", subtype: "work-session", source: "safe-alias" };
    case "travel":
      return { ok: true, type: "occurrence", subtype: "travel", source: "safe-alias" };
    case "milestone":
      return { ok: true, type: "occurrence", subtype: "milestone", source: "safe-alias" };
    case "life-event":
      return { ok: true, type: "occurrence", subtype: "life-event", source: "safe-alias" };
    case "observation":
      return { ok: true, type: "occurrence", subtype: "observation", source: "safe-alias" };
    case "transaction":
      return { ok: true, type: "occurrence", subtype: "transaction", source: "safe-alias" };
    case "product":
      return { ok: true, type: "offering", subtype: "product", source: "safe-alias" };
    case "software-product":
    case "software_product":
    case "software":
    case "saas":
      return { ok: true, type: "offering", subtype: "software-product", source: "safe-alias" };
    case "hardware-product":
    case "hardware_product":
      return { ok: true, type: "offering", subtype: "hardware-product", source: "safe-alias" };
    case "service":
    case "services":
      return { ok: true, type: "offering", subtype: "service", source: "safe-alias" };
    case "subscription":
      return { ok: true, type: "offering", subtype: "subscription", source: "safe-alias" };
    case "membership":
      return { ok: true, type: "offering", subtype: "membership", source: "safe-alias" };
    case "hotel-room-type":
    case "hotel_room_type":
    case "suite":
      return { ok: true, type: "offering", subtype: "hotel-room-type", source: "safe-alias" };
    case "travel-class":
    case "travel_class":
    case "fare-class":
    case "fare_class":
      return { ok: true, type: "offering", subtype: normalized.replace(/_/g, "-") as "travel-class" | "fare-class", source: "safe-alias" };
    case "ticket-class":
    case "ticket_class":
      return { ok: true, type: "offering", subtype: "ticket-class", source: "safe-alias" };
    case "podcast":
    case "media":
      return { ok: true, type: "offering", subtype: "media", source: "safe-alias" };
    case "offering-package":
      return { ok: true, type: "offering", subtype: "package", source: "safe-alias" };
    case "device":
    case "document":
    case "ticket":
    case "reservation":
    case "receipt":
    case "file":
    case "photo":
    case "vehicle":
    case "seat":
    case "room":
    case "deliverable":
      return { ok: true, type: "item", subtype: normalized as "device" | "document" | "ticket" | "reservation" | "receipt" | "file" | "photo" | "vehicle" | "seat" | "room" | "deliverable", source: "safe-alias" };
    case "physical-item":
    case "physical_item":
      return { ok: true, type: "item", subtype: "physical-item", source: "safe-alias" };
    case "created-work":
    case "created_work":
      return { ok: true, type: "item", subtype: "created-work", source: "safe-alias" };
    default:
      return { ok: false, reason: "unknown-endpoint-type" };
  }
}

function parseTypedPageEndpoint(parsed: ParsedLogseqFile, options: {
  authorityId: string;
  pathRedactionSecret: string;
  createdAt: string;
  defaultAccessClass: AccessClass;
}): TypedEndpointParseResult {
  const type = canonicalizeEndpointType(propertyValue(parsed.page_properties, "type"));
  if (!type.ok) {
    return { kind: "not-typed-endpoint" };
  }

  const aliases = propertyValues(parsed.page_properties, ["alias", "aliases"]).flatMap(parseAliasList);
  const base = {
    object_id: semanticTitleObjectId(options.authorityId, options.pathRedactionSecret, parsed.page_title),
    type: type.type,
    name: parsed.page_title,
    aliases,
    access_class: options.defaultAccessClass,
    source_ref: parsed.source_path_ref,
    confidence: "high",
    created_at: options.createdAt,
    updated_at: options.createdAt
  };
  const subtype = propertyValue(parsed.page_properties, "subtype")?.toLowerCase() ?? type.subtype;
  const objectIdOptions = {
    authorityId: options.authorityId,
    pathRedactionSecret: options.pathRedactionSecret
  };
  const endpoint = { ...base };
  const minimalEndpoint = type.type === "occurrence"
    ? {
        ...base,
        occurred_on: propertyValue(parsed.page_properties, "occurred-on")
          ?? propertyValue(parsed.page_properties, "occurred_on")
          ?? propertyValue(parsed.page_properties, "date")
          ?? "unknown"
      }
    : { ...base };

  if (type.type === "person") {
    addDefinedFields(endpoint, {
      primary_location_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "primary-location")
          ?? propertyValue(parsed.page_properties, "location")
          ?? propertyValue(parsed.page_properties, "based-in"),
        objectIdOptions
      )
    });
  } else if (type.type === "organization") {
    addDefinedFields(endpoint, {
      founded_year: propertyValue(parsed.page_properties, "founded-year") ?? propertyValue(parsed.page_properties, "founded"),
      homepage_ref: propertyValue(parsed.page_properties, "homepage") ?? propertyValue(parsed.page_properties, "website"),
      primary_location_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "primary-location")
          ?? propertyValue(parsed.page_properties, "headquarters")
          ?? propertyValue(parsed.page_properties, "location")
          ?? propertyValue(parsed.page_properties, "based-in"),
        objectIdOptions
      )
    });
  } else if (type.type === "project") {
    addDefinedFields(endpoint, {
      status: propertyValue(parsed.page_properties, "status"),
      start_date: propertyValue(parsed.page_properties, "start-date") ?? propertyValue(parsed.page_properties, "start"),
      end_date: propertyValue(parsed.page_properties, "end-date") ?? propertyValue(parsed.page_properties, "end"),
      primary_location_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "primary-location") ?? propertyValue(parsed.page_properties, "location"),
        objectIdOptions
      )
    });
  } else if (type.type === "location") {
    addDefinedFields(endpoint, {
      parent_location_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "parent-location")
          ?? propertyValue(parsed.page_properties, "located-in"),
        objectIdOptions
      ),
      timezone: propertyValue(parsed.page_properties, "timezone")
    });
  } else if (type.type === "occurrence") {
    const timezone = propertyValue(parsed.page_properties, "timezone");
    const recurrenceSet = unescapePropertyBlock(
      propertyValue(parsed.page_properties, "recurrence-set") ?? propertyValue(parsed.page_properties, "recurrence_set")
    );
    const recurrence = timezone && recurrenceSet
      ? {
          timezone,
          recurrence_set: recurrenceSet,
          duration: propertyValue(parsed.page_properties, "duration")
        }
      : undefined;
    addDefinedFields(endpoint, {
      occurred_on: propertyValue(parsed.page_properties, "occurred-on")
        ?? propertyValue(parsed.page_properties, "occurred_on")
        ?? propertyValue(parsed.page_properties, "date")
        ?? "unknown",
      occurred_until: propertyValue(parsed.page_properties, "occurred-until") ?? propertyValue(parsed.page_properties, "occurred_until"),
      scheduled_start: propertyValue(parsed.page_properties, "scheduled-start") ?? propertyValue(parsed.page_properties, "scheduled_start"),
      scheduled_end: propertyValue(parsed.page_properties, "scheduled-end") ?? propertyValue(parsed.page_properties, "scheduled_end"),
      timezone,
      location_ref: parseWikilinkObjectId(propertyValue(parsed.page_properties, "location"), objectIdOptions),
      participant_refs: parseWikilinkObjectIds(
        propertyValue(parsed.page_properties, "participants") ?? propertyValue(parsed.page_properties, "participant"),
        objectIdOptions
      ),
      organizer_refs: parseWikilinkObjectIds(
        propertyValue(parsed.page_properties, "organizers")
          ?? propertyValue(parsed.page_properties, "organizer")
          ?? propertyValue(parsed.page_properties, "hosts")
          ?? propertyValue(parsed.page_properties, "host"),
        objectIdOptions
      ),
      project_refs: parseWikilinkObjectIds(
        propertyValue(parsed.page_properties, "projects") ?? propertyValue(parsed.page_properties, "project"),
        objectIdOptions
      ),
      recurrence,
      status: propertyValue(parsed.page_properties, "status")
    });
  } else if (type.type === "topic") {
    addDefinedFields(endpoint, {
      parent_topic_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "parent-topic") ?? propertyValue(parsed.page_properties, "part-of-topic"),
        objectIdOptions
      ),
      tags: parseListValue(propertyValue(parsed.page_properties, "tags")).map((tag) => tag.replace(/^#/, ""))
    });
  } else if (type.type === "offering") {
    addDefinedFields(endpoint, {
      provider_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "provider")
          ?? propertyValue(parsed.page_properties, "vendor")
          ?? propertyValue(parsed.page_properties, "organization")
          ?? propertyValue(parsed.page_properties, "org"),
        objectIdOptions
      ),
      homepage_ref: propertyValue(parsed.page_properties, "homepage") ?? propertyValue(parsed.page_properties, "website"),
      status: propertyValue(parsed.page_properties, "status")
    });
  } else if (type.type === "item") {
    addDefinedFields(endpoint, {
      offering_ref: parseWikilinkObjectId(
        propertyValue(parsed.page_properties, "offering")
          ?? propertyValue(parsed.page_properties, "product")
          ?? propertyValue(parsed.page_properties, "model"),
        objectIdOptions
      ),
      owner_ref: parseWikilinkObjectId(propertyValue(parsed.page_properties, "owner"), objectIdOptions),
      location_ref: parseWikilinkObjectId(propertyValue(parsed.page_properties, "location"), objectIdOptions),
      acquired_on: propertyValue(parsed.page_properties, "acquired-on")
        ?? propertyValue(parsed.page_properties, "acquired_on")
        ?? propertyValue(parsed.page_properties, "purchased-on")
        ?? propertyValue(parsed.page_properties, "purchased_on"),
      status: propertyValue(parsed.page_properties, "status")
    });
  }

  return parseEndpointWithSubtypeFallback(endpoint, subtype, minimalEndpoint);
}

function propertyEdgeTargetTitles(properties: LogseqProperty[], keys: string[]): Array<{ key: string; title: string }> {
  const targets: Array<{ key: string; title: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const value of propertyValues(properties, [key]).flatMap(parseListValue)) {
      const title = parseWikilinkTitle(value);
      if (!title) {
        continue;
      }
      const dedupeKey = title.toLowerCase();
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      targets.push({ key, title });
    }
  }
  return targets;
}

function resolveExactTypedEndpoint(
  endpointTitleIndex: EndpointTitleIndex | undefined,
  targetType: EndpointType,
  value: string
): { title: string; endpoint: EndpointRecord; resolution: "exact-typed-title" | "exact-typed-alias" } | undefined {
  if (parseWikilinkTitle(value)) {
    return undefined;
  }
  const key = endpointTitleIndexKey(targetType, value);
  if (!key) {
    return undefined;
  }
  const match = endpointTitleIndex?.get(key);
  if (!match?.endpoint || match.count !== 1 || !match.resolution) {
    return undefined;
  }
  return { title: match.endpoint.name, endpoint: match.endpoint, resolution: match.resolution };
}

function resolvesToAnyExactTypedEndpoint(
  endpointTitleIndex: EndpointTitleIndex | undefined,
  targetTypes: EndpointType[],
  value: string
): boolean {
  return targetTypes.some((targetType) => resolveExactTypedEndpoint(endpointTitleIndex, targetType, value) !== undefined);
}

function resolveReviewResolution(input: {
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  targetType: EndpointType;
  value: string;
}): {
  title: string;
  reviewTargetHash: `sha256:${string}`;
  reviewDecision: "map-to-endpoint" | "create-endpoint";
  aliases: string[];
} | undefined {
  const reviewTargetHash = createLogseqSemanticReviewTargetHash({
    pathRedactionSecret: input.pathRedactionSecret,
    reasonCode: input.reasonCode,
    value: input.value
  });
  const resolution = input.reviewResolutionIndex?.get(reviewTargetHash);
  if (
    !resolution
    || resolution.decision === "defer"
    || resolution.reason_code !== input.reasonCode
    || resolution.endpoint_type !== input.targetType
    || !resolution.endpoint_title
  ) {
    return undefined;
  }
  return {
    title: resolution.endpoint_title,
    reviewTargetHash,
    reviewDecision: resolution.decision,
    aliases: resolution.aliases
  };
}

function resolveReviewDeferral(input: {
  reviewDeferralIndex?: ReviewDeferralIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  value: string;
}): { reviewTargetHash: `sha256:${string}` } | undefined {
  const reviewTargetHash = createLogseqSemanticReviewTargetHash({
    pathRedactionSecret: input.pathRedactionSecret,
    reasonCode: input.reasonCode,
    value: input.value
  });
  const resolution = input.reviewDeferralIndex?.get(reviewTargetHash);
  if (!resolution || resolution.decision !== "defer" || resolution.reason_code !== input.reasonCode) {
    return undefined;
  }
  return { reviewTargetHash };
}

function resolvesToAnyTarget(input: {
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  targetTypes: EndpointType[];
  value: string;
}): boolean {
  if (resolvesToAnyExactTypedEndpoint(input.endpointTitleIndex, input.targetTypes, input.value)) {
    return true;
  }
  return input.targetTypes.some((targetType) => resolveReviewResolution({ ...input, targetType }) !== undefined);
}

function exactTypedEndpointPropertyTargets(
  properties: LogseqProperty[],
  keys: string[],
  targetType: EndpointType,
  endpointTitleIndex: EndpointTitleIndex | undefined,
  splitList: boolean
): PropertyEdgeTarget[] {
  const targets: PropertyEdgeTarget[] = [];
  const seen = new Set<string>();
  for (const target of nonWikilinkPropertyTargets(properties, keys, splitList)) {
    const resolved = resolveExactTypedEndpoint(endpointTitleIndex, targetType, target.value);
    if (!resolved) {
      continue;
    }
    const dedupeKey = `${targetType}:${resolved.title.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    targets.push({ key: target.key, title: resolved.title, endpointType: targetType, resolution: resolved.resolution });
  }
  return targets;
}

function reviewResolutionPropertyTargets(input: {
  properties: LogseqProperty[];
  keys: string[];
  targetType: EndpointType;
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  splitList: boolean;
}): PropertyEdgeTarget[] {
  const targets: PropertyEdgeTarget[] = [];
  const seen = new Set<string>();
  for (const target of nonWikilinkPropertyTargets(input.properties, input.keys, input.splitList)) {
    const resolved = resolveReviewResolution({
      reviewResolutionIndex: input.reviewResolutionIndex,
      pathRedactionSecret: input.pathRedactionSecret,
      reasonCode: input.reasonCode,
      targetType: input.targetType,
      value: target.value
    });
    if (!resolved) {
      continue;
    }
    const dedupeKey = `${input.targetType}:${resolved.title.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    targets.push({
      key: target.key,
      title: resolved.title,
      endpointType: input.targetType,
      resolution: "review-resolution",
      reviewTargetHash: resolved.reviewTargetHash,
      reviewDecision: resolved.reviewDecision,
      aliases: resolved.aliases
    });
  }
  return targets;
}

function propertyEdgeTargets(input: {
  properties: LogseqProperty[];
  keys: string[];
  targetType: EndpointType;
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  splitList?: boolean;
}): PropertyEdgeTarget[] {
  const targets: PropertyEdgeTarget[] = [];
  const seen = new Set<string>();
  const add = (target: PropertyEdgeTarget) => {
    const dedupeKey = `${input.targetType}:${target.title.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    targets.push(target);
  };

  for (const wikilink of propertyEdgeTargetTitles(input.properties, input.keys)) {
    add({ ...wikilink, endpointType: input.targetType, resolution: "wikilink" });
  }
  for (const exact of exactTypedEndpointPropertyTargets(
    input.properties,
    input.keys,
    input.targetType,
    input.endpointTitleIndex,
    input.splitList ?? false
  )) {
    add(exact);
  }
  for (const reviewed of reviewResolutionPropertyTargets({
    properties: input.properties,
    keys: input.keys,
    targetType: input.targetType,
    reviewResolutionIndex: input.reviewResolutionIndex,
    pathRedactionSecret: input.pathRedactionSecret,
    reasonCode: input.reasonCode,
    splitList: input.splitList ?? false
  })) {
    add(reviewed);
  }
  return targets;
}

function firstPropertyEdgeTarget(input: {
  properties: LogseqProperty[];
  keys: string[];
  targetType: EndpointType;
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
  reasonCode: string;
}): PropertyEdgeTarget | undefined {
  return propertyEdgeTargets(input)[0];
}

function propertyTargetAttrs(target: PropertyEdgeTarget): Record<string, unknown> {
  return target.reviewTargetHash
    ? { target_resolution: target.resolution, review_target_hash: target.reviewTargetHash }
    : { target_resolution: target.resolution };
}

function reviewCreatedEndpointRecord(input: {
  authorityId: string;
  pathRedactionSecret: string;
  createdAt: string;
  defaultAccessClass: AccessClass;
  sourcePathRef: string;
  target: PropertyEdgeTarget;
}): EndpointRecord | undefined {
  if (
    input.target.resolution !== "review-resolution"
    || input.target.reviewDecision !== "create-endpoint"
    || !input.target.reviewTargetHash
  ) {
    return undefined;
  }
  const parsed = EndpointRecordSchema.safeParse({
    object_id: semanticTitleObjectId(input.authorityId, input.pathRedactionSecret, input.target.title),
    type: input.target.endpointType,
    name: input.target.title,
    aliases: input.target.aliases ?? [],
    access_class: input.defaultAccessClass,
    source_ref: input.sourcePathRef,
    confidence: "high",
    created_at: input.createdAt,
    updated_at: input.createdAt
  });
  return parsed.success ? parsed.data : undefined;
}

function typedPropertyEdge(input: {
  authorityId: string;
  pathRedactionSecret: string;
  sourcePathRef: string;
  sourceContentHash: `sha256:${string}`;
  sourceObjectId: string;
  sourceType: TemporalEdge["source_type"];
  targetObjectId: string;
  targetType: TemporalEdge["target_type"];
  predicate: TemporalEdge["predicate"];
  propertyKey: string;
  sourceValueHash: `sha256:${string}`;
  status?: TemporalEdge["status"];
  attrs?: Record<string, unknown>;
}): TemporalEdge | undefined {
  const parsed = TemporalEdgeSchema.safeParse({
    edge_id: `la_edge_${shortHash(`${input.authorityId}:logseq-property-edge:v2:${input.sourcePathRef}:${input.predicate}:${input.propertyKey}:${input.sourceObjectId}:${input.targetObjectId}`, 24)}`,
    source_object_id: input.sourceObjectId,
    source_type: input.sourceType,
    target_object_id: input.targetObjectId,
    target_type: input.targetType,
    predicate: input.predicate,
    valid_from: "unknown",
    status: input.status ?? "active",
    confidence: "high",
    source: "logseq-page-property",
    attrs: {
      source_path_ref: input.sourcePathRef,
      source_capsule_object_id: semanticObjectId(input.authorityId, "source-capsule", input.sourcePathRef, "source-capsule"),
      source_content_hash: input.sourceContentHash,
      source_value_hash: input.sourceValueHash,
      property_key: input.propertyKey,
      ...input.attrs
    }
  });
  return parsed.success ? parsed.data : undefined;
}

function typedCurrentPagePropertyEdge(input: {
  authorityId: string;
  pathRedactionSecret: string;
  sourcePathRef: string;
  sourceContentHash: `sha256:${string}`;
  sourceEndpoint: EndpointRecord;
  targetTitle: string;
  targetType: TemporalEdge["target_type"];
  predicate: TemporalEdge["predicate"];
  propertyKey: string;
  status?: TemporalEdge["status"];
  attrs?: Record<string, unknown>;
}): TemporalEdge | undefined {
  return typedPropertyEdge({
    authorityId: input.authorityId,
    pathRedactionSecret: input.pathRedactionSecret,
    sourcePathRef: input.sourcePathRef,
    sourceContentHash: input.sourceContentHash,
    sourceObjectId: input.sourceEndpoint.object_id,
    sourceType: input.sourceEndpoint.type,
    targetObjectId: semanticTitleObjectId(input.authorityId, input.pathRedactionSecret, input.targetTitle),
    targetType: input.targetType,
    predicate: input.predicate,
    propertyKey: input.propertyKey,
    sourceValueHash: sha256(`${input.propertyKey}:${input.targetTitle}`),
    status: input.status,
    attrs: input.attrs
  });
}

function taggedSuffixes(properties: LogseqProperty[]): Array<{ title: string; suffix: string }> {
  const tags = allPropertyValues(properties, "tags");
  const targets: Array<{ title: string; suffix: string }> = [];
  const seen = new Set<string>();
  for (const tagValue of tags) {
    for (const match of tagValue.matchAll(/\[\[([^\]\n]{1,256})\]\]-([A-Za-z0-9][A-Za-z0-9-]{0,80})/g)) {
      const title = normalizeEndpointTitle(match[1]);
      const suffix = match[2]?.toLowerCase();
      if (!title || !suffix) {
        continue;
      }
      const dedupeKey = `${title.toLowerCase()}:${suffix}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      targets.push({ title, suffix });
    }
  }
  return targets;
}

function suffixTagReviewReason(suffix: string): string | undefined {
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

function suffixTagReviewCandidates(parsed: ParsedLogseqFile, endpoint: EndpointRecord): Array<{ title: string; suffix: string; reason: string }> {
  if (endpoint.type !== "organization") {
    return [];
  }
  return taggedSuffixes(parsed.page_properties)
    .map((tagged) => ({ ...tagged, reason: suffixTagReviewReason(tagged.suffix) }))
    .filter((tagged): tagged is { title: string; suffix: string; reason: string } => tagged.reason !== undefined);
}

function reviewDeferralAttrs(input: {
  reviewDeferralIndex?: ReviewDeferralIndex;
  pathRedactionSecret: string;
  reasonCode: string;
  value: string;
}): Record<string, unknown> {
  const deferred = resolveReviewDeferral(input);
  return deferred
    ? {
        review_resolution: "defer",
        review_target_hash: deferred.reviewTargetHash
      }
    : {};
}

function nonWikilinkPropertyTargets(properties: LogseqProperty[], keys: string[], splitList: boolean): Array<{ key: string; value: string }> {
  const targets: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const rawValue of allPropertyValues(properties, key)) {
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

function nonWikilinkPropertyReviewCandidates(
  parsed: ParsedLogseqFile,
  endpoint: EndpointRecord,
  options: {
    endpointTitleIndex?: EndpointTitleIndex;
    reviewResolutionIndex?: ReviewResolutionIndex;
    pathRedactionSecret: string;
  }
): Array<{ key: string; value: string; reason: string }> {
  const candidates: Array<{ key: string; value: string; reason: string }> = [];
  const add = (keys: string[], reason: string, targetTypes: EndpointType[], splitList = false) => {
    candidates.push(...nonWikilinkPropertyTargets(parsed.page_properties, keys, splitList)
      .filter((target) => !resolvesToAnyTarget({
        endpointTitleIndex: options.endpointTitleIndex,
        reviewResolutionIndex: options.reviewResolutionIndex,
        pathRedactionSecret: options.pathRedactionSecret,
        reasonCode: reason,
        targetTypes,
        value: target.value
      }))
      .map((target) => ({ ...target, reason })));
  };

  if (endpoint.type === "person") {
    add(["primary-location", "location", "based-in"], "non-wikilink-location-review", ["location"]);
    add(["org", "organization", "employer-current", "employer-historical"], "non-wikilink-organization-review", ["organization"], true);
    add(["spouse", "estranged-from"], "non-wikilink-person-review", ["person"]);
  } else if (endpoint.type === "organization") {
    add(["primary-location", "headquarters", "location", "based-in"], "non-wikilink-location-review", ["location"]);
    add(["acquired-by", "customer-of"], "non-wikilink-organization-review", ["organization"], true);
  } else if (endpoint.type === "project") {
    add(["primary-location", "location"], "non-wikilink-location-review", ["location"]);
  } else if (endpoint.type === "occurrence") {
    add(["location"], "non-wikilink-location-review", ["location"]);
    add(["participants", "participant", "organizers", "organizer", "hosts", "host"], "non-wikilink-participant-review", ["person", "organization"], true);
    add(["projects", "project"], "non-wikilink-project-review", ["project"], true);
  } else if (endpoint.type === "location") {
    add(["parent-location", "located-in"], "non-wikilink-location-review", ["location"]);
  } else if (endpoint.type === "topic") {
    add(["parent-topic", "part-of-topic"], "non-wikilink-topic-review", ["topic"]);
  }

  return candidates;
}

function reviewCreatedEndpointTargetsForEndpoint(parsed: ParsedLogseqFile, options: {
  endpoint: EndpointRecord;
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
  pathRedactionSecret: string;
}): PropertyEdgeTarget[] {
  const targets: PropertyEdgeTarget[] = [];
  const addTargets = (input: {
    keys: string[];
    targetType: EndpointType;
    reasonCode: string;
    splitList?: boolean;
  }) => {
    targets.push(...propertyEdgeTargets({
      properties: parsed.page_properties,
      keys: input.keys,
      targetType: input.targetType,
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: input.reasonCode,
      splitList: input.splitList
    }).filter((target) => target.reviewDecision === "create-endpoint"));
  };

  if (options.endpoint.type === "person") {
    addTargets({ keys: ["primary-location", "location", "based-in"], targetType: "location", reasonCode: "non-wikilink-location-review" });
    addTargets({ keys: ["org", "organization", "employer-current", "employer-historical"], targetType: "organization", reasonCode: "non-wikilink-organization-review", splitList: true });
    addTargets({ keys: ["spouse", "estranged-from"], targetType: "person", reasonCode: "non-wikilink-person-review" });
  } else if (options.endpoint.type === "organization") {
    addTargets({ keys: ["primary-location", "headquarters", "location", "based-in"], targetType: "location", reasonCode: "non-wikilink-location-review" });
    addTargets({ keys: ["acquired-by", "customer-of"], targetType: "organization", reasonCode: "non-wikilink-organization-review", splitList: true });
  } else if (options.endpoint.type === "occurrence") {
    addTargets({ keys: ["location"], targetType: "location", reasonCode: "non-wikilink-location-review" });
  } else if (options.endpoint.type === "topic") {
    addTargets({ keys: ["parent-topic", "part-of-topic"], targetType: "topic", reasonCode: "non-wikilink-topic-review" });
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const dedupeKey = `${target.endpointType}:${target.title.toLowerCase()}`;
    if (seen.has(dedupeKey)) {
      return false;
    }
    seen.add(dedupeKey);
    return true;
  });
}

function propertyEdgesForEndpoint(parsed: ParsedLogseqFile, options: {
  authorityId: string;
  pathRedactionSecret: string;
  endpoint: EndpointRecord;
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
}): TemporalEdge[] {
  const edgesById = new Map<string, TemporalEdge>();
  const addEdge = (edge: TemporalEdge | undefined) => {
    if (edge) {
      edgesById.set(edge.edge_id, edge);
    }
  };
  const common = {
    authorityId: options.authorityId,
    pathRedactionSecret: options.pathRedactionSecret,
    sourcePathRef: parsed.source_path_ref,
    sourceContentHash: parsed.content_hash,
    sourceEndpoint: options.endpoint
  };

  if (options.endpoint.type === "person") {
    const target = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["primary-location", "location", "based-in"],
      targetType: "location",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-location-review"
    });
    addEdge(target ? typedCurrentPagePropertyEdge({
      ...common,
      targetTitle: target.title,
      targetType: "location",
      predicate: "based-in",
      propertyKey: target.key,
      attrs: propertyTargetAttrs(target)
    }) : undefined);
    for (const employer of propertyEdgeTargets({
      properties: parsed.page_properties,
      keys: ["org", "organization", "employer-current", "employer-historical"],
      targetType: "organization",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-organization-review",
      splitList: true
    })) {
      addEdge(typedCurrentPagePropertyEdge({
        ...common,
        targetTitle: employer.title,
        targetType: "organization",
        predicate: "employed-by",
        propertyKey: employer.key,
        status: employer.key === "employer-historical" ? "ended" : "active",
        attrs: propertyTargetAttrs(employer)
      }));
    }
    const spouse = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["spouse"],
      targetType: "person",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-person-review"
    });
    addEdge(spouse ? typedCurrentPagePropertyEdge({ ...common, targetTitle: spouse.title, targetType: "person", predicate: "spouse-of", propertyKey: spouse.key, attrs: propertyTargetAttrs(spouse) }) : undefined);
    const estranged = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["estranged-from"],
      targetType: "person",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-person-review"
    });
    addEdge(estranged ? typedCurrentPagePropertyEdge({ ...common, targetTitle: estranged.title, targetType: "person", predicate: "estranged-from", propertyKey: estranged.key, attrs: propertyTargetAttrs(estranged) }) : undefined);
  } else if (options.endpoint.type === "organization") {
    const target = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["primary-location", "headquarters", "location", "based-in"],
      targetType: "location",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-location-review"
    });
    addEdge(target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "location", predicate: "based-in", propertyKey: target.key, attrs: propertyTargetAttrs(target) }) : undefined);
    const acquirer = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["acquired-by"],
      targetType: "organization",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-organization-review"
    });
    addEdge(acquirer ? typedCurrentPagePropertyEdge({ ...common, targetTitle: acquirer.title, targetType: "organization", predicate: "acquired-by", propertyKey: acquirer.key, attrs: propertyTargetAttrs(acquirer) }) : undefined);
    const customerTarget = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["customer-of"],
      targetType: "organization",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-organization-review"
    });
    addEdge(customerTarget ? typedCurrentPagePropertyEdge({ ...common, targetTitle: customerTarget.title, targetType: "organization", predicate: "customer-of", propertyKey: customerTarget.key, attrs: propertyTargetAttrs(customerTarget) }) : undefined);
    for (const tagged of taggedSuffixes(parsed.page_properties)) {
      const sourceObjectId = semanticTitleObjectId(options.authorityId, options.pathRedactionSecret, tagged.title);
      const reverseCommon = {
        authorityId: options.authorityId,
        pathRedactionSecret: options.pathRedactionSecret,
        sourcePathRef: parsed.source_path_ref,
        sourceContentHash: parsed.content_hash,
        targetObjectId: options.endpoint.object_id,
        propertyKey: "tags",
        sourceValueHash: sha256(`tags:${tagged.title}:${tagged.suffix}`),
        attrs: { tag_suffix: tagged.suffix }
      };
      if (tagged.suffix === "employer-past") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "employed-by", status: "ended" });
        addEdge(edge);
      } else if (tagged.suffix === "education") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "alumnus-of" });
        addEdge(edge);
      } else if (tagged.suffix === "cohort") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "member-of" });
        addEdge(edge);
      } else if (tagged.suffix === "revenue") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "organization", targetType: "organization", predicate: "customer-of" });
        addEdge(edge);
      } else if (tagged.suffix === "advisory-past") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "advises", status: "ended" });
        addEdge(edge);
      }
    }
  } else if (options.endpoint.type === "occurrence") {
    const target = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["location"],
      targetType: "location",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-location-review"
    });
    addEdge(target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "location", predicate: "occurred-at", propertyKey: target.key, attrs: propertyTargetAttrs(target) }) : undefined);
  } else if (options.endpoint.type === "topic") {
    const target = firstPropertyEdgeTarget({
      properties: parsed.page_properties,
      keys: ["parent-topic", "part-of-topic"],
      targetType: "topic",
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret,
      reasonCode: "non-wikilink-topic-review"
    });
    addEdge(target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "topic", predicate: "part-of-topic", propertyKey: target.key, attrs: propertyTargetAttrs(target) }) : undefined);
  }

  return [...edgesById.values()];
}

function parseLogseqFile(input: MarkdownFileInput, pathRedactionSecret: string): ParsedLogseqFile {
  const parsed = MarkdownFileInputSchema.parse(input);
  const lines = parsed.markdown.split(/\r?\n/);
  const sourcePathRef = createMarkdownSourceRef(parsed.source_path, { path_redaction_secret: pathRedactionSecret });
  return {
    source_path_ref: sourcePathRef,
    source_kind: parsed.source_kind,
    page_title: normalizedTitleFromSourcePath(parsed.source_path),
    byte_size: Buffer.byteLength(parsed.markdown, "utf8"),
    line_count: parsed.markdown.length === 0 ? 0 : lines.length,
    content_hash: sha256(parsed.markdown),
    source_markdown: parsed.markdown,
    page_properties: extractPageProperties(lines),
    blocks: extractBlocks(lines, sourcePathRef),
    references: extractReferences(parsed.markdown),
    edge_candidates: extractEdgeCandidates(lines)
  };
}

function referenceDigest(kind: Reference["kind"], value: string, pathRedactionSecret: string): `sha256:${string}` {
  return sha256(`logseq-reference:v1:${pathRedactionSecret}:${kind}:${value.trim().toLowerCase()}`);
}

function referenceSummary(references: Reference[], pathRedactionSecret: string): Array<{
  kind: Reference["kind"];
  ref_hash: `sha256:${string}`;
  occurrences: number;
}> {
  const grouped = new Map<string, { kind: Reference["kind"]; ref_hash: `sha256:${string}`; occurrences: number }>();
  for (const reference of references) {
    const refHash = referenceDigest(reference.kind, reference.value, pathRedactionSecret);
    const key = `${reference.kind}:${refHash}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      grouped.set(key, { kind: reference.kind, ref_hash: refHash, occurrences: 1 });
    }
  }
  return [...grouped.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.ref_hash.localeCompare(right.ref_hash));
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function emptyEndpointTypeRecord(): Record<EndpointType, number> {
  return {
    person: 0,
    organization: 0,
    project: 0,
    location: 0,
    occurrence: 0,
    topic: 0,
    offering: 0,
    item: 0
  };
}

function emptyObjectTypeRecord(): Record<ObjectType, number> {
  return {
    page: 0,
    block: 0,
    entity: 0,
    assertion: 0,
    edge: 0,
    event: 0,
    index: 0,
    attachment: 0,
    evidence: 0,
    review: 0,
    manifest: 0,
    audit: 0,
    change: 0,
    config: 0
  };
}

function emptySemanticKindRecord(): Record<LogseqSemanticObjectKind, number> {
  return {
    "source-capsule": 0,
    page: 0,
    block: 0,
    "reference-index": 0,
    "typed-endpoint": 0,
    "edge-candidate": 0,
    "typed-edge": 0
  };
}

function sortedNumberRecord(source: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(source).sort(([left], [right]) => left.localeCompare(right)));
}

function plannedObject(input: {
  authorityId: string;
  sourcePathRef: string;
  objectId?: string;
  semanticKind: LogseqSemanticObjectKind;
  objectType: "page" | "block" | "edge" | "index" | "attachment";
  localRef: string;
  accessClass: AccessClass;
  sourceBlockRef?: string;
  decision: LogseqSemanticDecision;
  reasonCode: string;
  plaintextPayload: unknown;
}): DraftObject {
  const objectId = input.objectId ?? semanticObjectId(input.authorityId, input.semanticKind, input.sourcePathRef, input.localRef);
  return {
    plan: LogseqSemanticObjectPlanSchema.parse({
      object_id: objectId,
      object_type: input.objectType,
      semantic_kind: input.semanticKind,
      access_class: input.accessClass,
      source_path_ref: input.sourcePathRef,
      source_block_ref: input.sourceBlockRef,
      decision: input.decision,
      reason_code: input.reasonCode,
      plaintext_in_plan: false
    }),
    object_type: input.objectType,
    semantic_kind: input.semanticKind,
    plaintext_payload: input.plaintextPayload
  };
}

function draftObjectsForFile(parsed: ParsedLogseqFile, options: {
  authorityId: string;
  pathRedactionSecret: string;
  createdAt: string;
  defaultAccessClass: AccessClass;
  endpointTitleIndex?: EndpointTitleIndex;
  reviewResolutionIndex?: ReviewResolutionIndex;
  reviewDeferralIndex?: ReviewDeferralIndex;
  createdReviewEndpointIds?: Set<string>;
}): DraftObject[] {
  const drafts: DraftObject[] = [];
  drafts.push(plannedObject({
    authorityId: options.authorityId,
    sourcePathRef: parsed.source_path_ref,
    semanticKind: "source-capsule",
    objectType: "attachment",
    localRef: "source-capsule",
    accessClass: options.defaultAccessClass,
    decision: "captured-encrypted",
    reasonCode: "source-capsule-preserved",
    plaintextPayload: {
      kind: "logseq-source-capsule",
      source_path_ref: parsed.source_path_ref,
      source_kind: parsed.source_kind,
      content_hash: parsed.content_hash,
      markdown: parsed.source_markdown
    }
  }));

  drafts.push(plannedObject({
    authorityId: options.authorityId,
    sourcePathRef: parsed.source_path_ref,
    semanticKind: "page",
    objectType: "page",
    localRef: "page",
    accessClass: options.defaultAccessClass,
    decision: "captured-encrypted",
    reasonCode: "page-normalized",
    plaintextPayload: {
      kind: "logseq-page",
      title: parsed.page_title,
      source_path_ref: parsed.source_path_ref,
      source_kind: parsed.source_kind,
      properties: parsed.page_properties,
      content_hash: parsed.content_hash
    }
  }));

  const typedEndpoint = parseTypedPageEndpoint(parsed, options);
  if (typedEndpoint.kind === "promoted") {
    drafts.push(plannedObject({
      authorityId: options.authorityId,
      sourcePathRef: parsed.source_path_ref,
      objectId: typedEndpoint.endpoint.object_id,
      semanticKind: "typed-endpoint",
      objectType: "page",
      localRef: `typed-endpoint:${typedEndpoint.endpoint.type}`,
      accessClass: options.defaultAccessClass,
      decision: "captured-encrypted",
      reasonCode: "typed-endpoint-promoted",
      plaintextPayload: {
        kind: "logseq-endpoint",
        source_path_ref: parsed.source_path_ref,
        endpoint: typedEndpoint.endpoint
      }
    }));
    for (const edge of propertyEdgesForEndpoint(parsed, {
      authorityId: options.authorityId,
      pathRedactionSecret: options.pathRedactionSecret,
      endpoint: typedEndpoint.endpoint,
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex
    })) {
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        semanticKind: "typed-edge",
        objectType: "edge",
        localRef: `property-edge:${edge.edge_id}`,
        accessClass: options.defaultAccessClass,
        decision: "captured-encrypted",
        reasonCode: "property-edge-promoted",
        plaintextPayload: {
          kind: "logseq-temporal-edge",
          source_path_ref: parsed.source_path_ref,
          edge
        }
      }));
    }
    for (const target of reviewCreatedEndpointTargetsForEndpoint(parsed, {
      endpoint: typedEndpoint.endpoint,
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret
    })) {
      const endpoint = reviewCreatedEndpointRecord({
        authorityId: options.authorityId,
        pathRedactionSecret: options.pathRedactionSecret,
        createdAt: options.createdAt,
        defaultAccessClass: options.defaultAccessClass,
        sourcePathRef: parsed.source_path_ref,
        target
      });
      if (!endpoint || options.createdReviewEndpointIds?.has(endpoint.object_id)) {
        continue;
      }
      options.createdReviewEndpointIds?.add(endpoint.object_id);
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        objectId: endpoint.object_id,
        semanticKind: "typed-endpoint",
        objectType: "page",
        localRef: `review-endpoint:${target.reviewTargetHash}`,
        accessClass: options.defaultAccessClass,
        decision: "captured-encrypted",
        reasonCode: "review-endpoint-created",
        plaintextPayload: {
          kind: "logseq-endpoint",
          source_path_ref: parsed.source_path_ref,
          review_target_hash: target.reviewTargetHash,
          endpoint
        }
      }));
    }
    for (const candidate of suffixTagReviewCandidates(parsed, typedEndpoint.endpoint)) {
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        semanticKind: "edge-candidate",
        objectType: "edge",
        localRef: `suffix-tag-review:${shortHash(`${candidate.title}:${candidate.suffix}`, 24)}`,
        accessClass: "quarantine",
        decision: "quarantined",
        reasonCode: candidate.reason,
        plaintextPayload: {
          kind: "logseq-edge-candidate",
          source_path_ref: parsed.source_path_ref,
          source_text: `[[${candidate.title}]]-${candidate.suffix}`,
          predicate_text: candidate.suffix,
          canonical_predicate: undefined,
          canonicalization: "suffix-tag-review",
          source_value_hash: sha256(`tags:${candidate.title}:${candidate.suffix}`),
          tag_suffix: candidate.suffix,
          ...reviewDeferralAttrs({
            reviewDeferralIndex: options.reviewDeferralIndex,
            pathRedactionSecret: options.pathRedactionSecret,
            reasonCode: candidate.reason,
            value: candidate.title
          })
        }
      }));
    }
    for (const candidate of nonWikilinkPropertyReviewCandidates(parsed, typedEndpoint.endpoint, {
      endpointTitleIndex: options.endpointTitleIndex,
      reviewResolutionIndex: options.reviewResolutionIndex,
      pathRedactionSecret: options.pathRedactionSecret
    })) {
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        semanticKind: "edge-candidate",
        objectType: "edge",
        localRef: `property-review:${shortHash(`${candidate.key}:${candidate.value}`, 24)}`,
        accessClass: "quarantine",
        decision: "quarantined",
        reasonCode: candidate.reason,
        plaintextPayload: {
          kind: "logseq-edge-candidate",
          source_path_ref: parsed.source_path_ref,
          source_text: `${candidate.key}:: ${candidate.value}`,
          predicate_text: candidate.key,
          canonical_predicate: undefined,
          canonicalization: "non-wikilink-property-review",
          source_value_hash: sha256(`${candidate.key}:${candidate.value}`),
          property_key: candidate.key,
          ...reviewDeferralAttrs({
            reviewDeferralIndex: options.reviewDeferralIndex,
            pathRedactionSecret: options.pathRedactionSecret,
            reasonCode: candidate.reason,
            value: candidate.value
          })
        }
      }));
    }
  }

  for (const block of parsed.blocks) {
    drafts.push(plannedObject({
      authorityId: options.authorityId,
      sourcePathRef: parsed.source_path_ref,
      semanticKind: "block",
      objectType: "block",
      localRef: block.source_block_ref,
      accessClass: options.defaultAccessClass,
      sourceBlockRef: block.source_block_ref,
      decision: "captured-encrypted",
      reasonCode: "block-normalized",
      plaintextPayload: {
        kind: "logseq-block",
        source_path_ref: parsed.source_path_ref,
        source_block_ref: block.source_block_ref,
        index: block.index,
        depth: block.depth,
        text: block.text,
        properties: block.properties
      }
    }));
  }

  const references = referenceSummary(parsed.references, options.pathRedactionSecret);
  if (references.length > 0) {
    drafts.push(plannedObject({
      authorityId: options.authorityId,
      sourcePathRef: parsed.source_path_ref,
      semanticKind: "reference-index",
      objectType: "index",
      localRef: "references",
      accessClass: options.defaultAccessClass,
      decision: "captured-encrypted",
      reasonCode: "references-indexed",
      plaintextPayload: {
        kind: "logseq-reference-index",
        source_path_ref: parsed.source_path_ref,
        references
      }
    }));
  }

  for (const edge of parsed.edge_candidates) {
    const valid = edge.canonicalization === "canonical" || edge.canonicalization === "safe-alias";
    const typedEdge = valid
      ? parseTypedEdgeCandidate(edge, {
          authorityId: options.authorityId,
          sourcePathRef: parsed.source_path_ref,
          sourceContentHash: parsed.content_hash,
          pathRedactionSecret: options.pathRedactionSecret
        })
      : undefined;

    if (typedEdge?.kind === "promoted") {
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        semanticKind: "typed-edge",
        objectType: "edge",
        localRef: `typed-edge:${edge.index}`,
        accessClass: options.defaultAccessClass,
        decision: "captured-encrypted",
        reasonCode: "typed-edge-promoted",
        plaintextPayload: {
          kind: "logseq-temporal-edge",
          source_path_ref: parsed.source_path_ref,
          edge: typedEdge.edge
        }
      }));
      continue;
    }

    if (typedEdge?.kind === "rejected") {
      drafts.push(plannedObject({
        authorityId: options.authorityId,
        sourcePathRef: parsed.source_path_ref,
        semanticKind: "edge-candidate",
        objectType: "edge",
        localRef: `edge:${edge.index}`,
        accessClass: "quarantine",
        decision: "quarantined",
        reasonCode: typedEdge.reason,
        plaintextPayload: {
          kind: "logseq-edge-candidate",
          source_path_ref: parsed.source_path_ref,
          index: edge.index,
          source_text: edge.source_text,
          predicate_text: edge.predicate_text,
          canonical_predicate: edge.canonical_predicate,
          canonicalization: edge.canonicalization
        }
      }));
      continue;
    }

    drafts.push(plannedObject({
      authorityId: options.authorityId,
      sourcePathRef: parsed.source_path_ref,
      semanticKind: "edge-candidate",
      objectType: "edge",
      localRef: `edge:${edge.index}`,
      accessClass: "quarantine",
      decision: "quarantined",
      reasonCode: valid ? "ambiguous-edge-endpoints" : edge.canonicalization,
      plaintextPayload: {
        kind: "logseq-edge-candidate",
        source_path_ref: parsed.source_path_ref,
        index: edge.index,
        source_text: edge.source_text,
        predicate_text: edge.predicate_text,
        canonical_predicate: edge.canonical_predicate,
        canonicalization: edge.canonicalization
      }
    }));
  }

  return drafts;
}

function addEndpointTitleIndexEntry(
  index: EndpointTitleIndex,
  endpoint: EndpointRecord,
  resolution: "exact-typed-title" | "exact-typed-alias",
  value: string | undefined
): void {
  const key = endpointTitleIndexKey(endpoint.type, value);
  if (!key) {
    return;
  }
  const existing = index.get(key);
  if (!existing) {
    index.set(key, { endpoint, count: 1, resolution });
    return;
  }
  if (existing.endpoint?.object_id === endpoint.object_id) {
    if (existing.resolution !== "exact-typed-title" && resolution === "exact-typed-title") {
      index.set(key, { endpoint, count: existing.count, resolution });
    }
    return;
  }
  index.set(key, { count: existing.count + 1 });
}

function buildEndpointTitleIndex(parsedFiles: ParsedLogseqFile[], options: {
  authorityId: string;
  pathRedactionSecret: string;
  createdAt: string;
  defaultAccessClass: AccessClass;
}): EndpointTitleIndex {
  const index: EndpointTitleIndex = new Map();
  for (const parsed of parsedFiles) {
    const typedEndpoint = parseTypedPageEndpoint(parsed, options);
    if (typedEndpoint.kind !== "promoted") {
      continue;
    }
    addEndpointTitleIndexEntry(index, typedEndpoint.endpoint, "exact-typed-title", typedEndpoint.endpoint.name);
    for (const alias of typedEndpoint.endpoint.aliases) {
      addEndpointTitleIndexEntry(index, typedEndpoint.endpoint, "exact-typed-alias", alias);
    }
  }
  return index;
}

function collectTypedEndpointObjectIds(parsedFiles: ParsedLogseqFile[], options: {
  authorityId: string;
  pathRedactionSecret: string;
  createdAt: string;
  defaultAccessClass: AccessClass;
}): Set<string> {
  const objectIds = new Set<string>();
  for (const parsed of parsedFiles) {
    const typedEndpoint = parseTypedPageEndpoint(parsed, options);
    if (typedEndpoint.kind === "promoted") {
      objectIds.add(typedEndpoint.endpoint.object_id);
    }
  }
  return objectIds;
}

function buildReviewResolutionIndex(resolutions: LogseqSemanticReviewResolution[] | undefined): ReviewResolutionIndex {
  const index: ReviewResolutionIndex = new Map();
  const seen = new Set<string>();
  for (const resolution of resolutions ?? []) {
    const parsed = LogseqSemanticReviewResolutionSchema.parse(resolution);
    if (seen.has(parsed.target_hash)) {
      throw new Error(`duplicate semantic review resolution for ${parsed.target_hash}`);
    }
    seen.add(parsed.target_hash);
    if (parsed.decision === "defer") {
      continue;
    }
    index.set(parsed.target_hash, parsed);
  }
  return index;
}

function buildReviewDeferralIndex(resolutions: LogseqSemanticReviewResolution[] | undefined): ReviewDeferralIndex {
  const index: ReviewDeferralIndex = new Map();
  for (const resolution of resolutions ?? []) {
    const parsed = LogseqSemanticReviewResolutionSchema.parse(resolution);
    if (parsed.decision === "defer") {
      index.set(parsed.target_hash, parsed);
    }
  }
  return index;
}

function emptyTotals(): LogseqSemanticParityLedger["totals"] {
  return {
    bytes: 0,
    lines: 0,
    pages: 0,
    blocks: 0,
    page_properties: 0,
    block_properties: 0,
    wikilinks: 0,
    hash_tags: 0,
    block_refs: 0,
    reference_index_objects: 0,
    edge_candidates: 0,
    valid_edge_candidates: 0,
    quarantined_edge_candidates: 0,
    planned_objects: 0,
    page_objects: 0,
    block_objects: 0,
    reference_index_objects_planned: 0,
    source_capsule_objects: 0,
    edge_objects: 0,
    quarantine_objects: 0,
    terminal_migrated: 0,
    terminal_skipped: 0,
    terminal_quarantined: 0
  };
}

function ledgerFromDrafts(input: {
  authorityId: string;
  createdAt: string;
  parsedFiles: ParsedLogseqFile[];
  draftsBySourceRef: Map<string, DraftObject[]>;
}): LogseqSemanticParityLedger {
  const totals = emptyTotals();
  const decisions: Record<string, number> = {};
  const files: LogseqSemanticFileLedger[] = [];

  for (const parsed of input.parsedFiles) {
    const drafts = input.draftsBySourceRef.get(parsed.source_path_ref) ?? [];
    const edgeDrafts = drafts.filter((draft) => draft.plan.object_type === "edge");
    const quarantinedEdgeCandidates = edgeDrafts.filter((draft) => draft.plan.access_class === "quarantine").length;
    const validEdgeCandidates = edgeDrafts.length - quarantinedEdgeCandidates;
    const referenceIndexes = drafts.filter((draft) => draft.plan.semantic_kind === "reference-index").length;
    const sourceCapsules = drafts.filter((draft) => draft.plan.semantic_kind === "source-capsule").length;
    const blockPropertyCount = parsed.blocks.reduce((sum, block) => sum + block.properties.length, 0);
    const quarantineObjects = drafts.filter((draft) => draft.plan.access_class === "quarantine").length;
    const unreviewedQuarantineObjects = drafts.filter((draft) =>
      draft.plan.access_class === "quarantine" && !isReviewedQuarantineDraft(draft)
    ).length;
    const counts = {
      source_capsules: sourceCapsules,
      pages: 1,
      blocks: parsed.blocks.length,
      page_properties: parsed.page_properties.length,
      block_properties: blockPropertyCount,
      wikilinks: parsed.references.filter((reference) => reference.kind === "wikilink").length,
      hash_tags: parsed.references.filter((reference) => reference.kind === "hash-tag").length,
      block_refs: parsed.references.filter((reference) => reference.kind === "block-ref").length,
      reference_index_objects: referenceIndexes,
      edge_candidates: edgeDrafts.length,
      valid_edge_candidates: validEdgeCandidates,
      quarantined_edge_candidates: quarantinedEdgeCandidates,
      terminal_migrated: quarantineObjects > 0 ? 0 : 1,
      terminal_skipped: 0,
      terminal_quarantined: quarantineObjects > 0 ? 1 : 0
    };

    totals.bytes += parsed.byte_size;
    totals.lines += parsed.line_count;
    totals.pages += counts.pages;
    totals.blocks += counts.blocks;
    totals.page_properties += counts.page_properties;
    totals.block_properties += counts.block_properties;
    totals.wikilinks += counts.wikilinks;
    totals.hash_tags += counts.hash_tags;
    totals.block_refs += counts.block_refs;
    totals.reference_index_objects += counts.reference_index_objects;
    totals.edge_candidates += counts.edge_candidates;
    totals.valid_edge_candidates += counts.valid_edge_candidates;
    totals.quarantined_edge_candidates += counts.quarantined_edge_candidates;
    totals.planned_objects += drafts.length;
    totals.page_objects += drafts.filter((draft) => draft.plan.object_type === "page").length;
    totals.block_objects += drafts.filter((draft) => draft.plan.object_type === "block").length;
    totals.reference_index_objects_planned += drafts.filter((draft) => draft.plan.object_type === "index").length;
    totals.source_capsule_objects += sourceCapsules;
    totals.edge_objects += drafts.filter((draft) => draft.plan.object_type === "edge").length;
    totals.quarantine_objects += quarantineObjects;
    totals.terminal_migrated += counts.terminal_migrated;
    totals.terminal_skipped += counts.terminal_skipped;
    totals.terminal_quarantined += counts.terminal_quarantined;
    for (const draft of drafts) {
      increment(decisions, draft.plan.reason_code);
    }

    files.push(LogseqSemanticFileLedgerSchema.parse({
      source_path_ref: parsed.source_path_ref,
      source_kind: parsed.source_kind,
      migration_status: "planned",
      review_status: quarantineObjects > 0
        ? (unreviewedQuarantineObjects > 0 ? "needs-review" : "reviewed")
        : "not-required",
      parity_status: "planned",
      source_capsule_object_id: drafts.find((draft) => draft.plan.semantic_kind === "source-capsule")?.plan.object_id,
      byte_size: parsed.byte_size,
      line_count: parsed.line_count,
      content_hash: parsed.content_hash,
      source_hash_before: parsed.content_hash,
      source_hash_after: parsed.content_hash,
      counts,
      objects: drafts.map((draft) => draft.plan)
    }));
  }

  return LogseqSemanticParityLedgerSchema.parse({
    ledger_schema: "living-atlas-logseq-semantic-parity-ledger:v1",
    ledger_id: `la_semantic_ledger_${shortHash(`${input.authorityId}:${input.createdAt}:${files.map((file) => file.source_path_ref).join("|")}`)}`,
    authority_id: input.authorityId,
    created_at: input.createdAt,
    source_path_policy: "redacted",
    plaintext_policy: "hash-counts-refs-only",
    file_count: files.length,
    totals,
    decisions,
    files
  });
}

function isReviewedQuarantineDraft(draft: DraftObject): boolean {
  if (draft.plan.access_class !== "quarantine") {
    return true;
  }
  const payload = draft.plaintext_payload;
  return typeof payload === "object"
    && payload !== null
    && (payload as { review_resolution?: unknown }).review_resolution === "defer";
}

function buildSemanticDrafts(files: MarkdownFileInput[], options: CreateLogseqSemanticImportOptions): {
  authorityId: string;
  createdAt: string;
  parsedFiles: ParsedLogseqFile[];
  drafts: DraftObject[];
  ledger: LogseqSemanticParityLedger;
} {
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const createdAt = options.created_at ?? new Date().toISOString();
  const defaultAccessClass = AccessClassSchema.parse(options.default_access_class ?? "local-private");
  const pathRedactionSecret = options.path_redaction_secret ?? shortHash(`${authorityId}:${createdAt}:ephemeral-path-redaction`, 32);
  const parsedFiles = files.map((file) => parseLogseqFile(file, pathRedactionSecret));
  const endpointTitleIndex = buildEndpointTitleIndex(parsedFiles, {
    authorityId,
    pathRedactionSecret,
    createdAt,
    defaultAccessClass
  });
  const reviewResolutionIndex = buildReviewResolutionIndex(options.review_resolutions);
  const reviewDeferralIndex = buildReviewDeferralIndex(options.review_resolutions);
  const draftsBySourceRef = new Map<string, DraftObject[]>();
  const createdReviewEndpointIds = collectTypedEndpointObjectIds(parsedFiles, {
    authorityId,
    pathRedactionSecret,
    createdAt,
    defaultAccessClass
  });
  const drafts: DraftObject[] = [];

  for (const parsed of parsedFiles) {
    const fileDrafts = draftObjectsForFile(parsed, {
      authorityId,
      pathRedactionSecret,
      createdAt,
      defaultAccessClass,
      endpointTitleIndex,
      reviewResolutionIndex,
      reviewDeferralIndex,
      createdReviewEndpointIds
    });
    draftsBySourceRef.set(parsed.source_path_ref, fileDrafts);
    drafts.push(...fileDrafts);
  }

  const ledger = ledgerFromDrafts({
    authorityId,
    createdAt,
    parsedFiles,
    draftsBySourceRef
  });
  return {
    authorityId,
    createdAt,
    parsedFiles,
    drafts,
    ledger
  };
}

export function createLogseqSemanticParityLedger(
  files: MarkdownFileInput[],
  options: CreateLogseqSemanticImportOptions
): LogseqSemanticParityLedger {
  return buildSemanticDrafts(files, options).ledger;
}

function plaintextPayloadData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function plaintextObjectFromDraft(input: {
  authorityId: string;
  createdAt: string;
  draft: DraftObject;
}): LogseqSemanticPlaintextGraphObject {
  const plaintext = JSON.stringify(input.draft.plaintext_payload);
  return {
    schema_version: 1,
    authority_id: input.authorityId,
    object_id: input.draft.plan.object_id,
    object_type: input.draft.object_type,
    version: 1,
    access_class: input.draft.plan.access_class,
    encryption_class: "plaintext",
    created_at: input.createdAt,
    updated_at: input.createdAt,
    content_hash: sha256(plaintext),
    visible_metadata: {
      schema_namespace: `import/logseq-semantic/${input.draft.semantic_kind}`,
      tombstone: false,
      remote_indexable: false,
      size_class: sizeClass(Buffer.byteLength(plaintext, "utf8"))
    },
    payload: {
      kind: "plaintext-json",
      data: plaintextPayloadData(input.draft.plaintext_payload)
    }
  };
}

export function createLogseqSemanticPlaintextGraphObjects(
  files: MarkdownFileInput[],
  options: CreateLogseqSemanticImportOptions
): LogseqSemanticPlaintextGraphObjectsResult {
  const built = buildSemanticDrafts(files, options);
  return {
    ledger: built.ledger,
    objects: built.drafts.map((draft) => plaintextObjectFromDraft({
      authorityId: built.authorityId,
      createdAt: built.createdAt,
      draft
    }))
  };
}

/**
 * Exposes only high-confidence typed semantics for canonical-first callers.
 * Legacy envelopes are an internal parser implementation detail and are never
 * returned or persisted by this API.
 */
export function extractLogseqTypedSemantics(
  files: MarkdownFileInput[],
  options: CreateLogseqSemanticImportOptions
): { endpoints: EndpointRecord[]; edges: TemporalEdge[] } {
  const parsed = createLogseqSemanticPlaintextGraphObjects(files, options);
  const endpoints = new Map<string, EndpointRecord>();
  const edges = new Map<string, TemporalEdge>();
  for (const object of parsed.objects) {
    const data = object.payload.data;
    if (data.kind === "logseq-endpoint") {
      const endpoint = EndpointRecordSchema.safeParse(data.endpoint);
      if (endpoint.success) endpoints.set(endpoint.data.object_id, endpoint.data);
      continue;
    }
    if (data.kind === "logseq-temporal-edge") {
      const edge = TemporalEdgeSchema.safeParse(data.edge);
      if (edge.success) edges.set(edge.data.edge_id, edge.data);
    }
  }
  return {
    endpoints: [...endpoints.values()].sort((left, right) => left.object_id.localeCompare(right.object_id)),
    edges: [...edges.values()].sort((left, right) => left.edge_id.localeCompare(right.edge_id))
  };
}

export function createLogseqSemanticKnowledgeSummary(
  files: MarkdownFileInput[],
  options: CreateLogseqSemanticImportOptions
): LogseqSemanticKnowledgeSummary {
  const built = buildSemanticDrafts(files, options);
  const semanticKindCounts = emptySemanticKindRecord();
  const objectTypeCounts = emptyObjectTypeRecord();
  const endpointTypeCounts = emptyEndpointTypeRecord();
  const edgeSourceTypeCounts = emptyEndpointTypeRecord();
  const edgeTargetTypeCounts = emptyEndpointTypeRecord();
  const endpointSubtypeCounts: Record<string, number> = {};
  const edgePredicateCounts: Record<string, number> = {};
  const quarantineReasonCounts: Record<string, number> = {};
  let endpointsWithAliases = 0;
  let occurrenceCount = 0;
  let occurrenceWithRecurrenceCount = 0;
  let occurrenceWithTimezoneCount = 0;
  let occurrenceWithParticipantsCount = 0;
  let topicCount = 0;
  let edgeCount = 0;
  let quarantineObjectCount = 0;

  for (const draft of built.drafts) {
    semanticKindCounts[draft.semantic_kind] += 1;
    objectTypeCounts[draft.object_type] += 1;

    if (draft.plan.access_class === "quarantine") {
      quarantineObjectCount += 1;
      increment(quarantineReasonCounts, draft.plan.reason_code);
    }

    const payload = draft.plaintext_payload;
    if (typeof payload !== "object" || payload === null) {
      continue;
    }

    const endpoint = EndpointRecordSchema.safeParse((payload as { endpoint?: unknown }).endpoint);
    if (endpoint.success) {
      endpointTypeCounts[endpoint.data.type] += 1;
      increment(endpointSubtypeCounts, `${endpoint.data.type}:${endpoint.data.subtype}`);
      if (endpoint.data.aliases.length > 0) {
        endpointsWithAliases += 1;
      }
      if (endpoint.data.type === "occurrence") {
        occurrenceCount += 1;
        if (endpoint.data.recurrence || endpoint.data.recurrence_ref) {
          occurrenceWithRecurrenceCount += 1;
        }
        if (endpoint.data.timezone || endpoint.data.recurrence?.timezone) {
          occurrenceWithTimezoneCount += 1;
        }
        if (endpoint.data.participant_refs.length > 0) {
          occurrenceWithParticipantsCount += 1;
        }
      }
      if (endpoint.data.type === "topic") {
        topicCount += 1;
      }
    }

    const edge = TemporalEdgeSchema.safeParse((payload as { edge?: unknown }).edge);
    if (edge.success) {
      edgeCount += 1;
      increment(edgePredicateCounts, edge.data.predicate);
      edgeSourceTypeCounts[edge.data.source_type] += 1;
      edgeTargetTypeCounts[edge.data.target_type] += 1;
    }
  }

  return {
    report_schema: "living-atlas-logseq-semantic-knowledge-summary:v1",
    plaintext_policy: "counts-only",
    source_file_count: built.ledger.file_count,
    object_count: built.drafts.length,
    semantic_kind_counts: semanticKindCounts,
    object_type_counts: objectTypeCounts,
    endpoint_type_counts: endpointTypeCounts,
    endpoint_subtype_counts: sortedNumberRecord(endpointSubtypeCounts),
    endpoints_with_aliases: endpointsWithAliases,
    occurrence_count: occurrenceCount,
    occurrence_with_recurrence_count: occurrenceWithRecurrenceCount,
    occurrence_with_timezone_count: occurrenceWithTimezoneCount,
    occurrence_with_participants_count: occurrenceWithParticipantsCount,
    topic_count: topicCount,
    edge_count: edgeCount,
    edge_predicate_counts: sortedNumberRecord(edgePredicateCounts),
    edge_source_type_counts: edgeSourceTypeCounts,
    edge_target_type_counts: edgeTargetTypeCounts,
    quarantine_object_count: quarantineObjectCount,
    quarantine_reason_counts: sortedNumberRecord(quarantineReasonCounts)
  };
}

export async function createLogseqSemanticGraphObjects(
  files: MarkdownFileInput[],
  options: CreateLogseqSemanticGraphObjectsOptions
): Promise<LogseqSemanticGraphObjectsResult> {
  const built = buildSemanticDrafts(files, options);
  const objects: GraphObjectEnvelope[] = [];

  for (const draft of built.drafts) {
    const plaintext = JSON.stringify(draft.plaintext_payload);
    const aad = [
      "living-atlas-logseq-semantic:v1",
      built.authorityId,
      draft.plan.object_id,
      draft.plan.source_path_ref,
      draft.plan.semantic_kind
    ].join(":");
    const encrypted = await options.encrypt({
      object_id: draft.plan.object_id,
      object_type: draft.object_type,
      semantic_kind: draft.semantic_kind,
      source_path_ref: draft.plan.source_path_ref,
      plaintext,
      aad
    });
    objects.push(GraphObjectEnvelopeSchema.parse({
      schema_version: 1,
      authority_id: built.authorityId,
      object_id: draft.plan.object_id,
      object_type: draft.object_type,
      version: 1,
      access_class: draft.plan.access_class,
      encryption_class: "client-encrypted",
      created_at: built.createdAt,
      updated_at: built.createdAt,
      content_hash: encrypted.hash,
      key_ref: encrypted.key_ref ?? `la_key_logseqsem${shortHash(`${draft.plan.object_id}:key`, 14)}`,
      visible_metadata: {
        schema_namespace: `import/logseq-semantic/${draft.semantic_kind}`,
        tombstone: false,
        remote_indexable: false,
        size_class: sizeClass(Buffer.byteLength(plaintext, "utf8"))
      },
      payload: {
        kind: "ciphertext-inline",
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        algorithm: encrypted.algorithm ?? "aes-256-gcm"
      }
    }));
  }

  return {
    ledger: built.ledger,
    objects
  };
}

export function createLogseqSourceCapsuleObjectId(
  authorityId: string,
  sourcePath: string,
  pathRedactionSecret: string
): string {
  return createMarkdownObjectId(authorityId, sourcePath, { path_redaction_secret: pathRedactionSecret });
}
