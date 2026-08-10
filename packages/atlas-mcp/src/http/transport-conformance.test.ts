import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { callTool, envelope, listTools, startHttpHarness, type HttpHarness } from "../testing.js";
import { LOOPBACK_HOSTS, portFromEnv, startAtlasHttpListener } from "./listener.js";
import { HTTP_SUPPORTED_PROTOCOL_VERSIONS } from "./serve.js";
import { constantTimeEquals, presentedBearer, requireHttpCredentials } from "./auth.js";

/**
 * The 2026-07-28 Streamable HTTP requirements, asserted against this server.
 *
 * Most of these are answered by `createMcpHandler`, not by code in this package,
 * and they are pinned here anyway — deliberately. The SDK is a dependency with
 * its own release cycle, and "the transport is conformant" is a claim this
 * repository makes to consumers. A dependency bump that quietly stopped
 * answering `-32020` for a forged `Mcp-Name` would otherwise be discovered by
 * whatever was relying on it, which is the wrong place and the wrong time.
 *
 * Each case names the requirement it holds, so a failure reads as a spec
 * citation rather than as a number that changed.
 */

/** The JSON-RPC error a refusal carries, typed — `Response.json()` resolves `unknown`. */
async function errorBody(response: Response): Promise<{ code: number; message: string; data?: Record<string, unknown> }> {
  const body = (await response.json()) as { error?: { code: number; message: string; data?: Record<string, unknown> } };
  if (body.error === undefined) throw new Error(`expected a JSON-RPC error body, got ${JSON.stringify(body)}`);
  return body.error;
}

/** The result member, typed the same way. */
async function resultBody(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { result?: Record<string, unknown> };
  return body.result ?? {};
}

const started: HttpHarness[] = [];

async function harness(...args: Parameters<typeof startHttpHarness>): Promise<HttpHarness> {
  const instance = await startHttpHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

describe("the MCP endpoint", () => {
  it("answers a well-formed tools/list with a single JSON body", async () => {
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((await resultBody(response))["tools"]).toHaveLength(14);
  });

  it("serves one path and answers 404 with -32601 anywhere else", async () => {
    // "If the server does not implement the requested RPC method, it MUST respond
    //  with 404 Not Found and a JSON-RPC error with code -32601." The JSON-RPC
    //  body is what lets a negotiating client tell this 404 from a legacy
    //  HTTP+SSE server that does not host the modern endpoint at all.
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { path: "/not-mcp" });

    expect(response.status).toBe(404);
    expect((await errorBody(response)).code).toBe(-32601);
  });

  it("answers 405 to GET and DELETE rather than opening a stream or a session", async () => {
    // The revision removed the GET stream endpoint and protocol-level sessions:
    // "HTTP GET or DELETE to the MCP endpoint: respond with 405 Method Not Allowed."
    const http = await harness();
    for (const method of ["GET", "DELETE"]) {
      const response = await http.raw(undefined, { method });
      expect(response.status, method).toBe(405);
    }
  });

  it("ignores Mcp-Session-Id and never mints or echoes one", async () => {
    // "An Mcp-Session-Id header on a request: ignore it, and do not mint or echo
    //  session IDs."
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { headers: { "Mcp-Session-Id": "a-session-a-client-invented" } });

    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers 415 to a body that is not application/json", async () => {
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { headers: { "content-type": "text/plain" } });
    expect(response.status).toBe(415);
  });

  it("acknowledges a notification with 202 and no body", async () => {
    const http = await harness();
    const response = await http.raw({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { _meta: envelope(), progressToken: "t", progress: 1 }
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });
});

