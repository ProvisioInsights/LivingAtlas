import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { decideAssertion, maySupersede, redactionId } from "./access.js";
import { bucketCount } from "./principal.js";
import {
  CONSUMER_PRINCIPAL,
  callTool,
  seedAssertions,
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

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

function firstWithheld(graph: ReturnType<typeof syntheticGraph>) {
  const page = graph.assertions.query({});
  if (!page.ok) throw new Error("fixture query hit the floor");
  const hit = page.hits.find((candidate) => candidate.assertion.sensitivity.withheld);
  if (!hit) throw new Error("fixture holds no withheld assertion");
  return hit.assertion;
}

describe("the access decision", () => {
  it("withholds a record above the ceiling and returns a stub instead", () => {
    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const decision = decideAssertion(firstWithheld(graph), CONSUMER_PRINCIPAL);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.stub.record_schema).toBe("atlas.redaction:v1");
    expect(decision.stub.sensitivity.withheld).toBe(true);
  });

  it("does not let a high ceiling override a record the graph marked withheld", () => {
    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const owner: Principal = withGrant(
      { ...CONSUMER_PRINCIPAL, credential_class: "owner" },
      { sensitivity_reachable: [{ tier: "open", rank: 0 }, { tier: "sealed", rank: 1000 }] }
    );
    // `withheld` is the graph's own statement that this content is not for the
    // consumer plane. Unlocking it goes through the reveal path, which writes an
    // audit event — never through a ceiling high enough to make the mark moot.
    expect(decideAssertion(firstWithheld(graph), owner).allowed).toBe(false);
  });

  it("gives a different stub id to a different credential for the same record", () => {
    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const record = firstWithheld(graph);
    const mine = redactionId(record.assertion_id, CONSUMER_PRINCIPAL);
    const theirs = redactionId(record.assertion_id, { ...CONSUMER_PRINCIPAL, client_id: "someone-else" });
    expect(mine).not.toBe(theirs);
    // And the withheld record's own id never appears inside the stub id, because
    // an identifier is frequently the sensitive part.
    expect(mine).not.toContain(record.assertion_id);
  });

  it("narrows what a far-above-ceiling stub discloses about itself", () => {
    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const decision = decideAssertion(firstWithheld(graph), CONSUMER_PRINCIPAL);
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    // rank 90 against a ceiling of 0: naming the record KIND would itself be a
    // signal about what is being hidden.
    expect(decision.stub.disclosure_level).toBe("existence-only");
    expect(decision.stub.withheld_record_schema).toBe("atlas.withheld:v1");
  });
});

describe("supersession scope", () => {
  it("permits a credential to supersede only what it authored", () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 1, CONSUMER_PRINCIPAL.client_id);
    seedAssertions(graph, 1, "another-consumer");
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const [mine, theirs] = page.hits.map((hit) => hit.assertion);
    expect(mine).toBeDefined();
    expect(theirs).toBeDefined();
    if (!mine || !theirs) return;

    expect(maySupersede(mine, CONSUMER_PRINCIPAL)).toBe(true);
    expect(maySupersede(theirs, CONSUMER_PRINCIPAL)).toBe(false);
    expect(maySupersede(theirs, withGrant(CONSUMER_PRINCIPAL, { supersession_scope: "any" }))).toBe(true);
  });

  it("refuses a proposal that supersedes another credential's assertion", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 1, "another-consumer");
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const theirs = page.hits[0]?.assertion;
    expect(theirs).toBeDefined();
    if (!theirs) return;

    const { client, auditJournal } = harness({ graph });
    client.send(
      callTool({
        id: 1,
        name: "atlas.assertion.propose.v1",
        args: {
          idempotency_key: "retract-theirs",
          proposals: [
            {
              kind: "fact",
              lineage_action: "retract",
              subject_entity_id: theirs.subject_entity_id,
              predicate: theirs.predicate,
              confidence: { band: "high" },
              evidence_links: [{ evidence_id: "e1", stance: "contradicts" }],
              supersedes: [theirs.assertion_id]
            }
          ]
        }
      })
    );
    const response = await client.await(1);

    expect(response.result?.["isError"]).toBe(true);
    expect(JSON.parse(String((response.result?.["content"] as { text: string }[])[0]?.text))).toMatchObject({
      code: "supersession-not-permitted"
    });
    // Nothing was written to the graph, and the attempt is still on the record.
    expect(graph.assertions.size).toBe(1);
    expect(auditJournal.events[0]).toMatchObject({ outcome: "refused", reason_code: "supersession-not-permitted" });
  });
});

describe("coverage counting", () => {
  it("buckets a bucketed credential's counts upward, and leaves zero at zero", () => {
    expect(bucketCount(0)).toBe(0);
    expect(bucketCount(1)).toBe(10);
    expect(bucketCount(10)).toBe(10);
    expect(bucketCount(11)).toBe(20);
  });

  it("reports a bucketed basis to the caller rather than letting it assume exactness", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 7);
    const principal: Principal = withGrant(CONSUMER_PRINCIPAL, { coverage_counts_basis: "bucketed" });
    const { client } = harness({ graph, principal });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: {} }));
    const response = await client.await(1);
    const page = structured(response)["coverage"] as Record<string, unknown>;

    expect(page["counts_basis"]).toBe("bucketed");
    expect(page["bucket_width"]).toBe(10);
    expect(page["evaluated"]).toBe(10);
    // `returned` is the length of an array the caller is holding. Rounding it
    // would make the result contradict itself.
    expect(page["returned"]).toBe(7);
  });

  it("tells a credential what it can reach rather than making it infer scope from refusals", async () => {
    const { client } = harness();
    client.send(callTool({ id: 1, name: "atlas.scope.describe.v1" }));
    const response = await client.await(1);
    expect(structured(response)).toMatchObject({
      client_id: CONSUMER_PRINCIPAL.client_id,
      credential_class: "consumer",
      plane: "consumer",
      supersession_scope: "own-client-id",
      coverage_counts_basis: "exact",
      tools_available: [...CONTRACT_TOOL_NAMES],
      declared_client_capabilities: ["elicitation"]
    });
  });
});
