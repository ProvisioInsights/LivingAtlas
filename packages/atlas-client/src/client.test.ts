import { describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY, PROTOCOL_VERSION_META_KEY } from "@modelcontextprotocol/server";
import { CONTRACT_PROTOCOL_VERSION } from "@living-atlas/atlas-contract";
import {
  AtlasCapabilityRequired,
  AtlasContractViolation,
  AtlasProtocolError,
  AtlasProtocolMismatch,
  AtlasToolRefusal
} from "./errors.js";
import { AtlasConsumerClient, ATLAS_CREDENTIAL_META_KEY, MAX_REQUEST_STATE_LENGTH } from "./client.js";
import type { AtlasTransport, JsonRpcRequest, JsonRpcResponse } from "./transport.js";

/**
 * The protocol behaviour a REAL server cannot be made to produce on demand.
 *
 * The end-to-end journey in `@living-atlas/atlas-e2e` drives the real server
 * over a real pipe and mocks nothing; it is the authority on what the client
 * does against Atlas. What it cannot do is make a conformant server answer
 * `-32022` naming a revision it does not serve, or return a result that violates
 * its own published output schema, or omit `resultType`. Those are the cases
 * where a client either fails loudly or, much worse, guesses — so they are
 * driven here, from a transport that answers exactly what each case needs.
 *
 * The double is the TRANSPORT and never Atlas: no contract, no schema and no
 * validation is stubbed. Every result below still goes through the published
 * output schemas.
 */

type Exchange = { request: JsonRpcRequest; response: JsonRpcResponse };

type ScriptedAnswer = Record<string, unknown> | { error: { code: number; message: string; data?: unknown } };

function isErrorAnswer(answer: ScriptedAnswer): answer is { error: { code: number; message: string; data?: unknown } } {
  const candidate = (answer as { error?: unknown }).error;
  return typeof candidate === "object" && candidate !== null && typeof (candidate as { code?: unknown }).code === "number";
}

function scriptedTransport(answer: (request: JsonRpcRequest) => ScriptedAnswer): {
  transport: AtlasTransport;
  exchanges: Exchange[];
} {
  const exchanges: Exchange[] = [];
  const transport: AtlasTransport = {
    description: "scripted",
    request: (request) => {
      const produced = answer(request);
      const response: JsonRpcResponse = isErrorAnswer(produced)
        ? { jsonrpc: "2.0", id: request.id, error: produced.error }
        : { jsonrpc: "2.0", id: request.id, result: produced };
      exchanges.push({ request, response });
      return Promise.resolve(response);
    },
    close: () => Promise.resolve()
  };
  return { transport, exchanges };
}

function discoverResult(supportedVersions: string[] = [CONTRACT_PROTOCOL_VERSION]): Record<string, unknown> {
  return {
    supportedVersions,
    capabilities: { tools: {} },
    instructions: "synthetic",
    resultType: "complete",
    ttlMs: 0,
    cacheScope: "private"
  };
}

/** A minimally valid `atlas.scope.describe.v1` result. Validated, never waved through. */
function scopeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: "synthetic-consumer",
    credential_class: "consumer",
    plane: "consumer",
    grant_id: "grant-synthetic",
    tools_available: ["atlas.scope.describe.v1"],
    sensitivity_reachable: [{ tier: "open", rank: 0 }],
    sensitivity_ceiling: { tier: "open", rank: 0 },
    predicates_writable: [],
    write_tiers_permitted: [],
    limits: { max_page_size: 200, max_ids_per_request: 100, max_batch_items: 100 },
    coverage_counts_basis: "exact",
    supersession_scope: "own-client-id",
    reveal_available: false,
    declared_client_capabilities: [],
    horizon: {
      record_schema: "atlas.horizon:v1",
      status: "complete",
      bitemporal_since: "2026-01-01T00:00:00.000Z",
      feed_epoch: "e-test",
      seq_watermark: 0,
      as_of_recorded: "2026-08-04T12:00:00.000Z",
      recorded_at_fidelity_mixed: false,
      migration_window_open: false
    },
    cache: { ttl_ms: 60000, cache_scope: "private" },
    ...overrides
  };
}

