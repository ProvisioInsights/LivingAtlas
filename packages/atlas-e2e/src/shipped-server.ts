import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  AtlasConsumerClient,
  createStdioTransport,
  type StdioAtlasTransport
} from "@living-atlas/atlas-client";
import { STORE_DIRECTORY_ENV, STORE_MODE_ENV, type AtlasStoreMode } from "@living-atlas/atlas-mcp";

/**
 * Spawning the SHIPPED consumer binary, not the harness's own server entry.
 *
 * `harness.ts` runs `server-entry.ts`, which composes the real server with the
 * harness's own wiring: its data directory, its fixture, its credential file.
 * That is the right shape for the scenarios that exercise the twelve tools,
 * because they need a graph with known contents and two credentials in it.
 *
 * It is the WRONG shape for one claim: that the thing a user installs can be
 * pointed at a graph that already exists. The harness entry took `--data-dir`
 * because the harness told it to; the shipped binary has to do it from the
 * environment, on its own, with nobody composing anything for it. So this module
 * spawns the binary the package's own `bin` names, hands it exactly the
 * environment an operator would set, and asks it questions through the real
 * client.
 *
 * Everything it is pointed at is synthetic and under `os.tmpdir()`. The caller
 * builds the store and removes it.
 */

const require = createRequire(import.meta.url);

/**
 * The path the package DECLARES as its consumer binary.
 *
 * Read out of `bin` rather than hardcoded, so a test that says "the shipped
 * entry serves a store" cannot keep passing against a file the package stopped
 * shipping. The package root is found through the module resolver rather than by
 * counting `..` segments.
 */
export function shippedConsumerEntry(): string {
  const packageRoot = join(dirname(require.resolve("@living-atlas/atlas-mcp")), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
  };
  const declared = manifest.bin?.["living-atlas-atlas-mcp"];
  if (declared === undefined) {
    throw new Error("@living-atlas/atlas-mcp declares no living-atlas-atlas-mcp binary");
  }
  return join(packageRoot, declared);
}

function tsxCliPath(): string {
  return require.resolve("tsx/cli");
}

export type ShippedServerOptions = {
  auditLog: string;
  /** Omitted entirely when absent, so the unset-variable path is really unset. */
  storeDirectory?: string;
  storeMode?: AtlasStoreMode;
};

export type ShippedServer = {
  readonly transport: StdioAtlasTransport;
  /** Every line the server wrote to stderr. Diagnostics; nothing branches on it. */
  readonly diagnostics: readonly string[];
  readonly pid: number | undefined;
  /** Resolves with the exit code, so a startup refusal can be asserted on. */
  readonly exited: Promise<number | null>;
  kill(): Promise<void>;
  stop(): Promise<void>;
};

export function startShippedServer(options: ShippedServerOptions): ShippedServer {
  const diagnostics: string[] = [];
  const transport = createStdioTransport({
    command: process.execPath,
    args: [tsxCliPath(), shippedConsumerEntry(), "--audit-log", options.auditLog],
    /**
     * A REPLACEMENT environment, and the reason matters more here than in
     * `harness.ts`.
     *
     * This is the one server in the repository that reads `LIVING_ATLAS_*`, so
     * inheriting the parent's environment would let a variable set on the
     * developer's machine decide what the child serves — and a test that passed
     * because of somebody's shell profile is a test that proves nothing. PATH is
     * kept because the runner needs it; everything else is stated here.
     */
    env: {
      PATH: process.env["PATH"] ?? "",
      NODE_ENV: "test",
      ...(options.storeDirectory === undefined ? {} : { [STORE_DIRECTORY_ENV]: options.storeDirectory }),
      ...(options.storeMode === undefined ? {} : { [STORE_MODE_ENV]: options.storeMode })
    },
    onStderr: (line) => diagnostics.push(line)
  });

  return {
    transport,
    diagnostics,
    get pid(): number | undefined {
      return transport.pid;
    },
    exited: transport.exited,
    kill: async () => {
      const pid = transport.pid;
      // SIGKILL, deliberately. A graceful stop lets the process flush and proves
      // only that an ORDERLY shutdown loses nothing.
      if (pid !== undefined) process.kill(pid, "SIGKILL");
      await transport.exited;
    },
    stop: () => transport.close()
  };
}

/** A client with no credential: the shipped entry authenticates nobody. */
export function connectShipped(server: ShippedServer): AtlasConsumerClient {
  return new AtlasConsumerClient({
    transport: server.transport,
    clientInfo: { name: "atlas-e2e-shipped", version: "1" }
  });
}
