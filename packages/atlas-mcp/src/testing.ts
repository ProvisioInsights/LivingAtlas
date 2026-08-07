import { mkdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from "@modelcontextprotocol/server";
import {
  CONTRACT_PROTOCOL_VERSION,
  CONTRACT_TOOL_NAMES,
  loadContract,
  schemaDirectory,
  type LoadedContract
} from "@living-atlas/atlas-contract";
import { CONTRACT_REVISION } from "@living-atlas/atlas-contract";
import {
  AssertionLog,
  DurableAssertionLog,
  DurableEntityRegistry,
  EntityRegistry,
  canonicalRecordedAt,
  type Entity,
  type EntityId,
  type RecordedAt
} from "@living-atlas/atlas-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryAuditJournal } from "./audit.js";
import {
  CREDENTIAL_META_KEY,
  InMemoryCredentialDirectory,
  credentialResolver,
  fixedPrincipalResolver,
  hashCredential
} from "./credentials.js";
import { atlasConsumerHttpHandler, serveAtlasHttp } from "./http/consumer.js";
import type { AtlasHttpServeOptions } from "./http/serve.js";
import type { CapabilityGrant } from "./grant.js";
import type { GraphSource } from "./graph.js";
import type { Principal } from "./principal.js";
import { serveAtlasStdio, type ServeAtlasStdioOptions } from "./stdio.js";

/**
 * The synthetic harness.
 *
 * Everything here is fabricated in memory. No test in this package reads a real
 * graph, a real profile directory, or any path outside the repository — the
 * repo's privacy boundary is that policy, leakage, sync, key and audit
 * behaviour is proven on synthetic fixtures BEFORE real data is imported, and
 * this package is on the wrong side of that line if it ever needs otherwise.
 *
 * The client half drives real JSON-RPC bytes over a pipe pair rather than
 * calling handlers directly, because most of what this package must get right
 * — the `_meta` envelope, `-32022`, `resultType`, `ttlMs`/`cacheScope`, the
 * MRTR round trip — exists only on the wire.
 */

export function contractDirectory(): string {
  // The published bytes, from the atlas-contract package's own directory. The
  // server loads what a consumer would fetch; a test that rebuilt the schemas
  // would be checking the generator against itself.
  const here = dirname(fileURLToPath(import.meta.url));
  return schemaDirectory(join(here, "..", "..", "atlas-contract"), CONTRACT_REVISION);
}

let cached: LoadedContract | undefined;

export function testContract(): LoadedContract {
  cached ??= loadContract(contractDirectory());
  return cached;
}

/**
 * The grant the default synthetic consumer holds: every published tool, the
 * open tier, and the fixture's predicates.
 *
 * Deliberately broad, so a test that means to probe a NARROWER grant has to say
 * so with `withGrant`. A permissive default that tests silently rely on is how
 * an authorization test ends up proving nothing.
 */
export const CONSUMER_GRANT: CapabilityGrant = {
  grant_id: "grant-synthetic-consumer",
  // `local-private` is named because that is the tier `AssertionLog.commit`
  // stamps on unclassified content, per AGENTS.md — so a consumer that may
  // propose must be granted BOTH the reach to read its own writes back and the
  // permission to write at that tier. Naming it is the grant model working as
  // designed: a tier nobody granted is unreachable, including this one.
  sensitivity_reachable: [
    { tier: "open", rank: 0 },
    { tier: "local-private", rank: 10 }
  ],
  tools_permitted: [...CONTRACT_TOOL_NAMES],
  predicates_writable: ["worked-at", "medical-note", "date-of-birth", "reports-to"],
  write_tiers_permitted: ["local-private"],
  limits: {},
  coverage_counts_basis: "exact",
  supersession_scope: "own-client-id",
  reveal_available: true
};

export const CONSUMER_PRINCIPAL: Principal = {
  client_id: "synthetic-consumer",
  credential_class: "consumer",
  plane: "consumer",
  grant: CONSUMER_GRANT
};

/** The same principal with part of its grant replaced. */
export function withGrant(principal: Principal, patch: Partial<CapabilityGrant>): Principal {
  return { ...principal, grant: { ...principal.grant, ...patch } };
}

export type SyntheticGraph = GraphSource & {
  assertions: AssertionLog;
  registry: EntityRegistry;
  entityList: Entity[];
};

/** A fixed clock, so belief-time stamps in a test are reproducible. */
export function fixedClock(startIso = "2026-08-04T12:00:00.000Z"): () => Date {
  let millis = new Date(startIso).getTime();
  return () => new Date((millis += 1));
}

export function syntheticGraph(options: { clock?: () => Date; entityCount?: number } = {}): SyntheticGraph {
  const clock = options.clock ?? fixedClock();
  const assertions = new AssertionLog({ clock, feedEpoch: "e-test", bitemporalSince: canonicalRecordedAt(new Date("2026-01-01T00:00:00.000Z")) });
  const registry = new EntityRegistry({ clock });
  const entityList: Entity[] = [];

  const count = options.entityCount ?? 3;
  for (let index = 0; index < count; index += 1) {
    entityList.push(
      registry.register(
        {
          type: "person",
          display_name: `Synthetic Person ${index}`,
          also_known_as: [`alias-${index}`]
        },
        // `open` so the default fixture is readable; a withheld fixture is made
        // explicitly by `withWithheldAssertion`, so a test that means to probe
        // the access rule has to say so.
        { client_id: "fixture", sensitivity: { tier: "open", rank: 0, withheld: false } }
      )
    );
  }

  return {
    assertions,
    registry,
    entityList,
    entities: {
      read: (entityId: EntityId) => registry.read(entityId),
      resolve: (id: string) => registry.resolve(id)
    },
    searchableEntities: () => entityList,
    encryptedUnsearchable: () => 0,
    predicateRegistry: () => [
      { predicate: "worked-at", cardinality: "multi-valued", relational: false },
      { predicate: "medical-note", cardinality: "multi-valued", relational: false },
      { predicate: "date-of-birth", cardinality: "functional", functional_key: ["subject_entity_id"], relational: false },
      { predicate: "reports-to", cardinality: "functional", functional_key: ["subject_entity_id"], relational: true }
    ]
  };
}

/**
 * The tier the seed helpers stamp explicitly.
 *
 * Explicit, not inherited: `commit` defaults unclassified content to
 * `local-private`, and a fixture that leaned on the default would be a fixture
 * whose readability changes when a privacy default changes. The entity fixture
 * above makes the same choice for the same reason.
 */
const FIXTURE_OPEN = { tier: "open", rank: 0, withheld: false } as const;

/** Commit `count` open assertions about the fixture's first entity. */
export function seedAssertions(graph: SyntheticGraph, count: number, clientId = "fixture"): void {
  const subject = graph.entityList[0];
  if (!subject) throw new Error("the synthetic graph has no entities to assert about");
  for (let index = 0; index < count; index += 1) {
    graph.assertions.commit({
      client_id: clientId,
      idempotency_key: `seed-${clientId}-${index}`,
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subject.entity_id,
          predicate: "worked-at",
          value: `Employer ${index}`,
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: `ev-${index}`, stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { ...FIXTURE_OPEN }
    });
  }
}

/** Commit a relationship assertion from entity `from` to entity `to`. */
export function seedRelationship(
  graph: SyntheticGraph,
  from: number,
  to: number,
  predicate = "reports-to",
  clientId = "fixture"
): void {
  const subject = graph.entityList[from];
  const target = graph.entityList[to];
  if (!subject || !target) throw new Error("the synthetic graph has too few entities for that edge");
  graph.assertions.commit({
    client_id: clientId,
    idempotency_key: `edge-${from}-${to}-${predicate}`,
    drafts: [
      {
        kind: "relationship",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate,
        target_entity_id: target.entity_id,
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: `ev-edge-${from}-${to}`, stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { ...FIXTURE_OPEN }
  });
}

/** Commit one assertion the consumer credential may not read. */
export function seedWithheldAssertion(graph: SyntheticGraph, clientId = "fixture"): void {
  const subject = graph.entityList[0];
  if (!subject) throw new Error("the synthetic graph has no entities to assert about");
  graph.assertions.commit({
    client_id: clientId,
    idempotency_key: `withheld-${clientId}`,
    drafts: [
      {
        kind: "fact",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate: "medical-note",
        value: "synthetic sealed value",
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-sealed", stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { tier: "sealed", rank: 90, withheld: true }
  });
}

// ---------------------------------------------------------------------------
// a durable store on disk
// ---------------------------------------------------------------------------

/**
 * A synthetic store in a directory the CALLER owns, built the way a migration
 * would build one: with atlas-core directly, closed before anything opens it for
 * serving.
 *
 * It lives here rather than in one test file because three places need the same
 * bytes — the store unit tests, the operator plane's store tools, and the
 * end-to-end harness that spawns the shipped binary against a real directory —
 * and three seeders would be three fixtures that drift until an assertion about
 * one stops meaning anything about the others.
 *
 * The caller supplies the root and removes it. Nothing here chooses a location,
 * so no helper in this package can be pointed at a real graph by default.
 */

export const STORE_FIXTURE_FEED_EPOCH = "e-store-fixture";
export const STORE_FIXTURE_HISTORY_FLOOR = "2026-06-01T00:00:00.000Z";
export const STORE_FIXTURE_ENTITY_NAMES = ["Synthetic Person Alpha", "Synthetic Person Beta"] as const;
export const STORE_FIXTURE_PREDICATE = "worked-at";
export const STORE_FIXTURE_EDGE_PREDICATE = "reports-to";
export const STORE_FIXTURE_SEALED_PREDICATE = "medical-note";

export type SeededStoreDirectory = {
  root: string;
  subjectEntityId: string;
  targetEntityId: string;
  /** The values of the OPEN assertions, in commit order. What a reader must see. */
  openValues: string[];
};

export function seedStoreDirectory(
  root: string,
  options: { assertions?: number; withheld?: boolean } = {}
): SeededStoreDirectory {
  const assertionsDirectory = join(root, "assertions");
  const identityDirectory = join(root, "identity");
  mkdirSync(assertionsDirectory, { recursive: true });
  mkdirSync(identityDirectory, { recursive: true });

  const identity = DurableEntityRegistry.open({ directory: identityDirectory });
  const registered = STORE_FIXTURE_ENTITY_NAMES.map((displayName) =>
    identity.registry.register(
      {
        type: "person",
        display_name: displayName,
        also_known_as: [`alias-${displayName.split(" ").pop()?.toLowerCase() ?? "x"}`]
      },
      // `open` explicitly rather than by default: a fixture whose readability
      // changes when a privacy default changes is a fixture that stops testing
      // what it was written to test.
      { client_id: "fixture", sensitivity: { ...FIXTURE_OPEN } }
    )
  );

  const subject = registered[0];
  const target = registered[1];
  if (!subject || !target) throw new Error("the store fixture failed to register its entities");

  const log = DurableAssertionLog.open({
    directory: assertionsDirectory,
    feedEpoch: STORE_FIXTURE_FEED_EPOCH,
    bitemporalSince: STORE_FIXTURE_HISTORY_FLOOR as RecordedAt
  });

  const openValues: string[] = [];
  const count = options.assertions ?? 2;
  for (let index = 0; index < count; index += 1) {
    const value = `Synthetic Employer ${index}`;
    openValues.push(value);
    log.commit({
      client_id: "fixture",
      idempotency_key: `store-fixture-open-${index}`,
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subject.entity_id,
          predicate: STORE_FIXTURE_PREDICATE,
          value,
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: `ev-store-${index}`, stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { ...FIXTURE_OPEN }
    });
  }

  log.commit({
    client_id: "fixture",
    idempotency_key: "store-fixture-edge",
    drafts: [
      {
        kind: "relationship",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate: STORE_FIXTURE_EDGE_PREDICATE,
        target_entity_id: target.entity_id,
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-store-edge", stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { ...FIXTURE_OPEN }
  });

  if (options.withheld === true) {
    // One record no narrow grant may read, so a reader over this store has to
    // show a redaction stub rather than a shorter list.
    log.commit({
      client_id: "fixture",
      idempotency_key: "store-fixture-sealed",
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: subject.entity_id,
          predicate: STORE_FIXTURE_SEALED_PREDICATE,
          value: "synthetic sealed value",
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "ev-store-sealed", stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { tier: "sealed", rank: 90, withheld: true }
    });
  }

  // Closed before anything serves from it. A fixture that left a writer open
  // would be handing the server a directory another process is still appending
  // to, which is the corruption the one-handle rule exists to prevent.
  log.close();
  identity.close();

  return { root, subjectEntityId: subject.entity_id, targetEntityId: target.entity_id, openValues };
}

// ---------------------------------------------------------------------------
// the wire client
// ---------------------------------------------------------------------------

export type WireResponse = {
  jsonrpc: "2.0";
  id: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

export type WireClient = {
  send(message: Record<string, unknown>): void;
  /** Resolve when a response with this id arrives, or reject after `timeoutMs`. */
  await(id: string | number, timeoutMs?: number): Promise<WireResponse>;
  responses: WireResponse[];
  close(): Promise<void>;
};

export type HarnessOptions = Omit<ServeAtlasStdioOptions, "contract" | "graph" | "auditJournal" | "resolvePrincipal"> &
  Partial<Pick<ServeAtlasStdioOptions, "contract" | "graph" | "auditJournal" | "resolvePrincipal">>;

export type Harness = {
  client: WireClient;
  handle: StdioServerHandle;
  graph: SyntheticGraph;
  auditJournal: MemoryAuditJournal;
  principal: Principal;
};

export function startHarness(options: HarnessOptions & { principal?: Principal } = {}): Harness {
  const graph = (options.graph as SyntheticGraph | undefined) ?? syntheticGraph();
  const auditJournal = (options.auditJournal as MemoryAuditJournal | undefined) ?? new MemoryAuditJournal();
  const principal = options.principal ?? CONSUMER_PRINCIPAL;

  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const transport = new StdioServerTransport(toServer, fromServer);

  const handle = serveAtlasStdio({
    ...options,
    contract: options.contract ?? testContract(),
    graph,
    auditJournal,
    // A fixed principal by default, so a test that is not about credentials
    // does not have to carry one. A test that IS about credentials passes a
    // directory-backed resolver and presents a secret per request.
    resolvePrincipal: options.resolvePrincipal ?? fixedPrincipalResolver(principal),
    transport
  });

  const responses: WireResponse[] = [];
  const waiters = new Map<string | number, (response: WireResponse) => void>();
  let buffer = "";
  fromServer.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim().length > 0) {
        const parsed = JSON.parse(line) as WireResponse;
        responses.push(parsed);
        waiters.get(parsed.id)?.(parsed);
        waiters.delete(parsed.id);
      }
      index = buffer.indexOf("\n");
    }
  });

  const client: WireClient = {
    responses,
    send: (message) => {
      toServer.write(`${JSON.stringify(message)}\n`);
    },
    await: (id, timeoutMs = 4000) =>
      new Promise<WireResponse>((resolve, reject) => {
        const existing = responses.find((response) => response.id === id);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`no response for id ${String(id)} within ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      }),
    close: () => handle.close()
  };

  return { client, handle, graph, auditJournal, principal };
}

// ---------------------------------------------------------------------------
// the HTTP harness
// ---------------------------------------------------------------------------

/**
 * The synthetic bearer secret. Fabricated, like everything else here.
 *
 * One constant so the stdio and HTTP halves of a parity test present the SAME
 * secret through their respective channels — `_meta` on one, `Authorization` on
 * the other — and therefore resolve, through one directory, to one principal
 * with one `client_id`. If they resolved to two principals the comparison would
 * be between two different callers and would prove nothing.
 */
export const SYNTHETIC_SECRET = "synthetic-bearer-secret-not-a-real-credential";

/** A one-credential directory for `principal`, shared by both transports. */
export function syntheticDirectory(principal: Principal = CONSUMER_PRINCIPAL): InMemoryCredentialDirectory {
  return new InMemoryCredentialDirectory([{ token_hash: hashCredential(SYNTHETIC_SECRET), principal }]);
}

export type HttpHarness = {
  /** POST one JSON-RPC message and return the parsed response. */
  send(message: Record<string, unknown>, init?: { headers?: Record<string, string>; bearer?: string | null }): Promise<WireResponse>;
  /** The same, but returning the raw `Response` — for the conformance assertions. */
  raw(
    message: Record<string, unknown> | undefined,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      bearer?: string | null;
      path?: string;
      /** `false` omits the auto-derived `Mcp-*` headers, so a test can prove a missing one is refused. */
      standard?: boolean;
    }
  ): Promise<Response>;
  url: string;
  graph: SyntheticGraph;
  auditJournal: MemoryAuditJournal;
  principal: Principal;
  close(): Promise<void>;
};

/**
 * The standard request headers the revision REQUIRES on every POST.
 *
 * Derived from the message rather than passed in, because that is the rule being
 * honoured: `Mcp-Method` mirrors `method` and `Mcp-Name` mirrors `params.name`
 * (or `params.uri`), and a harness that let a test set them independently would
 * make the header/body agreement the tests assert on an accident of the harness.
 * A test that means to send a MISMATCH overrides them explicitly.
 */
export function standardHeaders(message: Record<string, unknown>): Record<string, string> {
  const method = message["method"];
  const params = message["params"] as Record<string, unknown> | undefined;
  const name = params?.["name"] ?? params?.["uri"];
  return {
    "MCP-Protocol-Version": CONTRACT_PROTOCOL_VERSION,
    ...(typeof method === "string" ? { "Mcp-Method": method } : {}),
    ...(typeof name === "string" ? { "Mcp-Name": name } : {})
  };
}

export type HttpHarnessOptions = Omit<HarnessOptions, "transport"> & {
  principal?: Principal;
  /** Defaults to a directory-backed consumer resolver over `SYNTHETIC_SECRET`. */
  directory?: InMemoryCredentialDirectory;
  allowedOrigins?: string[];
  onRejection?: AtlasHttpServeOptions["onRejection"];
  /**
   * Whether to bind a real loopback socket.
   *
   * Default `false`, which drives `handler.fetch` directly with a web-standard
   * `Request`. That is the same code path a bound listener reaches — the
   * listener is a thin adapter between Node streams and `Request`/`Response`
   * and holds no Atlas logic — so the edge, the protocol ladder and the tool
   * results are all exercised identically, without a port, a socket or a worker
   * blocked on I/O.
   *
   * `true` for the cases where the socket IS the subject: the parity tests,
   * which mean the claim to be about a real HTTP transport, and the handful of
   * conformance cases that assert the Node-to-web conversion. Sockets are opt-in
   * rather than the default because every test file that binds one competes for
   * the same worker pool, and a suite that spends its parallelism on loopback
   * connects starves the CPU-bound tests elsewhere in the repo.
   */
  socket?: boolean;
};

export async function startHttpHarness(options: HttpHarnessOptions = {}): Promise<HttpHarness> {
  const graph = (options.graph as SyntheticGraph | undefined) ?? syntheticGraph();
  const auditJournal = (options.auditJournal as MemoryAuditJournal | undefined) ?? new MemoryAuditJournal();
  const principal = options.principal ?? CONSUMER_PRINCIPAL;
  const directory = options.directory ?? syntheticDirectory(principal);

  const shared = {
    ...options,
    contract: options.contract ?? testContract(),
    graph,
    auditJournal,
    credentials: directory,
    resolvePrincipal: credentialResolver({ directory, plane: principal.plane }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins })
  };

  const listener =
    options.socket === true
      ? await serveAtlasHttp({
          ...shared,
          host: "127.0.0.1",
          // Port 0: the OS picks a free one, so parallel test files never collide
          // on a fixed port and no test ever depends on a port being available.
          port: 0
        })
      : undefined;
  const handler = listener === undefined ? atlasConsumerHttpHandler(shared) : undefined;

  // Only ever used to build a syntactically valid URL when there is no socket.
  const url = listener?.url ?? "http://127.0.0.1";

  const raw: HttpHarness["raw"] = async (message, init = {}) => {
    const bearer = init.bearer === undefined ? SYNTHETIC_SECRET : init.bearer;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // `standard: false` lets a test send a request that OMITS a required
      // header — which is the only way to assert that omitting it is refused.
      ...(message === undefined || init.standard === false ? {} : standardHeaders(message)),
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      ...(init.headers ?? {})
    };
    const target = `${url}${init.path ?? "/mcp"}`;
    const request = {
      method: init.method ?? "POST",
      headers,
      ...(message === undefined ? {} : { body: JSON.stringify(message) })
    };
    return listener === undefined ? handler!.fetch(new Request(target, request)) : fetch(target, request);
  };

  return {
    url,
    graph,
    auditJournal,
    principal,
    raw,
    send: async (message, init = {}) => {
      const response = await raw(message, init);
      return (await response.json()) as WireResponse;
    },
    close: async () => {
      if (listener !== undefined) await listener.close();
      else await handler!.close();
    }
  };
}

/** A well-formed 2026-07-28 request envelope. */
export function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: CONTRACT_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
    [CLIENT_INFO_META_KEY]: { name: "synthetic-client", version: "1" },
    ...overrides
  };
}

/** The same envelope, presenting a credential. Synthetic secrets only. */
export function credentialEnvelope(secret: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope({ [CREDENTIAL_META_KEY]: secret, ...overrides });
}

/** A `tools/list` request carrying a well-formed envelope. */
export function listTools(input: { id: number; meta?: Record<string, unknown> }): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: input.id,
    method: "tools/list",
    params: { _meta: input.meta ?? envelope() }
  };
}

export function callTool(input: {
  id: number;
  name: string;
  args?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: input.id,
    method: "tools/call",
    params: {
      name: input.name,
      arguments: input.args ?? {},
      _meta: input.meta ?? envelope(),
      ...(input.extra ?? {})
    }
  };
}
