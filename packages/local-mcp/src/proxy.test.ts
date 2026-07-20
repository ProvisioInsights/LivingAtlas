import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { connectToLocalMcpDaemon } from "./proxy";

async function listenOn(socketPath: string): Promise<Server> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

describe("connectToLocalMcpDaemon", () => {
  let dir: string;
  let socketPath: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-mcp-proxy-"));
    socketPath = join(dir, "local-mcp.sock");
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("connects immediately without asking spawnDaemon when the daemon is already up", async () => {
    server = await listenOn(socketPath);
    const spawnDaemon = vi.fn();

    const socket = await connectToLocalMcpDaemon({ socketPath, spawnDaemon });

    expect(spawnDaemon).not.toHaveBeenCalled();
    socket.destroy();
  });

  it("asks spawnDaemon to bring the daemon up, then connects on retry", async () => {
    const spawnDaemon = vi.fn(() => {
      // Simulate launchd/kickstart bringing the service up a moment later.
      void listenOn(socketPath).then((s) => {
        server = s;
      });
    });

    const socket = await connectToLocalMcpDaemon({
      socketPath,
      spawnDaemon,
      retryDelayMs: 10,
      maxAttempts: 50
    });

    expect(spawnDaemon).toHaveBeenCalledTimes(1);
    socket.destroy();
  });

  it("gives up after maxAttempts when the daemon never comes up", async () => {
    const spawnDaemon = vi.fn();

    await expect(
      connectToLocalMcpDaemon({ socketPath, spawnDaemon, retryDelayMs: 1, maxAttempts: 3 })
    ).rejects.toBeInstanceOf(Error);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });
});
