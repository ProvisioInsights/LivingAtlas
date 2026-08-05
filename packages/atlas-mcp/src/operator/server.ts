import { z } from "zod";
import {
  PROTOCOL_VERSION_META_KEY,
  McpServer,
  type CacheHint,
  type CacheScope,
  type CallToolResult,
  type ServerContext,
  type Tool
} from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION, CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import { AuditRecorder, type AuditJournal } from "../audit.js";
import { CREDENTIAL_META_KEY, presentedCredential } from "../credentials.js";
import { permittedTools } from "../grant.js";
import type { Plane, Principal, PrincipalResolver } from "../principal.js";
import { errorRecord, type ErrorRecord } from "../results.js";
import type { OperatorSource } from "./source.js";
import { OPERATOR_TOOLS, mayCallOperatorTool, type OperatorContext, type OperatorToolDefinition } from "./tools.js";

/**
 * The operator MCP server: a SEPARATE server, bound to a separate credential
 * class, never advertised in a consumer's `tools/list`.
 *
 * Two mechanisms keep it separate, and removing either still separates it.
 *
 *  1. **Different servers.** This builds its own `McpServer` with its own
 *     `serverInfo` and its own tool table. The consumer server registers
 *     `TOOL_HANDLERS`, which is `Record<ContractToolName, ToolHandler>` — total
 *     over the published twelve — so an operator tool is not expressible there.
 *     Nothing in the consumer tree imports this file.
 *  2. **Different credentials.** `credentialResolver` is built for
 *     `plane: "operator"` and refuses any credential granted another plane, and
 *     `PrincipalSchema` refuses a principal whose plane and credential class
 *     disagree. A consumer credential presented here never reaches a handler,
 *     and sees an empty `tools/list`.
 *
 * Varying the tool set by the presented authorization is explicitly permitted by
 * MCP 2026-07-28. From the specification, server/tools §Capabilities:
 *
 *   "Servers that declare the `tools` capability **MUST** respond to
 *    `tools/list` requests with the set of tools currently available to the
 *    requesting client. This set **MAY** be empty and **MAY** change over time
 *    …, but **MUST NOT** vary per-connection or as a side effect of other
 *    requests on the connection. The set **MAY** vary by the authorization
 *    presented on the request — for example, returning only the tools the
 *    caller's granted scopes permit — since credentials are per-request input,
 *    not connection state."
 *
 * Which is why the filter below reads the credential off the REQUEST and never
 * off the connection: the same paragraph that permits the one forbids the other.
 */

export const OPERATOR_SERVER_INFO = {
  name: "living-atlas-operator",
  version: CONTRACT_REVISION
} as const;

/** The plane this server serves. A property of the server, never of the caller. */
export const OPERATOR_PLANE: Plane = "operator";

export const OPERATOR_SERVER_INSTRUCTIONS = [
  "Living Atlas operator plane. Operational concerns only: migration windows, replication and sync state, usage and billing reconciliation, the curation queue, reconcile, and the audit read path.",
  "This is not the consumer surface and does not read graph content. A tool here answers a question about the system, never about the knowledge in it.",
  "Call atlas.ops.scope.describe.v1 first: it publishes this credential's grant and this plane's refusal vocabulary. Never branch on which transport you connected over.",
  "atlas.ops.reconcile.run.v1 defaults to dry_run. Every call writes exactly one durable audit event whether or not anything was applied."
].join(" ");

/** `private`, on every cacheable result — the listing varies by credential. */
export const OPERATOR_CACHE_SCOPE: CacheScope = "private";

/**
 * How long an operator client may hold a tool listing.
 *
 * Short, and shorter than the consumer plane's, on purpose: an operator's tool
 * set changes when a grant is revised, and a revision that takes an hour to be
 * noticed is an hour of a client offering an operator a tool that will refuse.
 */
export const OPERATOR_LIST_TTL_MS = 60_000;

export type OperatorServerOptions = {
  source: OperatorSource;
  auditJournal: AuditJournal;
  /** Resolves the credential presented on each REQUEST, for the operator plane. */
  resolvePrincipal: PrincipalResolver;
  clock?: () => Date;
};

export type OperatorServer = {
  server: McpServer;
  audit: AuditRecorder;
};

function envelopeValue(context: ServerContext, key: string): unknown {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[key];
}

