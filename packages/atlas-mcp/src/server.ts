import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  McpServer,
  fromJsonSchema,
  inputRequired,
  type CacheHint,
  type CacheScope,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
  type Tool
} from "@modelcontextprotocol/server";
import {
  CONTRACT_PROTOCOL_VERSION,
  CONTRACT_REVISION,
  createContractValidator,
  type ContractToolName,
  type LoadedContract
} from "@living-atlas/atlas-contract";
import { canonicalRecordedAt } from "@living-atlas/atlas-core";
import { AuditRecorder, type AuditEvent, type AuditJournal } from "./audit.js";
import type { CapabilityRefusalSink } from "./capability-refusal.js";
import { CREDENTIAL_META_KEY, presentedCredential } from "./credentials.js";
import { mayCallTool, permittedTools } from "./grant.js";
import type { GraphSource } from "./graph.js";
import type { Plane, Principal, PrincipalResolver } from "./principal.js";
import { errorRecord } from "./results.js";
import { createRevealStateCodec, type RevealStateCodec, type RevealStatePayload } from "./reveal-state.js";
import { contractSchemaProvider } from "./schema-provider.js";
import { AUDIT_RECEIPT_SLOT, TOOL_HANDLERS } from "./tools.js";
import type { ToolContext, ToolOutcome } from "./tool-context.js";

/**
 * The 12-tool consumer server, built from the PUBLISHED contract.
 *
 * Tools are registered from `manifest.json` and the schema documents on disk —
 * never from a schema rebuilt here. A tool whose shape is declared in two places
 * has two shapes, and the one that is wrong is always the one nobody looks at.
 * What a consumer fetched and what this server validates against are the same
 * bytes.
 *
 * This server serves the CONSUMER plane and nothing else. The operator plane is
 * a different server with a different tool set, bound to a different credential
 * class — see `operator/server.ts`. Nothing in this file imports it, so an
 * operational tool cannot reach a consumer's `tools/list` by being added to the
 * wrong table: `TOOL_HANDLERS` is `Record<ContractToolName, ToolHandler>`, and
 * `ContractToolName` is the published twelve.
 */

export const SERVER_INFO = {
  name: "living-atlas-consumer",
  version: CONTRACT_REVISION
} as const;

/** The plane this server serves. A property of the server, never of the caller. */
export const SERVER_PLANE: Plane = "consumer";

export const SERVER_INSTRUCTIONS = [
  `Living Atlas consumer plane, contract revision ${CONTRACT_REVISION}.`,
  "Call atlas.contract.describe.v1 first: it publishes the live vocabularies, the transport-invariant limits, and the belief-time history floor. Validate against what it returns, not against a copy captured when your client shipped.",
  "Call atlas.scope.describe.v1 second: it publishes YOUR credential's grant — the tools it may call, the sensitivity tiers it reaches, the predicates and tiers it may write, and the limits that apply. Differences between deployments are discovered there. Never branch on which transport you connected over.",
  "Every read result carries coverage and horizon. Records this credential may not read arrive as atlas.redaction:v1 stubs and still occupy their row, so a filtered graph is never a complete one with rows missing.",
  "World time (valid_from/valid_to) is when something was true. Belief time (recorded_at) is when Atlas learned it. They are never interchangeable."
].join(" ");

/** `private`, on every cacheable result. Not a default a caller may override. */
export const CACHE_SCOPE: CacheScope = "private";

