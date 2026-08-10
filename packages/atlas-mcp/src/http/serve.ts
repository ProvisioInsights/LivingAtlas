import { AsyncLocalStorage } from "node:async_hooks";
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

/** The single MODERN revision either plane speaks over HTTP. Same constant as stdio. */
export const HTTP_SUPPORTED_PROTOCOL_VERSIONS = [CONTRACT_PROTOCOL_VERSION] as const;

/**
 * THE HTTP SUNSET SWITCH (ADR 0036), and deliberately NOT the stdio one.
 *
 * ADR 0034 gave the stdio entry a transitional legacy era and left HTTP
 * modern-only, noting that HTTP has its own conformance surface to re-verify.
 * This is that surface, re-verified — and it has its own constant rather than
 * sharing `SUPPORTED_LEGACY_PROTOCOL_VERSIONS` because the two transports do not
 * carry the same risk. A pipe is reachable only by whoever spawned the process;
 * a loopback socket is reachable by every process on the host. They should be
 * retirable independently, and one shared switch would mean retiring the safer
 * one forced a decision about the riskier one.
 *
 * Empty means modern-only: the SDK runs `legacy: 'reject'` and every 2025-era
 * opening is refused, which is the behaviour that shipped before this ADR.
 *
 * Retire this when Claude Desktop negotiates 2026-07-28 on the wire — the same
 * condition ADR 0034 records for stdio, and it must be verified by reading a
 * handshake rather than a bundle.
 */
export const HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS: readonly string[] = ["2025-11-25"];

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

/**
 * `UnsupportedProtocolVersionError`. Spelled out for the same reason
 * `HEADER_MISMATCH_CODE` is: the SDK emits it and publishes no enum member.
 */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/** The MCP endpoint path. One path, POST only, as the revision requires. */
export const DEFAULT_MCP_ENDPOINT = "/mcp";

