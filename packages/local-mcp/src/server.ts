import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthorityIdSchema, ObjectIdSchema, TemporalEdgeSchema } from "@living-atlas/contracts";
import { createLivingAtlasGraphService } from "@living-atlas/graph-service";
import {
  LivingAtlasMcpToolDefinitions,
  livingAtlasMcpToolDefinition,
  type LivingAtlasMcpToolName
} from "@living-atlas/mcp-contract";
import { z } from "zod";
import { PlaintextGraphObjectDraftSchema } from "@living-atlas/local-keyring";
import {
  localReviewDecide,
  localReviewList,
  localReviewRead,
  type LocalReviewDecideInput,
  type LocalReviewListInput,
  type LocalReviewReadInput
} from "./review";
import {
  LocalGraphExpectedVersionSchema,
  LocalGraphObjectInputSchema,
  LocalGraphUpdatePatchSchema,
  localAccessModes,
  localActivityRead,
  localCreateObject,
  localCreateEdgeObject,
  localDeleteEdgeObject,
  localGraphStatus,
  localMigrationOpen,
  localMigrationSeal,
  localListObjects,
  localReadObject,
  localReadEdgeObject,
  localResolutionApply,
  localReconcileGraph,
  localSearchObjects,
  localSensitiveDecrypt,
  localSyncStatus,
  localTombstoneObject,
  localTimelineQuery,
  localTraverseGraph,
  localUnsupportedTool,
  localUpdateEdgeObject,
  localUpdateObject,
  type LocalMcpContext,
  type LocalGraphAuthorityToolInput,
  type LocalGraphCreateToolInput,
  type LocalGraphEdgeCreateToolInput,
  type LocalGraphEdgeDeleteToolInput,
  type LocalGraphEdgeReadToolInput,
  type LocalGraphEdgeUpdateToolInput,
  type LocalGraphReadToolInput,
  type LocalResolutionApplyInput,
  type LocalGraphSearchToolInput,
  type LocalGraphTombstoneToolInput,
  type LocalGraphToolInput,
  type LocalMigrationOpenToolInput,
  type LocalMigrationSealToolInput,
  type LocalGraphTimelineToolInput,
  type LocalGraphTraverseToolInput,
  type LocalGraphUpdateToolInput
} from "./local-graph";

export type LocalMcpServerAuthOptions = {
  authorizationHeader?: string;
};

