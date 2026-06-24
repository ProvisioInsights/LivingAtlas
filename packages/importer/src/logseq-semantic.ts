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

export type CreateLogseqSemanticImportOptions = {
  authority_id: string;
  created_at?: string;
  path_redaction_secret?: string;
  default_access_class?: AccessClass;
};

export type CreateLogseqSemanticGraphObjectsOptions = CreateLogseqSemanticImportOptions & {
  encrypt: LogseqSemanticEncryptor;
};

export type LogseqSemanticGraphObjectsResult = {
  ledger: LogseqSemanticParityLedger;
  objects: GraphObjectEnvelope[];
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
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
  }

  return parseEndpointWithSubtypeFallback(endpoint, subtype, minimalEndpoint);
}

function propertyEdgeTargetTitle(properties: LogseqProperty[], keys: string[]): { key: string; title: string } | undefined {
  for (const key of keys) {
    const title = parseWikilinkTitle(propertyValue(properties, key));
    if (title) {
      return { key, title };
    }
  }
  return undefined;
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
    status: input.status
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

function propertyEdgesForEndpoint(parsed: ParsedLogseqFile, options: {
  authorityId: string;
  pathRedactionSecret: string;
  endpoint: EndpointRecord;
}): TemporalEdge[] {
  const edges: TemporalEdge[] = [];
  const common = {
    authorityId: options.authorityId,
    pathRedactionSecret: options.pathRedactionSecret,
    sourcePathRef: parsed.source_path_ref,
    sourceContentHash: parsed.content_hash,
    sourceEndpoint: options.endpoint
  };

  if (options.endpoint.type === "person") {
    const target = propertyEdgeTargetTitle(parsed.page_properties, ["primary-location", "location", "based-in"]);
    const edge = target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "location", predicate: "based-in", propertyKey: target.key }) : undefined;
    if (edge) edges.push(edge);
    for (const employer of propertyEdgeTargetTitles(parsed.page_properties, ["org", "organization", "employer-current", "employer-historical"])) {
      const employmentEdge = typedCurrentPagePropertyEdge({
        ...common,
        targetTitle: employer.title,
        targetType: "organization",
        predicate: "employed-by",
        propertyKey: employer.key,
        status: employer.key === "employer-historical" ? "ended" : "active"
      });
      if (employmentEdge) edges.push(employmentEdge);
    }
    const spouse = propertyEdgeTargetTitle(parsed.page_properties, ["spouse"]);
    const spouseEdge = spouse ? typedCurrentPagePropertyEdge({ ...common, targetTitle: spouse.title, targetType: "person", predicate: "spouse-of", propertyKey: spouse.key }) : undefined;
    if (spouseEdge) edges.push(spouseEdge);
    const estranged = propertyEdgeTargetTitle(parsed.page_properties, ["estranged-from"]);
    const estrangedEdge = estranged ? typedCurrentPagePropertyEdge({ ...common, targetTitle: estranged.title, targetType: "person", predicate: "estranged-from", propertyKey: estranged.key }) : undefined;
    if (estrangedEdge) edges.push(estrangedEdge);
  } else if (options.endpoint.type === "organization") {
    const target = propertyEdgeTargetTitle(parsed.page_properties, ["primary-location", "headquarters", "location", "based-in"]);
    const edge = target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "location", predicate: "based-in", propertyKey: target.key }) : undefined;
    if (edge) edges.push(edge);
    const acquirer = propertyEdgeTargetTitle(parsed.page_properties, ["acquired-by"]);
    const acquisitionEdge = acquirer ? typedCurrentPagePropertyEdge({ ...common, targetTitle: acquirer.title, targetType: "organization", predicate: "acquired-by", propertyKey: acquirer.key }) : undefined;
    if (acquisitionEdge) edges.push(acquisitionEdge);
    const customerTarget = propertyEdgeTargetTitle(parsed.page_properties, ["customer-of"]);
    const customerEdge = customerTarget ? typedCurrentPagePropertyEdge({ ...common, targetTitle: customerTarget.title, targetType: "organization", predicate: "customer-of", propertyKey: customerTarget.key }) : undefined;
    if (customerEdge) edges.push(customerEdge);
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
        if (edge) edges.push(edge);
      } else if (tagged.suffix === "education") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "alumnus-of" });
        if (edge) edges.push(edge);
      } else if (tagged.suffix === "cohort") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "member-of" });
        if (edge) edges.push(edge);
      } else if (tagged.suffix === "revenue") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "organization", targetType: "organization", predicate: "customer-of" });
        if (edge) edges.push(edge);
      } else if (tagged.suffix === "advisory-past") {
        const edge = typedPropertyEdge({ ...reverseCommon, sourceObjectId, sourceType: "person", targetType: "organization", predicate: "advises", status: "ended" });
        if (edge) edges.push(edge);
      }
    }
  } else if (options.endpoint.type === "occurrence") {
    const target = propertyEdgeTargetTitle(parsed.page_properties, ["location"]);
    const edge = target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "location", predicate: "occurred-at", propertyKey: target.key }) : undefined;
    if (edge) edges.push(edge);
  } else if (options.endpoint.type === "topic") {
    const target = propertyEdgeTargetTitle(parsed.page_properties, ["parent-topic", "part-of-topic"]);
    const edge = target ? typedCurrentPagePropertyEdge({ ...common, targetTitle: target.title, targetType: "topic", predicate: "part-of-topic", propertyKey: target.key }) : undefined;
    if (edge) edges.push(edge);
  }

  return edges;
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
      endpoint: typedEndpoint.endpoint
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
          tag_suffix: candidate.suffix
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
      review_status: quarantineObjects > 0 ? "needs-review" : "not-required",
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
  const draftsBySourceRef = new Map<string, DraftObject[]>();
  const drafts: DraftObject[] = [];

  for (const parsed of parsedFiles) {
    const fileDrafts = draftObjectsForFile(parsed, {
      authorityId,
      pathRedactionSecret,
      createdAt,
      defaultAccessClass
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