export type AtlasHttpRejection = {
  status: number;
  reasonCode:
    | "endpoint-unknown"
    | "origin-forbidden"
    | "bearer-required"
    | "protocol-version-header-required"
    | "protocol-version-unsupported";
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

type RequestScope = { resolvePrincipal: PrincipalResolver; sink: CapabilityRefusalSink };

/**
 * What a header-less POST turns out to be.
 *
 * `modern-envelope` is the case that makes the era safe: a 2026-07-28 client
 * MUST carry `io.modelcontextprotocol/protocolVersion` in `params._meta`, and a
 * 2025-era client never does. So a request with no header but a modern envelope
 * is not a legacy client — it is a modern one that dropped a required header,
 * and serving it from a legacy-era server would answer it in a shape it never
 * asked for while both ends believed they agreed.
 */
type LegacyOpening =
  | { kind: "initialize"; version: string }
  | { kind: "initialize-unversioned" }
  | { kind: "modern-envelope"; version: string }
  | { kind: "legacy-follow-up" };

/**
 * Read a header-less POST far enough to classify it, WITHOUT consuming the body
 * the SDK still has to read.
 *
 * `clone()` rather than reading and rebuilding: rebuilding a `Request` loses
 * headers a future SDK version might read. A body that is not JSON is treated as
 * a follow-up and left to the SDK, which already answers `415`/`-32700` for it —
 * it is not this function's job to reject anything, only to classify.
 */
async function legacyOpeningOf(request: Request): Promise<LegacyOpening> {
  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null) return { kind: "legacy-follow-up" };
    const message = body as {
      method?: unknown;
      params?: { protocolVersion?: unknown; _meta?: Record<string, unknown> };
    };

    // The envelope is checked FIRST and on every method, not just initialize: a
    // modern client that drops the header mid-session must be refused too.
    const envelopeVersion = message.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
    if (typeof envelopeVersion === "string") return { kind: "modern-envelope", version: envelopeVersion };

    if (message.method !== "initialize") return { kind: "legacy-follow-up" };
    const version = message.params?.protocolVersion;
    // An initialize naming no version gets its OWN kind rather than falling in
    // with follow-ups, because the follow-up branch is the ADMITTING one: an
    // opening that states no revision would otherwise be admitted to an era
    // that is defined entirely by the revisions it names.
    return typeof version === "string" ? { kind: "initialize", version } : { kind: "initialize-unversioned" };
  } catch {
    return { kind: "legacy-follow-up" };
  }
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
  const scopes = new WeakMap<Request, RequestScope>();
  /** Binds the credential to this request's async execution — see `factory`. */
  const requestScope = new AsyncLocalStorage<RequestScope>();

  const factory = (ctx: McpRequestContext): McpServer | Server => {
    /**
     * IDENTITY FIRST, THEN ASYNC CONTEXT — and the second one is why the legacy
     * era works at all.
     *
     * The `WeakMap` keyed on the `Request` object holds on the modern path,
     * where the SDK hands the factory the very object this edge registered.
     * MEASURED: on the legacy path it does not. `@modelcontextprotocol/server@2.0.0`
     * passes a DIFFERENT `Request` (same `ctx.requestInfo !== undefined`, same
     * fields, different identity), so the lookup missed and the factory threw
     * "refusing to build a server with no bound credential" — a 500 on every
     * legacy opening. The guard was right; the key was fragile.
     *
     * `AsyncLocalStorage` binds the scope to the async execution of THIS request
     * instead of to an object the SDK is free to rebuild. The WeakMap is kept as
     * the first lookup because it is exact when it hits, and because keeping it
     * means an SDK upgrade that stops preserving async context degrades to the
     * throw below rather than to a silently unauthenticated server.
     */
    const byIdentity = ctx.requestInfo === undefined ? undefined : scopes.get(ctx.requestInfo);
    const scope = byIdentity ?? requestScope.getStore();
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
    legacy: HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length > 0 ? "stateless" : "reject",
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

    /**
     * 4. The version gate, and the ONE door the legacy era opens.
     *
     * A header-less POST is the shape of two very different callers, and the
     * whole correctness of the era is telling them apart:
     *
     *  - a 2025-era client, which sends the header on nothing, ever;
     *  - a modern client that dropped its header, which must still be refused,
     *    because serving it from a legacy-era server would answer a 2026-07-28
     *    caller in a shape it never asked for while both ends believed they
     *    agreed.
     *
     * They are separated by the `_meta` ENVELOPE, not by a session and not by a
     * guess. A modern client MUST carry
     * `io.modelcontextprotocol/protocolVersion` in `params._meta`; a 2025-era
     * client never does. MEASURED: the SDK's HTTP legacy mode is `stateless` —
     * it issues no `Mcp-Session-Id` — so a session-based discriminator would
     * have refused every legacy request after the opening. The envelope needs no
     * state at all, which is also why there is none to bound or evict.
     *
     * With the era switched off the whole block collapses to the refusal that
     * shipped before it, because `legacyOpeningOf` is only consulted here.
     */
    /**
     * A NAMED header is checked before anything else, because turning the SDK's
     * legacy mode on widened a door this edge does not own.
     *
     * MEASURED: with `legacy: 'reject'` the SDK answered `-32022` to a
     * `2025-06-18` client that sends the header its revision defined. With
     * legacy enabled it SERVES it — so the era would have admitted every 2025
     * revision, not the one it names, and the gate below never saw it because
     * that client does send a header.
     *
     * The admitted set is therefore enforced here, on the value, for both eras.
     */
    const namedVersion = request.headers.get("mcp-protocol-version");
    if (
      request.method === "POST" &&
      namedVersion !== null &&
      namedVersion !== CONTRACT_PROTOCOL_VERSION &&
      !HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.includes(namedVersion)
    ) {
      return reject(
        { status: 400, reasonCode: "protocol-version-unsupported" },
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: UNSUPPORTED_PROTOCOL_VERSION_CODE,
              message: `Unsupported protocol version: ${namedVersion}`,
              // `supported` names the MODERN revision only. The transitional era
              // is a door held open for clients that cannot yet speak it, never
              // a revision this server offers anybody to negotiate onto.
              data: { supported: [...HTTP_SUPPORTED_PROTOCOL_VERSIONS], requested: namedVersion }
            }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      );
    }

    if (request.method === "POST" && protocolVersionHeaderMissing(request)) {
      const opening =
        HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length > 0
          ? await legacyOpeningOf(request)
          : ({ kind: "legacy-follow-up" } as const);

      const refuseHeaderMissing = (): Response =>
        reject(
          { status: 400, reasonCode: "protocol-version-header-required" },
          edgeError(
            400,
            HEADER_MISMATCH_CODE,
            `Missing required header MCP-Protocol-Version. This server speaks ${CONTRACT_PROTOCOL_VERSION}` +
              (HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length > 0
                ? `, and admits a 2025-era client only through an initialize naming ${HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.join(", ")} and carrying no modern _meta envelope.`
                : " only and has no legacy era to infer a version for.")
          )
        );

      if (opening.kind === "initialize-unversioned") {
        // An opening that states no revision cannot be admitted to an era that
        // is defined by the revisions it names.
        return refuseHeaderMissing();
      }
      if (opening.kind === "modern-envelope") {
        // A modern client that dropped a required header. Refused as the header
        // problem it is, NOT admitted as legacy.
        return refuseHeaderMissing();
      }
      if (opening.kind === "initialize" && !HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.includes(opening.version)) {
        // Named rather than lumped in with the header refusal: this caller told
        // us a revision, and it is entitled to know which ones are served.
        return reject(
          { status: 400, reasonCode: "protocol-version-unsupported" },
          edgeError(
            400,
            UNSUPPORTED_PROTOCOL_VERSION_CODE,
            `Unsupported protocol version: ${opening.version}. This server speaks ${CONTRACT_PROTOCOL_VERSION}, and transitionally ${HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.join(", ")}.`
          )
        );
      }
      if (opening.kind === "legacy-follow-up" && HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS.length === 0) {
        return refuseHeaderMissing();
      }
    }

    const scope = {
      resolvePrincipal: bearerBoundResolver(options.resolvePrincipal, bearer),
      sink: new CapabilityRefusalSink()
    };
    scopes.set(request, scope);

    // `run` rather than a bare call: the legacy path rebuilds the `Request`, so
    // the async context is the only binding that survives to the factory.
    const response = await requestScope.run(scope, () => handler.fetch(request));


    return applyCapabilityRefusal(response, scope.sink);
  };

  return { fetch: serve, close: () => handler.close() };
}