function toolResult(structured: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resultType: "complete",
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
    ...extra
  };
}

describe("the request envelope", () => {
  it("presents the credential, the capabilities and the protocol revision on EVERY request", async () => {
    const { transport, exchanges } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(scopeResult())
    );
    const client = new AtlasConsumerClient({ transport, credential: "synthetic-secret" });

    await client.describeScope();

    // Two requests: discovery on first use, then the tool. Both carry it —
    // credentials are per-request input on this revision, not connection state,
    // so an envelope built once and reused would be the collapse the model
    // exists to prevent.
    expect(exchanges).toHaveLength(2);
    for (const exchange of exchanges) {
      const meta = exchange.request.params?.["_meta"] as Record<string, unknown>;
      expect(meta[PROTOCOL_VERSION_META_KEY]).toBe(CONTRACT_PROTOCOL_VERSION);
      expect(meta[ATLAS_CREDENTIAL_META_KEY]).toBe("synthetic-secret");
      expect(meta[CLIENT_CAPABILITIES_META_KEY]).toBeDefined();
    }
  });

  it("asks a credential function once per request, so a rotated secret reaches the next call", async () => {
    let issued = 0;
    const { transport, exchanges } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(scopeResult())
    );
    const client = new AtlasConsumerClient({
      transport,
      credential: () => `synthetic-secret-${(issued += 1)}`
    });

    await client.describeScope();

    const secrets = exchanges.map((exchange) => (exchange.request.params?.["_meta"] as Record<string, unknown>)[ATLAS_CREDENTIAL_META_KEY]);
    expect(secrets).toEqual(["synthetic-secret-1", "synthetic-secret-2"]);
  });

  it("declares elicitation only when it has a decider that could answer one", async () => {
    const { transport, exchanges } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(scopeResult())
    );

    const silent = new AtlasConsumerClient({ transport, credential: "s" });
    await silent.describeScope();
    const withoutDecider = (exchanges[0]?.request.params?.["_meta"] as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
    expect(withoutDecider).toEqual({});

    const speaking = new AtlasConsumerClient({ transport, credential: "s", elicitation: () => ({ action: "decline" }) });
    await speaking.describeScope();
    const withDecider = (exchanges[2]?.request.params?.["_meta"] as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY];
    expect(withDecider).toEqual({ elicitation: {} });
  });

  it("refuses to let a caller declare elicitation it cannot service", async () => {
    const { transport, exchanges } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(scopeResult())
    );
    // A capability advertised without a decider behind it produces a request
    // nobody can answer, and the caller waits on it. The option cannot express
    // that: `elicitation` is derived from the decider, last, and wins.
    const client = new AtlasConsumerClient({ transport, credential: "s", capabilities: { elicitation: {} } });
    await client.describeScope();
    expect((exchanges[0]?.request.params?.["_meta"] as Record<string, unknown>)[CLIENT_CAPABILITIES_META_KEY]).toEqual({});
  });
});

