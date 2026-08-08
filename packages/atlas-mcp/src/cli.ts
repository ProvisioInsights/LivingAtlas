#!/usr/bin/env -S npx tsx
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContract, schemaDirectory, CONTRACT_REVISION, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { AssertionLog, EntityRegistry, canonicalRecordedAt, type Entity, type EntityId } from "@living-atlas/atlas-core";
import { DurableFileAuditJournal } from "./audit-file.js";
import {
  CREDENTIAL_DIRECTORY_ENV,
  credentialDirectoryFromEnvironment,
  directoryPrincipalResolver,
  type LoadedCredentialDirectory
} from "./credential-directory.js";
import { fixedPrincipalResolver } from "./credentials.js";
import type { GraphSource } from "./graph.js";
import type { Principal, PrincipalResolver } from "./principal.js";
import { serveAtlasStdio } from "./stdio.js";
import {
  STORE_DIRECTORY_ENV,
  STORE_MODE_ENV,
  openStoreFromEnvironment,
  type AtlasStore
} from "./store.js";

/**
 * The stdio entry point.
 *
 * It serves ONE of two graphs, and which one is a property of the environment
 * rather than of anything a client can ask for:
 *
 *  - `LIVING_ATLAS_STORE_DIR` unset: an EMPTY in-memory graph. This binary then
 *    exists so a client can be pointed at a real 2026-07-28 server and see the
 *    surface — `server/discover`, the 12 tools, the envelope rules, the
 *    escalation — without any data being involved.
 *  - `LIVING_ATLAS_STORE_DIR` set: the durable store in that directory, opened
 *    once for the life of the process, `read-only` unless
 *    `LIVING_ATLAS_STORE_MODE` says otherwise.
 *
 * There is no third case. A store directory that does not exist is a startup
 * FAILURE, never an empty graph — see `store.ts` — because a server that
 * answered every query with an empty page over a typo'd path would look healthy
 * while serving nothing.
 *
 * Who the calls are attributed to is also a property of the environment:
 *
 *  - `LIVING_ATLAS_CREDENTIAL_DIR` unset: the unchanged single principal, an
 *    open-only grant, so a migrated graph arrives as redaction stubs. This is the
 *    honest default for an entry that authenticates nobody.
 *  - `LIVING_ATLAS_CREDENTIAL_DIR` set: the directory maps principals to grants.
 *    `--client-id` selects the one this connection speaks as, and a presented
 *    secret still resolves through the same directory. A malformed or unreadable
 *    directory is a startup FAILURE — never a silent fall back to open-only, and
 *    never a fall back to reaching everything.
 *
 * Nothing here reads a profile directory or any location it was not told about.
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
      "                       With a credential directory it must name a principal the directory defines.",
      "",
      `  ${STORE_DIRECTORY_ENV}   Directory of the durable store to serve. Must already exist,`,
      "                            holding assertions/ and identity/ segment logs. Unset serves an",
      "                            empty in-memory graph instead.",
      `  ${STORE_MODE_ENV}  read-only (default) or read-write. Read-only refuses every`,
      "                            proposal, from every credential, and writes no byte at all.",
      `  ${CREDENTIAL_DIRECTORY_ENV}  Directory of one-record-per-file JSON credentials mapping a`,
      "                            principal to a grant. Unset attributes every call to one open-only",
      "                            principal. Malformed or unreadable is a startup failure, never a",
      "                            silent fall back to open-only.",
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

/**
 * Opened ONCE, here, before the server is built — never per request.
 *
 * Two handles to one segment log interleave records and corrupt the commit
 * groups the reader depends on. `store.ts` refuses a second open of the same
 * directory in this process; opening at module scope is what makes that
 * refusal the guard against a bug rather than the shape of normal operation.
 */
