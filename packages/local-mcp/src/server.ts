import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ObjectIdSchema } from "@living-atlas/contracts";
import {
  LocalGraphExpectedVersionSchema,
  LocalGraphObjectInputSchema,
  LocalGraphUpdatePatchSchema,
  localCreateObject,
  localGraphStatus,
  localListObjects,
  localReadObject,
  localTombstoneObject,
  localUpdateObject,
  type LocalMcpContext,
  type LocalGraphCreateToolInput,
  type LocalGraphReadToolInput,
  type LocalGraphTombstoneToolInput,
  type LocalGraphToolInput,
  type LocalGraphUpdateToolInput
} from "./local-graph";

export type LocalMcpServerAuthOptions = {
  authorizationHeader?: string;
};

const EmptyInputSchema = {};
const ReadObjectInputSchema = {
  object_id: ObjectIdSchema.describe("Living Atlas graph object id.")
};
const CreateObjectInputSchema = {
  object: LocalGraphObjectInputSchema.describe("Complete graph object envelope or local plaintext draft to create.")
};
const UpdateObjectInputSchema = {
  object_id: ObjectIdSchema.describe("Living Atlas graph object id."),
  expected_version: LocalGraphExpectedVersionSchema.describe("Optional optimistic version guard."),
  patch: LocalGraphUpdatePatchSchema.describe("Synthetic in-memory graph object fields to merge into the existing envelope.")
};
const TombstoneObjectInputSchema = {
  object_id: ObjectIdSchema.describe("Living Atlas graph object id."),
  expected_version: LocalGraphExpectedVersionSchema.describe("Optional optimistic version guard.")
};

export const LocalMcpToolInputSchemas = {
  local_graph_status: EmptyInputSchema,
  local_list_objects: EmptyInputSchema,
  local_read_object: ReadObjectInputSchema,
  local_create_object: CreateObjectInputSchema,
  local_update_object: UpdateObjectInputSchema,
  local_tombstone_object: TombstoneObjectInputSchema
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

function withReadAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphReadToolInput {
  return withAuthorization(input, options) as LocalGraphReadToolInput;
}

function withCreateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphCreateToolInput {
  return withAuthorization(input, options) as LocalGraphCreateToolInput;
}

function withUpdateAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphUpdateToolInput {
  return withAuthorization(input, options) as LocalGraphUpdateToolInput;
}

function withTombstoneAuthorization(input: unknown, options: LocalMcpServerAuthOptions): LocalGraphTombstoneToolInput {
  return withAuthorization(input, options) as LocalGraphTombstoneToolInput;
}

export function createLivingAtlasLocalMcpServer(
  context: LocalMcpContext,
  options: LocalMcpServerAuthOptions = {}
): McpServer {
  const server = new McpServer({
    name: "living-atlas-local",
    version: "0.1.0"
  });

  server.registerTool(
    "local_graph_status",
    {
      title: "Local graph status",
      description: "Return fixture-backed local graph status for an authenticated local Living Atlas client.",
      inputSchema: LocalMcpToolInputSchemas.local_graph_status,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localGraphStatus(context, withAuthorization(input, options)))
  );

  server.registerTool(
    "local_list_objects",
    {
      title: "List local graph objects",
      description: "List graph object envelopes visible to an authenticated local Living Atlas client.",
      inputSchema: LocalMcpToolInputSchemas.local_list_objects,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localListObjects(context, withAuthorization(input, options)))
  );

  server.registerTool(
    "local_read_object",
    {
      title: "Read local graph object",
      description: "Read one graph object envelope through local Living Atlas policy enforcement.",
      inputSchema: LocalMcpToolInputSchemas.local_read_object,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localReadObject(context, withReadAuthorization(input, options)))
  );

  server.registerTool(
    "local_create_object",
    {
      title: "Create synthetic local graph object",
      description: "Create one authenticated synthetic in-memory graph object envelope. This is not durable persistence.",
      inputSchema: LocalMcpToolInputSchemas.local_create_object,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localCreateObject(context, withCreateAuthorization(input, options)))
  );

  server.registerTool(
    "local_update_object",
    {
      title: "Update synthetic local graph object",
      description: "Update one authenticated synthetic in-memory graph object envelope. This is not durable persistence.",
      inputSchema: LocalMcpToolInputSchemas.local_update_object,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localUpdateObject(context, withUpdateAuthorization(input, options)))
  );

  server.registerTool(
    "local_tombstone_object",
    {
      title: "Tombstone synthetic local graph object",
      description: "Tombstone one authenticated synthetic in-memory graph object envelope without hard-deleting it. This is not durable persistence.",
      inputSchema: LocalMcpToolInputSchemas.local_tombstone_object,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input: unknown) => asToolContent(await localTombstoneObject(context, withTombstoneAuthorization(input, options)))
  );

  return server;
}

export async function runLivingAtlasLocalMcpStdio(
  context: LocalMcpContext,
  options: LocalMcpServerAuthOptions = {}
): Promise<void> {
  const server = createLivingAtlasLocalMcpServer(context, options);
  await server.connect(new StdioServerTransport());
}