describe("protocol version negotiation", () => {
  it("retries once with a revision the server named, then succeeds", async () => {
    const seen: string[] = [];
    let refuse = true;
    const { transport } = scriptedTransport((request) => {
      const meta = request.params?.["_meta"] as Record<string, unknown>;
      seen.push(String(meta[PROTOCOL_VERSION_META_KEY]));
      if (refuse) {
        refuse = false;
        // The shape a rewriting proxy produces: the server refused a revision it
        // does in fact serve, and names that same revision in `supported`,
        // because what reached it was not what the client sent. The client's own
        // bytes were correct and one retry is exactly the remedy — a refusal
        // would send the caller looking for a version mismatch that is not there.
        return {
          error: {
            code: -32022,
            message: "Unsupported protocol version",
            data: { supported: [CONTRACT_PROTOCOL_VERSION], requested: "mangled-by-something-in-between" }
          }
        };
      }
      return discoverResult();
    });

    const client = new AtlasConsumerClient({ transport, credential: "s" });
    const description = await client.discover();

    expect(description.supportedVersions).toEqual([CONTRACT_PROTOCOL_VERSION]);
    // Exactly two attempts. The budget is spent on the retry itself, so no
    // sequence of replies can produce a third.
    expect(seen).toEqual([CONTRACT_PROTOCOL_VERSION, CONTRACT_PROTOCOL_VERSION]);
  });

  it("retries at most once, however many times the server answers -32022", async () => {
    let attempts = 0;
    const { transport } = scriptedTransport(() => {
      attempts += 1;
      return {
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: [CONTRACT_PROTOCOL_VERSION], requested: CONTRACT_PROTOCOL_VERSION }
        }
      };
    });
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    await expect(client.discover()).rejects.toBeInstanceOf(AtlasProtocolMismatch);
    // A server stuck in this state must not be able to hold a caller in a loop.
    expect(attempts).toBe(2);
  });

  it("names both sets when there is no revision in common", async () => {
    const { transport } = scriptedTransport(() => ({
      error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2025-06-18"], requested: CONTRACT_PROTOCOL_VERSION } }
    }));
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    await expect(client.discover()).rejects.toMatchObject({
      serverSupports: ["2025-06-18"],
      clientSpeaks: [CONTRACT_PROTOCOL_VERSION],
      requested: CONTRACT_PROTOCOL_VERSION
    });
  });

  it("refuses at discovery when the server's supportedVersions hold nothing this client speaks", async () => {
    const { transport } = scriptedTransport(() => discoverResult(["2025-06-18", "2025-11-25"]));
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    // Discovered rather than deferred to the first tool call, where a mismatch
    // arrives as an unexplained refusal with no version in it.
    await expect(client.discover()).rejects.toBeInstanceOf(AtlasProtocolMismatch);
  });
});

describe("result classification", () => {
  it("refuses a tool result that carries no resultType", async () => {
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover"
        ? discoverResult()
        : { content: [{ type: "text", text: "{}" }], structuredContent: scopeResult() }
    );
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    // Guessing `complete` here is what would let an escalation be read as an
    // answer, so the missing field is a refusal rather than a default.
    await expect(client.describeScope()).rejects.toBeInstanceOf(AtlasContractViolation);
  });

  it("refuses a result that fails the tool's own published output schema", async () => {
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover"
        ? discoverResult()
        : toolResult(scopeResult({ sensitivity_ceiling: "open" }))
    );
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    const failure = await client.describeScope().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasContractViolation);
    expect((failure as AtlasContractViolation).direction).toBe("output");
  });

  it("turns a typed atlas.error:v1 in a tool error into a refusal carrying the whole record", async () => {
    const record = {
      record_schema: "atlas.error:v1",
      code: "as-of-before-history-floor",
      message: "Atlas retains no belief-time history that far back.",
      retryable: false,
      details: { bitemporal_since: "2026-01-01T00:00:00.000Z" }
    };
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover"
        ? discoverResult()
        : { resultType: "complete", content: [{ type: "text", text: JSON.stringify(record) }], isError: true }
    );
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    const failure = await client.queryAssertions({ as_of_recorded: "2020-01-01T00:00:00.000Z" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasToolRefusal);
    // The record travels whole, `retryable` included. A caller branches on the
    // code; it never pattern-matches the message.
    expect((failure as AtlasToolRefusal).code).toBe("as-of-before-history-floor");
    expect((failure as AtlasToolRefusal).retryable).toBe(false);
    expect((failure as AtlasToolRefusal).record.details).toEqual({ bitemporal_since: "2026-01-01T00:00:00.000Z" });
  });

  it("validates an in-contract result even when it is flagged isError", async () => {
    // A declined reveal is a full contract payload that happens to be flagged.
    // It is the shape most likely to drift, because it is the one nothing else
    // checks — so it goes through the output schema like everything else.
    const structured = {
      outcome: "refused",
      error: { record_schema: "atlas.error:v1", code: "reveal-declined", message: "The owner did not approve.", retryable: false },
      audit: { event_id: "la_audit_synthetic", recorded_at: "2026-08-04T12:00:00.000Z" },
      horizon: scopeResult()["horizon"]
    };
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(structured, { isError: true })
    );
    const client = new AtlasConsumerClient({ transport, credential: "s", elicitation: () => ({ action: "decline" }) });

    const result = await client.revealSensitive({ redaction_id: "la_redaction_synthetic", reason: "checking" });
    expect(result.outcome).toBe("refused");
    expect(result.error?.code).toBe("reveal-declined");
  });

  it("refuses arguments the published input schema rejects, before anything is sent", async () => {
    const { transport, exchanges } = scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : toolResult(scopeResult())
    );
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    const failure = await client
      // `additionalProperties: false` on the published input schema. A round
      // trip that was always going to be refused spends an audit event on the
      // server and tells the caller less than this does.
      .queryAssertions({ subject_entity_id: "la_entity_x", nonsense: true } as never)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasContractViolation);
    expect((failure as AtlasContractViolation).direction).toBe("input");
    // Discovery went out; the tool call did not.
    expect(exchanges.map((exchange) => exchange.request.method)).toEqual(["server/discover"]);
  });
});

