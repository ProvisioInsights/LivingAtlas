import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { serializeMessage, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { AtlasTransportError } from "./errors.js";
import type { AtlasTransport, JsonRpcRequest, JsonRpcResponse } from "./transport.js";

/**
 * One MCP server, running as a child process, spoken to over its stdio.
 *
 * Outbound framing comes from the SDK's own `serializeMessage` rather than from
 * a `JSON.stringify(m) + "\n"` written here. It is twenty characters either way,
 * and that is exactly why it is worth importing: framing is the one thing where
 * a divergence does not fail loudly. A client that framed differently from the
 * server's `ReadBuffer` would leave the server's parser mid-message and every
 * subsequent request would be answered against the wrong bytes.
 *
 * Inbound is split and parsed HERE and deliberately not run through the SDK's
 * `deserializeMessage`. Part of what this client exists to check is whether the
 * server's answers are well formed; validating them with the server SDK's own
 * parser first would turn a malformed answer into a transport exception, which
 * is the wrong report to whoever has to fix it.
 *
 * stdout is the wire. stderr is diagnostics, and it is captured rather than
 * inherited: a server that writes a line to the wrong stream corrupts framing
 * for every message after it, and a harness that could not see stderr would
 * watch a process die with no reason attached.
 */

export type StdioTransportOptions = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * The child's environment. Replaces rather than extends `process.env`: a
   * server that inherits the parent's whole environment inherits every secret in
   * it, and a test harness is exactly where that happens by accident.
   */
  env?: Readonly<Record<string, string>>;
  /** Rejects a pending request that has waited this long. */
  requestTimeoutMs?: number;
  /** Every stderr line the child writes. Diagnostics only; nothing may branch on it. */
  onStderr?: (line: string) => void;
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export type StdioAtlasTransport = AtlasTransport & {
  /** The child's pid, for a harness that means to kill it. Absent once it has exited. */
  readonly pid: number | undefined;
  /** Resolves with the child's exit code once it has gone. */
  readonly exited: Promise<number | null>;
};

type Pending = {
  resolve: (response: JsonRpcResponse) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

function isResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const id = candidate["id"];
  return typeof id === "string" || typeof id === "number";
}

export function createStdioTransport(options: StdioTransportOptions): StdioAtlasTransport {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    stdio: ["pipe", "pipe", "pipe"]
  });

  const pending = new Map<string | number, Pending>();
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let exitReason: string | undefined;

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      exitReason = `the server process exited with code ${code === null ? "(signal)" : String(code)}`;
      failAll(new AtlasTransportError(exitReason));
      resolve(code);
    });
  });

  function failAll(reason: unknown): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0) deliver(line);
      index = stdoutBuffer.indexOf("\n");
    }
  });

  function deliver(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (cause) {
      // Not routable to one waiter: a line that is not JSON has no id. Every
      // pending request fails, because the stream's framing is now suspect and
      // answering the others from it would be answering from garbage.
      failAll(new AtlasTransportError(`the server wrote a line on stdout that is not JSON`, { cause }));
      return;
    }
    if (!isResponse(parsed)) {
      // A notification or a server-initiated request. This revision's flows are
      // all client-initiated, so there is nothing to do with it — but it is not
      // an error either, and treating it as one would break the moment the
      // server adds a progress notification.
      return;
    }
    const waiter = pending.get(parsed.id);
    if (!waiter) return;
    pending.delete(parsed.id);
    clearTimeout(waiter.timer);
    waiter.resolve(parsed);
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer += chunk;
    let index = stderrBuffer.indexOf("\n");
    while (index >= 0) {
      const line = stderrBuffer.slice(0, index);
      stderrBuffer = stderrBuffer.slice(index + 1);
      if (line.length > 0) options.onStderr?.(line);
      index = stderrBuffer.indexOf("\n");
    }
  });

  child.on("error", (error) => {
    failAll(new AtlasTransportError(`the server process could not be started or spoken to: ${error.message}`, { cause: error }));
  });

  return {
    description: `stdio:${options.command}`,
    get pid(): number | undefined {
      return child.exitCode === null && child.signalCode === null ? (child.pid ?? undefined) : undefined;
    },
    exited,
    request: (message: JsonRpcRequest, requestOptions?: { signal?: AbortSignal }) =>
      new Promise<JsonRpcResponse>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(new AtlasTransportError(exitReason ?? "the server process is no longer running"));
          return;
        }
        if (pending.has(message.id)) {
          // Reusing an outstanding id would make two answers indistinguishable.
          reject(new AtlasTransportError(`request id ${String(message.id)} is already outstanding`));
          return;
        }

        const timer = setTimeout(() => {
          pending.delete(message.id);
          reject(new AtlasTransportError(`no response for ${message.method} within ${timeoutMs}ms`));
        }, timeoutMs);
        // A pending request must never hold the event loop open on its own: a
        // harness that forgot to close the transport would hang instead of
        // reporting the failure it already has.
        timer.unref?.();

        pending.set(message.id, { resolve, reject, timer });

        requestOptions?.signal?.addEventListener(
          "abort",
          () => {
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            waiter.reject(new AtlasTransportError(`${message.method} was aborted by the caller`));
          },
          { once: true }
        );

        try {
          // The cast is confined to this one line. `JsonRpcRequest` is a
          // structural subset of the SDK's request union; widening this
          // package's own types to the SDK's zod-derived union would drag a
          // server dependency through every signature for no gain.
          child.stdin.write(serializeMessage(message as unknown as JSONRPCMessage));
        } catch (cause) {
          pending.delete(message.id);
          clearTimeout(timer);
          reject(new AtlasTransportError(`could not write ${message.method} to the server`, { cause }));
        }
      }),
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      child.kill("SIGTERM");
      await exited;
    }
  };
}
