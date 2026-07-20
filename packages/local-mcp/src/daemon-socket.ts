import { createServer, connect, type Server, type Socket } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

const ownerOnlySocketMode = 0o600;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * True if some process is actively accepting connections at socketPath.
 * A Unix domain socket path can exist on disk with nothing listening on it
 * (the owning process crashed/was killed without unlinking) — connecting is
 * the only reliable way to tell "live daemon" apart from "stale leftover file".
 */
function probeExistingSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    probe.once("connect", () => {
      probe.end();
      resolve(true);
    });
    probe.once("error", () => {
      resolve(false);
    });
  });
}

export type BindLocalMcpDaemonSocketResult =
  | { ok: true; server: Server }
  | { ok: false; reason: "already-running" };

/**
 * Bind the local-mcp daemon's Unix domain socket, self-healing a stale
 * leftover socket file from a prior crash. If another process is genuinely
 * listening at socketPath already, returns { ok: false } so the caller can
 * exit quietly rather than fight over ownership of the replica — this is the
 * only "lock" the daemon needs: the OS refuses a second bind to the same
 * path, so at most one process ever holds the FileLocalGraphStore open.
 */
export async function bindLocalMcpDaemonSocket(socketPath: string): Promise<BindLocalMcpDaemonSocketResult> {
  await mkdir(dirname(socketPath), { recursive: true });

  if (await probeExistingSocket(socketPath)) {
    return { ok: false, reason: "already-running" };
  }

  await rm(socketPath, { force: true });

  const server = createServer();
  const result = await new Promise<BindLocalMcpDaemonSocketResult>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE") {
        // Lost a race with another process that bound first between our probe
        // and our listen() call. That process now legitimately owns the socket.
        resolve({ ok: false, reason: "already-running" });
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ ok: true, server });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

  if (result.ok) {
    await chmod(socketPath, ownerOnlySocketMode).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }

  return result;
}

export type IdleShutdownTimer = {
  connectionOpened(): void;
  connectionClosed(): void;
  dispose(): void;
};

/**
 * Auto-shuts the daemon down after it has held zero open connections for
 * timeoutMs. The daemon holds decrypted personal-graph state in memory for as
 * long as it runs; an idle daemon nobody is using should not linger
 * indefinitely just because it was spawned once. A non-positive timeoutMs
 * disables auto-shutdown.
 */
export function createIdleShutdownTimer(options: { timeoutMs: number; onIdle: () => void }): IdleShutdownTimer {
  let openConnections = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const armIfIdle = () => {
    if (options.timeoutMs <= 0) {
      return;
    }
    if (openConnections === 0) {
      clear();
      timer = setTimeout(options.onIdle, options.timeoutMs);
      timer.unref();
    }
  };

  armIfIdle();

  return {
    connectionOpened() {
      openConnections += 1;
      clear();
    },
    connectionClosed() {
      openConnections = Math.max(0, openConnections - 1);
      armIfIdle();
    },
    dispose() {
      clear();
    }
  };
}

export type { Server as LocalMcpDaemonSocketServer, Socket as LocalMcpDaemonSocket };
