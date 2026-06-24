import { createHash, randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import {
  AccessClassSchema,
  AuthorityIdSchema,
  EncryptionClassSchema,
  ObjectIdSchema,
  Sha256HashSchema,
  type AccessClass,
  type EncryptionClass
} from "@living-atlas/contracts";
import { z } from "zod";

export const MarkdownImportSourceKindSchema = z.enum(["logseq", "obsidian", "generic-markdown"]);
export type MarkdownImportSourceKind = z.infer<typeof MarkdownImportSourceKindSchema>;

export const MarkdownSourceModeSchema = z.enum([
  "markdown-only",
  "logseq-notes",
  "logseq-extensionless-only"
]);
export type MarkdownSourceMode = z.infer<typeof MarkdownSourceModeSchema>;

export const MarkdownFileInputSchema = z
  .object({
    source_path: z.string().min(1),
    markdown: z.string(),
    source_kind: MarkdownImportSourceKindSchema.default("generic-markdown"),
    observed_mtime_ms: z.number().int().nonnegative().optional()
  })
  .strict();
export type MarkdownFileInput = z.input<typeof MarkdownFileInputSchema>;

export const MarkdownDetectedFeatureSchema = z.enum([
  "frontmatter",
  "headings",
  "wikilinks",
  "markdown-links",
  "hash-tags",
  "logseq-properties",
  "logseq-block-refs",
  "edges-section"
]);
export type MarkdownDetectedFeature = z.infer<typeof MarkdownDetectedFeatureSchema>;

export const MarkdownReferenceKindSchema = z.enum([
  "wikilink",
  "markdown-link",
  "hash-tag",
  "logseq-block-ref"
]);
export type MarkdownReferenceKind = z.infer<typeof MarkdownReferenceKindSchema>;

export const MarkdownReferenceDigestSchema = z
  .object({
    kind: MarkdownReferenceKindSchema,
    ref_hash: Sha256HashSchema,
    occurrences: z.number().int().positive()
  })
  .strict();
export type MarkdownReferenceDigest = z.infer<typeof MarkdownReferenceDigestSchema>;

export const MarkdownImportSummarySchema = z
  .object({
    source_kind: MarkdownImportSourceKindSchema,
    source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    source_extension: z.string().min(1).max(16),
    byte_size: z.number().int().nonnegative(),
    line_count: z.number().int().nonnegative(),
    content_hash: Sha256HashSchema,
    frontmatter_key_count: z.number().int().nonnegative(),
    known_frontmatter_fields: z.array(z.enum(["aliases", "tags", "title", "created", "updated"])),
    heading_count: z.number().int().nonnegative(),
    wikilink_count: z.number().int().nonnegative(),
    markdown_link_count: z.number().int().nonnegative(),
    hash_tag_count: z.number().int().nonnegative(),
    logseq_property_count: z.number().int().nonnegative(),
    logseq_block_ref_count: z.number().int().nonnegative(),
    has_edges_section: z.boolean(),
    detected_features: z.array(MarkdownDetectedFeatureSchema),
    reference_digests: z.array(MarkdownReferenceDigestSchema),
    plaintext_policy: z.literal("hash-only-plan")
  })
  .strict();
export type MarkdownImportSummary = z.infer<typeof MarkdownImportSummarySchema>;

export const PlannedMarkdownObjectSchema = z
  .object({
    object_id: ObjectIdSchema,
    object_type: z.literal("page"),
    access_class: AccessClassSchema,
    encryption_class: EncryptionClassSchema,
    content_hash: Sha256HashSchema,
    source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    source_kind: MarkdownImportSourceKindSchema,
    visible_metadata: z
      .object({
        schema_namespace: z.string().min(1),
        tombstone: z.literal(false),
        remote_indexable: z.literal(false),
        size_class: z.enum(["tiny", "small", "medium", "large", "huge"])
      })
      .strict(),
    payload_plan: z
      .object({
        kind: z.literal("markdown-source"),
        persist_as: z.literal("client-encrypted-envelope"),
        plaintext_in_plan: z.literal(false),
        plaintext_location: z.literal("caller-local-memory")
      })
      .strict()
  })
  .strict();
export type PlannedMarkdownObject = z.infer<typeof PlannedMarkdownObjectSchema>;

export const MarkdownImportPlanSchema = z
  .object({
    plan_schema: z.literal("living-atlas-markdown-import-plan:v1"),
    plan_id: z.string().regex(/^la_import_plan_[a-f0-9]{24}$/),
    authority_id: AuthorityIdSchema,
    created_at: z.string().refine((value) => value.includes("T") && !Number.isNaN(Date.parse(value))),
    source_path_policy: z.literal("redacted"),
    default_access_class: AccessClassSchema,
    default_encryption_class: EncryptionClassSchema,
    files: z.array(
      z
        .object({
          summary: MarkdownImportSummarySchema,
          planned_object: PlannedMarkdownObjectSchema,
          import_action: z.literal("upsert-page"),
          safety_notes: z.array(z.string().min(1))
        })
        .strict()
    )
  })
  .strict();
export type MarkdownImportPlan = z.infer<typeof MarkdownImportPlanSchema>;

export type CreateMarkdownImportPlanOptions = {
  authority_id: string;
  created_at?: string;
  default_access_class?: AccessClass;
  default_encryption_class?: EncryptionClass;
  path_redaction_secret?: string;
};

export type MarkdownPathRedactionOptions = {
  path_redaction_secret?: string;
};

export type MarkdownSourcePathClassification =
  | {
      supported: true;
      reason_code: "markdown-file" | "logseq-extensionless-note";
    }
  | {
      supported: false;
      reason_code: "ignored-extension" | "unsupported-extensionless";
    };

export function classifyMarkdownSourcePath(input: {
  source_path: string;
  source_kind: MarkdownImportSourceKind;
  mode?: MarkdownSourceMode;
}): MarkdownSourcePathClassification {
  const mode = input.mode ?? "logseq-notes";
  const normalized = normalizeMarkdownSourcePath(input.source_path);
  const segments = normalized.split("/").filter(Boolean);
  if (
    normalized.startsWith(".git/")
    || normalized.includes("/.git/")
    || normalized.startsWith("node_modules/")
    || normalized.includes("/node_modules/")
    || normalized.startsWith(".obsidian/")
    || normalized.includes("/.obsidian/")
    || normalized.startsWith("logseq/bak/")
    || normalized.includes("/logseq/bak/")
    || normalized.startsWith("logseq/.recycle/")
    || normalized.includes("/logseq/.recycle/")
    || segments.some((segment) => segment.startsWith("."))
  ) {
    return { supported: false, reason_code: "ignored-extension" };
  }
  const extension = extname(basename(normalized)).toLowerCase();
  const isMarkdown = extension === ".md" || extension === ".markdown";
  const isExtensionless = extension === "";
  const isLogseqNotePath = input.source_kind === "logseq" && (segments[0] === "pages" || segments[0] === "journals");

  if (mode === "markdown-only") {
    return isMarkdown
      ? { supported: true, reason_code: "markdown-file" }
      : { supported: false, reason_code: isExtensionless ? "unsupported-extensionless" : "ignored-extension" };
  }

  if (mode === "logseq-extensionless-only") {
    return isExtensionless && isLogseqNotePath
      ? { supported: true, reason_code: "logseq-extensionless-note" }
      : { supported: false, reason_code: isExtensionless ? "unsupported-extensionless" : "ignored-extension" };
  }

  if (isMarkdown) {
    return { supported: true, reason_code: "markdown-file" };
  }
  if (isExtensionless && isLogseqNotePath) {
    return { supported: true, reason_code: "logseq-extensionless-note" };
  }
  return { supported: false, reason_code: isExtensionless ? "unsupported-extensionless" : "ignored-extension" };
}

const KnownFrontmatterFields = new Set(["aliases", "tags", "title", "created", "updated"]);

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function shortHash(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function ephemeralPathRedactionSecret(): string {
  return randomBytes(16).toString("hex");
}

function pathHashInput(sourcePath: string, pathRedactionSecret: string | undefined): string {
  return `${pathRedactionSecret ?? ephemeralPathRedactionSecret()}:${normalizeMarkdownSourcePath(sourcePath)}`;
}

export function normalizeMarkdownSourcePath(sourcePath: string): string {
  return sourcePath.replaceAll("\\", "/").replace(/\/+/g, "/");
}

export function createMarkdownSourceRef(sourcePath: string, options: MarkdownPathRedactionOptions = {}): string {
  return `la_source_${shortHash(pathHashInput(sourcePath, options.path_redaction_secret), 24)}`;
}

export function createMarkdownObjectId(
  authorityId: string,
  sourcePath: string,
  options: MarkdownPathRedactionOptions = {}
): string {
  return ObjectIdSchema.parse(`la_object_${shortHash(`${authorityId}:${pathHashInput(sourcePath, options.path_redaction_secret)}`, 24)}`);
}

function sourceExtension(sourcePath: string): string {
  const extension = extname(sourcePath).toLowerCase();
  return extension.length > 0 ? extension.slice(1) : "markdown";
}

function sizeClass(byteSize: number): PlannedMarkdownObject["visible_metadata"]["size_class"] {
  if (byteSize < 4_096) return "tiny";
  if (byteSize < 64_000) return "small";
  if (byteSize < 512_000) return "medium";
  if (byteSize < 5_000_000) return "large";
  return "huge";
}

function extractFrontmatter(markdown: string): { keys: string[]; body: string } {
  if (!markdown.startsWith("---")) {
    return { keys: [], body: markdown };
  }

  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { keys: [], body: markdown };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { keys: [], body: markdown };
  }

  const keys = lines
    .slice(1, endIndex)
    .map((line) => /^([A-Za-z0-9_-]{1,64})\s*:/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);

  return { keys, body: lines.slice(endIndex + 1).join("\n") };
}

function countMatches(markdown: string, pattern: RegExp): number {
  return [...markdown.matchAll(pattern)].length;
}

function addReference(
  references: Map<string, { kind: MarkdownReferenceKind; ref_hash: `sha256:${string}`; occurrences: number }>,
  kind: MarkdownReferenceKind,
  value: string,
  pathRedactionSecret: string
): void {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return;
  }

  const refHash = sha256(`markdown-reference:v2:${pathRedactionSecret}:${kind}:${normalized}`);
  const key = `${kind}:${refHash}`;
  const existing = references.get(key);
  if (existing) {
    existing.occurrences += 1;
    return;
  }

  references.set(key, { kind, ref_hash: refHash, occurrences: 1 });
}

