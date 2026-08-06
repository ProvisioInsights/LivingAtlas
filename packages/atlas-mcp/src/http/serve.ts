import {
  ProtocolErrorCode,
  createMcpHandler,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHttpHandler,
  type McpRequestContext,
  type McpServer,
  type Server
} from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import { CapabilityRefusalSink } from "../capability-refusal.js";
import type { CredentialDirectory } from "../credentials.js";
import type { PrincipalResolver } from "../principal.js";
import { bearerBoundResolver, presentedBearer, requireHttpCredentials } from "./auth.js";
import { applyCapabilityRefusal } from "./refusal-rewrite.js";

/**
 * The Streamable HTTP transport for both planes, MCP revision 2026-07-28.
 *
 * The contract's core promise is that a consumer never branches on transport, so
 * the second transport gets the same server CORE — `buildAtlasServer` /
 * `buildOperatorServer`, unchanged — rather than a second implementation of it.
 * What differs between the two entries is confined to this directory: how a
 * credential arrives (`auth.ts`), and where the `-32021` swap is applied
 * (`refusal-rewrite.ts`). Neither changes what a tool answers.
 *
 * The protocol itself is `createMcpHandler` with `legacy: 'reject'`, and it is
 * used rather than hand-wired for a measured reason. Against
 * `@modelcontextprotocol/server@2.0.0` the entry already answers, correctly:
 * `-32020` + 400 for a missing or disagreeing `Mcp-Method` / `Mcp-Name` /
 * `MCP-Protocol-Version` (including base64-sentinel values); `-32601` + 404 for
 * an unknown method; `-32022` + 400 naming `["2026-07-28"]` for a request whose
 * envelope claims any other revision, for a request with no envelope, and for a
 * 2025-era `initialize`; `405` for GET and DELETE; `415` for a non-JSON body;
 * `202` for a notification; and on an SSE upgrade, `X-Accel-Buffering: no`. An
 * `Mcp-Session-Id` header is ignored and never echoed. Each of those was
 * verified by running it, and `transport-conformance.test.ts` re-verifies them
 * so an SDK upgrade that regresses one fails the build here rather than in a
 * deployment.
 *
 * Two things the entry documents that it does NOT do, and this file therefore
 * must: Origin validation, and authentication. Both are below, in code.
 */

/** The single revision either plane speaks over HTTP. Same constant as stdio. */
export const HTTP_SUPPORTED_PROTOCOL_VERSIONS = [CONTRACT_PROTOCOL_VERSION] as const;

/**
 * `HeaderMismatch`, the code the revision assigns to a header that is missing,
 * malformed, or disagrees with the body.
 *
 * Spelled out here because `ProtocolErrorCode` in
 * `@modelcontextprotocol/server@2.0.0` does not carry it: the SDK emits `-32020`
 * from its core internals but publishes no enum member for it, so an import
 * would not compile and a bare `-32020` at the call site would be a number
 * nobody could search for.
 */
export const HEADER_MISMATCH_CODE = -32020;

/** The MCP endpoint path. One path, POST only, as the revision requires. */
export const DEFAULT_MCP_ENDPOINT = "/mcp";

export type AtlasHttpRejection = {
  status: number;
  reasonCode:
    | "endpoint-unknown"
    | "origin-forbidden"
    | "bearer-required"
    | "protocol-version-header-required";
};

export type AtlasHttpServeOptions = {
  /**
   * Resolves a bearer secret into a principal. The SAME resolver the stdio entry
   * is given — normally `credentialResolver({ directory, plane })`.
   */
  resolvePrincipal: PrincipalResolver;
  /**
   * The directory behind that resolver, so the listener can refuse to start
   * without one. Required: see `auth.ts` for why HTTP has no fixed-principal
   * mode.
   */
  credentials: CredentialDirectory;
  /** Defaults to `/mcp`. */
  endpoint?: string;
  /**
   * Origin hostnames a browser may present. Defaults to the SDK's localhost set.
   * A request whose `Origin` is absent is allowed (non-browser clients send
   * none); any present value outside the set is 403.
   */
  allowedOrigins?: string[];
  /** Observability for edge refusals. They never reach a tool, so they never reach the audit log. */
  onRejection?: (rejection: AtlasHttpRejection) => void;
  onerror?: (error: Error) => void;
};

/** A JSON-RPC error response with no `id`, which the revision permits for edge refusals. */
function edgeError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Refuse a POST that carries no `MCP-Protocol-Version` header.
 *
 * The revision makes the header REQUIRED on every POST and lists a missing
 * standard header among the conditions that MUST produce `-32020` + 400. It also
 * permits a server that still serves pre-2025-06-18 clients to infer the version
 * instead — which is what the SDK does, so a header-less request measurably
 * reaches the modern path and is answered `200`. This server serves exactly one
 * revision and no legacy era, so the permission does not apply to it and the
 * MUST does. Closed here rather than by patching the SDK.
 */