describe("request metadata headers", () => {
  it("refuses a request whose Mcp-Method disagrees with the body", async () => {
    // "Servers MUST reject requests with a 400 Bad Request HTTP status and
    //  JSON-RPC error code -32020 (HeaderMismatch) if any validation fails."
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { headers: { "Mcp-Method": "tools/call" } });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });

  it("refuses a request whose Mcp-Name disagrees with params.name", async () => {
    // The load-bearing case: a load balancer routing on the header while the
    // server executes on the body is exactly the split the rule exists to close.
    const http = await harness();
    const response = await http.raw(callTool({ id: 1, name: "atlas.contract.describe.v1" }), {
      headers: { "Mcp-Name": "atlas.assertion.propose.v1" }
    });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });

  it("refuses a tools/call that omits Mcp-Name", async () => {
    const http = await harness();
    const response = await http.raw(callTool({ id: 1, name: "atlas.contract.describe.v1" }), {
      standard: false,
      headers: { "MCP-Protocol-Version": CONTRACT_PROTOCOL_VERSION, "Mcp-Method": "tools/call" }
    });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });

  it("refuses a POST carrying no MCP-Protocol-Version header", async () => {
    /**
     * The one rung the SDK leaves open, closed in `serve.ts`.
     *
     * The revision lets a server that still serves pre-2025-06-18 clients infer
     * a version from a header-less request, and `@modelcontextprotocol/server`
     * takes that permission — measured: such a request reaches the modern path
     * and is answered 200. This server has no legacy era, so the permission does
     * not apply to it and the MUST does.
     */
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), {
      standard: false,
      headers: { "Mcp-Method": "tools/list" }
    });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });

  it("refuses a MCP-Protocol-Version header that disagrees with the _meta envelope", async () => {
    // "The header value MUST match the io.modelcontextprotocol/protocolVersion
    //  field carried in the request body's _meta."
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { headers: { "MCP-Protocol-Version": "2025-11-25" } });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });
});

describe("per-request version negotiation", () => {
  it("refuses an envelope naming any other revision with -32022 and names what it speaks", async () => {
    const http = await harness();
    const response = await http.raw(
      listTools({ id: 1, meta: envelope({ [PROTOCOL_VERSION_META_KEY]: "2025-11-25" }) }),
      { headers: { "MCP-Protocol-Version": "2025-11-25" } }
    );

    expect(response.status).toBe(400);
    const error = await errorBody(response);
    expect(error.code).toBe(-32022);
    expect(error.data?.["supported"]).toEqual([...HTTP_SUPPORTED_PROTOCOL_VERSIONS]);
  });

  it("refuses a 2025-era initialize handshake rather than serving a legacy era", async () => {
    /**
     * Sent as a 2025-06-18 client actually sends it: that revision defined the
     * `MCP-Protocol-Version` header, so the header names 2025 and the body is a
     * bare `initialize` with no `_meta` envelope. The answer names what this
     * server does speak, which is what lets the client retry rather than guess.
     */
    const http = await harness();
    const response = await http.raw(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }
      },
      { headers: { "MCP-Protocol-Version": "2025-06-18" } }
    );

    expect(response.status).toBe(400);
    const error = await errorBody(response);
    expect(error.code).toBe(-32022);
    expect(error.data?.["supported"]).toEqual([...HTTP_SUPPORTED_PROTOCOL_VERSIONS]);
  });

  it("refuses a pre-2025-06-18 client, which sends no version header at all, with a recognizable modern error", async () => {
    /**
     * The interaction between this server's no-legacy-era stance and the
     * revision's fallback rules. A client older than 2025-06-18 sends no
     * `MCP-Protocol-Version`, so it meets the header MUST first and is answered
     * `-32020` rather than `-32022`. That is still the RIGHT answer for such a
     * client: the backward-compatibility rules tell it to inspect a 400 body and
     * only fall back to the legacy `initialize` flow when the body is "not a
     * recognized modern JSON-RPC error". `-32020` is one, so the client learns
     * this endpoint is modern instead of retrying an HTTP+SSE handshake against it.
     */
    const http = await harness();
    const response = await http.raw(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ancient", version: "1" } }
      },
      { standard: false }
    );

    expect(response.status).toBe(400);
    expect((await errorBody(response)).code).toBe(-32020);
  });
});

