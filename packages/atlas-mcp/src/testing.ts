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
import { AssertionLog, EntityRegistry, canonicalRecordedAt, type Entity, type EntityId } from "@living-atlas/atlas-core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryAuditJournal } from "./audit.js";
import { CREDENTIAL_META_KEY, fixedPrincipalResolver } from "./credentials.js";
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
