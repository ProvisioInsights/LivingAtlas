import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localMcpSocketPathFromEnv } from "./context-from-env";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectOnce(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/**
 * Connect to the local-mcp daemon's Unix socket. In the normal always-on
 * deployment the launchd LaunchAgent already holds it open, so the first
 * connectOnce succeeds immediately. If nobody is listening yet (pre-login
 * window, or no LaunchAgent installed) we ask spawnDaemon to bring it up and
 * retry with backoff — daemon startup does real async work (Keychain-backed
 * control-store/keyring reads, replaying the graph journal) before it accepts
 * connections. launchd's single-instance guarantee (or, in the fallback, the
 * daemon's own socket bind) means concurrent proxies converge on one daemon.
 */
export async function connectToLocalMcpDaemon(options: {
  socketPath: string;
  spawnDaemon: () => void;
  maxAttempts?: number;
  retryDelayMs?: number;
}): Promise<Socket> {
  try {
    return await connectOnce(options.socketPath);
  } catch {
    // No live daemon (ENOENT: no socket file, or ECONNREFUSED: stale file).
    // Spawn one — if we lose a race with another proxy doing the same thing,
    // bindLocalMcpDaemonSocket makes the loser exit quietly and we still
    // converge on whichever daemon actually won the bind.
    options.spawnDaemon();
  }

  const maxAttempts = options.maxAttempts ?? 100;
  const retryDelayMs = options.retryDelayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await connectOnce(options.socketPath);
    } catch (error) {
      lastError = error;
      await sleep(retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out connecting to local-mcp daemon");
}

/**
 * Raw byte passthrough between this process's stdio and the daemon socket.
 * No protocol translation needed: MCP-over-stdio is newline-delimited
 * JSON-RPC, and the daemon's per-connection transport speaks the exact same
 * framing over the socket (see daemon.ts / StdioServerTransport(socket, socket)).
 */
export function pipeStdioToDaemon(socket: Socket): void {
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  const exit = (code: number) => process.exit(code);
  socket.once("close", () => exit(0));
  socket.once("error", () => exit(1));
  process.stdin.once("error", () => socket.destroy());
}

/**
 * Ensure the daemon is up. Preferred path: the daemon runs as an always-on
 * launchd LaunchAgent (RunAtLoad + KeepAlive), so we simply ask launchd to
 * (re)start its own managed service — idempotent, single-instance guaranteed
 * by launchd, no raw process spawned by us. Fallback (no LaunchAgent
 * installed, e.g. dev/fixture runs): spawn the daemon detached ourselves so
 * proxy.ts still works standalone.
 */
function ensureLocalMcpDaemonRunning(): void {
  const launchdLabel = process.env.LIVING_ATLAS_LOCAL_MCP_LAUNCHD_LABEL;
  if (launchdLabel) {
    const child = spawn("launchctl", ["kickstart", `gui/${process.getuid?.() ?? ""}/${launchdLabel}`], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => spawnLocalMcpDaemonProcess());
    child.unref();
    return;
  }
  spawnLocalMcpDaemonProcess();
}

function spawnLocalMcpDaemonProcess(): void {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const daemonEntryPath = join(thisDir, "daemon.ts");
  const repoRoot = join(thisDir, "..", "..", "..");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

  const child = spawn(tsxBin, [daemonEntryPath], {
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const socketPath = localMcpSocketPathFromEnv();
  const socket = await connectToLocalMcpDaemon({
    socketPath,
    spawnDaemon: ensureLocalMcpDaemonRunning
  });
  pipeStdioToDaemon(socket);
}