const EmptyInputSchema = {};
const AuthorityInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional()
};
const ReadObjectInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  object_id: ObjectIdSchema.describe("Living Atlas graph object id.")
};
const CreateObjectInputSchema = {
  object: LocalGraphObjectInputSchema.describe("Complete graph object envelope or local plaintext draft to create.")
};
const UpdateObjectInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  object_id: ObjectIdSchema.describe("Living Atlas graph object id."),
  expected_version: LocalGraphExpectedVersionSchema.describe("Optional optimistic version guard."),
  patch: LocalGraphUpdatePatchSchema.describe("Synthetic in-memory graph object fields to merge into the existing envelope.")
};
const TombstoneObjectInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  object_id: ObjectIdSchema.describe("Living Atlas graph object id."),
  expected_version: LocalGraphExpectedVersionSchema.describe("Optional optimistic version guard.")
};
const BatchLimitsInputSchema = {
  max_items: z.number().int().min(1).max(100).optional(),
  max_bytes: z.number().int().min(1024).max(1024 * 1024).optional()
};
const BatchItemCommonInputSchema = {
  idempotency_key: z.string().optional(),
  authority_id: AuthorityIdSchema.optional()
};
const ObjectBatchItemInputSchema = z.discriminatedUnion("op", [
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("create"),
    object: LocalGraphObjectInputSchema
  }).strict(),
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("update"),
    object_id: ObjectIdSchema,
    expected_version: LocalGraphExpectedVersionSchema,
    patch: LocalGraphUpdatePatchSchema
  }).strict(),
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("delete"),
    object_id: ObjectIdSchema,
    expected_version: LocalGraphExpectedVersionSchema
  }).strict()
]);
const ObjectBatchInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  idempotency_key: z.string().optional(),
  items: z.array(ObjectBatchItemInputSchema).min(1).max(100),
  limits: z.object(BatchLimitsInputSchema).strict().optional()
};
const ResolutionApplyInputSchema = {
  operation_id: z.string().regex(/^la_operation_[A-Za-z0-9_-]{8,}$/),
  idempotency_key: z.string().regex(/^la_idem_[A-Za-z0-9_-]{8,}$/),
  candidate_id: z.string().regex(/^la_candidate_[A-Za-z0-9_-]{8,}$/),
  expected_generation: z.number().int().nonnegative(),
  expected_review_version: z.number().int().nonnegative(),
  objects: z.array(PlaintextGraphObjectDraftSchema).min(1)
};
const ReviewListInputSchema = {
  queue: z.enum(["actionable", "owner-review", "research", "deferred", "automatic", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional()
};
const ReviewReadInputSchema = {
  candidate_id: z.string().regex(/^la_candidate_[A-Za-z0-9_-]{8,}$/)
};
const ReviewDecideInputSchema = {
  action: z.enum(["keep", "research", "defer"]),
  candidate_ids: z.array(z.string().regex(/^la_candidate_[A-Za-z0-9_-]{8,}$/)).min(1).max(100),
  preview_only: z.boolean().optional(),
  preview_token: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
};
const ActivityReadInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  operation_id: z.string().optional(),
  trace_id: z.string().optional(),
  event_type: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional()
};
const SearchInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  query: z.string().min(1),
  object_type: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional()
};
const TraverseInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  start_object_id: ObjectIdSchema.describe("Living Atlas graph object id."),
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
  max_depth: z.number().int().min(1).max(5).optional(),
  predicates: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(1000).optional()
};
const TimelineInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  object_id: ObjectIdSchema.describe("Living Atlas graph object id.").optional(),
  predicate: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional()
};
const EdgeCreateInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  edge: TemporalEdgeSchema.describe("Typed temporal edge to create.")
};
const EdgeReadInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/)
};
const EdgeUpdateInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
  expected_version: LocalGraphExpectedVersionSchema.describe("Optional optimistic version guard."),
  patch: z.record(z.string(), z.unknown()).describe("Temporal edge fields to merge into the existing edge.")
};
const EdgeBatchItemInputSchema = z.discriminatedUnion("op", [
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("create"),
    edge: TemporalEdgeSchema
  }).strict(),
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("update"),
    edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
    expected_version: LocalGraphExpectedVersionSchema,
    patch: z.record(z.string(), z.unknown())
  }).strict(),
  z.object({
    ...BatchItemCommonInputSchema,
    op: z.literal("delete"),
    edge_id: z.string().regex(/^la_edge_[A-Za-z0-9_-]{8,}$/),
    expected_version: LocalGraphExpectedVersionSchema
  }).strict()
]);
const EdgeBatchInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  idempotency_key: z.string().optional(),
  items: z.array(EdgeBatchItemInputSchema).min(1).max(100),
  limits: z.object(BatchLimitsInputSchema).strict().optional()
};
const SyncReadInputSchema = {
  authority_id: AuthorityIdSchema.describe("Living Atlas authority id.").optional(),
  after_generation: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50).optional()
};
const MigrationOpenInputSchema = {
  reason: z.string().min(1).describe("Why this migration window is being opened (audited in the sealed-migration record).")
};
const MigrationSealInputSchema = {
  migration_id: z.string().regex(/^la_migration_[a-f0-9]{24}$/).describe("Optional guard: only seal if this matches the currently open window.").optional()
};

export const LocalMcpToolInputSchemas = {
  access_modes: EmptyInputSchema,
  activity_read: ActivityReadInputSchema,
  sensitive_decrypt: ReadObjectInputSchema,
  status: EmptyInputSchema,
  reconcile: AuthorityInputSchema,
  object_list: AuthorityInputSchema,
  object_read: ReadObjectInputSchema,
  object_create: CreateObjectInputSchema,
  object_update: UpdateObjectInputSchema,
  object_delete: TombstoneObjectInputSchema,
  object_batch: ObjectBatchInputSchema,
  review_list: ReviewListInputSchema,
  review_read: ReviewReadInputSchema,
  review_decide: ReviewDecideInputSchema,
  resolution_apply: ResolutionApplyInputSchema,
  search: SearchInputSchema,
  traverse: TraverseInputSchema,
  timeline: TimelineInputSchema,
  edge_create: EdgeCreateInputSchema,
  edge_read: EdgeReadInputSchema,
  edge_update: EdgeUpdateInputSchema,
  edge_delete: EdgeReadInputSchema,
  edge_batch: EdgeBatchInputSchema,
  sync_status: EmptyInputSchema,
  sync_pull: SyncReadInputSchema,
  sync_envelopes: SyncReadInputSchema,
  usage_gate: EmptyInputSchema,
  usage_reconcile: EmptyInputSchema,
  migration_open: MigrationOpenInputSchema,
  migration_seal: MigrationSealInputSchema
};