function requestProtocolVersion(context: ServerContext): string {
  const named = envelopeValue(context, PROTOCOL_VERSION_META_KEY);
  return typeof named === "string" && named.length > 0 ? named : CONTRACT_PROTOCOL_VERSION;
}

/**
 * The tool list this server publishes, as JSON Schema.
 *
 * Converted from the zod definitions once at build time rather than per
 * request, so the listing a client caches and the schema the SDK validates
 * against are derived from the same object.
 */
export function operatorToolDefinitions(): Tool[] {
  return OPERATOR_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.input, { io: "input" }) as Tool["inputSchema"],
    outputSchema: z.toJSONSchema(tool.output, { io: "output" }) as Tool["outputSchema"],
    annotations: tool.annotations
  }));
}

export function buildOperatorServer(options: OperatorServerOptions): OperatorServer {
  const clock = options.clock ?? (() => new Date());
  const audit = new AuditRecorder({ journal: options.auditJournal, clock });
  const resolve = (serverContext: ServerContext) => options.resolvePrincipal(presentedCredential(serverContext));

  const server = new McpServer(OPERATOR_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: OPERATOR_SERVER_INSTRUCTIONS,
    cacheHints: {
      "tools/list": { ttlMs: OPERATOR_LIST_TTL_MS, cacheScope: OPERATOR_CACHE_SCOPE },
      "server/discover": { ttlMs: OPERATOR_LIST_TTL_MS, cacheScope: OPERATOR_CACHE_SCOPE }
    }
  });

  function refuse(record: ErrorRecord): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(record) }], isError: true };
  }

  /**
   * Validate a result against the tool's own output shape before it leaves.
   *
   * The operator plane publishes no fetchable contract, which makes this MORE
   * necessary rather than less: there is no third party validating the other
   * end, so a drifting result would be noticed by nobody.
   */
  function complete(tool: OperatorToolDefinition, structured: Record<string, unknown>): CallToolResult {
    const parsed = tool.output.safeParse(structured);
    if (!parsed.success) {
      return refuse(
        errorRecord({
          code: "output-contract-violation",
          message: `The result this server built does not satisfy the declared output shape for ${tool.name}. It is refused rather than returned.`,
          retryable: false,
          details: { errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) }
        })
      );
    }
    // The ORIGINAL object, not the parsed one: a loose object parse returns a
    // copy, and returning the copy would make the validator's normalisation
    // part of the wire format.
    return {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured
    };
  }

  for (const tool of OPERATOR_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: tool.output,
        annotations: tool.annotations
      },
      async (args, serverContext): Promise<CallToolResult> => {
        const resolution = resolve(serverContext);
        if (!resolution.ok) {
          audit.record({
            tool: tool.name,
            principal: undefined,
            plane: OPERATOR_PLANE,
            protocolVersion: requestProtocolVersion(serverContext),
            outcome: "refused",
            // The precise cause is in the event; the wire gets one answer, so a
            // consumer credential presented here cannot learn that it IS a
            // valid credential for somewhere else.
            reasonCode: resolution.reasonCode,
            counts: {},
            args
          });
          return refuse(
            resolution.reasonCode === "credential-required"
              ? errorRecord({
                  code: "credential-required",
                  message: `This server resolves identity from the credential presented on each request, in the request _meta member ${CREDENTIAL_META_KEY}. None was presented.`,
                  retryable: false
                })
              : errorRecord({
                  code: "credential-unrecognised",
                  message: "The presented credential was not recognised by this server.",
                  retryable: false
                })
          );
        }

        const principal = resolution.principal;
        if (!mayCallOperatorTool(principal.grant, tool.name)) {
          audit.record({
            tool: tool.name,
            principal,
            plane: OPERATOR_PLANE,
            protocolVersion: requestProtocolVersion(serverContext),
            outcome: "refused",
            reasonCode: "tool-not-permitted",
            counts: {},
            args
          });
          return refuse(
            errorRecord({
              code: "tool-not-permitted",
              message: `This credential's grant does not permit ${tool.name}. Call atlas.ops.scope.describe.v1 for the tools it does permit rather than probing for them.`,
              retryable: false,
              remedy: { tool: "atlas.ops.scope.describe.v1" }
            })
          );
        }

        const context: OperatorContext = {
          principal,
          protocolVersion: requestProtocolVersion(serverContext),
          now: clock(),
          source: options.source
        };

        /**
         * A throw is an outcome here too, and on THIS plane the gap was worse: a
         * failing operational tool is exactly the event an operator is reading
         * the journal to find, and the SDK's `tools/call` catch would have
         * turned it into a text error that the journal never saw.
         *
         * Same shape as the consumer plane, guarded on the recorder's counter so
         * the invariant is exactly one event per call regardless of where the
         * throw came from. See `../server.ts` for the full reasoning.
         */
        const before = audit.writes;
        try {
          const outcome = await tool.handler((args ?? {}) as Record<string, unknown>, context);

          // One call in, one event out. `OperatorContext` carries no recorder, so
          // a handler cannot write an event even by mistake — the same structural
          // rule as the consumer plane, for the same reason.
          audit.record({
            tool: tool.name,
            principal,
            plane: OPERATOR_PLANE,
            protocolVersion: context.protocolVersion,
            outcome: outcome.audit.outcome,
            ...(outcome.audit.reasonCode === undefined ? {} : { reasonCode: outcome.audit.reasonCode }),
            counts: outcome.audit.counts,
            ...(outcome.audit.subjects === undefined ? {} : { subjects: outcome.audit.subjects }),
            args
          });

          if (outcome.kind === "refusal") return refuse(outcome.error);
          return complete(tool, outcome.structured);
        } catch (thrown) {
          if (audit.writes !== before) throw thrown;
          audit.record({
            tool: tool.name,
            principal,
            plane: OPERATOR_PLANE,
            protocolVersion: context.protocolVersion,
            outcome: "error",
            reasonCode: "handler-failed",
            counts: {},
            args
          });
          // Recorded that it failed, never what failed — a fault message carries
          // stack frames and whatever value provoked it, and this plane reads the
          // control store.
          return refuse(
            errorRecord({
              code: "internal-error",
              message:
                "This tool failed while serving the request. The failure is recorded in this server's audit log; no detail about it is returned here, because a fault message is a channel for server internals.",
              retryable: false
            })
          );
        }
      }
    );
  }

  /**
   * `tools/list` answers with the operator tools the PRESENTED credential may
   * call, and with nothing at all for a credential this plane does not know.
   *
   * Empty rather than an error: the spec allows the set to be empty, and "you
   * may call nothing here" is the honest and least informative answer to a
   * consumer credential that found this endpoint. `tools/call` refuses by name,
   * because there the caller needs to learn why.
   *
   * Installed by overwriting the SDK's own handler AFTER registration. Measured
   * against `@modelcontextprotocol/server@2.0.0`: `McpServer` installs its
   * `tools/list` handler lazily on the first `registerTool` and guards with
   * `assertCanSetRequestHandler`, so installing first makes `registerTool`
   * throw; `Server.setRequestHandler` itself overwrites without asserting.
   *
   * The listing varies by the presented credential, so it is an authorization
   * decision and writes its own audit event — the same rule as the consumer
   * plane. On THIS plane it matters more: a consumer credential probing here is
   * exactly the event an operator wants to see, and an empty list that recorded
   * nothing would report that probe as silence.
   */
  const definitions = operatorToolDefinitions();
  server.server.setRequestHandler("tools/list", (_request, serverContext) => {
    const resolution = resolve(serverContext);
    const listed = (tools: Tool[], principal: Principal | undefined, reasonCode?: string): { tools: Tool[] } => {
      audit.record({
        tool: "tools/list",
        principal,
        plane: OPERATOR_PLANE,
        protocolVersion: requestProtocolVersion(serverContext),
        outcome: principal === undefined ? "refused" : "ok",
        ...(reasonCode === undefined ? {} : { reasonCode }),
        counts: { returned: tools.length },
        args: {}
      });
      return { tools };
    };

    if (!resolution.ok) return listed([], undefined, resolution.reasonCode);
    const permitted = new Set(
      permittedTools(
        resolution.principal.grant,
        OPERATOR_PLANE,
        definitions.map((tool) => tool.name)
      )
    );
    return listed(definitions.filter((tool) => permitted.has(tool.name)), resolution.principal);
  });

  return { server, audit };
}

/** The cache hint this server publishes, exposed for a host that mirrors it. */
export function operatorCacheHints(): Partial<Record<"tools/list" | "server/discover", CacheHint>> {
  return {
    "tools/list": { ttlMs: OPERATOR_LIST_TTL_MS, cacheScope: OPERATOR_CACHE_SCOPE },
    "server/discover": { ttlMs: OPERATOR_LIST_TTL_MS, cacheScope: OPERATOR_CACHE_SCOPE }
  };
}
