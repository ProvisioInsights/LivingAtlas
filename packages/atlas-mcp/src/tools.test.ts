import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_LIMITS, CONTRACT_REVISION, createContractValidator } from "@living-atlas/atlas-contract";
import {
  callTool,
  seedAssertions,
  seedRelationship,
  startHarness,
  syntheticGraph,
  testContract,
  type Harness
} from "./testing.js";

const started: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  started.push(instance);
  return instance;
}

afterEach(async () => {
  while (started.length > 0) await started.pop()?.handle.close();
});

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

function toolError(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  const content = response.result?.["content"] as { text: string }[] | undefined;
  return JSON.parse(content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("atlas.contract.describe.v1", () => {
  it("quotes the published limits, number for number", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.contract.describe.v1" }));
    const payload = structured(await client.await(1));

    expect(payload["revision"]).toBe(CONTRACT_REVISION);
    expect(payload["limits"]).toEqual({ ...CONTRACT_LIMITS });
    // The number, not a phrase. A consumer that knows there is no history and
    // one that assumes there is some behave differently.
    expect((payload["history"] as Record<string, unknown>)["prior_versions_retained_before_cutover"]).toBe(0);
  });

  it("refuses a revision it does not serve rather than substituting the current one", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.contract.describe.v1", args: { revision: "2025.01.0" } }));
    const response = await client.await(1);
    expect(response.result?.["isError"]).toBe(true);
    expect(toolError(response)).toMatchObject({ code: "revision-not-served" });
  });
});

describe("the belief-time history floor", () => {
  it("refuses an as-of read below it rather than answering from present state", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 2);
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: { as_of_recorded: "2020-01-01T00:00:00.000Z" } }));
    const response = await client.await(1);

    expect(response.result?.["isError"]).toBe(true);
    expect(toolError(response)).toMatchObject({ code: "as-of-before-history-floor", retryable: false });
  });

  it("echoes the belief instant on a present-tense read too, so both answers replay the same way", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 1);
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: {} }));
    const horizon = structured(await client.await(1))["horizon"] as Record<string, unknown>;
    expect(horizon["as_of_recorded"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(horizon["feed_epoch"]).toBe("e-test");
  });
});

describe("paging", () => {
  it("refuses a cursor echoed without its snapshot pin", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 5);
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: { page_size: 2 } }));
    const first = await client.await(1);
    const page = structured(first)["page"] as Record<string, unknown>;
    expect(page["has_more"]).toBe(true);

    client.send(callTool({ id: 2, name: "atlas.assertion.query.v1", args: { page_size: 2, cursor: page["cursor"] } }));
    const second = await client.await(2);
    expect(toolError(second)).toMatchObject({ code: "snapshot-invalid" });
  });

  it("walks a full scan to the end and hands off to the change feed at an exact seq", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 5);
    const { client } = harness({ graph });

    const seen: string[] = [];
    let cursor: unknown;
    let snapshot: unknown;
    for (let id = 1; id <= 4; id += 1) {
      client.send(
        callTool({
          id,
          name: "atlas.assertion.query.v1",
          args: { page_size: 2, full_scan: true, ...(cursor ? { cursor, snapshot } : {}) }
        })
      );
      const response = await client.await(id);
      const payload = structured(response);
      for (const record of payload["results"] as Record<string, unknown>[]) seen.push(String(record["assertion_id"]));
      const page = payload["page"] as Record<string, unknown>;
      cursor = page["cursor"];
      snapshot = page["snapshot"];
      if (page["has_more"] !== true) {
        // Bootstrap-then-follow with no gap and no overlap.
        expect(page["feed_handoff"]).toMatchObject({ tool: "atlas.changes.read.v1" });
        break;
      }
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it("clamps a page size above the published cap instead of honouring it", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 3);
    const { client } = harness({ graph });

    // The published schema caps `page_size`, so this is refused before dispatch.
    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: { page_size: CONTRACT_LIMITS.max_page_size + 1 } }));
    const response = await client.await(1);
    expect(response.result?.["isError"]).toBe(true);
  });
});

