import { afterEach, describe, expect, it } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/server";
import { redactionId } from "./access.js";
import {
  CONSUMER_PRINCIPAL,
  callTool,
  envelope,
  seedWithheldAssertion,
  startHarness,
  syntheticGraph,
  withGrant,
  type Harness
} from "./testing.js";
import type { Principal } from "./principal.js";

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

/** Build a graph holding one sealed assertion, and the stub id the consumer will see. */
function sealedFixture(principal: Principal = CONSUMER_PRINCIPAL): { graph: ReturnType<typeof syntheticGraph>; stubId: string } {
  const graph = syntheticGraph();
  seedWithheldAssertion(graph);
  const page = graph.assertions.query({});
  if (!page.ok) throw new Error("the fixture query hit the history floor");
  const sealed = page.hits.find((hit) => hit.assertion.sensitivity.withheld);
  if (!sealed) throw new Error("the fixture holds no withheld assertion");
  return { graph, stubId: redactionId(sealed.assertion.assertion_id, principal) };
}

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

describe("a withheld record", () => {
  it("occupies its row as a redaction stub rather than being dropped", async () => {
    const { graph } = sealedFixture();
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: {} }));
    const response = await client.await(1);
    const results = structured(response)["results"] as Record<string, unknown>[];

    const stubs = results.filter((record) => record["record_schema"] === "atlas.redaction:v1");
    expect(stubs).toHaveLength(1);
    expect(stubs[0]).toMatchObject({ reveal_available: true, reveal_tool: "atlas.sensitive.reveal.v1" });
    // Counts reconcile: the row is present AND counted as withheld, so a
    // filtered graph is never indistinguishable from a complete one.
    expect(structured(response)["coverage"]).toMatchObject({ returned: results.length, withheld: 1 });
  });
});

