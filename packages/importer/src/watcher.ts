import { createHash, randomBytes } from "node:crypto";
import { AuthorityIdSchema, ObjectIdSchema } from "@living-atlas/contracts";
import { z } from "zod";
import {
  MarkdownImportSourceKindSchema,
  classifyMarkdownSourcePath,
  createMarkdownObjectId,
  createMarkdownSourceRef,
  type MarkdownPathRedactionOptions,
  normalizeMarkdownSourcePath
} from "./markdown";

export const WatcherEventTypeSchema = z.enum(["created", "modified", "deleted", "renamed"]);
export type WatcherEventType = z.infer<typeof WatcherEventTypeSchema>;

export const MarkdownWatcherRootInputSchema = z
  .object({
    root_path: z.string().min(1),
    source_kind: MarkdownImportSourceKindSchema,
    recursive: z.boolean().default(true)
  })
  .strict();
export type MarkdownWatcherRootInput = z.input<typeof MarkdownWatcherRootInputSchema>;

export const MarkdownWatcherPlanSchema = z
  .object({
    plan_schema: z.literal("living-atlas-markdown-watcher-plan:v1"),
    plan_id: z.string().regex(/^la_watch_plan_[a-f0-9]{24}$/),
    created_at: z.string().refine((value) => value.includes("T") && !Number.isNaN(Date.parse(value))),
    execution_mode: z.literal("planning-only"),
    path_policy: z.literal("redacted"),
    debounce_ms: z.number().int().positive(),
    max_file_bytes: z.number().int().positive(),
    roots: z.array(
      z
        .object({
          root_ref: z.string().regex(/^la_watch_root_[a-f0-9]{24}$/),
          source_kind: MarkdownImportSourceKindSchema,
          recursive: z.boolean(),
          include_globs: z.array(z.string().min(1)),
          ignore_globs: z.array(z.string().min(1)),
          watch_events: z.array(WatcherEventTypeSchema)
        })
        .strict()
    ),
    safety_notes: z.array(z.string().min(1))
  })
  .strict();
export type MarkdownWatcherPlan = z.infer<typeof MarkdownWatcherPlanSchema>;

export const WatcherFileEventSchema = z
  .object({
    event_type: WatcherEventTypeSchema,
    source_path: z.string().min(1),
    source_kind: MarkdownImportSourceKindSchema.default("generic-markdown"),
    previous_source_path: z.string().min(1).optional()
  })
  .strict();
export type WatcherFileEvent = z.input<typeof WatcherFileEventSchema>;

export const WatcherImportActionPlanSchema = z
  .object({
    action_schema: z.literal("living-atlas-markdown-watcher-action:v1"),
    action: z.enum(["plan-import", "plan-tombstone", "ignore"]),
    reason: z.string().min(1),
    source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/),
    previous_source_path_ref: z.string().regex(/^la_source_[a-f0-9]{24}$/).optional(),
    object_id: ObjectIdSchema.optional(),
    source_kind: MarkdownImportSourceKindSchema,
    requires_content_read: z.boolean(),
    path_policy: z.literal("redacted")
  })
  .strict();
export type WatcherImportActionPlan = z.infer<typeof WatcherImportActionPlanSchema>;

export type CreateMarkdownWatcherPlanOptions = MarkdownPathRedactionOptions & {
  created_at?: string;
  debounce_ms?: number;
  max_file_bytes?: number;
};

export type PlanWatcherFileEventOptions = MarkdownPathRedactionOptions & {
  authority_id: string;
};

const DefaultIgnoreGlobs = [
  ".git/**",
  ".obsidian/**",
  "logseq/bak/**",
  "logseq/.recycle/**",
  "**/.DS_Store",
  "**/node_modules/**"
];

const IncludeGlobsByKind: Record<z.infer<typeof MarkdownImportSourceKindSchema>, string[]> = {
  logseq: ["pages/**", "journals/**", "whiteboards/**/*.md", "*.md"],
  obsidian: ["**/*.md"],
  "generic-markdown": ["**/*.md", "*.markdown"]
};

function shortHash(value: string, length = 24): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function createWatcherRootRef(rootPath: string, pathRedactionSecret: string | undefined): string {
  return `la_watch_root_${shortHash(`${pathRedactionSecret ?? randomBytes(16).toString("hex")}:${normalizeMarkdownSourcePath(rootPath)}`, 24)}`;
}

