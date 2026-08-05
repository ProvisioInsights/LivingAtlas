import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY
} from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { gateInbound } from "./protocol-gate.js";
import { SERVER_INFO } from "./server.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./stdio.js";
import { callTool, envelope, startHarness, testContract, type Harness } from "./testing.js";

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope(overrides);
}

/** What the published contract says about holding a description of itself. */
function publishedDescribeTtl(): number {
  const describe = testContract().manifest.tools.find((tool) => tool.name === "atlas.contract.describe.v1");
  return describe?.cache.ttl_ms ?? -1;
}

describe("the protocol gate", () => {
  it("passes a request naming the one revision this server speaks", () => {
    const decision = gateInbound(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } },
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
    );
    expect(decision.kind).toBe("pass");
  });

  it("refuses a request naming a revision this server does not speak, with both supported and requested", () => {
    const decision = gateInbound(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: "2025-06-18" }) }
      },
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
    );
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    expect(decision.rejection.code).toBe(-32022);
    expect(decision.response).toMatchObject({
      id: 7,
      error: { code: -32022, data: { supported: [CONTRACT_PROTOCOL_VERSION], requested: "2025-06-18" } }
    });
  });

  it.each([["2019-01-01"], ["2027-01-01"], ["not-a-date"], [""]])(
    "refuses the envelope value %j rather than serving it as the current revision",
    (version) => {
      const decision = gateInbound(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: version }) } },
        { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
      );
      expect(decision.kind).toBe("reject");
    }
  );

  it("refuses a non-string protocol version without letting it reach a handler", () => {
    const decision = gateInbound(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: 20260728 }) } },
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
    );
    expect(decision.kind).toBe("reject");
    if (decision.kind !== "reject") return;
    // `requested` is still reported, as the JSON rendering of what arrived: a
    // client that sent a number needs to see that, not an empty field.
    expect(decision.response).toMatchObject({ error: { data: { requested: "20260728" } } });
  });

  it("never refuses a notification, because a refusal needs an id to answer on", () => {
    const decision = gateInbound(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { _meta: meta({ [PROTOCOL_VERSION_META_KEY]: "2019-01-01" }) } },
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
    );
    expect(decision.kind).toBe("pass");
  });

  it("leaves the no-envelope case to the SDK so one shape has one answer", () => {
    const decision = gateInbound(
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS }
    );
    expect(decision.kind).toBe("pass");
  });
});

describe("server/discover", () => {
  it("answers with supportedVersions, capabilities, instructions, serverInfo and the caching fields", async () => {
    const { client } = harness();
    client.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta() } });
    const response = await client.await(1);

    expect(response.error).toBeUndefined();
    const result = response.result ?? {};
    expect(result["supportedVersions"]).toEqual([CONTRACT_PROTOCOL_VERSION]);
    expect(result["capabilities"]).toMatchObject({ tools: {} });
    expect(String(result["instructions"])).toContain("atlas.contract.describe.v1");
    // serverInfo rides the reserved `_meta` key rather than a top-level member:
    // that is where the 2026-07-28 revision puts it, and inventing a second
    // location would publish a field no consumer is told to read.
    expect((result["_meta"] as Record<string, unknown>)[SERVER_INFO_META_KEY]).toEqual(SERVER_INFO);
    expect(result["resultType"]).toBe("complete");
    expect(result["cacheScope"]).toBe("private");
    // The number comes from the contract, not from this server: it is
    // `atlas.contract.describe.v1`'s own published TTL, so a cached description
    // can never outlive the contract's answer about how long to hold one.
    expect(result["ttlMs"]).toBe(publishedDescribeTtl());
  });

  it("is refused when the request carries no protocol version at all", async () => {
    const { client } = harness();
    client.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    const response = await client.await(1);
    expect(response.error?.code).toBe(-32022);
    expect(response.error?.data).toMatchObject({ supported: [CONTRACT_PROTOCOL_VERSION] });
  });
});