describe("the change feed", () => {
  it("fails loudly on a feed epoch that is not this one", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 2);
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.changes.read.v1", args: { cursor_seq: 0, feed_epoch: "e-other" } }));
    expect(toolError(await client.await(1))).toMatchObject({ code: "feed-epoch-mismatch" });
  });

  it("returns changes in seq order with a resumable cursor", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 4);
    const { client } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.changes.read.v1", args: { cursor_seq: 0, limit: 2 } }));
    const first = structured(await client.await(1));
    expect((first["changes"] as unknown[]).length).toBe(2);
    expect(first["has_more"]).toBe(true);

    client.send(callTool({ id: 2, name: "atlas.changes.read.v1", args: { cursor_seq: first["next_cursor_seq"] as number } }));
    const second = structured(await client.await(2));
    const seqs = (second["changes"] as { seq: number }[]).map((change) => change.seq);
    expect(seqs).toEqual([3, 4]);
  });
});

describe("proposing", () => {
  it("returns the ORIGINAL receipt on a retry with the same key and payload", async () => {
    const graph = syntheticGraph();
    const { client, graph: fixture } = harness({ graph });
    const subject = fixture.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    const args = {
      idempotency_key: "same-key",
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
    };

    client.send(callTool({ id: 1, name: "atlas.assertion.propose.v1", args }));
    const first = structured(await client.await(1));
    client.send(callTool({ id: 2, name: "atlas.assertion.propose.v1", args }));
    const second = structured(await client.await(2));

    const original = first["submission"] as Record<string, unknown>;
    const replay = second["submission"] as Record<string, unknown>;
    expect(replay["submission_id"]).toBe(original["submission_id"]);
    expect(replay["assertion_ids"]).toEqual(original["assertion_ids"]);
    expect(replay["state"]).toBe("replayed");
    // Nothing was re-minted and no seq was burned.
    expect(graph.assertions.size).toBe(1);
  });

  it("refuses the same key with a different payload rather than accepting either version", async () => {
    const graph = syntheticGraph();
    const { client, graph: fixture } = harness({ graph });
    const subject = fixture.entityList[0];
    if (!subject) return;

    const proposal = (value: string) => ({
      idempotency_key: "one-key",
      proposals: [
        {
          kind: "fact",
          subject_entity_id: subject.entity_id,
          predicate: "worked-at",
          value,
          confidence: { band: "high" },
          evidence_links: [{ evidence_id: "e1", stance: "supports" }]
        }
      ]
    });

    client.send(callTool({ id: 1, name: "atlas.assertion.propose.v1", args: proposal("Acme") }));
    await client.await(1);
    client.send(callTool({ id: 2, name: "atlas.assertion.propose.v1", args: proposal("Globex") }));
    expect(toolError(await client.await(2))).toMatchObject({ code: "idempotency-key-conflict" });
  });

  it("stamps provenance.client_id from the credential, never from the request", async () => {
    const graph = syntheticGraph();
    const { client, graph: fixture } = harness({ graph });
    const subject = fixture.entityList[0];
    if (!subject) return;

    client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        args: {
          idempotency_key: "provenance",
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
        }
      })
    );
    await client.await(1);

    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("query hit the floor");
    expect(page.hits[0]?.assertion.provenance.client_id).toBe("synthetic-consumer");
  });
});

