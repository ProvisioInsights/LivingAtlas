import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createLivingAtlasLocalMcpServer, type LocalMcpServerAuthOptions } from "./server";
import type { LocalMcpContext } from "./local-graph";

const DEFAULT_PATH = "/mcp";
const SESSION_HEADER = "mcp-session-id";

export type LocalMcpHttpListener = {
  host: string;
  port: number;
  close(): Promise<void>;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  close(): Promise<void>;
};

/**
 * Constant-time bearer-token check. A loopback TCP port is reachable by any
 * local process (unlike the 0600 Unix socket, which the OS restricts to this
 * user), so the token is the primary access control here, not a convenience.
 * Timing-safe so a caller can't recover it byte-by-byte from response latency.
 */
function authorized(req: IncomingMessage, expectedHeader: string | undefined): boolean {
  if (!expectedHeader) {
    // No token configured => refuse rather than fail open. An HTTP listener
    // without a token would let any local process read the whole graph.
    return false;
  }
  const provided = req.headers.authorization;
  if (typeof provided !== "string") {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedHeader);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim().length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Expose the local MCP over Streamable HTTP on loopback only, so clients that
 * prefer a URL (like a remote MCP server) can connect without the stdio proxy.
 * Binds to 127.0.0.1 by default — never a routable interface — so nothing off
 * this machine can reach it; every request must still carry the bearer token.
 * Shares the one LocalMcpContext (and its single FileLocalGraphStore) with the
 * daemon's Unix-socket path, so HTTP and socket clients hit the same store and
 * the same in-process mutation queue.
 */
export async function startLocalMcpHttpListener(
  context: LocalMcpContext,
  options: {
    port: number;
    host?: string;
    path?: string;
    authorizationHeader?: string;
  }
): Promise<LocalMcpHttpListener> {
  const host = options.host ?? "127.0.0.1";
  const path = options.path ?? DEFAULT_PATH;
  const port = options.port;
  const authOptions: LocalMcpServerAuthOptions = { authorizationHeader: options.authorizationHeader };
  // Populated once the OS assigns the real port (may differ from `port` when 0
  // is passed for an ephemeral bind). Sessions are only created on inbound
  // requests, which cannot arrive before listen() resolves, so this is set
  // before any createSession() call reads it.
  let allowedHosts: string[] = [];

  const sessions = new Map<string, Session>();

  const createSession = async (): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Reject requests whose Host header isn't our loopback binding, blocking
      // DNS-rebinding attacks where a malicious page tricks a browser into
      // POSTing to this local port.
      enableDnsRebindingProtection: true,
      allowedHosts,
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, { transport, close: closeSession });
      }
    });
    const mcpServer = createLivingAtlasLocalMcpServer(context, authOptions);
    // Guard against the close cycle: closing the server closes the transport,
    // whose onclose would otherwise close the server again — infinite recursion.
    let closed = false;
    const closeSession = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
      }
      await mcpServer.close().catch(() => undefined);
    };
    transport.onclose = () => {
      void closeSession();
    };
    await mcpServer.connect(transport);
    return transport;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
    if (url.pathname !== path) {
      sendJson(res, 404, { error: "not-found" });
      return;
    }
    if (!authorized(req, options.authorizationHeader)) {
      res.setHeader("www-authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const sessionId = req.headers[SESSION_HEADER];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 400, { error: "missing-or-unknown-session" });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid-json" });
      return;
    }

    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { error: "expected-initialize-or-valid-session" });
      return;
    }

    const transport = await createSession();
    await transport.handleRequest(req, res, body);
  };

  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal" });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // Binding to a specific host (127.0.0.1) rather than omitting it is what
    // keeps this off every other interface. Never pass 0.0.0.0 here.
    server.listen(port, host);
  });

  const boundPort = (server.address() as AddressInfo).port;
  allowedHosts = [`${host}:${boundPort}`, `127.0.0.1:${boundPort}`, `localhost:${boundPort}`];

  return {
    host,
    port: boundPort,
    async close() {
      for (const session of sessions.values()) {
        await session.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

export type { Server as LocalMcpHttpServer };