function protocolVersionHeaderMissing(request: Request): boolean {
  return request.headers.get("mcp-protocol-version") === null;
}

type AtlasHttpServer = { server: McpServer | Server };

/**
 * Build the fetch handler for one plane.
 *
 * `build` receives the per-request principal resolver and the sink for that
 * request; everything else about the server is the plane's own business and this
 * file never looks inside it.
 *
 * The sink is created PER REQUEST and reached through a `WeakMap` keyed on the
 * `Request` object, which is the same object the SDK hands back as
 * `ctx.requestInfo` — verified against 2.0.0. Per request rather than per
 * listener because a refusal is parked under a JSON-RPC id, ids are chosen by
 * the caller, and every client in the world numbers its first request `1`: one
 * shared sink would deliver one caller's refusal onto another caller's response
 * as soon as two requests were in flight.
 */
export function atlasHttpFetchHandler(
  options: AtlasHttpServeOptions,
  build: (input: { resolvePrincipal: PrincipalResolver; capabilityRefusals: CapabilityRefusalSink }) => AtlasHttpServer
): { fetch: (request: Request) => Promise<Response>; close: () => Promise<void> } {
  requireHttpCredentials(options.credentials);

  const endpoint = options.endpoint ?? DEFAULT_MCP_ENDPOINT;
  const allowedOrigins = options.allowedOrigins ?? localhostAllowedOrigins();
  const scopes = new WeakMap<Request, { resolvePrincipal: PrincipalResolver; sink: CapabilityRefusalSink }>();

  const factory = (ctx: McpRequestContext): McpServer | Server => {
    const scope = ctx.requestInfo === undefined ? undefined : scopes.get(ctx.requestInfo);
    if (scope === undefined) {
      // Unreachable through `serve` below, which always registers a scope before
      // it calls `fetch`. It throws rather than falling back to the unbound
      // resolver, because the fallback would be a server that answers without
      // having authenticated anyone — the one failure this file exists to make
      // impossible.
      throw new Error("no request scope for this HTTP exchange: refusing to build a server with no bound credential");
    }
    return build({ resolvePrincipal: scope.resolvePrincipal, capabilityRefusals: scope.sink }).server;
  };

  const handler: McpHttpHandler = createMcpHandler(factory, {
    legacy: "reject",
    ...(options.onerror === undefined ? {} : { onerror: options.onerror })
  });

  const reject = (rejection: AtlasHttpRejection, response: Response): Response => {
    options.onRejection?.(rejection);
    return response;
  };

  const serve = async (request: Request): Promise<Response> => {
    // 1. The endpoint. One path serves MCP; anything else is 404 with `-32601`,
    //    which is the answer the revision gives for a method this server does not
    //    host and the one a negotiating client can tell from a legacy 404.
    if (new URL(request.url).pathname !== endpoint) {
      return reject(
        { status: 404, reasonCode: "endpoint-unknown" },
        edgeError(404, ProtocolErrorCode.MethodNotFound, `No MCP endpoint at this path. This server serves ${endpoint}.`)
      );
    }

    // 2. Origin, BEFORE authentication. A DNS-rebinding attacker's page holds no
    //    bearer token, but it does hold the browser's ambient reach to loopback,
    //    and the refusal should not depend on what it managed to guess.
    const foreignOrigin = originValidationResponse(request, allowedOrigins);
    if (foreignOrigin !== undefined) return reject({ status: 403, reasonCode: "origin-forbidden" }, foreignOrigin);

    // 3. Authentication, before the body is parsed and before any server exists.
    const bearer = presentedBearer(request.headers);
    if (bearer === undefined) {
      return reject(
        { status: 401, reasonCode: "bearer-required" },
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: ProtocolErrorCode.InvalidRequest,
              message:
                "This endpoint resolves identity from the bearer token on each request. Present Authorization: Bearer <credential>."
            }
          }),
          {
            status: 401,
            headers: {
              "content-type": "application/json",
              // RFC 9110 requires the challenge on a 401. Bare `Bearer`: naming a
              // realm or a scope would describe the credential set to something
              // that has not authenticated.
              "www-authenticate": "Bearer"
            }
          }
        )
      );
    }

    // 4. The one conformance gap the SDK leaves open on the modern path.
    if (request.method === "POST" && protocolVersionHeaderMissing(request)) {
      return reject(
        { status: 400, reasonCode: "protocol-version-header-required" },
        edgeError(
          400,
          HEADER_MISMATCH_CODE,
          `Missing required header MCP-Protocol-Version. This server speaks ${CONTRACT_PROTOCOL_VERSION} only and has no legacy era to infer a version for.`
        )
      );
    }

    const scope = {
      resolvePrincipal: bearerBoundResolver(options.resolvePrincipal, bearer),
      sink: new CapabilityRefusalSink()
    };
    scopes.set(request, scope);

    const response = await handler.fetch(request);
    return applyCapabilityRefusal(response, scope.sink);
  };

  return { fetch: serve, close: () => handler.close() };
}