export type AtlasServerOptions = {
  contract: LoadedContract;
  graph: GraphSource;
  auditJournal: AuditJournal;
  /**
   * Where a `-32021` refusal is parked for the transport to raise.
   *
   * REQUIRED, not optional, and that is the point: `atlas.sensitive.reveal.v1`
   * publishes a MUST that only a JSON-RPC error can satisfy, and a handler
   * cannot raise one. A server built without the sink would serve a weaker
   * contract than it publishes, silently. See `capability-refusal.ts`.
   */
  capabilityRefusals: CapabilityRefusalSink;
  /** Resolves the credential presented on each REQUEST. See `principal.ts`. */
  resolvePrincipal: PrincipalResolver;
  clock?: () => Date;
  /** HMAC key for the MRTR `requestState`. See `reveal-state.ts` for the default. */
  revealStateKey?: Uint8Array | string;
  /**
   * Return the reveal escalation as a COMPLETE result carrying
   * `outcome: "input-required"` instead of using the protocol's
   * `resultType: "input_required"` channel.
   *
   * Default `false`, which is the required behaviour: a client that declared
   * elicitation gets the protocol round. The option exists because the spec is
   * explicit that a server MUST NOT assume the client will ever retry, and a
   * harness that renders tool output but implements no multi-round-trip retry
   * can still act on the in-band form — `request_state` is a published INPUT
   * argument, so re-calling the tool is a complete second channel needing no
   * protocol support. Both forms mint the same signed state, bound the same
   * way, and write the same single audit event.
   */
  revealEscalationInBand?: boolean;
};

/**
 * The cacheable-result hints for `tools/list` and `server/discover`.
 *
 * Read from the published contract, not chosen here, and specifically from
 * `atlas.contract.describe.v1`'s own TTL — which is the contract's published
 * answer to "how long may you hold a description of me". `tools/list` and
 * `server/discover` are descriptions of the same thing, so they get the same
 * number and a cache can never outlive the description it holds.
 *
 * Deliberately NOT the minimum across all tools. Most read tools publish
 * `ttl_ms: 0` because a *result* must not be cached — a resolution or a
 * bitemporal read is answered fresh every time. That says nothing about how
 * long the tool LIST stays valid, and taking the minimum conflates the two into
 * a permanent zero.
 *
 * `private` on `tools/list` is now load-bearing rather than merely careful: the
 * listing varies by the authorization presented, so a shared cache would serve
 * one credential's permitted tool set to another.
 */
export function cacheHints(contract: LoadedContract): Partial<Record<"tools/list" | "server/discover", CacheHint>> {
  const describe = contract.manifest.tools.find((tool) => tool.name === "atlas.contract.describe.v1");
  const ttlMs = Math.max(describe?.cache.ttl_ms ?? 0, 0);
  return {
    "tools/list": { ttlMs, cacheScope: CACHE_SCOPE },
    "server/discover": { ttlMs, cacheScope: CACHE_SCOPE }
  };
}

function envelopeValue(context: ServerContext, key: string): unknown {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[key];
}

function declaredCapabilities(context: ServerContext): Readonly<Record<string, unknown>> {
  const declared = envelopeValue(context, CLIENT_CAPABILITIES_META_KEY);
  return typeof declared === "object" && declared !== null ? (declared as Record<string, unknown>) : {};
}

function requestProtocolVersion(context: ServerContext): string {
  const named = envelopeValue(context, PROTOCOL_VERSION_META_KEY);
  // The gate already refused anything else, so this is the revision the request
  // named. The fallback is the contract's own revision rather than an empty
  // string: an audit event with no protocol field is one nobody can correlate.
  return typeof named === "string" && named.length > 0 ? named : CONTRACT_PROTOCOL_VERSION;
}

/**
 * Fill the audit receipt slot a handler left for the dispatcher.
 *
 * Targeted rather than blanket: only a top-level `audit` object still carrying
 * the empty placeholder is replaced. The placeholder is empty rather than
 * plausible precisely so this can recognise it — a fabricated id that failed to
 * be replaced would validate against the schema and name nothing.
 */
function fillAuditReceipt(
  structured: Record<string, unknown>,
  receipt: Pick<AuditEvent, "event_id" | "recorded_at">
): Record<string, unknown> {
  const slot = structured["audit"];
  if (typeof slot !== "object" || slot === null) return structured;
  if ((slot as Record<string, unknown>)["event_id"] !== AUDIT_RECEIPT_SLOT.event_id) return structured;
  return { ...structured, audit: { event_id: receipt.event_id, recorded_at: receipt.recorded_at } };
}

/**
 * The tool list as this server publishes it, in contract order.
 *
 * Built from the PUBLISHED documents rather than from the SDK's re-serialization
 * of the schemas it compiled, so what a client reads out of `tools/list` and
 * what it can fetch from the contract package are the same bytes.
 */