describe("the -32021 capability refusal", () => {
  it("carries the required capabilities and the payload the server built", async () => {
    const carried = {
      outcome: "refused",
      error: {
        record_schema: "atlas.error:v1",
        code: "capability-required",
        message: "needs an owner decision",
        retryable: false,
        jsonrpc_code: -32021,
        required_capabilities: ["elicitation"]
      },
      audit: { event_id: "la_audit_synthetic", recorded_at: "2026-08-04T12:00:00.000Z" }
    };
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover"
        ? discoverResult()
        : { error: { code: -32021, message: "missing capability", data: { requiredCapabilities: { elicitation: {} }, result: carried } } }
    );
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    const failure = await client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasCapabilityRequired);
    expect((failure as AtlasCapabilityRequired).requiredCapabilities).toEqual({ elicitation: {} });
    // The audit receipt the reveal contract promises on every outcome survives
    // the change of channel. Dropping `data.result` would lose it.
    expect((failure as AtlasCapabilityRequired).result?.["audit"]).toEqual(carried.audit);
    expect((failure as AtlasCapabilityRequired).record?.code).toBe("capability-required");
  });
});

describe("the multi-round-trip escalation", () => {
  function revealFixture(decision: "accept" | "decline") {
    const revealed = {
      outcome: "revealed",
      record: {
        record_schema: "atlas.entity:v1",
        entity_id: "la_entity_0123456789abcdefghijklmnop",
        type: "person",
        display_name: "Synthetic Person",
        also_known_as: [],
        registered_at: "2026-08-04T12:00:00.000Z",
        updated_at: "2026-08-04T12:00:00.000Z",
        provenance: { client_id: "fixture", origin: "owner-authored", recorded_at_fidelity: "authoritative" },
        sensitivity: { tier: "sealed", rank: 90, withheld: true }
      },
      audit: { event_id: "la_audit_synthetic", recorded_at: "2026-08-04T12:00:00.000Z" },
      horizon: scopeResult()["horizon"]
    };

    const calls: Record<string, unknown>[] = [];
    const { transport } = scriptedTransport((request) => {
      if (request.method === "server/discover") return discoverResult();
      const params = request.params ?? {};
      calls.push(params);
      if (params["requestState"] === undefined) {
        return {
          resultType: "input_required",
          requestState: "v1.synthetic-state.mac",
          inputRequests: {
            "la_reveal_synthetic": {
              method: "elicitation/create",
              params: { message: "Disclose the withheld entity?", requestedSchema: { type: "object" } }
            }
          }
        };
      }
      const answers = params["inputResponses"] as Record<string, { action: string }>;
      if (answers?.["la_reveal_synthetic"]?.action !== "accept") {
        return toolResult({
          outcome: "refused",
          error: { record_schema: "atlas.error:v1", code: "reveal-declined", message: "declined", retryable: false },
          audit: revealed.audit,
          horizon: revealed.horizon
        });
      }
      return toolResult(revealed);
    });

    const client = new AtlasConsumerClient({
      transport,
      credential: "s",
      elicitation: () => (decision === "accept" ? { action: "accept", content: { approve: true } } : { action: "decline" })
    });
    return { client, calls };
  }

  it("carries the owner's approval back on the same signed state and discloses the record", async () => {
    const { client, calls } = revealFixture("accept");
    const result = await client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking a citation" });

    expect(result.outcome).toBe("revealed");
    expect(result.record?.record_schema).toBe("atlas.entity:v1");
    // The state is echoed VERBATIM, and the answer is filed under the request id
    // the server chose. Inventing either is how an approval ends up authorising
    // something nobody approved.
    expect(calls[1]?.["requestState"]).toBe("v1.synthetic-state.mac");
    expect(calls[1]?.["inputResponses"]).toEqual({ "la_reveal_synthetic": { action: "accept", content: { approve: true } } });
  });

  it("discloses nothing when the owner declined", async () => {
    const { client } = revealFixture("decline");
    const result = await client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking a citation" });

    expect(result.outcome).toBe("refused");
    expect(result.record).toBeUndefined();
    expect(result.error?.code).toBe("reveal-declined");
  });

  it("never asks call() to guess an owner decision", async () => {
    const { transport } = scriptedTransport((request) =>
      request.method === "server/discover"
        ? discoverResult()
        : { resultType: "input_required", requestState: "v1.s.m", inputRequests: { a: { method: "elicitation/create", params: {} } } }
    );
    const client = new AtlasConsumerClient({ transport, credential: "s", elicitation: () => ({ action: "accept" }) });

    // `call()` is the generic path and has no business inventing an answer, so
    // it points at the method that carries one instead of silently accepting.
    await expect(client.call("atlas.sensitive.reveal.v1", { redaction_id: "x", reason: "y" })).rejects.toThrow(/revealSensitive/);
  });
});

