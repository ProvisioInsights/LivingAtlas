#!/usr/bin/env -S npx tsx
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_REVISION, loadContract, schemaDirectory } from "@living-atlas/atlas-contract";
import { DurableFileAuditJournal } from "../audit-file.js";
import {
  CREDENTIAL_DIRECTORY_ENV,
  credentialDirectoryFromEnvironment,
  type LoadedCredentialDirectory
} from "../credential-directory.js";
import { credentialResolver } from "../credentials.js";
import { STORE_DIRECTORY_ENV, openStoreFromEnvironment, type AtlasStore } from "../store.js";
import { serveAtlasHttp } from "./consumer.js";
import { portFromEnv } from "./listener.js";

/**
 * THE LIVE ATLAS SERVICE: one process, one store, many clients (ADR 0035).
 *
 * The stdio entry serves ONE client per process, because a pipe has one other
 * end. That is why an edit was invisible to everyone else: N clients meant N
 * processes, each holding its own snapshot of a store opened once for the life
 * of the process. Nothing was stale in the query engine — the topology was one
 * private copy per reader.
 *
 * This entry inverts it. One process opens the store (read-write, normally) and
 * serves every client over Streamable HTTP on loopback, so a write mutates the
 * same state every reader's next query is answered from. No restart, no
 * reconnect, no cache to invalidate — there is only one copy.
 *
 * ## Why this entry REQUIRES a credential directory
 *
 * On stdio the pipe is the trust boundary: whoever spawned the process is the
 * only party who can talk to it, so a fixed principal is a documented
 * single-consumer choice. A loopback socket is reachable by every process on the
 * host. `auth.ts` therefore refuses to build a listener without a directory, and
 * this entry surfaces that as a startup failure with a sentence rather than a
 * stack trace.
 *
 * ## The cross-process lock is not this entry's job
 *
 * `openAtlasStore` refuses a second read-write handle in ONE process, and takes
 * a lock file for the cross-PROCESS case — a maintenance runner, a read-write
 * stdio client, or this service started twice. It lives at the store boundary
 * rather than here on purpose: every read-write opener goes through that one
 * function, so no entrypoint can forget. See `write-lock.ts`.
 *
 * ## Env contract
 *
 *   LIVING_ATLAS_STORE_DIR         (required) the store to serve
 *   LIVING_ATLAS_STORE_MODE        read-only | read-write. Defaults to READ-ONLY,
 *                                  like every other entry: a service that
 *                                  defaulted to writable would make "can this
 *                                  thing change my graph?" depend on a variable
 *                                  nobody set.
 *   LIVING_ATLAS_CREDENTIAL_DIR    (required) principals and their grants
 *   LIVING_ATLAS_HTTP_PORT         (required) loopback port; no default, so a
 *                                  typo cannot listen somewhere unexpected
 *   LIVING_ATLAS_HTTP_HOST         defaults to 127.0.0.1; loopback only
 *   LIVING_ATLAS_ATLAS_AUDIT_LOG   (required) one event per tool call
 */

export const HTTP_PORT_ENV = "LIVING_ATLAS_HTTP_PORT" as const;
export const HTTP_HOST_ENV = "LIVING_ATLAS_HTTP_HOST" as const;
export const AUDIT_LOG_ENV = "LIVING_ATLAS_ATLAS_AUDIT_LOG" as const;

