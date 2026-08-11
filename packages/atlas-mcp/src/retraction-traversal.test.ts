import { afterEach, describe, expect, it } from "vitest";
import { LINEAGE_ACTION_AFFIRMS_EDGE } from "@living-atlas/atlas-core";
import { callTool, startHarness, syntheticGraph, type Harness, type SyntheticGraph } from "./testing.js";

/**
 * A RETRACTED RELATIONSHIP MUST LEAVE THE TRAVERSAL (#86).
 *
 * The defect these exist for, found by retracting relationships on a live
 * store: `atlas.assertion.query.v1` correctly reported them as superseded, and
 * `atlas.graph.neighbors.v1` went on listing every one of them as a live edge.
 * An entity whose every edge had just been retracted came back with MORE
 * neighbours than before, not fewer.
 *
 * The cause was that the traversal filtered on `kind === "relationship"` and
 * nothing else. A retraction IS a relationship assertion carrying the same
 * subject, predicate and target, because that is how supersession is expressed.
 *
 * That failure mode is the dangerous kind: durable, auditable, and invisible
 * where a person actually looks. So the tests below assert BOTH halves of the
 * guarantee together — gone from the traversal, still readable in the ledger —
 * because either one alone is satisfied by a bug.
 */

const harnesses: Harness[] = [];

function harness(...args: Parameters<typeof startHarness>): Harness {
  const instance = startHarness(...args);
  harnesses.push(instance);
  return instance;
}

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()?.handle.close();
});

const FIXTURE_OPEN = { tier: "open", rank: 0, withheld: false } as const;

/** Commit one relationship between the fixture's first two entities. */
function seedRelationship(graph: SyntheticGraph, predicate = "employed-by"): string {
  const [subject, target] = graph.entityList;
  if (!subject || !target) throw new Error("fixture needs two entities");
  const result = graph.assertions.commit({
    client_id: "fixture",
    idempotency_key: `seed-${predicate}`,
    drafts: [
      {
        kind: "relationship",
        lineage_action: "assert",
        subject_entity_id: subject.entity_id,
        predicate,
        target_entity_id: target.entity_id,
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-1", stance: "supports" }],
        supersedes: []
      }
    ],
    sensitivity: { ...FIXTURE_OPEN }
  });
  if (!result.ok) throw new Error("fixture commit refused");
  const id = result.receipt.assertion_ids[0];
  if (id === undefined) throw new Error("fixture commit produced no assertion");
  return id;
}

/** Supersede it with a record carrying `lineage_action`. */
function supersedeWith(graph: SyntheticGraph, originalId: string, lineageAction: string, predicate = "employed-by"): void {
  const original = graph.assertions.read(originalId as never);
  if (!original) throw new Error("no such assertion");
  const result = graph.assertions.commit({
    client_id: "fixture",
    idempotency_key: `supersede-${lineageAction}-${predicate}`,
    drafts: [
      {
        kind: "relationship",
        lineage_action: lineageAction as never,
        subject_entity_id: original.subject_entity_id,
        predicate: original.predicate,
        ...(original.target_entity_id === undefined ? {} : { target_entity_id: original.target_entity_id }),
        confidence: { band: "high" },
        evidence_links: [{ evidence_id: "ev-2", stance: "supports" }],
        supersedes: [originalId as never]
      }
    ],
    sensitivity: { ...FIXTURE_OPEN }
  });
  if (!result.ok) throw new Error(`supersede refused: ${result.message}`);
}

function structured(response: { result?: Record<string, unknown> }): Record<string, unknown> {
  return (response.result?.["structuredContent"] ?? {}) as Record<string, unknown>;
}

async function neighbourPredicates(client: Harness["client"], entityId: string, id: number): Promise<string[]> {
  client.send(callTool({ id, name: "atlas.graph.neighbors.v1", args: { entity_id: entityId, direction: "both" } }));
  const page = structured(await client.await(id));
  return ((page["edges"] ?? []) as { predicate: string }[]).map((edge) => edge.predicate);
}

