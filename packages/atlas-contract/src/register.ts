import type { LoadedContract, LoadedTool } from "./manifest.js";
import type { ContractValidator, ValidationOutcome } from "./validator.js";
import type { JsonSchema } from "./shape.js";

/**
 * Binding the published contract to a server.
 *
 * The server registers tools FROM the manifest. It does not carry its own copy
 * of any schema, and there is no code path here that lets it advertise a shape
 * different from the one it published — the schemas handed to `registerTool`
 * are the bytes read off disk, unmodified.
 *
 * The registrar port is structural on purpose: this package does not import an
 * MCP SDK. A contract that depends on a protocol library is a contract that
 * gets revised whenever the library does.
 */

export type RegisteredToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: LoadedTool["annotations"];
  _meta: Record<string, unknown>;
};

export type ToolHandler = (args: unknown) => Promise<unknown> | unknown;

export type ToolRegistrar = {
  registerTool(definition: RegisteredToolDefinition, handler: ToolHandler): void;
};

/**
 * Arguments failed the tool's published input schema. A CALLER error: it maps
 * to JSON-RPC -32602 and the caller can fix it. Thrown rather than returned,
 * because a tool's own output schema has no shape that can express "your
 * arguments were wrong" — every read result requires a coverage block and a
 * horizon, and inventing empty ones would report a refusal as an answer.
 */
export class ContractInputError extends Error {
  readonly code = "invalid-argument";
  readonly jsonrpc_code = -32602;
  constructor(
    readonly tool: string,
    readonly errors: string[]
  ) {
    super(`${tool}: arguments failed the published input schema: ${errors.join("; ")}`);
    this.name = "ContractInputError";
  }
}

/**
 * A result failed the tool's own published output schema. A SERVER error, and
 * deliberately loud: the contract's single promise is that a response matches
 * the shape it published, so serving a violation is worse than serving nothing.
 * Consumers cache and replay these records for years with no server present to
 * ask what a malformed one meant.
 */
export class ContractOutputError extends Error {
  readonly code = "contract-output-violation";
  constructor(
    readonly tool: string,
    readonly errors: string[]
  ) {
    super(`${tool}: result failed its own published output schema: ${errors.join("; ")}`);
    this.name = "ContractOutputError";
  }
}

export type RegisterOptions = {
  /**
   * Validate results before returning them. On by default: a server that
   * validates only what comes in is checking the party that cannot break the
   * contract's promise, and not the one that can.
   */
  validateOutput?: boolean;
};

export function registerContractTools(
  registrar: ToolRegistrar,
  contract: LoadedContract,
  validator: ContractValidator,
  handlers: Record<string, ToolHandler>,
  options: RegisterOptions = {}
): string[] {
  const validateOutput = options.validateOutput ?? true;
  const published = new Set<string>(contract.tools.map((tool) => tool.name));

  // Both directions, and both are failures. A published tool with no handler is
  // a tool that appears in tools/list and then errors when called; a handler
  // for an unpublished tool is a callable surface nobody reviewed and no
  // consumer can validate against. The prior surface had 30 tools whose only
  // description of a response was prose.
  const missing = contract.tools.filter((tool) => !(tool.name in handlers)).map((tool) => tool.name);
  if (missing.length > 0) {
    throw new Error(`published tools have no handler: ${missing.join(", ")}`);
  }
  const unpublished = Object.keys(handlers).filter((name) => !published.has(name));
  if (unpublished.length > 0) {
    throw new Error(`handlers registered for unpublished tools: ${unpublished.join(", ")}`);
  }

  const registered: string[] = [];
  // Manifest order, which is contract order. tools/list is a list a consumer
  // diffs; an order that depends on object iteration changes for reasons nobody
  // can name.
  for (const tool of contract.tools) {
    const handler = handlers[tool.name];
    if (!handler) continue;

    registrar.registerTool(
      {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        _meta: {
          "atlas.contract/revision": contract.manifest.contract_revision,
          "atlas.contract/input_schema_id": tool.input_schema_id,
          "atlas.contract/output_schema_id": tool.output_schema_id,
          "atlas.contract/cache": tool.cache,
          "atlas.contract/requires_capabilities": tool.requires_capabilities,
          "atlas.contract/deprecation": tool.deprecation
        }
      },
      async (args: unknown) => {
        assertOk(validator.validateToolInput(tool.name, args), (errors) => new ContractInputError(tool.name, errors));
        const result = await handler(args);
        if (validateOutput) {
          assertOk(
            validator.validateToolOutput(tool.name, result),
            (errors) => new ContractOutputError(tool.name, errors)
          );
        }
        return result;
      }
    );
    registered.push(tool.name);
  }

  return registered;
}

function assertOk(outcome: ValidationOutcome, toError: (errors: string[]) => Error): void {
  if (!outcome.valid) throw toError(outcome.errors);
}
