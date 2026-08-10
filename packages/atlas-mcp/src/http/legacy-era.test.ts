import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import { listTools, startHttpHarness, type HttpHarness } from "../testing.js";
import { HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS } from "./serve.js";

/**
 * THE TRANSITIONAL LEGACY ERA OVER HTTP (ADR 0036).
 *
 * ADR 0034 gave stdio a legacy era and left HTTP modern-only, noting that HTTP
 * has its own conformance surface to re-verify. These are that verification.
 *
 * The single property that makes the era safe is the last group: a MODERN client
 * that drops its required header must still be refused. If that ever starts
 * passing as legacy, a 2026-07-28 caller is being answered by a 2025-era server
 * while both ends believe they agree — which is worse than the refusal the era
 * replaced, and is invisible from either side.
 */

const started: HttpHarness[] = [];

async function harness(...args: Parameters<typeof startHttpHarness>): Promise<HttpHarness> {
  const instance = await startHttpHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.close();
});

/** The `_meta` envelope a modern client is REQUIRED to carry. */
function modernEnvelope(version = "2026-07-28"): Record<string, unknown> {
  return {
    "io.modelcontextprotocol/protocolVersion": version,
    "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
    "io.modelcontextprotocol/clientInfo": { name: "modern-client", version: "1" }
  };
}

/**
 * A 2025-era POST: no `MCP-Protocol-Version`, no `Mcp-Method`, no `Mcp-Name`,
 * and no `_meta`. `standard: false` is what omits the auto-derived headers, so
 * this is the shape Claude Desktop actually puts on the wire.
 */
async function legacyPost(http: HttpHarness, message: Record<string, unknown>): Promise<Response> {
  return http.raw(message, { standard: false });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  // A served legacy result may arrive as an SSE frame; a refusal is plain JSON.
  const line = text.split("\n").find((candidate) => candidate.startsWith("data:"));
  return JSON.parse(line === undefined ? text : line.slice(5).trim()) as Record<string, unknown>;
}

describe("an admitted 2025-era client is served", () => {
  it("completes an initialize at the admitted revision and echoes it back", async () => {
    const http = await harness();
    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "desktop-sim", version: "1" } }
    });

    expect(response.status).toBe(200);
    const result = (await bodyOf(response))["result"] as Record<string, unknown>;
    // Echoed at the LEGACY revision, not silently upgraded: a client told it is
    // speaking 2026-07-28 would then be expected to send envelopes it has no
    // code for.
    expect(result["protocolVersion"]).toBe("2025-11-25");
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("living-atlas-consumer");
  });

  it("serves a follow-up that carries no session and no header", async () => {
    /**
     * The case a session-based gate would have failed. MEASURED: the SDK's HTTP
     * legacy mode is `stateless` and issues no `Mcp-Session-Id`, so "is this an
     * established legacy session?" has no answer to read. The envelope is what
     * separates the eras, and it needs no state.
     */
    const http = await harness();
    await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "d", version: "1" } }
    });

    const response = await legacyPost(http, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    expect(response.status).toBe(200);
    const tools = ((await bodyOf(response))["result"] as { tools: unknown[] }).tools;
    expect(tools).toHaveLength(14);
  });

  it("answers a tools/call with real content, so the era is reads and not just a handshake", async () => {
    const http = await harness();
    await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "d", version: "1" } }
    });

    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "atlas.text.search.v1", arguments: { query: "Synthetic Person 1" } }
    });

    expect(response.status).toBe(200);
    const result = (await bodyOf(response))["result"] as { content?: { text?: string }[] };
    expect(JSON.parse(String(result.content?.[0]?.text))["results"]).toBeDefined();
  });
});

describe("the era admits exactly the revisions it names, and nothing else", () => {
  it("refuses an initialize naming a 2025 revision that is not admitted", async () => {
    const http = await harness();
    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } }
    });

    expect(response.status).toBe(400);
    const error = (await bodyOf(response))["error"] as { code: number; message: string };
    expect(error.code).toBe(-32022);
    // It names what IS served, because a caller that told us a revision is
    // entitled to know which ones it could have used.
    expect(error.message).toContain("2025-11-25");
  });

  it("refuses an initialize that names no revision at all", async () => {
    // The era admits a STATED revision, never an omission.
    const http = await harness();
    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "vague", version: "1" } }
    });

    expect(response.status).toBe(400);
    expect(((await bodyOf(response))["error"] as { code: number }).code).toBe(-32020);
  });
});

describe("a MODERN client that drops its header is still refused", () => {
  it("refuses a header-less request that carries a modern envelope", async () => {
    /**
     * THE PROPERTY THE WHOLE ERA RESTS ON. Without this, widening the door for
     * 2025-era clients would also route a modern client's header mistake to a
     * legacy-era server — answered in a shape it never asked for, with neither
     * end aware.
     */
    const http = await harness();
    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: modernEnvelope() }
    });

    expect(response.status).toBe(400);
    const error = (await bodyOf(response))["error"] as { code: number; message: string };
    // The HEADER problem it is, not an era mismatch.
    expect(error.code).toBe(-32020);
    expect(error.message).toContain("MCP-Protocol-Version");
  });

  it("refuses it on an initialize too, not only on a follow-up", async () => {
    const http = await harness();
    const response = await legacyPost(http, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "m", version: "1" }, _meta: modernEnvelope() }
    });

    expect(response.status).toBe(400);
    expect(((await bodyOf(response))["error"] as { code: number }).code).toBe(-32020);
  });
});

describe("the modern path is untouched", () => {
  it("still serves a fully-formed modern request", async () => {
    const http = await harness();
    const response = await http.send(listTools({ id: 1 }));

    expect(response.error).toBeUndefined();
    expect((response.result as { tools: unknown[] }).tools).toHaveLength(14);
  });
});

describe("the sunset switch", () => {
  it("names the revision the era exists for, so retiring it is one edit", () => {
    // If this list is emptied the SDK reverts to `legacy: 'reject'`, the gate
    // stops classifying, and every header-less POST is refused again — which is
    // the behaviour that shipped before ADR 0036.
    expect(HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS).toEqual(["2025-11-25"]);
    // And it is NOT the modern revision, which would make the era permanent by
    // accident.
    expect(HTTP_SUPPORTED_LEGACY_PROTOCOL_VERSIONS).not.toContain(CONTRACT_PROTOCOL_VERSION);
  });
});