function fail(message: string): never {
  process.stderr.write(`[atlas-http] ${message}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const auditLogPath = process.env[AUDIT_LOG_ENV];
  if (auditLogPath === undefined || auditLogPath.trim().length === 0) {
    fail(`${AUDIT_LOG_ENV} is not set: every tool call is audited and this entry has no default path`);
  }

  let port: number;
  try {
    port = portFromEnv(HTTP_PORT_ENV);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }

  const host = process.env[HTTP_HOST_ENV] ?? "127.0.0.1";

  // The store FIRST, so a bad path fails before a socket exists. A listener that
  // bound and then discovered it had no store would look healthy to whatever
  // connected to it.
  const storeDirectory = process.env[STORE_DIRECTORY_ENV];
  if (storeDirectory === undefined || storeDirectory.trim().length === 0) {
    // No in-memory fallback here, unlike the stdio entry. That entry serves an
    // empty graph so a client can inspect the SURFACE with no data involved; a
    // long-lived service on a socket has no such purpose, and an empty graph
    // served to every client on the host would look exactly like a healthy one.
    fail(`${STORE_DIRECTORY_ENV} is not set: this entry serves a durable store and has no in-memory mode`);
  }

  let opened: AtlasStore | undefined;
  try {
    opened = openStoreFromEnvironment(process.env);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  if (opened === undefined) fail(`${STORE_DIRECTORY_ENV} named no store`);
  const store: AtlasStore = opened;

  /**
   * The cross-process write lock is NOT taken here.
   *
   * `openAtlasStore` takes it for any read-write open and releases it in
   * `close()`, so every entrypoint — this one, the stdio consumer, the operator
   * plane, every `real-data:*` runner — is guarded by the single act of opening
   * the store. It lived here once, which made it advisory: it stopped this
   * service being started twice and did nothing about the service running beside
   * a read-write stdio client, which is the case it was written for.
   *
   * A refused lock therefore surfaces as a throw from `openStoreFromEnvironment`
   * above, with the holder's pid in the message.
   */
  if (store.reclaimedWriteLockFrom !== undefined) {
    // Loud on purpose: a stale lock is evidence that a previous writer died
    // without releasing, which an operator should know about even though the
    // reclaim is safe.
    process.stderr.write(
      `[atlas-http] reclaimed a stale write lock from pid ${store.reclaimedWriteLockFrom} — the ` +
        "previous writer exited without releasing it. If that was a crash, verify the store's tail.\n"
    );
  }

  let loaded: LoadedCredentialDirectory | undefined;
  try {
    loaded = credentialDirectoryFromEnvironment(process.env);
  } catch (cause) {
    store.close();
    fail(cause instanceof Error ? cause.message : String(cause));
  }
  if (loaded === undefined) {
    store.close();
    fail(
      `${CREDENTIAL_DIRECTORY_ENV} is not set. Unlike the stdio entry, an HTTP listener has no ` +
        "fixed-principal mode: a loopback socket is reachable by every process on this host, so " +
        "every request must carry a bearer token that resolves to a principal."
    );
  }

  const auditJournal = new DurableFileAuditJournal(auditLogPath);

  // `../..` twice: this file sits one level deeper than the stdio entry.
  const contractRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "atlas-contract");

  const listener = await serveAtlasHttp({
    contract: loadContract(schemaDirectory(contractRoot, CONTRACT_REVISION)),
    graph: store.graph,
    auditJournal,
    resolvePrincipal: credentialResolver({ directory: loaded.directory, plane: "consumer" }),
    credentials: loaded.directory,
    host,
    port,
    onRejection: (rejection) => {
      // Edge refusals never reach a tool, so they never reach the audit log.
      // One line each, and no request body: this file is the one that must not
      // become the unbounded log that took Atlas down.
      process.stderr.write(`[atlas-http] rejected: ${rejection.reasonCode}\n`);
    },
    onerror: (error) => {
      process.stderr.write(`[atlas-http] ${error.message}\n`);
    }
  });

  process.stderr.write(
    `[atlas-http] serving contract ${CONTRACT_REVISION} at ${listener.url} ` +
      `mode=${store.mode} principals=${loaded.size}\n`
  );

  /**
   * Shut down once, on either signal, releasing in reverse order.
   *
   * The lock is released LAST and only after the store is closed: releasing it
   * first would let a second writer open the store while this one still had a
   * handle on it, which is the exact condition the lock exists to prevent.
   */
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stderr.write(`[atlas-http] ${signal}: closing\n`);
    try {
      await listener.close();
      store.close();
    } finally {
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((cause) => {
  process.stderr.write(`[atlas-http] ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
  process.exit(1);
});