export function publishedTools(contract: LoadedContract): Tool[] {
  return contract.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    outputSchema: tool.outputSchema as Tool["outputSchema"],
    annotations: tool.annotations
  }));
}

export type AtlasServer = {
  server: McpServer;
  /** Exposed so a host can see the codec the server verifies with. */
  reveal: RevealStateCodec;
  audit: AuditRecorder;
};


export function buildAtlasServer(options: AtlasServerOptions): AtlasServer {
  const clock = options.clock ?? (() => new Date());
  const resolve = (serverContext: ServerContext) => options.resolvePrincipal(presentedCredential(serverContext));

  const reveal = createRevealStateCodec({
    resolveBindingIdentity: (serverContext) => {
      const resolution = resolve(serverContext);
      // Throwing here is the intended verify-path behaviour: a state echoed
      // without a credential this server recognises fails at the SDK seam,
      // before any handler, rather than being bound to a shared placeholder
      // that every unauthenticated caller would also match.
      if (!resolution.ok) throw new Error("no credential resolved for this request");
      return resolution.principal.client_id;
    },
    ...(options.revealStateKey === undefined ? {} : { key: options.revealStateKey })
  });
  const audit = new AuditRecorder({ journal: options.auditJournal, clock });
  const validator = createContractValidator(options.contract);
  const schemas = contractSchemaProvider(options.contract, validator);

  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
    cacheHints: cacheHints(options.contract),
    // Without this hook the SDK hands the handler the RAW wire string: it
    // applies no integrity protection of its own and documents that it does
    // not. With it, a state failing HMAC, expiry or principal binding is
    // refused at the seam and the handler is never entered.
    requestState: { verify: reveal.verify }
  });

  /**
   * Validate a result against the tool's OWN published output schema before it
   * leaves.
   *
   * The SDK validates too, against the same document — so this is not a second
   * opinion, it is a second SEAM. An `isError` result is not output-validated
   * by the SDK, and the reveal refusal path is precisely an `isError` result
   * carrying a full contract payload. Without this, the one result shape most
   * likely to drift would be the only one nothing checked.
   */
  function completeResult(structured: Record<string, unknown>, name: string, isError: boolean): CallToolResult {
    const outcome = validator.validateToolOutput(name, structured);
    if (!outcome.valid) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              record_schema: "atlas.error:v1",
              code: "output-contract-violation",
              message: `The result this server built does not satisfy the published output schema for ${name}. It is refused rather than returned: a consumer validating against the published contract would reject it anyway, and one that does not validate would silently accept a shape nobody published.`,
              retryable: false,
              details: { errors: outcome.errors }
            })
          }
        ],
        isError: true
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
      ...(isError ? { isError: true } : {})
    };
  }

  /** A typed refusal that is not expressible in a tool's published output schema. */
  function refuse(record: ReturnType<typeof errorRecord>): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(record) }], isError: true };
  }

  /**
   * The single place an audit event is written and the single place a result
   * leaves.
   *
   * One call in, one event out. Not a convention: `ToolContext` carries no
   * recorder, so a handler CANNOT write an event — it reports counts and this
   * function writes them. That is the structural fix for the defect the prior
   * server had, where the handler held `recordToolDecision` and one of them put
   * it inside an unbounded whole-graph loop.
   */
  async function finish(input: {
    outcome: ToolOutcome;
    context: ToolContext;
    serverContext: ServerContext;
    toolName: ContractToolName;
    args: unknown;
  }): Promise<CallToolResult | InputRequiredResult> {
    const { outcome, context, toolName, args } = input;

    const write = (): AuditEvent =>
      audit.record({
        tool: toolName,
        principal: context.principal,
        plane: SERVER_PLANE,
        protocolVersion: context.protocolVersion,
        outcome: outcome.audit.outcome,
        ...(outcome.audit.reasonCode === undefined ? {} : { reasonCode: outcome.audit.reasonCode }),
        counts: outcome.audit.counts,
        ...(outcome.audit.subjects === undefined ? {} : { subjects: outcome.audit.subjects }),
        args
      });

    if (outcome.kind === "escalate") {
      const expiresAt = canonicalRecordedAt(new Date(context.now.getTime() + context.reveal.ttlSeconds * 1000));
      // The handler never touches the key: it hands over a payload, the
      // dispatcher signs it. A handler that could mint its own state could mint
      // one bound to nothing.
      const requestState = await context.reveal.codec.mint(outcome.payload, input.serverContext);
      const event = write();

      if (options.revealEscalationInBand === true) {
        return completeResult(fillAuditReceipt(outcome.inBand({ requestState, expiresAt }), event), toolName, false);
      }

      return inputRequired({
        requestState,
        inputRequests: {
          [outcome.requestId]: inputRequired.elicit({
            message: outcome.prompt,
            requestedSchema: {
              type: "object",
              properties: {
                approve: { type: "boolean", description: "Disclose this record to the calling credential." }
              },
              required: ["approve"]
            }
          })
        }
      });
    }

    const event = write();

    if (outcome.kind === "refusal") {
      // This tool's published output schema has no `error` member, so the
      // refusal cannot be expressed as a result without inventing one. It
      // becomes a tool error carrying the typed record instead.
      return refuse(outcome.error);
    }

    if (outcome.kind === "capability-required") {
      // Parked, not thrown. A throw here is inside `McpServer`'s own
      // `tools/call` try/catch, which flattens everything but
      // `UrlElicitationRequired` into a text tool error and loses the numeric
      // code — so the refusal is raised at the transport, keyed on this
      // request's id. See `capability-refusal.ts` for why that seam and not
      // another.
      const structured = fillAuditReceipt(outcome.structured, event);
      options.capabilityRefusals.park(input.serverContext.mcpReq.id, {
        requiredCapabilities: outcome.requiredCapabilities,
        message: outcome.message,
        result: structured
      });
      // Built and validated anyway: the payload has to satisfy the tool's own
      // published output schema before it is carried in `error.data`, and this
      // is the seam that checks that. The transport replaces the response.
      return completeResult(structured, toolName, true);
    }

    return completeResult(fillAuditReceipt(outcome.structured, event), toolName, outcome.isError === true);
  }

  /**
   * There are TWO channels a `requestState` can arrive on, and both are
   * attacker-controlled.
   *
   *  - The PROTOCOL channel, `params.requestState`. The SDK's configured
   *    `requestState.verify` hook runs before the handler is entered, so a bad
   *    state never reaches tool code at all.
   *
   *  - The ARGUMENT channel, `arguments.request_state`. This is a published
   *    INPUT field on `atlas.sensitive.reveal.v1` — it exists because the spec
   *    forbids assuming a client will ever retry, so a harness with no
   *    multi-round-trip support can re-call the tool instead. The SDK's hook
   *    does not see it: to the SDK it is an ordinary string argument.
   *
   * A verification enforced on one channel and not the other is not enforced.
   * Both go through the same codec, with the same principal and method binding,
   * here — before the handler runs, in code, not in a description.
   */
  async function resolveRequestState(
    args: unknown,
    serverContext: ServerContext
  ): Promise<{ kind: "ok"; payload: RevealStatePayload | undefined } | { kind: "invalid"; result: CallToolResult }> {
    const fromProtocol = serverContext.mcpReq.requestState<RevealStatePayload>();
    if (fromProtocol !== undefined) return { kind: "ok", payload: fromProtocol };

    const supplied = typeof args === "object" && args !== null ? (args as Record<string, unknown>)["request_state"] : undefined;
    if (typeof supplied !== "string" || supplied.length === 0) return { kind: "ok", payload: undefined };

    try {
      return { kind: "ok", payload: await reveal.verify(supplied, serverContext) };
    } catch {
      // The reason is deliberately not surfaced. The codec's own failure reasons
      // ('mac' / 'expired' / 'bind' / 'malformed') tell a caller which of its
      // guesses was wrong, which is an oracle. One opaque refusal, matching the
      // frozen message the SDK uses on the protocol channel.
      return {
        kind: "invalid",
        result: refuse(
          errorRecord({
            code: "invalid-request-state",
            message: "Invalid or expired request_state.",
            retryable: false,
            jsonrpcCode: -32602
          })
        )
      };
    }
  }

  for (const tool of options.contract.tools) {
    const toolName = tool.name as ContractToolName;
    const handler = TOOL_HANDLERS[toolName];

    server.registerTool(
      toolName,
      {
        title: tool.title,
        description: tool.description,
        // The PUBLISHED documents, loaded from disk, not rebuilt here — and
        // compiled by the contract's own validator, because the published
        // schemas `$ref` across documents and the SDK's default provider
        // compiles each one alone. See `schema-provider.ts`.
        inputSchema: fromJsonSchema(tool.inputSchema as never, schemas),
        outputSchema: fromJsonSchema(tool.outputSchema as never, schemas),
        annotations: tool.annotations
      },
      async (args, serverContext): Promise<CallToolResult | InputRequiredResult> => {
        /**
         * Authorization runs before anything else, in this order and in code:
         * WHO is calling, then WHETHER that credential may call this tool. Both
         * refusals write exactly one audit event, because a refused call is the
         * activity an audit reader most needs to see and a thrown exception is
         * not an event.
         */
        const resolution = resolve(serverContext);
        if (!resolution.ok) {
          audit.record({
            tool: toolName,
            principal: undefined,
            plane: SERVER_PLANE,
            protocolVersion: requestProtocolVersion(serverContext),
            outcome: "refused",
            // The event carries the PRECISE cause; the wire does not.
            reasonCode: resolution.reasonCode,
            counts: {},
            args
          });
          return refuse(
            resolution.reasonCode === "credential-required"
              ? errorRecord({
                  code: "credential-required",
                  message: `This server resolves identity from the credential presented on each request, in the request _meta member ${CREDENTIAL_META_KEY}. None was presented, so there is no client_id to attribute this call to.`,
                  retryable: false
                })
              : errorRecord({
                  code: "credential-unrecognised",
                  // One answer for every cause. Distinguishing "unknown secret"
                  // from "known secret, wrong plane" tells a prober that a
                  // secret it holds is real, which is the more useful half.
                  message: "The presented credential was not recognised by this server.",
                  retryable: false
                })
          );
        }

        const principal = resolution.principal;
        if (!mayCallTool(principal.grant, SERVER_PLANE, toolName)) {
          audit.record({
            tool: toolName,
            principal,
            plane: SERVER_PLANE,
            protocolVersion: requestProtocolVersion(serverContext),
            outcome: "refused",
            reasonCode: "tool-not-permitted",
            counts: {},
            args
          });
          return refuse(
            errorRecord({
              code: "tool-not-permitted",
              message: `This credential's grant does not permit ${toolName}. Call atlas.scope.describe.v1 for the tools it does permit rather than probing for them.`,
              retryable: false,
              remedy: { tool: "atlas.scope.describe.v1" }
            })
          );
        }

        const resolved = await resolveRequestState(args, serverContext);
        if (resolved.kind === "invalid") return resolved.result;
        const verified = resolved.payload;
        const context: ToolContext = {
          principal,
          protocolVersion: requestProtocolVersion(serverContext),
          clientCapabilities: declaredCapabilities(serverContext),
          now: clock(),
          graph: options.graph,
          contract: options.contract,
          reveal,
          ...(verified === undefined ? {} : { requestState: verified }),
          ...(serverContext.mcpReq.inputResponses === undefined
            ? {}
            : { inputResponses: serverContext.mcpReq.inputResponses })
        };

        /**
         * A throw is an OUTCOME, and it gets an event like every other one.
         *
         * Without this the failure path is the one path that leaves no trace:
         * `McpServer`'s own `tools/call` try/catch swallows everything but
         * `UrlElicitationRequired` into a text tool error — verified against
         * `@modelcontextprotocol/server@2.0.0` — so a handler that threw
         * returned an error to the caller and wrote nothing to the journal. An
         * audit reader would see the refused calls and the successful ones and
         * nothing in between, which reports a tool crashing on crafted input as
         * silence. That is the same failure mode as the unwritable log this
         * package was built to fix, reached from the other direction.
         *
         * Guarded on the recorder's own counter rather than wrapping only the
         * handler call, so the invariant is EXACTLY one event per call no matter
         * where the throw came from: if `finish` already wrote, this writes
         * nothing and rethrows to the SDK; if nothing wrote, this writes the one
         * event. A second event here would be the per-call-fanout regression the
         * counter exists to catch.
         */
        const before = audit.writes;
        try {
          const outcome = await handler((args ?? {}) as Record<string, unknown>, context);
          return await finish({ outcome, context, serverContext, toolName, args });
        } catch (thrown) {
          if (audit.writes !== before) throw thrown;
          audit.record({
            tool: toolName,
            principal,
            plane: SERVER_PLANE,
            protocolVersion: context.protocolVersion,
            outcome: "error",
            reasonCode: "handler-failed",
            counts: {},
            args
          });
          // The event records that this call failed; it deliberately does not
          // record WHAT failed, and neither does the wire. A thrown message
          // carries stack frames, file paths and frequently the graph value that
          // provoked it — the message is the leak, and copying it into the
          // journal would put it somewhere longer-lived than the response.
          return refuse(
            errorRecord({
              code: "internal-error",
              message:
                "This tool failed while serving the request. The failure is recorded in this server's audit log; no detail about it is returned here, because a fault message is a channel for graph content and server internals.",
              retryable: false
            })
          );
        }
      }
    );
  }

  /**
   * `tools/list` answers with the tools the PRESENTED credential may call.
   *
   * Spec-legal under 2026-07-28, and the specification says so in as many words
   * (server/tools §Capabilities): the set "**MAY** vary by the authorization
   * presented on the request — for example, returning only the tools the
   * caller's granted scopes permit — since credentials are per-request input,
   * not connection state". The same paragraph forbids the other thing, which is
   * why the filter reads the request's credential and never the connection: the
   * set "**MUST NOT** vary per-connection or as a side effect of other requests
   * on the connection".
   *
   * Installed by overwriting the SDK's own handler AFTER registration. Measured
   * against `@modelcontextprotocol/server@2.0.0`: `McpServer` installs its
   * `tools/list` handler lazily on the first `registerTool`, guarding with
   * `assertCanSetRequestHandler` — so a handler installed FIRST makes
   * `registerTool` throw. `Server.setRequestHandler` itself does not assert; it
   * overwrites. Registering first and overriding second is therefore the only
   * order that works, and the override still passes through `_wrapHandler`, so
   * the configured `ttlMs`/`cacheScope` are still attached.
   *
   * An unresolved credential gets an EMPTY list rather than an error. That is
   * the honest answer to "what may I call" from a credential this server does
   * not recognise, and the spec allows the set to be empty. `tools/call`
   * refuses explicitly instead, because there the caller needs to learn why.
   *
   * And because the answer VARIES by credential, the listing is itself an
   * authorization decision and writes its own audit event. Without one, this is
   * the only credential-varying operation on the server that leaves no trace: a
   * caller could enumerate credentials against `tools/list` — an unrecognised
   * one gets `[]`, a recognised one gets its set — and produce nothing an audit
   * reader could see, while the identical probe through `tools/call` writes an
   * event every time. AGENTS.md: reads by remote providers are security-relevant
   * events and must be observable.
   */
  const published = publishedTools(options.contract);
  server.server.setRequestHandler("tools/list", (_request, serverContext) => {
    const resolution = resolve(serverContext);
    // `args` is the empty object rather than the request: `tools/list` carries
    // no arguments, and the digest has to be over what the caller sent.
    const listed = (tools: Tool[], principal: Principal | undefined, reasonCode?: string): { tools: Tool[] } => {
      audit.record({
        tool: "tools/list",
        principal,
        plane: SERVER_PLANE,
        protocolVersion: requestProtocolVersion(serverContext),
        outcome: principal === undefined ? "refused" : "ok",
        ...(reasonCode === undefined ? {} : { reasonCode }),
        // The COUNT, never the names: which tools a credential may call is
        // derivable from `grant_id`, and the event already carries that.
        counts: { returned: tools.length },
        args: {}
      });
      return { tools };
    };

    if (!resolution.ok) return listed([], undefined, resolution.reasonCode);
    const permitted = new Set(
      permittedTools(
        resolution.principal.grant,
        SERVER_PLANE,
        published.map((tool) => tool.name)
      )
    );
    return listed(published.filter((tool) => permitted.has(tool.name)), resolution.principal);
  });

  return { server, reveal, audit };
}
