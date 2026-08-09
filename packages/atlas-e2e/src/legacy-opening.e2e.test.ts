import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_SCENARIO_TIMEOUT_MS, createWorkspace, type AtlasWorkspace } from "./harness.js";

/**
 * THE LEGACY OPENING, on the real wire.
 *
 * Claude Desktop opens its stdio connection with an `initialize` at protocol
 * revision 2025-11-25 — verified from the server's own stderr — even though its
 * bundle carries 2026-07-28 code. The modern-only server refused that with
 * -32022 and no client could reach the graph. This proves the transitional
 * legacy era: a 2025-11-25 handshake is served and a tool call reads real
 * seeded content back.
 *
 * It speaks RAW JSON-RPC rather than through `AtlasConsumerClient`, because that
 * client only speaks 2026-07-28 — the whole failure is invisible to a client
 * that cannot open the legacy way. A legacy client presents its credential in
 * `_meta` exactly as a modern one does; what it omits is the modern
 * protocol-version and capability envelope keys, which is precisely the shape
 * the SDK classifies as legacy.
 */

const require = createRequire(import.meta.url);
const CREDENTIAL_META_KEY = "io.livingatlas/credential";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";

type WireResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

/**
 * A raw stdio client: newline-delimited JSON in and out, no protocol library
 * between it and the server. This is what lets it open the legacy way.
 */
type RawServer = {
  send(message: Record<string, unknown>): void;
  await(id: string | number, timeoutMs?: number): Promise<WireResponse>;
  ready(): Promise<void>;
  stop(): Promise<void>;
};

function startRawServer(workspace: AtlasWorkspace): RawServer {
  const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "server-entry.ts");
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [require.resolve("tsx/cli"), serverEntry, "--data-dir", workspace.dataDirectory],
    // A replacement environment, not an extension: a child that inherited the
    // parent's environment would inherit every secret in it. Nothing here reads
    // a LIVING_ATLAS_* variable.
    { env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" } }
  );

  const responses: WireResponse[] = [];
  const waiters = new Map<string | number, (response: WireResponse) => void>();
  let outBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    outBuffer += chunk.toString("utf8");
    let index = outBuffer.indexOf("\n");
    while (index >= 0) {
      const line = outBuffer.slice(0, index);
      outBuffer = outBuffer.slice(index + 1);
      if (line.trim().length > 0) {
        const parsed = JSON.parse(line) as WireResponse;
        responses.push(parsed);
        waiters.get(parsed.id)?.(parsed);
        waiters.delete(parsed.id);
      }
      index = outBuffer.indexOf("\n");
    }
  });

  let readyResolve: (() => void) | undefined;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let errBuffer = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errBuffer += chunk.toString("utf8");
    if (errBuffer.includes("[atlas-e2e] ready")) readyResolve?.();
  });

  return {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    await: (id, timeoutMs = 4000) =>
      new Promise<WireResponse>((resolve, reject) => {
        const existing = responses.find((response) => response.id === id);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`no response for id ${String(id)} within ${timeoutMs}ms; stderr:\n${errBuffer}`));
        }, timeoutMs);
        waiters.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      }),
    ready: () => readyPromise,
    stop: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      })
  };
}

function legacyInitialize(id: number, version: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "claude-desktop", version: "1.26832.0" } }
  };
}

/** A legacy tool call: the credential rides `_meta`, no modern version envelope. */
function legacyCall(id: number, name: string, secret: string, args: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args, _meta: { [CREDENTIAL_META_KEY]: secret } }
  };
}

const servers: RawServer[] = [];
const workspaces: AtlasWorkspace[] = [];

function begin(): { server: RawServer; workspace: AtlasWorkspace } {
  const workspace = createWorkspace();
  const server = startRawServer(workspace);
  servers.push(server);
  workspaces.push(workspace);
  return { server, workspace };
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.stop();
  while (workspaces.length > 0) workspaces.pop()?.dispose();
});

describe("the legacy opening reaches the graph", () => {
  it(
    "serves a 2025-11-25 handshake and reads seeded content back through a tool call",
    async () => {
      const { server, workspace } = begin();
      await server.ready();

      server.send(legacyInitialize(1, LEGACY_PROTOCOL_VERSION));
      const init = await server.await(1);
      // Served, not refused, and the negotiated revision is the legacy one — not
      // silently upgraded to 2026-07-28.
      expect(init.error).toBeUndefined();
      expect(init.result?.["protocolVersion"]).toBe(LEGACY_PROTOCOL_VERSION);

      server.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

      // A real read, authenticated by a credential in `_meta`, over the legacy
      // envelope. The fixture seeds three open `Synthetic Employer N` assertions.
      server.send(legacyCall(2, "atlas.assertion.query.v1", workspace.secrets.consumer));
      const read = await server.await(2);

      expect(read.error).toBeUndefined();
      const text = JSON.stringify(read.result ?? {});
      expect(text).toContain("Synthetic Employer");
    },
    E2E_SCENARIO_TIMEOUT_MS
  );

  it(
    "still refuses a non-admitted 2025-06-18 handshake on the real wire",
    async () => {
      const { server } = begin();
      await server.ready();

      server.send(legacyInitialize(1, "2025-06-18"));
      const init = await server.await(1);

      // The door opens for 2025-11-25, not for anything: a different legacy
      // revision is refused with -32022, naming both revisions the server accepts.
      expect(init.result).toBeUndefined();
      expect(init.error?.code).toBe(-32022);
      expect(init.error?.data).toMatchObject({ requested: "2025-06-18" });
    },
    E2E_SCENARIO_TIMEOUT_MS
  );
});
