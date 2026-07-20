import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Socket } from "node:net";
import { bindLocalMcpDaemonSocket, createIdleShutdownTimer } from "./daemon-socket";
import { buildLocalMcpContextFromEnv, localMcpSocketPathFromEnv } from "./context-from-env";
import { createLivingAtlasLocalMcpServer, type LocalMcpServerAuthOptions } from "./server";
import type { LocalMcpContext } from "./local-graph";

export type LocalMcpDaemon = {
  socketPath: string;
  close(): Promise<void>;
};

export type StartLocalMcpDaemonResult =
  | { ok: true; daemon: LocalMcpDaemon }
  | { ok: false; reason: "already-running" };

/**
 * Start the local-mcp daemon: the ONE process in the whole system allowed to
 * hold a FileLocalGraphStore open against a given replica directory. Every
 * connection on the Unix socket gets its own MCP protocol session
 * (independent StdioServerTransport/McpServer pair, so each client's
 * initialize handshake, tool-call ids, etc. stay isolated) but all sessions
 * share the one `context` passed in, and therefore the one graph store and
 * its in-process mutation queue. That queue — not a filesystem lock — is what
 * makes concurrent writers from several local MCP clients safe: writes are
 * serialized by construction because there is exactly one JS event loop
 * touching the store, never by racing separate OS processes against the same
 * files (see ADR-0010 / local-graph-store.ts serializeMutation).
 */
export async function startLocalMcpDaemon(
  context: LocalMcpContext,
  options: {
    socketPath: string;
    authorizationHeader?: string;
    idleTimeoutMs?: number;
  }
): Promise<StartLocalMcpDaemonResult> {
  const bound = await bindLocalMcpDaemonSocket(options.socketPath);
  if (!bound.ok) {
    return { ok: false, reason: "already-running" };
  }

  const authOptions: LocalMcpServerAuthOptions = { authorizationHeader: options.authorizationHeader };
  const idleTimer = createIdleShutdownTimer({
    timeoutMs: options.idleTimeoutMs ?? 0,
    onIdle: () => {
      void close();
    }
  });

  const activeSockets = new Set<Socket>();

  bound.server.on("connection", (socket: Socket) => {
    idleTimer.connectionOpened();
    activeSockets.add(socket);

    const mcpServer = createLivingAtlasLocalMcpServer(context, authOptions);
    const transport = new StdioServerTransport(socket, socket);

    const onDisconnect = () => {
      activeSockets.delete(socket);
      idleTimer.connectionClosed();
      void mcpServer.close().catch(() => undefined);
    };
    socket.once("close", onDisconnect);
    socket.once("error", onDisconnect);

    void mcpServer.connect(transport).catch(() => {
      socket.destroy();
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    idleTimer.dispose();
    for (const socket of activeSockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => bound.server.close(() => resolve()));
  };

  return { ok: true, daemon: { socketPath: options.socketPath, close } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { context, authorizationHeader } = await buildLocalMcpContextFromEnv();
  const socketPath = localMcpSocketPathFromEnv();
  const idleTimeoutMs = process.env.LIVING_ATLAS_LOCAL_MCP_DAEMON_IDLE_MINUTES
    ? Number(process.env.LIVING_ATLAS_LOCAL_MCP_DAEMON_IDLE_MINUTES) * 60_000
    : 30 * 60_000;

  const result = await startLocalMcpDaemon(context, { socketPath, authorizationHeader, idleTimeoutMs });
  if (!result.ok) {
    // Another daemon already owns this socket — nothing to do, exit quietly.
    // Whichever proxy spawned us will connect to that other daemon instead.
    process.exit(0);
  }

  const shutdown = () => {
    void result.daemon.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