describe("origin validation", () => {
  it("answers 403 to a foreign Origin before authentication is even considered", async () => {
    // "Servers MUST validate the Origin header on all incoming connections to
    //  prevent DNS rebinding attacks … servers MUST respond with HTTP 403."
    const rejections: unknown[] = [];
    const http = await harness({ onRejection: (rejection) => rejections.push(rejection) });

    // No bearer either: the refusal must not depend on what the page guessed.
    const response = await http.raw(listTools({ id: 1 }), {
      headers: { origin: "https://evil.example" },
      bearer: null
    });

    expect(response.status).toBe(403);
    expect(rejections).toEqual([{ status: 403, reasonCode: "origin-forbidden" }]);
  });

  it("serves a loopback Origin", async () => {
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { headers: { origin: "http://localhost:5173" } });
    expect(response.status).toBe(200);
  });

  it("serves a request with no Origin, because non-browser clients send none", async () => {
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }));
    expect(response.status).toBe(200);
  });
});

describe("bearer authentication", () => {
  it("answers 401 with a challenge when no bearer is presented", async () => {
    const http = await harness();
    const response = await http.raw(listTools({ id: 1 }), { bearer: null });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("answers 401 for a malformed Authorization header rather than falling through", async () => {
    const http = await harness();
    for (const header of ["", "Basic abc", "Bearer", "Bearer    "]) {
      const response = await http.raw(listTools({ id: 1 }), { bearer: null, headers: { authorization: header } });
      expect(response.status, header).toBe(401);
    }
  });

  it("answers an empty tool list to an unknown bearer instead of 401", async () => {
    /**
     * The unknown-credential answer is the SERVER's, not the edge's, and stays
     * that way over HTTP: the edge proves a bearer was presented, and the
     * principal resolver decides whether it names anyone. A `tools/list` from a
     * credential this server does not know is an empty list — the honest answer
     * to "what may I call" — while `tools/call` refuses explicitly. Moving that
     * decision into the edge would give HTTP a different answer than stdio for
     * the same credential, which is the parity break this file exists to catch.
     */
    const http = await harness();
    const response = await http.send(listTools({ id: 1 }), { bearer: "a-secret-nobody-issued" });

    expect(response.error).toBeUndefined();
    expect((response.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("refuses a _meta credential that disagrees with the bearer", async () => {
    /**
     * ADR 0015 OPEN-5, resolved. Silently preferring the bearer would let a
     * caller that can set `_meta` but not the `Authorization` header believe it
     * is acting as one principal while the server attributes its writes to
     * another.
     */
    const http = await harness();
    const response = await http.send(
      listTools({ id: 1, meta: envelope({ "io.livingatlas/credential": "some-other-credential" }) })
    );

    expect((response.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("serves a _meta credential identical to the bearer, so a client may send both", async () => {
    const http = await harness();
    const { SYNTHETIC_SECRET } = await import("../testing.js");
    const response = await http.send(
      listTools({ id: 1, meta: envelope({ "io.livingatlas/credential": SYNTHETIC_SECRET }) })
    );

    expect((response.result as { tools: unknown[] }).tools).toHaveLength(14);
  });
});

describe("over a real loopback socket", () => {
  /**
   * The cases above drive `handler.fetch` directly, which is the same code path
   * a bound listener reaches. These few bind an actual socket, because the thing
   * under test here is the part that only exists when one is bound: the
   * conversion between Node's `IncomingMessage`/`ServerResponse` and the
   * web-standard `Request`/`Response` the handler speaks.
   *
   * Kept to a handful on purpose. Every test that binds a port holds a worker on
   * I/O, and a suite that spends its parallelism on loopback connects starves
   * the CPU-bound tests elsewhere in this repository — which is not theoretical:
   * adding these files with sockets everywhere pushed a 17-second backup test
   * past its 20-second timeout.
   */
  it("round-trips a tool call, its status and its headers through the Node adapter", async () => {
    const http = await harness({ socket: true });
    const response = await http.raw(callTool({ id: 1, name: "atlas.contract.describe.v1" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(new URL(http.url).hostname).toBe("127.0.0.1");

    const result = await resultBody(response);
    expect((result["structuredContent"] as Record<string, unknown>)["revision"]).toBeDefined();
  });

  it("carries an edge refusal's status and challenge header back over the socket", async () => {
    const http = await harness({ socket: true });
    const response = await http.raw(listTools({ id: 1 }), { bearer: null });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("answers 405 to a body-less GET over the socket", async () => {
    const http = await harness({ socket: true });
    expect((await http.raw(undefined, { method: "GET" })).status).toBe(405);
  });
});

describe("constructing a listener", () => {
  it("refuses to start without a credential directory", () => {
    // The "refuse to start tokenless" rule. At construction, not per request: a
    // deployment that starts without credentials has already made the mistake,
    // and refusing the first request would leave a socket that looks healthy.
    expect(() => requireHttpCredentials(undefined)).toThrow(/requires a credential directory/);
  });

  it("refuses to start on an empty directory", () => {
    expect(() => requireHttpCredentials({ resolve: () => undefined, size: 0 } as never)).toThrow(/empty/);
  });

  it("accepts a directory that cannot report its size rather than refusing it", () => {
    expect(() => requireHttpCredentials({ resolve: () => undefined })).not.toThrow();
  });

  it("refuses to bind anything but loopback", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10"]) {
      await expect(
        startAtlasHttpListener({ fetch: async () => new Response("no"), host, port: 0 })
      ).rejects.toThrow(/loopback only/);
    }
    expect(LOOPBACK_HOSTS).toContain("127.0.0.1");
  });

  it("reads its port from the environment and refuses a value that is not one", () => {
    expect(portFromEnv("ATLAS_PORT", { ATLAS_PORT: "8931" } as never)).toBe(8931);
    expect(() => portFromEnv("ATLAS_PORT", {} as never)).toThrow(/is not set/);
    expect(() => portFromEnv("ATLAS_PORT", { ATLAS_PORT: "not-a-port" } as never)).toThrow(/not a port/);
    expect(() => portFromEnv("ATLAS_PORT", { ATLAS_PORT: "70000" } as never)).toThrow(/not a port/);
  });
});

describe("bearer parsing", () => {
  it("accepts the scheme case-insensitively, as RFC 9110 requires", () => {
    expect(presentedBearer(new Headers({ authorization: "bearer abc" }))).toBe("abc");
    expect(presentedBearer(new Headers({ authorization: "BEARER abc" }))).toBe("abc");
    expect(presentedBearer(new Headers({ authorization: "Bearer abc" }))).toBe("abc");
  });

  it("collapses every malformed shape into one undefined answer", () => {
    for (const header of ["", "abc", "Basic abc", "Bearer", "Bearer   "]) {
      expect(presentedBearer(new Headers({ authorization: header })), header).toBeUndefined();
    }
    expect(presentedBearer(new Headers())).toBeUndefined();
  });

  it("compares secrets without short-circuiting on a shared prefix", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    // Different LENGTHS must compare false rather than throwing: `timingSafeEqual`
    // rejects unequal-length inputs, and a throw that happens only for unequal
    // lengths is itself a length oracle.
    expect(constantTimeEquals("abc", "abcdefghijklmnop")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("the elicitation capability over HTTP", () => {
  it("still reaches the wire as -32021 with no transport to decorate", async () => {
    /**
     * The Atlas-specific answer that `createMcpHandler` cannot produce: it owns
     * its transport, so `capabilityRefusalTransport` has nothing to wrap. The
     * rule moves to the response and the DECISION stays in `capabilityErrorFor`,
     * shared with stdio.
     */
    const { seedWithheldAssertion, syntheticGraph } = await import("../testing.js");
    const { redactionId } = await import("../access.js");
    const { CONSUMER_PRINCIPAL } = await import("../testing.js");

    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("the fixture query hit the history floor");
    const sealed = page.hits.find((hit) => hit.assertion.sensitivity.withheld);
    if (!sealed) throw new Error("the fixture holds no withheld assertion");
    const stubId = redactionId(sealed.assertion.assertion_id, CONSUMER_PRINCIPAL);

    const http = await harness({ graph });
    const response = await http.send(
      callTool({
        id: 1,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "checking a citation" },
        meta: envelope({ [CLIENT_CAPABILITIES_META_KEY]: {} })
      })
    );

    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(-32021);
    const data = response.error?.data as Record<string, unknown>;
    expect(data["requiredCapabilities"]).toEqual({ elicitation: {} });
    expect((data["result"] as Record<string, unknown>)["outcome"]).toBe("refused");
  });

  it("gives every exchange its own refusal sink, so two in flight cannot cross", async () => {
    /**
     * The isolation guarantee, pinned where it is DECIDABLE.
     *
     * A refusal is parked under a JSON-RPC id, ids are chosen by the caller, and
     * every client numbers its first request `1`. A listener-wide sink would
     * therefore hand one caller's `-32021` to whichever response happened to be
     * serialised first — a race, and the sibling test below can only lose it by
     * luck. This asserts the property the race depends on instead: the handler
     * builds a fresh sink per `Request`, so there is no shared cell for a
     * refusal to cross through no matter how the scheduling falls.
     *
     * Reached through the `build` seam `atlasHttpFetchHandler` already takes, so
     * the test observes the real wiring rather than a reimplementation of it.
     */
    const { CapabilityRefusalSink } = await import("../capability-refusal.js");
    const { buildAtlasServer } = await import("../server.js");
    const { credentialResolver } = await import("../credentials.js");
    const { MemoryAuditJournal } = await import("../audit.js");
    const { syntheticDirectory, syntheticGraph, testContract, SYNTHETIC_SECRET } = await import("../testing.js");
    const { atlasHttpFetchHandler } = await import("./serve.js");

    const directory = syntheticDirectory();
    const seen: InstanceType<typeof CapabilityRefusalSink>[] = [];

    const handler = atlasHttpFetchHandler(
      { resolvePrincipal: credentialResolver({ directory, plane: "consumer" }), credentials: directory },
      ({ resolvePrincipal, capabilityRefusals }) => {
        seen.push(capabilityRefusals);
        return buildAtlasServer({
          contract: testContract(),
          graph: syntheticGraph(),
          auditJournal: new MemoryAuditJournal(),
          capabilityRefusals,
          resolvePrincipal
        });
      }
    );

    const request = (): Request =>
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": CONTRACT_PROTOCOL_VERSION,
          "Mcp-Method": "tools/list",
          authorization: `Bearer ${SYNTHETIC_SECRET}`
        },
        body: JSON.stringify(listTools({ id: 1 }))
      });

    await Promise.all([handler.fetch(request()), handler.fetch(request())]);
    await handler.close();

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("does not leak one exchange's refusal onto another in flight on the same listener", async () => {
    /**
     * Why the sink is per REQUEST and not per listener.
     *
     * A refusal is parked under a JSON-RPC id; ids are chosen by the caller and
     * every client numbers its first request `1`. A listener-wide sink would
     * hand the refusing call's `-32021` to whichever response was serialised
     * first — so this sends a refusing reveal and an innocent `tools/list`
     * concurrently, both as id 1.
     */
    const { seedWithheldAssertion, syntheticGraph } = await import("../testing.js");
    const { redactionId } = await import("../access.js");
    const { CONSUMER_PRINCIPAL } = await import("../testing.js");

    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("the fixture query hit the history floor");
    const sealed = page.hits.find((hit) => hit.assertion.sensitivity.withheld);
    if (!sealed) throw new Error("the fixture holds no withheld assertion");
    const stubId = redactionId(sealed.assertion.assertion_id, CONSUMER_PRINCIPAL);

    const http = await harness({ graph });
    const [refused, innocent] = await Promise.all([
      http.send(
        callTool({
          id: 1,
          name: "atlas.sensitive.reveal.v1",
          args: { redaction_id: stubId, reason: "why" },
          meta: envelope({ [CLIENT_CAPABILITIES_META_KEY]: {} })
        })
      ),
      http.send(listTools({ id: 1 }))
    ]);

    expect(refused.error?.code).toBe(-32021);
    expect(innocent.error).toBeUndefined();
    expect((innocent.result as { tools: unknown[] }).tools).toHaveLength(14);
  });
});