let store: AtlasStore | undefined;
try {
  store = openStoreFromEnvironment(process.env);
} catch (cause) {
  // Exit, rather than fall back to the in-memory graph. A fallback is exactly
  // how a misconfigured path becomes a server that reports an empty graph as if
  // it were the truth.
  process.stderr.write(`[atlas-mcp] ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(2);
}

const graph = store?.graph ?? emptyGraph();

const clientId = argument("client-id") ?? "local-consumer";

/**
 * The credential directory the environment named, or `undefined` for none.
 *
 * Loaded ONCE, here, and a malformed or unreadable directory EXITS rather than
 * falling back. The fallback is exactly how a typo'd or unreadable path becomes a
 * server that authenticates nobody while looking like it loaded a directory:
 * open-only content served as stubs, with no sign anything went wrong. See
 * `credential-directory.ts` for why the other fallback — reaching everything — is
 * refused too.
 */
let loadedCredentials: LoadedCredentialDirectory | undefined;
try {
  loadedCredentials = credentialDirectoryFromEnvironment(process.env);
} catch (cause) {
  process.stderr.write(`[atlas-mcp] ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(2);
}

let resolvePrincipal: PrincipalResolver;
if (loadedCredentials === undefined) {
  const principal: Principal = {
    client_id: clientId,
    credential_class: "consumer",
    plane: "consumer",
    grant: {
      grant_id: "grant-cli-consumer",
      // `open` only. With no credential directory this entry authenticates
      // nobody, so it is given the narrowest grant that can still exercise every
      // path: it reaches open records, and a withheld one arrives as a stub it
      // may ask about.
      //
      // Over a DURABLE store that has a real consequence worth stating out loud:
      // `local-private` is the tier atlas-core stamps on anything committed
      // without a classification, so most of a migrated graph arrives here as
      // redaction stubs rather than content. That is the grant model working, not
      // the store failing — a deployment that needs to read further supplies a
      // credential directory and a grant that names the tier.
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
  resolvePrincipal = fixedPrincipalResolver(principal);

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
} else {
  /**
   * The connection speaks as the principal `--client-id` names, whose grant is
   * read from the directory.
   *
   * A `--client-id` the directory does not define EXITS. Serving the open-only
   * default instead would answer to an id nobody granted anything to, which is
   * the silent-degradation this whole path exists to refuse; and there is no
   * plausible right principal to guess. A presented secret still resolves through
   * the same directory — see `directoryPrincipalResolver`.
   */
  const selected = loadedCredentials.principal(clientId);
  if (selected === undefined) {
    process.stderr.write(
      `[atlas-mcp] ${CREDENTIAL_DIRECTORY_ENV} defines no principal named ${clientId}. ` +
        `Known principals: ${loadedCredentials.clientIds.join(", ")}. ` +
        `Refusing to start rather than serving as a principal the directory did not define.\n`
    );
    process.exit(2);
  }
  resolvePrincipal = directoryPrincipalResolver({
    directory: loadedCredentials.directory,
    plane: "consumer",
    defaultPrincipal: selected
  });
  process.stderr.write(
    `[atlas-mcp] credential directory loaded: ${loadedCredentials.size} principal(s); ` +
      `this connection speaks as client_id ${selected.client_id} ` +
      `(grant ${selected.grant.grant_id}) reaching ${selected.grant.sensitivity_reachable
        .map((tier) => tier.tier)
        .join(", ")}\n`
  );
}

/**
 * What was opened, in one line, before the first request is served.
 *
 * An operator has to be able to tell a server serving a real store from one
 * serving the empty in-memory fixture, and "the answers looked plausible" is not
 * a way to tell. The counts come from the store's own load, so a store that
 * opened successfully and holds nothing says so rather than looking identical to
 * a healthy one.
 */
if (store === undefined) {
  process.stderr.write(`[atlas-mcp] no ${STORE_DIRECTORY_ENV}: serving an EMPTY in-memory graph\n`);
} else {
  const status = store.status();
  process.stderr.write(
    `[atlas-mcp] store opened ${status.mode} feed_epoch=${status.feed_epoch} ` +
      `assertions=${status.assertions} entities=${status.entities} ` +
      `segment_repairs=${status.segment_repairs} ignored_files=${status.ignored_files}\n`
  );
  if (status.assertions === 0) {
    process.stderr.write("[atlas-mcp] the store opened and holds no assertions\n");
  }
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "atlas-contract");

const auditJournal = new DurableFileAuditJournal(auditLog);

const handle = serveAtlasStdio({
  contract: loadContract(schemaDirectory(packageRoot, CONTRACT_REVISION)),
  graph,
  // fsynced before each call returns: a disclosure whose event is not yet
  // durable is a disclosure the log could lose. See `audit-file.ts`.
  auditJournal,
  resolvePrincipal,
  // stderr, never stdout: stdout is the JSON-RPC wire, and a stray line on it
  // corrupts the framing for every message after it.
  onerror: (error) => process.stderr.write(`[atlas-mcp] ${error.message}\n`),
  onProtocolRejection: (rejection) =>
    process.stderr.write(
      `[atlas-mcp] refused ${rejection.method}: protocol revision ${rejection.requested ?? "(unnamed)"}\n`
    )
});

/**
 * The ready line, printed AFTER the store is open.
 *
 * A caller that starts sending on seeing it cannot race the open, and a caller
 * that never sees it knows the server did not start — which is the difference
 * between a failed open and a slow one.
 */
process.stderr.write(`[atlas-mcp] ready revision=${CONTRACT_REVISION}\n`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    store?.close();
    auditJournal.close();
    void handle.close();
    process.exit(0);
  });
}