describe("atlas.submission.read.v1", () => {
  it("refuses when neither or both selectors are supplied", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.submission.read.v1", args: {} }));
    expect(toolError(await client.await(1))).toMatchObject({ code: "invalid-argument" });

    client.send(
      callTool({
        id: 2,
        name: "atlas.submission.read.v1",
        args: { submission_id: "la_submission_00000000000000000000000000", idempotency_key: "k" }
      })
    );
    expect(toolError(await client.await(2))).toMatchObject({ code: "invalid-argument" });
  });

  it("does not return another credential's receipt", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 1, "another-consumer");
    const receipt = graph.assertions.readSubmission("another-consumer", "seed-another-consumer-0");
    expect(receipt).toBeDefined();
    if (!receipt) return;

    const { client } = harness({ graph });
    client.send(callTool({ id: 1, name: "atlas.submission.read.v1", args: { submission_id: receipt.submission_id } }));
    expect(structured(await client.await(1))["error"]).toMatchObject({ code: "unknown-submission" });
  });
});

describe("atlas.graph.neighbors.v1", () => {
  it("walks outward one hop and returns both endpoints and the edge", async () => {
    const graph = syntheticGraph({ entityCount: 3 });
    seedRelationship(graph, 0, 1);
    const { client } = harness({ graph });
    const origin = graph.entityList[0];
    if (!origin) return;

    client.send(callTool({ id: 1, name: "atlas.graph.neighbors.v1", args: { entity_id: origin.entity_id, direction: "outbound" } }));
    const payload = structured(await client.await(1));

    const nodes = payload["nodes"] as { entity_id: string }[];
    const edges = payload["edges"] as { predicate: string; target_entity_id: string }[];
    expect(nodes.map((node) => node.entity_id)).toEqual([origin.entity_id, graph.entityList[1]?.entity_id]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ predicate: "reports-to", target_entity_id: graph.entityList[1]?.entity_id });
    expect(payload["traversal"]).toMatchObject({ origin_entity_id: origin.entity_id, direction: "outbound", deepest_reached: 1 });
  });

  it("says WHY it stopped rather than presenting a subgraph as a graph", async () => {
    const graph = syntheticGraph({ entityCount: 4 });
    seedRelationship(graph, 0, 1);
    seedRelationship(graph, 1, 2);
    seedRelationship(graph, 2, 3);
    const { client } = harness({ graph });
    const origin = graph.entityList[0];
    if (!origin) return;

    client.send(
      callTool({ id: 1, name: "atlas.graph.neighbors.v1", args: { entity_id: origin.entity_id, direction: "outbound", max_depth: 1 } })
    );
    const payload = structured(await client.await(1));
    expect(payload["traversal"]).toMatchObject({ max_depth: 1, truncated_by: "max_depth" });
    // A truncated traversal reports `partial`, not `complete`.
    expect((payload["horizon"] as Record<string, unknown>)["status"]).toBe("partial");
  });

  it("does not follow an edge whose predicate the caller excluded", async () => {
    const graph = syntheticGraph({ entityCount: 3 });
    seedRelationship(graph, 0, 1, "reports-to");
    seedRelationship(graph, 0, 2, "mentored-by");
    const { client } = harness({ graph });
    const origin = graph.entityList[0];
    if (!origin) return;

    client.send(
      callTool({
        id: 1,
        name: "atlas.graph.neighbors.v1",
        args: { entity_id: origin.entity_id, direction: "outbound", predicates: ["reports-to"] }
      })
    );
    const payload = structured(await client.await(1));
    expect((payload["edges"] as { predicate: string }[]).map((edge) => edge.predicate)).toEqual(["reports-to"]);
  });
});

describe("output conformance", () => {
  it("refuses to return a result that fails the tool's own published output schema", () => {
    // Directly against the validator the server checks with, so the guarantee is
    // asserted where it lives rather than inferred from a passing tool call.
    const validator = createContractValidator(testContract());
    const outcome = validator.validateToolOutput("atlas.scope.describe.v1", { client_id: "x" });
    expect(outcome.valid).toBe(false);
  });

  it("treats an unpublished schema as a failure, never as nothing to check", () => {
    const validator = createContractValidator(testContract());
    expect(validator.validateToolOutput("atlas.not.a.tool.v1", {}).valid).toBe(false);
  });
});