describe("atlas.sensitive.reveal.v1", () => {
  it("returns input_required with an elicitation when the client advertises the capability", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    client.send(
      callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "checking a citation" } })
    );
    const response = await client.await(1);

    expect(response.result?.["resultType"]).toBe("input_required");
    expect(typeof response.result?.["requestState"]).toBe("string");
    const requests = response.result?.["inputRequests"] as Record<string, { method: string; params: Record<string, unknown> }>;
    const entries = Object.values(requests);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.method).toBe("elicitation/create");
    expect(String(entries[0]?.params["message"])).toContain("checking a citation");
  });

  it("answers -32021 on the wire when the client advertises no elicitation", async () => {
    const { graph, stubId } = sealedFixture();
    const { client, auditJournal } = harness({ graph });

    client.send(
      callTool({
        id: 1,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "checking a citation" },
        meta: envelope({ [CLIENT_CAPABILITIES_META_KEY]: {} })
      })
    );
    const response = await client.await(1);

    // Not an input_required: a server MUST NOT send an inputRequest type the
    // client never declared, because nobody would be able to answer it. And not
    // a tool RESULT either — the spec requires a JSON-RPC error, because that
    // is the only form a conformant client can branch on. A result carrying the
    // number in a field is a number nobody reads.
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(-32021);

    const data = response.error?.data as Record<string, unknown>;
    // `ClientCapabilities` shape, per the spec's own `data` member — not a
    // list of names.
    expect(data["requiredCapabilities"]).toEqual({ elicitation: {} });

    // Nothing is lost by the change of channel: the typed record and the audit
    // receipt the tool's own contract requires on every outcome ride along.
    const payload = data["result"] as Record<string, unknown>;
    expect(payload["outcome"]).toBe("refused");
    expect(payload["error"]).toMatchObject({
      record_schema: "atlas.error:v1",
      code: "capability-required",
      jsonrpc_code: -32021,
      required_capabilities: ["elicitation"]
    });
    // The audit receipt is returned even on a refusal: an audit trail a
    // consumer does not know exists is one it cannot reason about.
    expect(payload["audit"]).toMatchObject({ event_id: expect.stringMatching(/^la_audit_/) });
    expect(auditJournal.events).toHaveLength(1);
    expect(auditJournal.events[0]).toMatchObject({ outcome: "refused", reason_code: "capability-required" });
    expect((payload["audit"] as Record<string, unknown>)["event_id"]).toBe(auditJournal.events[0]?.event_id);
  });

  it("discloses the record when the retry carries a valid state and the owner accepted", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;
    const requestId = Object.keys(first.result?.["inputRequests"] as Record<string, unknown>)[0];
    expect(requestId).toBeDefined();

    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: state, inputResponses: { [requestId as string]: { action: "accept", content: { approve: true } } } }
      })
    );
    const second = await client.await(2);

    const payload = structured(second);
    expect(payload["outcome"]).toBe("revealed");
    expect(payload["record"]).toMatchObject({ record_schema: "atlas.assertion:v1", predicate: "medical-note" });
  });

  it("refuses a tampered requestState before the handler ever runs", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;
    const requestId = Object.keys(first.result?.["inputRequests"] as Record<string, unknown>)[0] as string;

    // Flip the last three characters of the MAC. Everything else is byte-identical.
    const tampered = `${state.slice(0, -3)}AAA`;
    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: tampered, inputResponses: { [requestId]: { action: "accept", content: { approve: true } } } }
      })
    );
    const second = await client.await(2);

    expect(second.result).toBeUndefined();
    expect(second.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
  });

  it("refuses a forged requestState whose payload was written by hand", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    const body = Buffer.from(
      JSON.stringify({ p: { request_id: "forged", redaction_id: stubId }, exp: 9999999999 }),
      "utf8"
    ).toString("base64url");
    client.send(
      callTool({
        id: 1,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: `v1.${body}.AAAA` }
      })
    );
    const response = await client.await(1);
    expect(response.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
  });

  it("refuses a forged request_state supplied as a tool ARGUMENT, not only on the protocol channel", async () => {
    const { graph, stubId } = sealedFixture();
    const { client, auditJournal } = harness({ graph });

    // The argument channel is a published INPUT field, so the SDK's
    // `requestState.verify` hook never sees it — to the SDK it is an ordinary
    // string. A verification enforced on one channel and not the other is not
    // enforced, so this forgery is exactly the shape that would slip through.
    const body = Buffer.from(
      JSON.stringify({ p: { request_id: "forged", redaction_id: stubId }, exp: 9999999999 }),
      "utf8"
    ).toString("base64url");

    client.send(
      callTool({
        id: 1,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why", request_state: `v1.${body}.AAAA` }
      })
    );
    const response = await client.await(1);

    expect(response.result?.["isError"]).toBe(true);
    const error = JSON.parse(String((response.result?.["content"] as { text: string }[])[0]?.text)) as Record<string, unknown>;
    expect(error).toMatchObject({ code: "invalid-request-state", jsonrpc_code: -32602 });
    // Nothing was disclosed and nothing was escalated, so no event was written.
    expect(auditJournal.events).toHaveLength(0);
  });

  it("refuses a valid state that was minted for a different record", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;

    // Genuine, unexpired, correctly bound to this principal and method — and
    // pointed at another object. Only the in-handler object check catches this.
    const other = redactionId("la_assertion_00000000000000000000000000", CONSUMER_PRINCIPAL);
    graph.assertions.commit({
      client_id: "fixture",
      idempotency_key: "second-sealed",
      drafts: [
        {
          kind: "fact",
          lineage_action: "assert",
          subject_entity_id: graph.entityList[0]?.entity_id ?? "",
          predicate: "medical-note",
          value: "another sealed value",
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "ev-2", stance: "supports" }],
          supersedes: []
        }
      ],
      sensitivity: { tier: "sealed", rank: 90, withheld: true }
    });
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const second = page.hits.filter((hit) => hit.assertion.sensitivity.withheld)[1];
    expect(second).toBeDefined();
    const otherStub = redactionId(second?.assertion.assertion_id ?? other, CONSUMER_PRINCIPAL);

    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: otherStub, reason: "why" },
        extra: { requestState: state }
      })
    );
    const response = await client.await(2);
    expect(structured(response)["error"]).toMatchObject({ code: "request-state-object-mismatch" });
  });

  it("refuses when the owner declined, and discloses nothing", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;
    const requestId = Object.keys(first.result?.["inputRequests"] as Record<string, unknown>)[0] as string;

    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: state, inputResponses: { [requestId]: { action: "decline" } } }
      })
    );
    const response = await client.await(2);
    const payload = structured(response);
    expect(payload["outcome"]).toBe("refused");
    expect(payload["record"]).toBeUndefined();
    expect(payload["error"]).toMatchObject({ code: "reveal-declined" });
  });

  it("refuses a state a DIFFERENT principal echoes, because the binding covers the credential", async () => {
    const { graph, stubId } = sealedFixture();
    let principal: Principal = CONSUMER_PRINCIPAL;
    const { client } = harness({ graph, resolvePrincipal: () => ({ ok: true, principal }) });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;
    const requestId = Object.keys(first.result?.["inputRequests"] as Record<string, unknown>)[0] as string;

    principal = { ...CONSUMER_PRINCIPAL, client_id: "a-different-credential" };
    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: state, inputResponses: { [requestId]: { action: "accept", content: { approve: true } } } }
      })
    );
    const response = await client.await(2);
    expect(response.error).toMatchObject({ code: -32602, data: { reason: "invalid_request_state" } });
  });

  it("never puts key material or plaintext into the state the client holds", async () => {
    const { graph, stubId } = sealedFixture();
    const key = "0123456789abcdef0123456789abcdef";
    const { client } = harness({ graph, revealStateKey: key });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    const state = first.result?.["requestState"] as string;

    expect(state).not.toContain(key);
    // The codec is signed, not encrypted, so the payload is readable. What is
    // readable must therefore be only a redaction id and a request id — never
    // the sealed value, never the credential, never the tier.
    const [, body] = state.split(".");
    const payload = JSON.parse(Buffer.from(body ?? "", "base64url").toString("utf8")) as { p: Record<string, unknown> };
    expect(Object.keys(payload.p).sort()).toEqual(["redaction_id", "request_id"]);
    expect(JSON.stringify(payload)).not.toContain("synthetic sealed value");
    expect(JSON.stringify(payload)).not.toContain(CONSUMER_PRINCIPAL.client_id);
    expect(JSON.stringify(first.result?.["_meta"] ?? {})).not.toContain(key);
  });

  it("offers the escalation in band, with the same signed state, when configured to", async () => {
    const { graph, stubId } = sealedFixture();
    const { client } = harness({ graph, revealEscalationInBand: true });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const response = await client.await(1);

    expect(response.result?.["resultType"]).toBe("complete");
    const payload = structured(response);
    expect(payload["outcome"]).toBe("input-required");
    const request = payload["input_request"] as Record<string, unknown>;
    expect(request).toMatchObject({ required_capabilities: ["elicitation"] });
    expect(String(request["request_state"]).startsWith("v1.")).toBe(true);

    // The same channel a client that will not retry can use: `request_state` is
    // a published INPUT argument, so re-calling the tool needs no protocol
    // support at all.
    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why", request_state: String(request["request_state"]) }
      })
    );
    const second = await client.await(2);
    // No owner answer arrived with it, so nothing is disclosed — but the state
    // itself verified, which is what this asserts.
    expect(structured(second)["error"]).toMatchObject({ code: "owner-decision-missing" });
  });

  it("refuses outright for a credential that may never unlock anything", async () => {
    const principal: Principal = withGrant(CONSUMER_PRINCIPAL, { reveal_available: false });
    const { graph, stubId } = sealedFixture(principal);
    const { client } = harness({ graph, principal });

    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const response = await client.await(1);
    expect(structured(response)["error"]).toMatchObject({ code: "reveal-not-available" });
  });
});
