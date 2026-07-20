import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindLocalMcpDaemonSocket, createIdleShutdownTimer } from "./daemon-socket";

describe("bindLocalMcpDaemonSocket", () => {
  let dir: string;
  let socketPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "local-mcp-daemon-socket-"));
    socketPath = join(dir, "local-mcp.sock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("binds fresh when no socket file exists", async () => {
    const result = await bindLocalMcpDaemonSocket(socketPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      result.server.close();
    }
  });

  it("refuses to bind when a live daemon already owns the path, so only one process ever holds the store", async () => {
    const first = await bindLocalMcpDaemonSocket(socketPath);
    expect(first.ok).toBe(true);

    const second = await bindLocalMcpDaemonSocket(socketPath);
    expect(second).toEqual({ ok: false, reason: "already-running" });

    if (first.ok) {
      first.server.close();
    }
  });

  it("self-heals a stale socket file left behind by a crashed daemon", async () => {
    const first = await bindLocalMcpDaemonSocket(socketPath);
    expect(first.ok).toBe(true);
    if (first.ok) {
      // Simulate a crash: the process dies without unlinking the socket file,
      // so the path lingers on disk with nothing listening on it.
      first.server.close();
    }

    const second = await bindLocalMcpDaemonSocket(socketPath);
    expect(second.ok).toBe(true);
    if (second.ok) {
      second.server.close();
    }
  });

  it("lets multiple clients connect concurrently to the one bound server", async () => {
    const bound = await bindLocalMcpDaemonSocket(socketPath);
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;

    const seenConnections: number[] = [];
    bound.server.on("connection", (socket) => {
      seenConnections.push(seenConnections.length);
      socket.end();
    });

    await Promise.all(
      Array.from({ length: 5 }, () => new Promise<void>((resolve, reject) => {
        const client = connect(socketPath);
        client.once("close", resolve);
        client.once("error", reject);
      }))
    );

    expect(seenConnections).toHaveLength(5);
    bound.server.close();
  });
});

describe("createIdleShutdownTimer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onIdle after timeoutMs with zero open connections", () => {
    const onIdle = vi.fn();
    const timer = createIdleShutdownTimer({ timeoutMs: 1000, onIdle });

    vi.advanceTimersByTime(999);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onIdle).toHaveBeenCalledTimes(1);

    timer.dispose();
  });

  it("cancels the idle shutdown while a connection is open", () => {
    const onIdle = vi.fn();
    const timer = createIdleShutdownTimer({ timeoutMs: 1000, onIdle });

    timer.connectionOpened();
    vi.advanceTimersByTime(5000);
    expect(onIdle).not.toHaveBeenCalled();

    timer.dispose();
  });

  it("re-arms once the last connection closes", () => {
    const onIdle = vi.fn();
    const timer = createIdleShutdownTimer({ timeoutMs: 1000, onIdle });

    timer.connectionOpened();
    timer.connectionOpened();
    timer.connectionClosed();
    vi.advanceTimersByTime(1000);
    expect(onIdle).not.toHaveBeenCalled();

    timer.connectionClosed();
    vi.advanceTimersByTime(1000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    timer.dispose();
  });

  it("never fires when timeoutMs is non-positive", () => {
    const onIdle = vi.fn();
    const timer = createIdleShutdownTimer({ timeoutMs: 0, onIdle });

    vi.advanceTimersByTime(1_000_000);
    expect(onIdle).not.toHaveBeenCalled();

    timer.dispose();
  });
});
