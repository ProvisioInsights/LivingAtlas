import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AtlasConsumerClient,
  createStdioTransport,
  type ElicitationDecider,
  type StdioAtlasTransport
} from "@living-atlas/atlas-client";
import { hashCredential, type AuditEvent, type CredentialRecord } from "@living-atlas/atlas-mcp";
import { harnessPrincipals, type HarnessPrincipalName } from "./fixture.js";
import { layoutFor } from "./layout.js";

/**
 * Spawning the real server, and holding the secrets it will never see on disk.
 *
 * Everything lives under `os.tmpdir()`, in a directory this process creates and
 * removes. Nothing here reads a profile directory, a configured path, or any
 * location a real graph could be at — and the server it spawns has no fallback
 * that could reach one either.
 *
 * The data directory OUTLIVES a server, which is the point of the whole
 * exercise: a restart scenario stops one process and starts another against the
 * same bytes, and the client is not told which of the two it is talking to.
 */

const require = createRequire(import.meta.url);

function serverEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "server-entry.ts");
}

/**
 * The TypeScript runner, resolved through its package rather than by path.
 *
 * `tsx/cli` is an export the package declares; reaching into `dist/` by hand
 * would work until the day it moved, and it would move quietly.
 */
function tsxCliPath(): string {
  return require.resolve("tsx/cli");
}

export type HarnessSecrets = Record<HarnessPrincipalName, string>;

export type AtlasWorkspace = {
  /** The data directory. Survives a server restart; removed by `dispose`. */
  readonly dataDirectory: string;
  readonly secrets: HarnessSecrets;
  /** Every audit event written so far, re-read from disk. */
  auditEvents(): AuditEvent[];
  /** A marker for `auditSince`. Take one immediately before the call under test. */
  auditMark(): number;
  /**
   * The events written since a marker.
   *
   * Deltas rather than totals, because the invariant is "this CALL wrote exactly
   * one event with aggregate counts" — never "the log holds exactly one event".
   * Asserting the total says the same thing only on a server nothing else has
   * spoken to, so it quietly forces a private process per scenario and still
   * checks the weaker claim.
   */
  auditSince(marker: number): AuditEvent[];
  dispose(): void;
};

/**
 * A fresh temporary data directory, with the credential file written.
 *
 * Secrets are minted HERE and only their hashes reach disk. They are handed to a
 * client in memory and presented per request — never written to the credential
 * file, never put on the child's command line, and never placed in its
 * environment. Argv is readable through `ps` and an inherited environment
 * carries every secret the parent holds, so neither is a place a secret goes.
 */