function isIgnoredPath(sourcePath: string): boolean {
  const normalized = normalizeMarkdownSourcePath(sourcePath);
  return normalized.startsWith(".git/")
    || normalized.includes("/.git/")
    || normalized.startsWith("node_modules/")
    || normalized.includes("/node_modules/")
    || normalized.startsWith(".obsidian/")
    || normalized.includes("/.obsidian/")
    || normalized.startsWith("logseq/bak/")
    || normalized.includes("/logseq/bak/")
    || normalized.startsWith("logseq/.recycle/")
    || normalized.includes("/logseq/.recycle/")
    || normalized.endsWith("/.DS_Store")
    || normalized === ".DS_Store";
}

export function createMarkdownWatcherPlan(
  roots: MarkdownWatcherRootInput[],
  options: CreateMarkdownWatcherPlanOptions = {}
): MarkdownWatcherPlan {
  const parsedRoots = roots.map((root) => MarkdownWatcherRootInputSchema.parse(root));
  const createdAt = options.created_at ?? new Date().toISOString();
  const pathRedactionSecret = options.path_redaction_secret ?? randomBytes(16).toString("hex");
  const rootRefs = parsedRoots.map((root) => createWatcherRootRef(root.root_path, pathRedactionSecret));
  const planId = `la_watch_plan_${shortHash(`${createdAt}:${rootRefs.join("|")}`)}`;

  return MarkdownWatcherPlanSchema.parse({
    plan_schema: "living-atlas-markdown-watcher-plan:v1",
    plan_id: planId,
    created_at: createdAt,
    execution_mode: "planning-only",
    path_policy: "redacted",
    debounce_ms: options.debounce_ms ?? 300,
    max_file_bytes: options.max_file_bytes ?? 2_000_000,
    roots: parsedRoots.map((root, index) => ({
      root_ref: rootRefs[index]!,
      source_kind: root.source_kind,
      recursive: root.recursive,
      include_globs: IncludeGlobsByKind[root.source_kind],
      ignore_globs: DefaultIgnoreGlobs,
      watch_events: ["created", "modified", "deleted", "renamed"]
    })),
    safety_notes: [
      "This plan does not start a filesystem watcher.",
      "Root paths are represented only by opaque refs.",
      "Watcher runners must pass changed markdown content explicitly to the importer."
    ]
  });
}

export function planWatcherFileEvent(
  event: WatcherFileEvent,
  options: PlanWatcherFileEventOptions
): WatcherImportActionPlan {
  const parsed = WatcherFileEventSchema.parse(event);
  const authorityId = AuthorityIdSchema.parse(options.authority_id);
  const sourcePathRef = createMarkdownSourceRef(parsed.source_path, options);
  const previousSourcePathRef = parsed.previous_source_path ? createMarkdownSourceRef(parsed.previous_source_path, options) : undefined;

  if (isIgnoredPath(parsed.source_path)) {
    return WatcherImportActionPlanSchema.parse({
      action_schema: "living-atlas-markdown-watcher-action:v1",
      action: "ignore",
      reason: "path matches default ignored workspace metadata or build output",
      source_path_ref: sourcePathRef,
      previous_source_path_ref: previousSourcePathRef,
      source_kind: parsed.source_kind,
      requires_content_read: false,
      path_policy: "redacted"
    });
  }

  const classification = classifyMarkdownSourcePath({
    source_path: parsed.source_path,
    source_kind: parsed.source_kind
  });
  if (!classification.supported) {
    return WatcherImportActionPlanSchema.parse({
      action_schema: "living-atlas-markdown-watcher-action:v1",
      action: "ignore",
      reason: classification.reason_code === "unsupported-extensionless"
        ? "extensionless file is not a Logseq page or journal"
        : "file extension is not markdown",
      source_path_ref: sourcePathRef,
      previous_source_path_ref: previousSourcePathRef,
      source_kind: parsed.source_kind,
      requires_content_read: false,
      path_policy: "redacted"
    });
  }

  const objectId = createMarkdownObjectId(authorityId, parsed.source_path, options);
  if (parsed.event_type === "deleted") {
    return WatcherImportActionPlanSchema.parse({
      action_schema: "living-atlas-markdown-watcher-action:v1",
      action: "plan-tombstone",
      reason: "markdown file deletion should be represented as an explicit tombstone after local confirmation",
      source_path_ref: sourcePathRef,
      previous_source_path_ref: previousSourcePathRef,
      object_id: objectId,
      source_kind: parsed.source_kind,
      requires_content_read: false,
      path_policy: "redacted"
    });
  }

  return WatcherImportActionPlanSchema.parse({
    action_schema: "living-atlas-markdown-watcher-action:v1",
    action: "plan-import",
    reason: "markdown file change requires caller-supplied content before import planning",
    source_path_ref: sourcePathRef,
    previous_source_path_ref: previousSourcePathRef,
    object_id: objectId,
    source_kind: parsed.source_kind,
    requires_content_read: true,
    path_policy: "redacted"
  });
}