function extractReferenceDigests(markdown: string, options: MarkdownPathRedactionOptions = {}): MarkdownReferenceDigest[] {
  const references = new Map<string, { kind: MarkdownReferenceKind; ref_hash: `sha256:${string}`; occurrences: number }>();
  const pathRedactionSecret = options.path_redaction_secret ?? ephemeralPathRedactionSecret();

  for (const match of markdown.matchAll(/\[\[([^\]\n]{1,256})\]\]/g)) {
    const target = match[1]?.split("|", 1)[0];
    if (target) addReference(references, "wikilink", target, pathRedactionSecret);
  }

  for (const match of markdown.matchAll(/\[[^\]\n]{1,256}\]\(([^)\s]{1,512})(?:\s+"[^"]*")?\)/g)) {
    if (match[1]) addReference(references, "markdown-link", match[1], pathRedactionSecret);
  }

  for (const match of markdown.matchAll(/(^|[\s([{])#([A-Za-z0-9_/-]{1,80})/gm)) {
    if (match[2]) addReference(references, "hash-tag", match[2], pathRedactionSecret);
  }

  for (const match of markdown.matchAll(/\(\(([A-Za-z0-9_-]{3,128})\)\)/g)) {
    if (match[1]) addReference(references, "logseq-block-ref", match[1], pathRedactionSecret);
  }

  return [...references.values()]
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.ref_hash.localeCompare(right.ref_hash))
    .map((reference) => MarkdownReferenceDigestSchema.parse(reference));
}

function detectedFeatures(summary: Omit<MarkdownImportSummary, "detected_features">): MarkdownDetectedFeature[] {
  const features: MarkdownDetectedFeature[] = [];
  if (summary.frontmatter_key_count > 0) features.push("frontmatter");
  if (summary.heading_count > 0) features.push("headings");
  if (summary.wikilink_count > 0) features.push("wikilinks");
  if (summary.markdown_link_count > 0) features.push("markdown-links");
  if (summary.hash_tag_count > 0) features.push("hash-tags");
  if (summary.logseq_property_count > 0) features.push("logseq-properties");
  if (summary.logseq_block_ref_count > 0) features.push("logseq-block-refs");
  if (summary.has_edges_section) features.push("edges-section");
  return features;
}

export function summarizeMarkdownFile(
  input: MarkdownFileInput,
  options: MarkdownPathRedactionOptions = {}
): MarkdownImportSummary {
  const parsed = MarkdownFileInputSchema.parse(input);
  const { keys, body } = extractFrontmatter(parsed.markdown);
  const byteSize = Buffer.byteLength(parsed.markdown, "utf8");
  const headingCount = countMatches(body, /^#{1,6}\s+\S.*$/gm);
  const wikilinkCount = countMatches(body, /\[\[[^\]\n]{1,256}\]\]/g);
  const markdownLinkCount = countMatches(body, /\[[^\]\n]{1,256}\]\([^)]+\)/g);
  const hashTagCount = countMatches(body, /(^|[\s([{])#[A-Za-z0-9_/-]{1,80}/gm);
  const logseqPropertyCount = countMatches(body, /^(?:\s*[-*]\s+)?[A-Za-z0-9_-]{1,64}::\s+\S.*$/gm);
  const logseqBlockRefCount = countMatches(body, /\(\([A-Za-z0-9_-]{3,128}\)\)/g);
  const hasEdgesSection = /^#{2,6}\s+Edges\s*$/im.test(body);
  const baseSummary = {
    source_kind: parsed.source_kind,
    source_path_ref: createMarkdownSourceRef(parsed.source_path, options),
    source_extension: sourceExtension(parsed.source_path),
    byte_size: byteSize,
    line_count: parsed.markdown.length === 0 ? 0 : parsed.markdown.split(/\r?\n/).length,
    content_hash: sha256(parsed.markdown),
    frontmatter_key_count: keys.length,
    known_frontmatter_fields: [...new Set(keys.filter((key) => KnownFrontmatterFields.has(key)))]
      .sort() as MarkdownImportSummary["known_frontmatter_fields"],
    heading_count: headingCount,
    wikilink_count: wikilinkCount,
    markdown_link_count: markdownLinkCount,
    hash_tag_count: hashTagCount,
    logseq_property_count: logseqPropertyCount,
    logseq_block_ref_count: logseqBlockRefCount,
    has_edges_section: hasEdgesSection,
    reference_digests: extractReferenceDigests(body, options),
    plaintext_policy: "hash-only-plan" as const
  };

  return MarkdownImportSummarySchema.parse({
    ...baseSummary,
    detected_features: detectedFeatures(baseSummary)
  });
}

function defaultEncryptionForAccessClass(accessClass: AccessClass): EncryptionClass {
  return accessClass === "local-private" || accessClass === "quarantine" ? "client-encrypted" : "remote-readable";
}

function assertSafeImportEncryption(accessClass: AccessClass, encryptionClass: EncryptionClass): void {
  if ((accessClass === "local-private" || accessClass === "quarantine") && encryptionClass !== "client-encrypted") {
    throw new Error("Sensitive markdown import plans must use client-encrypted persistence.");
  }
}

export function createMarkdownImportPlan(
  files: MarkdownFileInput[],
  options: CreateMarkdownImportPlanOptions
): MarkdownImportPlan {
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const defaultAccessClass = AccessClassSchema.parse(options.default_access_class ?? "local-private");
  const defaultEncryptionClass = EncryptionClassSchema.parse(
    options.default_encryption_class ?? defaultEncryptionForAccessClass(defaultAccessClass)
  );
  assertSafeImportEncryption(defaultAccessClass, defaultEncryptionClass);
  const createdAt = options.created_at ?? new Date().toISOString();
  const parsedFiles = files.map((file) => MarkdownFileInputSchema.parse(file));
  const pathRedactionSecret = options.path_redaction_secret ?? ephemeralPathRedactionSecret();
  const redactedPathRefs = parsedFiles.map((file) => createMarkdownSourceRef(file.source_path, {
    path_redaction_secret: pathRedactionSecret
  }));
  const planId = `la_import_plan_${shortHash(`${authorityId}:${createdAt}:${redactedPathRefs.join("|")}`)}`;

  return MarkdownImportPlanSchema.parse({
    plan_schema: "living-atlas-markdown-import-plan:v1",
    plan_id: planId,
    authority_id: authorityId,
    created_at: createdAt,
    source_path_policy: "redacted",
    default_access_class: defaultAccessClass,
    default_encryption_class: defaultEncryptionClass,
    files: parsedFiles.map((file) => {
      const summary = summarizeMarkdownFile(file, { path_redaction_secret: pathRedactionSecret });
      const objectId = createMarkdownObjectId(authorityId, file.source_path, { path_redaction_secret: pathRedactionSecret });
      return {
        summary,
        planned_object: {
          object_id: objectId,
          object_type: "page",
          access_class: defaultAccessClass,
          encryption_class: defaultEncryptionClass,
          content_hash: summary.content_hash,
          source_path_ref: summary.source_path_ref,
          source_kind: file.source_kind,
          visible_metadata: {
            schema_namespace: `import/${file.source_kind}-markdown`,
            tombstone: false,
            remote_indexable: false,
            size_class: sizeClass(summary.byte_size)
          },
          payload_plan: {
            kind: "markdown-source",
            persist_as: "client-encrypted-envelope",
            plaintext_in_plan: false,
            plaintext_location: "caller-local-memory"
          }
        },
        import_action: "upsert-page",
        safety_notes: [
          "Markdown plaintext is not serialized into this plan.",
          "Source paths are redacted from planner output.",
          "Caller must encrypt local-private payloads before persistence or sync."
        ]
      };
    })
  });
}