describe("a retraction leaves the traversal", () => {
  it("removes the edge from atlas.graph.neighbors.v1 while the ledger still holds both records", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const originalId = seedRelationship(graph);
    const { client } = harness({ graph });

    // Believed before the retraction.
    expect(await neighbourPredicates(client, subject.entity_id, 1)).toContain("employed-by");

    supersedeWith(graph, originalId, "retract");

    // HALF ONE: gone from the traversal.
    expect(await neighbourPredicates(client, subject.entity_id, 2)).not.toContain("employed-by");

    // HALF TWO: still readable in the ledger, both records, with the original
    // marked superseded. A traversal that hid the edge by DELETING it would
    // pass the first assertion and fail this one.
    client.send(
      callTool({
        id: 3,
        name: "atlas.assertion.query.v1",
        args: { subject_entity_id: subject.entity_id, include_superseded: true }
      })
    );
    const ledger = (structured(await client.await(3))["results"] ?? []) as {
      assertion_id: string;
      lineage_action: string;
      superseded_at: string | null;
    }[];
    const original = ledger.find((row) => row.assertion_id === originalId);
    expect(original).toBeDefined();
    expect(original?.superseded_at).not.toBeNull();
    expect(ledger.some((row) => row.lineage_action === "retract")).toBe(true);
  });

  it("does not COUNT the retraction as an edge of its own", async () => {
    // The symptom that gave it away: an entity whose every edge was retracted
    // came back with MORE neighbours than before, because each retraction was
    // counted as an edge in its own right.
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const originalId = seedRelationship(graph);
    const { client } = harness({ graph });

    const before = (await neighbourPredicates(client, subject.entity_id, 1)).length;
    supersedeWith(graph, originalId, "retract");
    const after = (await neighbourPredicates(client, subject.entity_id, 2)).length;

    expect(after).toBeLessThan(before);
  });
});

describe("the other lineage actions keep their edge", () => {
  it("keeps a CORRECTED relationship, which is the current claim", async () => {
    // The bug's tempting over-fix is "exclude everything that is not assert",
    // which would silently delete every corrected relationship in the graph.
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const originalId = seedRelationship(graph);
    const { client } = harness({ graph });

    supersedeWith(graph, originalId, "correct");

    expect(await neighbourPredicates(client, subject.entity_id, 1)).toContain("employed-by");
  });

  it("keeps a REINSTATED relationship", async () => {
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const originalId = seedRelationship(graph);
    const { client } = harness({ graph });

    supersedeWith(graph, originalId, "reinstate");

    expect(await neighbourPredicates(client, subject.entity_id, 1)).toContain("employed-by");
  });

  it("keeps an INVALIDATED relationship, because it carries the interval in which it held", async () => {
    // `invalidate` is a WORLD change, not a belief error: it was true and
    // stopped being true. Dropping it here would delete real history from an
    // as_of_valid read; a caller asking about now is answered by valid-time
    // filtering instead.
    const graph = syntheticGraph();
    const subject = graph.entityList[0];
    expect(subject).toBeDefined();
    if (!subject) return;
    const originalId = seedRelationship(graph);
    const { client } = harness({ graph });

    supersedeWith(graph, originalId, "invalidate");

    expect(await neighbourPredicates(client, subject.entity_id, 1)).toContain("employed-by");
  });
});

describe("the lineage table is total, so a new action cannot inherit a default", () => {
  it("names every lineage action the contract publishes", () => {
    // A seventh action must fail to COMPILE here rather than silently take
    // whichever answer an `else` branch happened to give.
    expect(Object.keys(LINEAGE_ACTION_AFFIRMS_EDGE).sort()).toEqual([
      "assert",
      "correct",
      "invalidate",
      "other",
      "reinstate",
      "retract"
    ]);
  });

  it("fails CLOSED on an action it does not understand", () => {
    // Same reason `kind: "other"` exists: better visibly ignorant than silently
    // wrong. The record stays readable through atlas.assertion.query.v1.
    expect(LINEAGE_ACTION_AFFIRMS_EDGE.other).toBe(false);
    expect(LINEAGE_ACTION_AFFIRMS_EDGE.retract).toBe(false);
  });
});
