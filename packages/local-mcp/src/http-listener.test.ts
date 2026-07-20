import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { createFixtureLocalControlState } from "@living-atlas/local-control-store";
import { FileLocalGraphStore } from "@living-atlas/local-graph-store";
import { InMemoryLocalMcpAuditSink } from "./audit";
import { createLocalMcpContextFromControlState, type LocalMcpContext } from "./local-graph";
import { startLocalMcpHttpListener, type LocalMcpHttpListener } from "./http-listener";

const now = "2026-06-21T12:00:00.000Z";
const token = "local-token-http-listener-0001";
const bearer = `Bearer ${token}`;

async function buildContext(): Promise<{ context: LocalMcpContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "living-atlas-http-listener-"));
  const controlState = await createFixtureLocalControlState(token);
  const graphStore = await FileLocalGraphStore.open({
    directory: dir,
    authorityId: controlState.authority_id,
    plaintextPersistence: "allow"
  });
  const context = createLocalMcpContextFromControlState({
    controlState,
    graphStore,
    auditSink: new InMemoryLocalMcpAuditSink(),
    now
  });
  return { context, dir };
}

function initializeBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.0" } }
  };
}

describe("local MCP HTTP listener (loopback + token)", () => {
  let listener: LocalMcpHttpListener | undefined;
  let dir: string | undefined;
  let base: string;

  beforeEach(async () => {
    const built = await buildContext();
    dir = built.dir;
    listener = await startLocalMcpHttpListener(built.context, {
      port: 0,
      authorizationHeader: bearer
    });
    base = `http://${listener.host}:${listener.port}/mcp`;
  });

  afterEach(async () => {
    if (listener) {
      await listener.close();
      listener = undefined;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("binds loopback only, never a routable interface", () => {
    expect(listener!.host).toBe("127.0.0.1");
    expect(listener!.host).not.toBe("0.0.0.0");
  });

  it("rejects a request with no Authorization header (401)", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(initializeBody())
    });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong token (401)", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer not-the-real-token"
      },
      body: JSON.stringify(initializeBody())
    });
    expect(res.status).toBe(401);
  });

  it("completes a real MCP initialize handshake when the token is present", async () => {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: bearer
      },
      body: JSON.stringify(initializeBody())
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();

    // Streamable HTTP replies as SSE or JSON depending on negotiation; both
    // carry the initialize result for id 1.
    const text = await res.text();
    expect(text).toContain("\"protocolVersion\"");
    expect(text).toContain("living-atlas-local");
  });

  it("refuses to start without a token rather than fail open", async () => {
    const built = await buildContext();
    const tokenless = await startLocalMcpHttpListener(built.context, { port: 0 });
    try {
      const res = await fetch(`http://${tokenless.host}:${tokenless.port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: bearer },
        body: JSON.stringify(initializeBody())
      });
      // No configured token => every request is unauthorized, including a
      // correct-looking one. The listener never serves the graph tokenless.
      expect(res.status).toBe(401);
    } finally {
      await tokenless.close();
      await rm(built.dir, { recursive: true, force: true });
    }
  });
});
