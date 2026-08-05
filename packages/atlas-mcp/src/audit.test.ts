import { afterEach, describe, expect, it } from "vitest";
import { CONTRACT_LIMITS, CONTRACT_TOOL_NAMES } from "@living-atlas/atlas-contract";
import { redactionId } from "./access.js";
import { AuditRecorder, MAX_AUDIT_SUBJECTS, MemoryAuditJournal } from "./audit.js";
import {
  CONSUMER_PRINCIPAL,
  callTool,
  fixedClock,
  seedAssertions,
  seedWithheldAssertion,
  startHarness,
  syntheticGraph,
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

describe("the audit log", () => {
  it("writes ONE event per tool call however many assertions the call touched", async () => {
    const graph = syntheticGraph();
    // Well past a page, so a per-object recorder would be obvious: the prior
    // server's `object_list` wrote one event per object inside an unbounded
    // whole-graph loop and reached ~58 MiB on a single call.
    seedAssertions(graph, 400);
    const { client, auditJournal } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: { page_size: 200 } }));
    const response = await client.await(1);
    const payload = response.result?.["structuredContent"] as Record<string, unknown>;

    expect((payload["results"] as unknown[]).length).toBe(200);
    expect((payload["coverage"] as Record<string, number>)["evaluated"]).toBe(400);
    expect(auditJournal.events).toHaveLength(1);

    const event = auditJournal.events[0];
    expect(event).toBeDefined();
    if (!event) return;
    expect(event.tool).toBe("atlas.assertion.query.v1");
    expect(event.counts).toMatchObject({ evaluated: 400, returned: 200 });
    // The counts carry the fact. The ids do not, because listing what a query
    // FOUND is a copy of the graph inside the audit log.
    expect(event.subjects).toEqual([]);
  });

  it("names only ids the CALLER supplied, never ids the graph produced", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 50);
    const { client, auditJournal, graph: fixture } = harness({ graph });
    const subject = fixture.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;

    client.send(callTool({ id: 1, name: "atlas.entity.read.v1", args: { entity_ids: [subject.entity_id] } }));
    await client.await(1);

    const event = auditJournal.events[0];
    expect(event?.subjects).toEqual([subject.entity_id]);
    expect(event?.subjects_truncated).toBe(false);
  });

  it("refuses an over-limit request before any handler, so no event is written for it", async () => {
    const graph = syntheticGraph();
    const { client, auditJournal } = harness({ graph });

    // Deliberately past `max_ids_per_request`. The SDK rejects it against the
    // published input schema, so the call never reaches a handler. This asserts
    // that outer braces and nothing else — the recorder's own cap is exercised
    // directly below, because on this path it is never reached.
    const many = Array.from({ length: CONTRACT_LIMITS.max_ids_per_request + 25 }, (_unused, index) => `id-${index}`);
    client.send(callTool({ id: 1, name: "atlas.entity.resolve.v1", args: { ids: many } }));
    const response = await client.await(1);
    expect(response.result?.["isError"]).toBe(true);
    expect(auditJournal.events).toHaveLength(0);
  });

  it("caps the named ids at the published per-request limit even when the caller exceeds it", () => {
    const journal = new MemoryAuditJournal();
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    // Straight at the recorder, because that is the only path where the cap is
    // load-bearing: the consumer plane's schemas stop an over-long id array at
    // validation, but the operator plane publishes no fetchable schemas, so the
    // moment an operator tool forwards a caller-supplied list this slice is the
    // only bound on how large one event can grow. The measured failure it
    // prevents is an audit log that reached ~58 MiB for a single call and
    // eventually past Node's maximum string length, at which point it stopped
    // being writable at all.
    const many = Array.from({ length: CONTRACT_LIMITS.max_ids_per_request + 25 }, (_unused, index) => `id-${index}`);
    const event = recorder.record({
      tool: "atlas.entity.resolve.v1",
      principal: CONSUMER_PRINCIPAL,
      plane: "consumer",
      protocolVersion: "2026-07-28",
      outcome: "ok",
      counts: {},
      subjects: many,
      args: {}
    });

    expect(MAX_AUDIT_SUBJECTS).toBe(CONTRACT_LIMITS.max_ids_per_request);
    expect(event.subjects).toHaveLength(MAX_AUDIT_SUBJECTS);
    // Truncation is REPORTED, never performed silently: an event that dropped
    // ids without saying so reads as a smaller call than the one that happened.
    expect(event.subjects_truncated).toBe(true);
    expect(event.subjects[0]).toBe("id-0");
    expect(journal.events[0]?.subjects).toHaveLength(MAX_AUDIT_SUBJECTS);
  });

  it("reports subjects_truncated false when the caller stayed inside the cap", () => {
    const journal = new MemoryAuditJournal();
    const recorder = new AuditRecorder({ journal, clock: fixedClock() });

    const event = recorder.record({
      tool: "atlas.entity.read.v1",
      principal: CONSUMER_PRINCIPAL,
      plane: "consumer",
      protocolVersion: "2026-07-28",
      outcome: "ok",
      counts: {},
      subjects: Array.from({ length: MAX_AUDIT_SUBJECTS }, (_unused, index) => `id-${index}`),
      args: {}
    });

    expect(event.subjects).toHaveLength(MAX_AUDIT_SUBJECTS);
    expect(event.subjects_truncated).toBe(false);
  });

  it("records a read as an event, because a read by a remote provider is security-relevant", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 3);
    const { client, auditJournal } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.assertion.query.v1", args: {} }));
    await client.await(1);
    expect(auditJournal.events[0]).toMatchObject({
      tool: "atlas.assertion.query.v1",
      outcome: "ok",
      client_id: CONSUMER_PRINCIPAL.client_id,
      credential_class: "consumer",
      protocol_version: "2026-07-28"
    });
  });

  it("records a refusal, with its reason, and not as a success", async () => {
    const graph = syntheticGraph();
    const { client, auditJournal } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.contract.describe.v1", args: { revision: "1999.01.0" } }));
    await client.await(1);
    expect(auditJournal.events[0]).toMatchObject({ outcome: "refused", reason_code: "revision-not-served" });
  });

  it("records the escalation exactly once, not once for the ask and once for the answer", async () => {
    const graph = syntheticGraph();
    seedWithheldAssertion(graph);
    const page = graph.assertions.query({});
    if (!page.ok) throw new Error("fixture query hit the floor");
    const sealed = page.hits.find((hit) => hit.assertion.sensitivity.withheld);
    expect(sealed).toBeDefined();
    if (!sealed) return;
    const stubId = redactionId(sealed.assertion.assertion_id, CONSUMER_PRINCIPAL);

    const { client, auditJournal } = harness({ graph });
    client.send(callTool({ id: 1, name: "atlas.sensitive.reveal.v1", args: { redaction_id: stubId, reason: "why" } }));
    const first = await client.await(1);
    expect(auditJournal.events).toHaveLength(1);
    expect(auditJournal.events[0]).toMatchObject({ outcome: "input-required", subjects: [stubId] });

    const state = first.result?.["requestState"] as string;
    const requestId = Object.keys(first.result?.["inputRequests"] as Record<string, unknown>)[0] as string;
    client.send(
      callTool({
        id: 2,
        name: "atlas.sensitive.reveal.v1",
        args: { redaction_id: stubId, reason: "why" },
        extra: { requestState: state, inputResponses: { [requestId]: { action: "accept", content: { approve: true } } } }
      })
    );
    await client.await(2);

    // Two calls, two events. The disclosure is its own event with its own
    // counter, so a reveal that happened is distinguishable from one that was
    // only ever asked for.
    expect(auditJournal.events).toHaveLength(2);
    expect(auditJournal.events[1]).toMatchObject({ outcome: "ok", counts: { revealed: 1 } });
  });

  it("puts the arguments in a digest rather than in the log", async () => {
    const graph = syntheticGraph();
    const { client, auditJournal } = harness({ graph });

    client.send(callTool({ id: 1, name: "atlas.text.search.v1", args: { query: "a private search term" } }));
    await client.await(1);

    const event = auditJournal.events[0];
    expect(event?.arguments_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    // A text query is frequently the most sensitive string in a request. It is
    // covered by the digest and appears nowhere in the event.
    expect(JSON.stringify(event)).not.toContain("a private search term");
  });

  it("writes exactly one event for every one of the 12 tools", async () => {
    const graph = syntheticGraph();
    seedAssertions(graph, 2);
    const { client, auditJournal, graph: fixture } = harness({ graph });
    const subject = fixture.entityList[0];
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
        idempotency_key: "audit-k1",
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
      "atlas.submission.read.v1": { idempotency_key: "audit-k1" },
      "atlas.sensitive.reveal.v1": { redaction_id: "la_redaction_absent", reason: "auditing the audit" }
    };

    let id = 200;
    for (const name of CONTRACT_TOOL_NAMES) {
      client.send(callTool({ id, name, args: argumentsByTool[name] ?? {} }));
      await client.await(id);
      id += 1;
    }

    expect(auditJournal.events).toHaveLength(CONTRACT_TOOL_NAMES.length);
    expect(auditJournal.events.map((event) => event.tool)).toEqual([...CONTRACT_TOOL_NAMES]);
    // Every event id is distinct and every belief-time stamp advances, so two
    // events in the same millisecond still order.
    expect(new Set(auditJournal.events.map((event) => event.event_id)).size).toBe(CONTRACT_TOOL_NAMES.length);
    const stamps = auditJournal.events.map((event) => event.recorded_at);
    expect([...stamps].sort()).toEqual(stamps);
  });
});