describe("the per-request envelope", () => {
  it("rejects a tools/call whose _meta omits clientCapabilities", async () => {
    const { client } = harness();
    client.send(
      callTool({
        id: 1,
        name: "atlas.scope.describe.v1",
        meta: { [PROTOCOL_VERSION_META_KEY]: CONTRACT_PROTOCOL_VERSION }
      })
    );
    const response = await client.await(1);
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(-32602);
  });

  it("rejects a tools/call whose _meta omits the protocol version", async () => {
    const { client } = harness();
    client.send(
      callTool({ id: 1, name: "atlas.scope.describe.v1", meta: { [CLIENT_CAPABILITIES_META_KEY]: {} } })
    );
    const response = await client.await(1);
    expect(response.error).toBeDefined();
  });

  it("answers -32022 on the wire for a version the SDK alone would have served", async () => {
    const rejected: unknown[] = [];
    const { client } = harness({ onProtocolRejection: (rejection) => rejected.push(rejection) });
    client.send(
      callTool({
        id: 1,
        name: "atlas.scope.describe.v1",
        meta: meta({ [PROTOCOL_VERSION_META_KEY]: "2019-01-01" })
      })
    );
    const response = await client.await(1);
    expect(response.error).toMatchObject({
      code: -32022,
      data: { supported: [CONTRACT_PROTOCOL_VERSION], requested: "2019-01-01" }
    });
    expect(rejected).toHaveLength(1);
  });

  it("refuses a 2025-era initialize rather than serving a legacy connection", async () => {
    const { client } = harness();
    client.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "legacy", version: "1" } }
    });
    const response = await client.await(1);
    expect(response.error?.code).toBe(-32022);
  });
});

describe("tools/list", () => {
  it("publishes exactly the 12 consumer tools, in the contract's order, every time", async () => {
    const { client } = harness();
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } });
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta() } });
    const first = await client.await(1);
    const second = await client.await(2);

    const names = (first.result?.["tools"] as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual([...CONTRACT_TOOL_NAMES]);
    expect((second.result?.["tools"] as { name: string }[]).map((tool) => tool.name)).toEqual(names);
  });

  it("carries resultType and the caching fields, scoped private", async () => {
    const { client } = harness();
    client.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta() } });
    const response = await client.await(1);
    expect(response.result?.["resultType"]).toBe("complete");
    expect(response.result?.["cacheScope"]).toBe("private");
    expect(response.result?.["ttlMs"]).toBe(publishedDescribeTtl());
  });
});

describe("resultType", () => {
  it("is present on every result of every tool", async () => {
    const { client, graph } = harness();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    const argumentsByTool: Record<string, Record<string, unknown>> = {
      "atlas.contract.describe.v1": {},
      "atlas.scope.describe.v1": {},
      "atlas.entity.resolve.v1": { ids: [subject.entity_id] },
      "atlas.entity.read.v1": { entity_ids: [subject.entity_id] },
      "atlas.assertion.query.v1": {},
      "atlas.assertion.read.v1": { assertion_ids: ["la_assertion_00000000000000000000000000"] },
      "atlas.graph.neighbors.v1": { entity_id: subject.entity_id },
      "atlas.text.search.v1": { query: "Synthetic" },
      "atlas.changes.read.v1": { cursor_seq: 0 },
      "atlas.assertion.propose.v1": {
        idempotency_key: "k1",
        proposals: [
          {
            kind: "fact",
            subject_entity_id: subject.entity_id,
            predicate: "worked-at",
            value: "Acme",
            confidence: { band: "high" },
            evidence_links: [{ evidence_id: "e1", stance: "supports" }]
          }
        ]
      },
      "atlas.submission.read.v1": { idempotency_key: "k1" },
      "atlas.sensitive.reveal.v1": { redaction_id: "la_redaction_none", reason: "checking the envelope" }
    };

    let id = 100;
    for (const name of CONTRACT_TOOL_NAMES) {
      const args = argumentsByTool[name];
      expect(args, `no fixture arguments for ${name}`).toBeDefined();
      client.send(callTool({ id, name, args: args ?? {} }));
      const response = await client.await(id);
      expect(response.error, `${name} answered a protocol error`).toBeUndefined();
      expect(response.result?.["resultType"], `${name} returned no resultType`).toBe("complete");

      // A result that failed its own published output schema comes back as an
      // untyped tool error with no `structuredContent`. Asserting the positive
      // shape here is what makes this a contract-conformance check for all 12
      // rather than a check that a JSON-RPC response arrived.
      const content = response.result?.["content"] as { text: string }[] | undefined;
      const firstBlock = content?.[0]?.text ?? "{}";
      expect(JSON.parse(firstBlock), `${name} refused its own output schema`).not.toMatchObject({
        code: "output-contract-violation"
      });
      if (name !== "atlas.sensitive.reveal.v1") {
        expect(response.result?.["structuredContent"], `${name} returned no structured result`).toBeDefined();
        expect(response.result?.["isError"], `${name} answered an error`).toBeUndefined();
      }
      id += 1;
    }
  });
});
