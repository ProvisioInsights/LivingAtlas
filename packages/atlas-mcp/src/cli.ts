#!/usr/bin/env -S npx tsx
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContract, schemaDirectory, CONTRACT_REVISION, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { AssertionLog, EntityRegistry, canonicalRecordedAt, type Entity, type EntityId } from "@living-atlas/atlas-core";
import type { AuditEvent, AuditJournal } from "./audit.js";
import { fixedPrincipalResolver } from "./credentials.js";
import type { GraphSource } from "./graph.js";
import type { Principal } from "./principal.js";
import { serveAtlasStdio } from "./stdio.js";

/**
 * The stdio entry point, wired to an EMPTY in-memory graph.
 *
 * Deliberately empty. This binary exists so a client can be pointed at a real
 * 2026-07-28 server and see the surface — `server/discover`, the 12 tools, the
 * envelope rules, the escalation — without any data being involved. Wiring a
 * durable store to it is a separate, reviewable act, and migration against real
 * data is blocked on offline media in any case.
 *
 * Nothing here reads a profile directory, a graph path, or any location outside
 * the directory it is told to write its audit log to.
 */

function usage(): never {
  process.stderr.write(
    [
      "living-atlas-atlas-mcp — Living Atlas consumer plane over stdio",
      "",
      `  contract revision : ${CONTRACT_REVISION}`,
      "  protocol revision : 2026-07-28 only (no legacy era, no dual era)",
      "",
      "  --audit-log <path>   Where the one-event-per-tool-call log is appended (required).",
      "  --client-id <id>     The principal this connection speaks as. Default: local-consumer.",
      "",
      "The graph is empty and in memory. This entry serves the SURFACE, not data.",
      ""
    ].join("\n")
  );
  process.exit(2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

/** Append-only, one JSON object per line, fsync-free — the log is not the graph. */
function fileAuditJournal(path: string): AuditJournal {
  mkdirSync(dirname(path), { recursive: true });
  return {
    append: (event: AuditEvent) => {
      appendFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

function emptyGraph(): GraphSource {
  const assertions = new AssertionLog({
    feedEpoch: "e1",
    bitemporalSince: canonicalRecordedAt(new Date())
  });
  const registry = new EntityRegistry();
  const entities: Entity[] = [];
  return {
    assertions,
    entities: {
      read: (entityId: EntityId) => registry.read(entityId),
      resolve: (id: string) => registry.resolve(id)
    },
    searchableEntities: () => entities,
    encryptedUnsearchable: () => 0,
    predicateRegistry: () => []
  };
}

const auditLog = argument("audit-log");
if (auditLog === undefined) usage();

const principal: Principal = {
  client_id: argument("client-id") ?? "local-consumer",
  credential_class: "consumer",
  plane: "consumer",
  grant: {
    grant_id: "grant-cli-consumer",
    // `open` only. This entry authenticates nobody, so it is given the narrowest
    // grant that can still exercise every path: it reaches open records, and a
    // withheld one arrives as a stub it may ask about.
    sensitivity_reachable: [{ tier: "open", rank: 0 }],
    tools_permitted: [...CONTRACT_TOOL_NAMES],
    predicates_writable: [],
    write_tiers_permitted: [],
    limits: {},
    coverage_counts_basis: "bucketed",
    supersession_scope: "own-client-id",
    reveal_available: true
  }
};

/**
 * One credential, therefore one `client_id`, therefore no attribution.
 *
 * Said out loud on stderr rather than left implicit. This entry serves the
 * surface and has no credential directory, so every call it answers is
 * attributed to the same client — which is exactly the collapse the per-request
 * credential model exists to prevent. A deployment that needs attribution
 * supplies a directory and `credentialResolver`.
 */
process.stderr.write(
  `[atlas-mcp] no credential directory: every call is attributed to client_id ${principal.client_id}\n`
);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "atlas-contract");

serveAtlasStdio({
  contract: loadContract(schemaDirectory(packageRoot, CONTRACT_REVISION)),
  graph: emptyGraph(),
  auditJournal: fileAuditJournal(auditLog),
  resolvePrincipal: fixedPrincipalResolver(principal),
  // stderr, never stdout: stdout is the JSON-RPC wire, and a stray line on it
  // corrupts the framing for every message after it.
  onerror: (error) => process.stderr.write(`[atlas-mcp] ${error.message}\n`),
  onProtocolRejection: (rejection) =>
    process.stderr.write(
      `[atlas-mcp] refused ${rejection.method}: protocol revision ${rejection.requested ?? "(unnamed)"}\n`
    )
});