function asToolContent(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

function withAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphToolInput {
  return {
    ...(input && typeof input === "object" ? input : {}),
    authorization: options.authorizationHeader ?? ""
  } as LocalGraphToolInput;
}

function withAuthorityAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphAuthorityToolInput {
  return withAuthorization(input, options) as LocalGraphAuthorityToolInput;
}

function withReadAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphReadToolInput {
  return withAuthorization(input, options) as LocalGraphReadToolInput;
}

function withCreateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphCreateToolInput {
  return withAuthorization(input, options) as LocalGraphCreateToolInput;
}

function withUpdateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphUpdateToolInput {
  return withAuthorization(input, options) as LocalGraphUpdateToolInput;
}

function withMigrationOpenAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalMigrationOpenToolInput {
  return withAuthorization(input, options) as LocalMigrationOpenToolInput;
}

function withMigrationSealAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalMigrationSealToolInput {
  return withAuthorization(input, options) as LocalMigrationSealToolInput;
}

function withTombstoneAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphTombstoneToolInput {
  return withAuthorization(input, options) as LocalGraphTombstoneToolInput;
}

function withResolutionAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalResolutionApplyInput {
  return withAuthorization(input, options) as LocalResolutionApplyInput;
}

function withReviewListAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalReviewListInput {
  return withAuthorization(input, options) as LocalReviewListInput;
}

function withReviewReadAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalReviewReadInput {
  return withAuthorization(input, options) as LocalReviewReadInput;
}

function withReviewDecideAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalReviewDecideInput {
  return withAuthorization(input, options) as LocalReviewDecideInput;
}

function withSearchAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphSearchToolInput {
  return withAuthorization(input, options) as LocalGraphSearchToolInput;
}

function withTraverseAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphTraverseToolInput {
  return withAuthorization(input, options) as LocalGraphTraverseToolInput;
}

function withTimelineAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphTimelineToolInput {
  return withAuthorization(input, options) as LocalGraphTimelineToolInput;
}

function withEdgeCreateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphEdgeCreateToolInput {
  return withAuthorization(input, options) as LocalGraphEdgeCreateToolInput;
}

function withEdgeReadAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphEdgeReadToolInput {
  return withAuthorization(input, options) as LocalGraphEdgeReadToolInput;
}

function withEdgeUpdateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphEdgeUpdateToolInput {
  return withAuthorization(input, options) as LocalGraphEdgeUpdateToolInput;
}

function withEdgeDeleteAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphEdgeDeleteToolInput {
  return withAuthorization(input, options) as LocalGraphEdgeDeleteToolInput;
}

function toolMetadata(name: LivingAtlasMcpToolName) {
  return livingAtlasMcpToolDefinition(name);
}

export function createLivingAtlasLocalMcpServer(
  context: LocalMcpContext,
  options: LocalMcpServerAuthOptions = {}
): McpServer {
  const server = new McpServer({
    name: "living-atlas-local",
    version: "0.1.0"
  });

  const knownNames = new Set(LivingAtlasMcpToolDefinitions.map((tool) => tool.name));
  for (const name of Object.keys(LocalMcpToolInputSchemas)) {
    if (!knownNames.has(name as LivingAtlasMcpToolName)) {
      throw new Error(`Local MCP schema is not in shared contract: ${name}`);
    }
  }
  const graphService = createLivingAtlasGraphService({
    async execute(toolName, input) {
      switch (toolName) {
        case "access_modes":
          return localAccessModes(context, withAuthorization(input, options));
        case "activity_read":
          return localActivityRead(context, withAuthorityAuthorization(input, options));
        case "sensitive_decrypt":
          return localSensitiveDecrypt(context, withReadAuthorization(input, options));
        case "status":
          return localGraphStatus(context, withAuthorization(input, options));
        case "reconcile":
          return localReconcileGraph(context, withAuthorityAuthorization(input, options));
        case "object_list":
          return localListObjects(context, withAuthorization(input, options));
        case "object_read":
          return localReadObject(context, withReadAuthorization(input, options));
        case "object_create":
          return localCreateObject(context, withCreateAuthorization(input, options));
        case "object_update":
          return localUpdateObject(context, withUpdateAuthorization(input, options));
        case "object_delete":
          return localTombstoneObject(context, withTombstoneAuthorization(input, options));
        case "review_list":
          return localReviewList(context, withReviewListAuthorization(input, options));
        case "review_read":
          return localReviewRead(context, withReviewReadAuthorization(input, options));
        case "review_decide":
          return localReviewDecide(context, withReviewDecideAuthorization(input, options));
        case "resolution_apply":
          return localResolutionApply(context, withResolutionAuthorization(input, options));
        case "object_batch":
        case "edge_batch":
          throw new Error("batch-tools-are-handled-by-graph-service");
        case "search":
          return localSearchObjects(context, withSearchAuthorization(input, options));
        case "traverse":
          return localTraverseGraph(context, withTraverseAuthorization(input, options));
        case "timeline":
          return localTimelineQuery(context, withTimelineAuthorization(input, options));
        case "edge_create":
          return localCreateEdgeObject(context, withEdgeCreateAuthorization(input, options));
        case "edge_read":
          return localReadEdgeObject(context, withEdgeReadAuthorization(input, options));
        case "edge_update":
          return localUpdateEdgeObject(context, withEdgeUpdateAuthorization(input, options));
        case "edge_delete":
          return localDeleteEdgeObject(context, withEdgeDeleteAuthorization(input, options));
        case "sync_status":
          return localSyncStatus(context, withAuthorization(input, options));
        case "sync_pull":
        case "sync_envelopes":
        case "usage_gate":
        case "usage_reconcile":
          return localUnsupportedTool(context, withAuthorization(input, options), toolName);
        case "migration_open":
          return localMigrationOpen(context, withMigrationOpenAuthorization(input, options));
        case "migration_seal":
          return localMigrationSeal(context, withMigrationSealAuthorization(input, options));
      }
    }
  });
  const callLocalTool = (toolName: LivingAtlasMcpToolName, input: unknown) =>
    graphService.callTool(toolName, input, {
      ingress: "local-stdio",
      access_mode: "local-keyholding-only",
      authority_id: context.controlPlane.authority.authority_id
    });

  server.registerTool(
    "access_modes",
    {
      title: "Access modes",
      description: toolMetadata("access_modes").description,
      inputSchema: LocalMcpToolInputSchemas.access_modes,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("access_modes", input))
  );

  server.registerTool(
    "activity_read",
    {
      title: "Read activity stream",
      description: toolMetadata("activity_read").description,
      inputSchema: LocalMcpToolInputSchemas.activity_read,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("activity_read", input))
  );

  server.registerTool(
    "sensitive_decrypt",
    {
      title: "Decrypt sensitive object",
      description: toolMetadata("sensitive_decrypt").description,
      inputSchema: LocalMcpToolInputSchemas.sensitive_decrypt,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("sensitive_decrypt", input))
  );

  server.registerTool(
    "status",
    {
      title: "Local graph status",
      description: toolMetadata("status").description,
      inputSchema: LocalMcpToolInputSchemas.status,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("status", input))
  );

  server.registerTool(
    "reconcile",
    {
      title: "Reconcile local graph",
      description: toolMetadata("reconcile").description,
      inputSchema: LocalMcpToolInputSchemas.reconcile,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("reconcile", input))
  );

  server.registerTool(
    "object_list",
    {
      title: "List local graph objects",
      description: toolMetadata("object_list").description,
      inputSchema: LocalMcpToolInputSchemas.object_list,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_list", input))
  );

  server.registerTool(
    "object_read",
    {
      title: "Read local graph object",
      description: toolMetadata("object_read").description,
      inputSchema: LocalMcpToolInputSchemas.object_read,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_read", input))
  );

  server.registerTool(
    "object_create",
    {
      title: "Create synthetic local graph object",
      description: toolMetadata("object_create").description,
      inputSchema: LocalMcpToolInputSchemas.object_create,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_create", input))
  );

  server.registerTool(
    "object_update",
    {
      title: "Update synthetic local graph object",
      description: toolMetadata("object_update").description,
      inputSchema: LocalMcpToolInputSchemas.object_update,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_update", input))
  );

  server.registerTool(
    "object_delete",
    {
      title: "Tombstone synthetic local graph object",
      description: toolMetadata("object_delete").description,
      inputSchema: LocalMcpToolInputSchemas.object_delete,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_delete", input))
  );

  server.registerTool(
    "object_batch",
    {
      title: "Batch object mutations",
      description: toolMetadata("object_batch").description,
      inputSchema: LocalMcpToolInputSchemas.object_batch,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("object_batch", input))
  );

  server.registerTool(
    "review_list",
    {
      title: "List review cards",
      description: toolMetadata("review_list").description,
      inputSchema: LocalMcpToolInputSchemas.review_list,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => {
      try {
        return asToolContent(await callLocalTool("review_list", input));
      } catch (error) {
        console.error("Living Atlas review_list projection failed", error);
        throw error;
      }
    }
  );

  server.registerTool(
    "review_read",
    {
      title: "Read review evidence",
      description: toolMetadata("review_read").description,
      inputSchema: LocalMcpToolInputSchemas.review_read,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("review_read", input))
  );

  server.registerTool(
    "review_decide",
    {
      title: "Preview or decide reviews",
      description: toolMetadata("review_decide").description,
      inputSchema: LocalMcpToolInputSchemas.review_decide,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("review_decide", input))
  );

  server.registerTool(
    "resolution_apply",
    {
      title: "Apply canonical review resolution",
      description: toolMetadata("resolution_apply").description,
      inputSchema: LocalMcpToolInputSchemas.resolution_apply,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("resolution_apply", input))
  );

  server.registerTool(
    "search",
    {
      title: "Search graph",
      description: toolMetadata("search").description,
      inputSchema: LocalMcpToolInputSchemas.search,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("search", input))
  );

  server.registerTool(
    "traverse",
    {
      title: "Traverse graph",
      description: toolMetadata("traverse").description,
      inputSchema: LocalMcpToolInputSchemas.traverse,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("traverse", input))
  );

  server.registerTool(
    "timeline",
    {
      title: "Query timeline",
      description: toolMetadata("timeline").description,
      inputSchema: LocalMcpToolInputSchemas.timeline,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("timeline", input))
  );

  server.registerTool(
    "edge_create",
    {
      title: "Create edge",
      description: toolMetadata("edge_create").description,
      inputSchema: LocalMcpToolInputSchemas.edge_create,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("edge_create", input))
  );

  server.registerTool(
    "edge_read",
    {
      title: "Read edge",
      description: toolMetadata("edge_read").description,
      inputSchema: LocalMcpToolInputSchemas.edge_read,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("edge_read", input))
  );

  server.registerTool(
    "edge_update",
    {
      title: "Update edge",
      description: toolMetadata("edge_update").description,
      inputSchema: LocalMcpToolInputSchemas.edge_update,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("edge_update", input))
  );

  server.registerTool(
    "edge_delete",
    {
      title: "Delete edge",
      description: toolMetadata("edge_delete").description,
      inputSchema: LocalMcpToolInputSchemas.edge_delete,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("edge_delete", input))
  );

  server.registerTool(
    "edge_batch",
    {
      title: "Batch edge mutations",
      description: toolMetadata("edge_batch").description,
      inputSchema: LocalMcpToolInputSchemas.edge_batch,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("edge_batch", input))
  );

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description: toolMetadata("sync_status").description,
      inputSchema: LocalMcpToolInputSchemas.sync_status,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await callLocalTool("sync_status", input))
  );

  for (const name of ["sync_pull", "sync_envelopes", "usage_gate", "usage_reconcile"] as const) {
    server.registerTool(
      name,
      {
        title: name.replaceAll("_", " "),
        description: toolMetadata(name).description,
        inputSchema: LocalMcpToolInputSchemas[name],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (input: unknown) => asToolContent(await callLocalTool(name, input))
    );
  }

  for (const name of ["migration_open", "migration_seal"] as const) {
    server.registerTool(
      name,
      {
        title: name.replaceAll("_", " "),
        description: toolMetadata(name).description,
        inputSchema: LocalMcpToolInputSchemas[name],
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (input: unknown) => asToolContent(await callLocalTool(name, input))
    );
  }

  return server;
}

export async function runLivingAtlasLocalMcpStdio(
  context: LocalMcpContext,
  options: LocalMcpServerAuthOptions = {}
): Promise<void> {
  const server = createLivingAtlasLocalMcpServer(context, options);
  await server.connect(new StdioServerTransport());
}