export function createWorkspace(): AtlasWorkspace {
  const dataDirectory = mkdtempSync(join(tmpdir(), "atlas-e2e-"));
  const secrets: HarnessSecrets = {
    consumer: `synthetic-consumer-${randomBytes(16).toString("hex")}`,
    operator: `synthetic-operator-${randomBytes(16).toString("hex")}`
  };

  const principals = harnessPrincipals();
  const records: CredentialRecord[] = (Object.keys(principals) as HarnessPrincipalName[]).map((name) => ({
    token_hash: hashCredential(secrets[name]),
    principal: principals[name]
  }));

  const layout = layoutFor(dataDirectory);
  mkdirSync(dataDirectory, { recursive: true });
  writeFileSync(layout.credentials, JSON.stringify(records, null, 2), "utf8");

  const auditEvents = (): AuditEvent[] => {
    if (!existsSync(layout.auditLog)) return [];
    return readFileSync(layout.auditLog, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditEvent);
  };

  return {
    dataDirectory,
    secrets,
    auditEvents,
    auditMark: () => auditEvents().length,
    auditSince: (marker) => auditEvents().slice(marker),
    dispose: () => {
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  };
}

export type ServerHandle = {
  readonly transport: StdioAtlasTransport;
  /** Every line the server wrote to stderr. Diagnostics; nothing branches on it. */
  readonly diagnostics: readonly string[];
  /** The pid, while it is running. A restart scenario kills through this. */
  readonly pid: number | undefined;
  /** SIGKILL, and wait. Not a graceful stop: a graceful stop proves less. */
  kill(): Promise<void>;
  stop(): Promise<void>;
};

export function startServer(workspace: AtlasWorkspace): ServerHandle {
  const diagnostics: string[] = [];
  const transport = createStdioTransport({
    command: process.execPath,
    args: [tsxCliPath(), serverEntryPath(), "--data-dir", workspace.dataDirectory],
    // A replacement environment rather than an extension of this process's. A
    // child that inherited the parent's whole environment would inherit every
    // secret in it, and a test harness is exactly where that happens by
    // accident. PATH is kept because the runner shells out to resolve nothing
    // else; nothing here reads a LIVING_ATLAS_* variable at all.
    env: { PATH: process.env["PATH"] ?? "", NODE_ENV: "test" },
    onStderr: (line) => diagnostics.push(line)
  });

  return {
    transport,
    diagnostics,
    get pid(): number | undefined {
      return transport.pid;
    },
    kill: async () => {
      const pid = transport.pid;
      // SIGKILL, deliberately. A graceful stop lets the process flush and close
      // cleanly, which proves the store survives an ORDERLY shutdown — a much
      // weaker claim than the one this harness is making. Every commit is meant
      // to be on disk before its receipt was returned, so the process being shot
      // should cost nothing that was ever acknowledged.
      if (pid !== undefined) process.kill(pid, "SIGKILL");
      await transport.exited;
    },
    stop: () => transport.close()
  };
}

export type ClientOptions = {
  principal?: HarnessPrincipalName;
  /** Supplying one declares the elicitation capability. Omitting it declares none. */
  elicitation?: ElicitationDecider;
  /** Present no credential at all, for the unauthenticated path. */
  anonymous?: boolean;
};

export function connect(workspace: AtlasWorkspace, server: ServerHandle, options: ClientOptions = {}): AtlasConsumerClient {
  const principal = options.principal ?? "consumer";
  return new AtlasConsumerClient({
    transport: server.transport,
    ...(options.anonymous === true ? {} : { credential: workspace.secrets[principal] }),
    ...(options.elicitation === undefined ? {} : { elicitation: options.elicitation }),
    clientInfo: { name: "atlas-e2e", version: "1" }
  });
}

/**
 * One workspace, one server, one client.
 *
 * A scenario that WRITES — a proposal, a supersession, a restart — takes its own
 * session, because the change feed's seq and the idempotency table are exactly
 * the state a later test would otherwise depend on, and an order-dependent suite
 * is one that passes until somebody inserts a test in the middle.
 *
 * A scenario that only READS shares one per file (`startSharedSession`), and
 * that is not a compromise for speed alone: sharing forces the audit assertions
 * to be DELTAS, which is the invariant that was always meant — "this call wrote
 * one event" rather than "the log holds one event". Spawning a process per read
 * scenario also puts real CPU pressure on the rest of `npm test`; a suite that
 * destabilises its neighbours is not a suite anyone keeps.
 *
 * Different CREDENTIALS need no separate server. Credentials are per-request
 * input on this revision, so one process serves a consumer, an operator and an
 * anonymous caller at once — and a shared server proving that is a better test
 * than three servers each seeing one.
 */
export type Session = {
  workspace: AtlasWorkspace;
  server: ServerHandle;
  client: AtlasConsumerClient;
  /** Stop the server and remove the directory. Safe to call twice. */
  dispose(): Promise<void>;
};

export async function startSession(options: ClientOptions = {}): Promise<Session> {
  const workspace = createWorkspace();
  const server = startServer(workspace);
  const client = connect(workspace, server, options);
  return {
    workspace,
    server,
    client,
    dispose: async () => {
      await server.stop();
      workspace.dispose();
    }
  };
}

/**
 * A session for a whole file's read-only scenarios, plus a way to reconnect
 * under a different credential without spawning a second server.
 */
export type SharedSession = Session & {
  /** Another client on the SAME process, with different options. */
  as(options: ClientOptions): AtlasConsumerClient;
};

export async function startSharedSession(options: ClientOptions = {}): Promise<SharedSession> {
  const base = await startSession(options);
  return { ...base, as: (clientOptions) => connect(base.workspace, base.server, clientOptions) };
}

/** Restart on the SAME data directory, with a fresh client that is told nothing. */
export function restart(workspace: AtlasWorkspace, options: ClientOptions = {}): { server: ServerHandle; client: AtlasConsumerClient } {
  const server = startServer(workspace);
  return { server, client: connect(workspace, server, options) };
}