describe("an escalation from a server that is not behaving", () => {
  /**
   * `inputRequests` is the one server-controlled input that reaches a human.
   *
   * Every entry in it is handed to the host's owner-approval UI. The `-32021`
   * MUST stops a CONFORMANT server sending a kind the client never declared;
   * nothing stops a compromised or hostile one, so the client checks — and until
   * it did, a scripted server drove the decider of a client that had declared
   * only `{ elicitation: {} }` with a `sampling/createMessage` request, and the
   * owner was asked to approve a blank prompt because `params.message` does not
   * exist on that shape.
   */
  function hostileEscalation(inputRequests: Record<string, unknown>, requestState = "v1.s.m"): AtlasTransport {
    return scriptedTransport((request) =>
      request.method === "server/discover" ? discoverResult() : { resultType: "input_required", requestState, inputRequests }
    ).transport;
  }

  /** Records every request the decider was asked to answer. Should stay empty. */
  function recordingClient(transport: AtlasTransport): { client: AtlasConsumerClient; seen: string[] } {
    const seen: string[] = [];
    const client = new AtlasConsumerClient({
      transport,
      credential: "s",
      elicitation: (request) => {
        seen.push(request.method);
        return { action: "accept", content: { approve: true } };
      }
    });
    return { client, seen };
  }

  it("refuses a sampling request rather than driving the owner-approval UI with it", async () => {
    const { client, seen } = recordingClient(
      hostileEscalation({
        k: { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "x" } }] } }
      })
    );

    const failure = await client
      .revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasContractViolation);
    expect((failure as AtlasContractViolation).errors.join(" ")).toContain("sampling/createMessage");
    // The decider was never reached, so no human was ever asked.
    expect(seen).toEqual([]);
  });

  it("refuses a roots/list request the same way", async () => {
    const { client, seen } = recordingClient(hostileEscalation({ k: { method: "roots/list", params: {} } }));

    await expect(client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" })).rejects.toBeInstanceOf(
      AtlasContractViolation
    );
    expect(seen).toEqual([]);
  });

  it("reports rather than silently skips, so a probe for a confused deputy is visible", async () => {
    // A dropped entry would leave the client retrying with an answer nobody
    // asked for and the caller none the wiser — the server would learn nothing
    // happened and try the next shape.
    const { client, seen } = recordingClient(
      hostileEscalation({
        good: { method: "elicitation/create", params: { message: "approve?" } },
        bad: { method: "sampling/createMessage", params: {} }
      })
    );

    await expect(client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" })).rejects.toBeInstanceOf(
      AtlasContractViolation
    );
    expect(seen).toEqual([]);
  });

  it("refuses a requestState too large to be one of ours rather than echoing it back", async () => {
    // The state is ECHOED on the retry, so an unbounded one is memory here and a
    // request body there, for free. A real signed envelope is a few hundred
    // characters.
    const enormous = "v1.".padEnd(MAX_REQUEST_STATE_LENGTH + 1, "A");
    const { client, seen } = recordingClient(
      hostileEscalation({ k: { method: "elicitation/create", params: { message: "approve?" } } }, enormous)
    );

    const failure = await client
      .revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AtlasContractViolation);
    expect((failure as AtlasContractViolation).errors.join(" ")).toContain(String(MAX_REQUEST_STATE_LENGTH));
    expect(seen).toEqual([]);
  });

  it("still accepts a state right at the ceiling, so the bound is not a rounding error", async () => {
    const atLimit = "v1.".padEnd(MAX_REQUEST_STATE_LENGTH, "A");
    const { client, seen } = recordingClient(
      hostileEscalation({ k: { method: "elicitation/create", params: { message: "approve?" } } }, atLimit)
    );

    // The second round is answered with the same escalation, so this ends in the
    // one-round refusal rather than a result — which is exactly the point: the
    // state was accepted and carried, and the failure is about rounds, not size.
    await expect(client.revealSensitive({ redaction_id: "la_redaction_x", reason: "checking" })).rejects.toThrow(
      /exactly one round/
    );
    expect(seen).toEqual(["elicitation/create"]);
  });
});

describe("paging", () => {
  it("continues a read only with the cursor and its snapshot together", () => {
    expect(AtlasConsumerClient.nextPage({ page_size: 2, has_more: false, cursor: null })).toBeUndefined();
    // A cursor with no pin is answered against newer state, and the page
    // sequence silently skips and repeats rows. There is no shape of this
    // function that returns one without the other.
    expect(AtlasConsumerClient.nextPage({ page_size: 2, has_more: true, cursor: "c1" })).toBeUndefined();
    expect(AtlasConsumerClient.nextPage({ page_size: 2, has_more: true, cursor: "c1", snapshot: "s1" })).toEqual({
      cursor: "c1",
      snapshot: "s1"
    });
  });
});

describe("an unexpected JSON-RPC error", () => {
  it("keeps the code and data rather than flattening them into a message", async () => {
    const { transport } = scriptedTransport(() => ({ error: { code: -32601, message: "Method not found", data: { method: "atlas.ops.x" } } }));
    const client = new AtlasConsumerClient({ transport, credential: "s" });

    const failure = await client.discover().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AtlasProtocolError);
    expect((failure as AtlasProtocolError).code).toBe(-32601);
    expect((failure as AtlasProtocolError).data).toEqual({ method: "atlas.ops.x" });
  });
});
